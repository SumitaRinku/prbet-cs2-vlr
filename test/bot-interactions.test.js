const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const express = require('express');
const { issueCode, runCommand } = require('../server/services/botCommands');
const { createBotRouter } = require('../server/routes/bot');
const { createBotAccountRouter } = require('../server/routes/botAccount');
const { parseEvent, verifySignature, settlementText, startInteractions } = require('../bot/interactions');
const { saveState } = require('../bot/run');

const now = Date.parse('2026-09-22T04:00:00Z');
const group = '123456', otherGroup = '123457', qq = '234567', admin = '345678';
const policy = { groups: [group, otherGroup], admins: [admin] };
function database() {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    function load(file) {
        const filename = path.resolve(__dirname, '..', file), req = createRequire(filename), module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console: { log() {}, error() {} },
            process: { env: { ADMIN_PASSWORD: 'test-password-only' } }, require(name) {
                if (['./database', '../config/database'].includes(name)) return db;
                if (name === '../utils/settlement') return load('server/utils/settlement.js');
                return req(name);
            } }, { filename });
        return module.exports;
    }
    load('server/config/init-db.js').ensureDatabase();
    const settlement = load('server/utils/settlement.js');
    db.exec(`INSERT INTO users(id,username,password_hash) VALUES(2,'alice','unused'),(3,'bob','unused');
        INSERT INTO tournaments(id,name,game_type,is_active) VALUES(1,'Cup','cs2',1);
        INSERT INTO teams(id,name,game_type) VALUES(1,'Alpha','cs2'),(2,'Beta','cs2');
        INSERT INTO matches(id,tournament_id,team1_id,team2_id,format,match_time,time_confirmed)
        VALUES(1,1,1,2,'BO3','2026-09-23T04:00:00Z',1);`);
    let request = 0;
    const command = (text, user = qq, grp = group, extra = {}) => runCommand(db,
        { group_id: grp, qq_id: user, request_id: `test:${++request}`, text, ...extra }, { policy, now, settlement });
    const bind = (userId = 2, user = qq, grp = group) => command(`绑定 ${issueCode(db,userId,user,now).code}`, user, grp);
    return { db, command, bind, settlement };
}

test('binding is expiring, single-use, QQ-specific and one-to-one; website can revoke', () => {
    const {db,command} = database();
    try {
        const code = issueCode(db,2,qq,now).code;
        assert.match(command(`绑定 ${code}`, '999999').text, /无效/);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_bindings').get().n,0);
        assert.match(command(`绑定 ${code}`).text,/成功/);
        assert.match(command(`绑定 ${code}`).text,/无效/);
        assert.match(command(`绑定 ${issueCode(db,3,qq,now).code}`).text,/已绑定/);
        assert.equal(db.prepare('SELECT user_id FROM bot_bindings WHERE qq_id=?').get(qq).user_id,2);
        const expired = issueCode(db,3,'999999',now-600001).code;
        assert.match(command(`绑定 ${expired}`,'999999').text,/过期/);
        command('解绑');
        assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_group_members').get().n,0);
    } finally {db.close();}
});

test('commands submit, edit and cancel same prediction with cutoff, status, score and group checks', () => {
    const {db,command,bind} = database();
    try {
        assert.match(command('竞猜 1 2:1').text,/绑定/); bind();
        assert.match(command('竞猜 1 2:1').text,/提交/);
        assert.match(command('修改 1 0:2').text,/修改/);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM predictions').get().n,1);
        assert.equal(db.prepare('SELECT predicted_winner_id FROM predictions').get().predicted_winner_id,2);
        assert.match(command('竞猜 1 3:2').text,/不符合/);
        assert.match(command('取消 1').text,/取消/);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM prediction_history').get().n,3);
        assert.match(command('竞猜 1 2:1',qq,otherGroup).text,/加入/);
        command('加入',qq,otherGroup);
        command('竞猜 1 2:1',qq,otherGroup);
        db.prepare("UPDATE matches SET match_time='2026-09-22T04:00:00Z'").run();
        assert.match(command('竞猜 1 0:2').text,/已开始/);
        assert.match(command('取消 1').text,/已开始/);
        assert.throws(()=>command('帮助',qq,'999999'),/未启用/);
        db.prepare("UPDATE matches SET match_time='2026-09-23T04:00:00Z',status='cancelled'").run();
        assert.match(command('竞猜 1 0:2').text,/已开始/);
    } finally {db.close();}
});

test('request replay cannot revert a later prediction and does not duplicate history', () => {
    const {db,command,bind} = database();
    try {
        bind();
        const first=command('竞猜 1 2:1',qq,group,{request_id:'same'});
        command('竞猜 1 0:2');
        assert.deepEqual(command('竞猜 1 2:1',qq,group,{request_id:'same'}),first);
        assert.equal(db.prepare('SELECT predicted_team1_score s FROM predictions').get().s,0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM prediction_history').get().n,2);
    } finally {db.close();}
});

test('admin permissions and settlement events are atomic, deduplicated, and correction-aware', () => {
    const {db,command,bind,settlement} = database();
    try {
        bind(); command('竞猜 1 2:1');
        assert.match(command('结算 1 2:1').text,/管理员/);
        assert.equal(db.prepare('SELECT status FROM matches').get().status,'upcoming');
        command('关闭竞猜 1',admin);
        assert.match(command('竞猜 1 0:2').text,/未开放/);
        command('开启竞猜 1',admin);
        assert.match(command('结算 1 2:1',admin).text,/已结算/);
        assert.equal(db.prepare('SELECT total_score FROM users WHERE id=2').get().total_score,2);
        settlement.settleMatch(1); settlement.settleMatch(1);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_settlement_events').get().n,1);
        command('结算 1 0:2',admin);
        assert.equal(db.prepare('SELECT total_score FROM users WHERE id=2').get().total_score,0);
        const event=JSON.parse(db.prepare('SELECT payload FROM bot_settlement_events ORDER BY id DESC LIMIT 1').get().payload);
        assert.equal(event.correction,true); assert.equal(event.predictions[0].delta,-2);
        assert.match(settlementText(event),/较上次结算 -2/);
        command('弃权 1 1',admin);
        assert.equal(db.prepare('SELECT is_forfeit FROM matches').get().is_forfeit,1);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_command_receipts WHERE qq_id=?').get(admin).n,5);
    } finally {db.close();}
});

async function serve(app, work) {
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    try {await work(`http://127.0.0.1:${server.address().port}`);} finally {await new Promise(resolve=>server.close(resolve));}
}

test('website account authentication and settlement feed expose only opted-in group members', async () => {
    const {db,command,bind} = database();
    const previous=process.env.BOT_COMMAND_GROUP_IDS;
    process.env.BOT_COMMAND_GROUP_IDS=`${group},${otherGroup}`;
    try {
        bind(); command('竞猜 1 2:1'); bind(3,'456789',otherGroup); command('竞猜 1 0:2','456789',otherGroup);
        command('结算 1 2:1',admin);
        // Align real settlement timestamps with the commands' injected clock.
        db.prepare('UPDATE bot_settlement_events SET created_at=?').run(now + 1);
        const app=express(); app.use(express.json());
        app.use('/api/bot',createBotRouter(db,()=> 'test-token'));
        app.use('/account',createBotAccountRouter(db,(req,res,next)=>{
            if(req.get('authorization')!=='Bearer alice') return res.sendStatus(401);
            req.user={id:2};next();
        }));
        await serve(app,async base=>{
            assert.equal((await fetch(`${base}/account`)).status,401);
            const headers={Authorization:'Bearer test-token'};
            const latest=await (await fetch(`${base}/api/bot/settlements?group_id=${group}`,{headers})).json();
            assert.equal(latest.events.length,0);assert.equal(latest.cursor,1);
            const page=await (await fetch(`${base}/api/bot/settlements?group_id=${group}&after=0`,{headers})).json();
            assert.deepEqual(page.events[0].predictions.map(p=>p.username),['alice']);
            assert.equal((await fetch(`${base}/api/bot/settlements?group_id=999999&after=0`,{headers})).status,403);
            await fetch(`${base}/account`,{method:'DELETE',headers:{Authorization:'Bearer alice'}});
            const revoked=await (await fetch(`${base}/api/bot/settlements?group_id=${group}&after=0`,{headers})).json();
            assert.equal(revoked.events[0].predictions.length,0);
        });
    } finally {db.close(); if(previous===undefined) delete process.env.BOT_COMMAND_GROUP_IDS; else process.env.BOT_COMMAND_GROUP_IDS=previous;}
});

function event(extra={}) {return {post_type:'message',message_type:'group',group_id:group,user_id:qq,self_id:987654,
    message_id:10,time:now/1000,message:[{type:'text',data:{text:'/prbet 竞猜 1 2:1'}}],...extra};}

test('event parser ignores non-whitelisted, self, forged raw strings, stale events and verifies HMAC', () => {
    const config={commandGroupIds:[group]};
    assert.equal(parseEvent(event(),config,now).text,'竞猜 1 2:1');
    assert.equal(parseEvent(event({group_id:otherGroup}),config,now),null);
    assert.equal(parseEvent(event({user_id:987654}),config,now),null);
    assert.equal(parseEvent(event({message:'[CQ:at] /prbet 结算 1 2:1'}),config,now),null);
    assert.equal(parseEvent(event({time:now/1000-601}),config,now),null);
    const body=Buffer.from(JSON.stringify(event())),secret='0123456789abcdef';
    const signature='sha1='+crypto.createHmac('sha1',secret).update(body).digest('hex');
    assert.equal(verifySignature(body,signature,secret),true);
    assert.equal(verifySignature(body,'sha1=bad',secret),false);
});

test('worker durably receives signed events, deduplicates retries, queues settlement before cursor advance', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prbet-interactions-'));
    const file=path.join(dir,'interactions.json');
    const config={commandGroupIds:[group],games:['cs2'],eventSecret:'0123456789abcdef',eventPort:0};
    let current=now, calls=0, sends=0, worker;
    const dependencies={saveState,now:()=>current,sleep:async()=>{},sendMessage:async()=>{sends++;return {status:'sent',messageId:'1'};},
        request:async(c,pathname,body)=>{
            if(body){calls++;assert.equal(body.qq_id,qq);return {text:'竞猜已提交'};}
            if(!pathname.includes('after=')) return {cursor:0,events:[]};
            return {cursor:1,events:[{id:1,match:{id:1,game_type:'cs2',tournament_name:'Cup',team1_name:'Alpha',team2_name:'Beta',team1_score:2,team2_score:1},predictions:[]}]};
        }};
    try {
        worker=await startInteractions(config,file,dependencies);
        const url=`http://127.0.0.1:${worker.server.address().port}/onebot`;
        const body=JSON.stringify(event());
        const headers={'x-signature':'sha1='+crypto.createHmac('sha1',config.eventSecret).update(body).digest('hex')};
        assert.equal((await fetch(url,{method:'POST',body})).status,401);
        assert.equal((await fetch(url,{method:'POST',body,headers})).status,200);
        assert.equal((await fetch(url,{method:'POST',body,headers})).status,200);
        await worker.pump(); assert.equal(calls,1);assert.equal(sends,1);
        current+=16000;await worker.pump();assert.equal(sends,2);
        await worker.close();worker=null;
        worker=await startInteractions(config,file,dependencies);
        await worker.pump();assert.equal(calls,1);assert.equal(sends,2);
        assert.equal(JSON.parse(fs.readFileSync(file)).cursors[group],1);
    } finally {if(worker)await worker.close();fs.rmSync(dir,{recursive:true});}
});

test('profile binding UI uses authenticated sharedApi and produces the exact binding command', async () => {
    const elements = new Map();
    for (const id of ['botBindingFeedback','botBindingForm','botBindingQQ','botUnbind']) {
        elements.set(id,{textContent:'',value:qq,handlers:{},addEventListener(type,handler){this.handlers[type]=handler;}});
    }
    const calls=[];
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../public/js/bot-account.js'),'utf8'),{
        document:{getElementById:id=>elements.get(id)},window:{addEventListener(){}},sharedState:{token:'session'},
        sharedApi:async(route,options)=>{
            calls.push([route,options]);
            if(route.endsWith('/code'))return {code:'ABCD1234'};
            if(options?.method==='DELETE')return {message:'已解绑'};
            return {binding:null,groups:[]};
        }
    });
    await new Promise(resolve=>setImmediate(resolve));
    await elements.get('botBindingForm').handlers.submit({preventDefault(){}});
    assert.match(elements.get('botBindingFeedback').textContent,/\/prbet 绑定 ABCD1234/);
    assert.equal(calls[1][1].body.qq_id,qq);
    await elements.get('botUnbind').handlers.click();
    assert.equal(elements.get('botBindingFeedback').textContent,'已解绑');
});

test('ambiguous interaction delivery survives restart without automatic resend', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prbet-unknown-'));
    const file=path.join(dir,'state.json');
    const config={commandGroupIds:[group],games:['cs2'],eventSecret:'0123456789abcdef',eventPort:0};
    saveState(file,{version:1,inbox:{},cursors:{[group]:0},deliveries:{one:{group,source:'command',createdAt:now,
        parts:[{text:'done',status:'sending',attempts:1}]}}});
    let sends=0,worker;
    try {
        worker=await startInteractions(config,file,{saveState,now:()=>now,sleep:async()=>{},
            request:async()=>({cursor:0,events:[]}),sendMessage:async()=>{sends++;return {status:'sent'};}});
        await worker.pump();assert.equal(sends,0);
        assert.equal(JSON.parse(fs.readFileSync(file)).deliveries.one.parts[0].status,'unknown');
    } finally {if(worker)await worker.close();fs.rmSync(dir,{recursive:true});}
});
