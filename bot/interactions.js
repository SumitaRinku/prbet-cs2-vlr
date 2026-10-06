const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { splitMessage } = require('./core');

function verifySignature(body, signature, secret) {
    const expected = Buffer.from(`sha1=${crypto.createHmac('sha1', secret).update(body).digest('hex')}`);
    const actual = Buffer.from(signature || '');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseEvent(event, config, now = Date.now()) {
    const group = String(event.group_id || ''), qq = String(event.user_id || '');
    if (!config.commandGroupIds.includes(group) || qq === String(event.self_id)) return null;
    if (!Number.isFinite(event.time) || Math.abs(now - event.time * 1000) > 600000) return null;
    if (event.post_type === 'notice' && event.notice_type === 'group_decrease') {
        return { group, qq, request_id: `leave:${event.time}:${qq}`, text: '退出', silent: true };
    }
    if (event.post_type !== 'message' || event.message_type !== 'group'
        || !Number.isFinite(event.time) || Math.abs(now - event.time * 1000) > 600000) return null;
    if (!Array.isArray(event.message)) return null;
    // Ignore non-text content except a direct @ of the bot. Never trust raw_message or sender.role.
    if (event.message.some(s => s.type !== 'text' && !(s.type === 'at' && String(s.data?.qq) === String(event.self_id)))) return null;
    const text = event.message.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
    const match = /^\/prbet(?:\s+(.+))?$/is.exec(text);
    if (!match || !/^-?\d{1,20}$/.test(String(event.message_id))) return null;
    const command = (match[1] || '帮助').trim();
    if (command.length > 200 || !/^[1-9]\d{4,15}$/.test(qq)) return null;
    return { group, qq, request_id: `msg:${event.self_id}:${event.message_id}`, text: command, silent: false };
}

async function siteRequest(config, pathname, body) {
    const response = await fetch(`${config.siteUrl}/api/bot/${pathname}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${config.feedToken}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
        const error = new Error(`群竞猜接口 HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function settlementText(event) {
    const m = event.match;
    const clean = s => String(s).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160);
    const lines = [`【${event.correction ? '赛果更正' : '比赛结算'} · #${m.id}】`, clean(m.tournament_name),
        `${clean(m.team1_name)} ${m.team1_score}:${m.team2_score} ${clean(m.team2_name)}${m.is_forfeit ? '（弃权，不计分）' : ''}`, '', '本群竞猜结果'];
    for (const p of event.predictions) {
        const outcome = m.is_forfeit ? '弃权不计分' : p.predicted_winner_id !== m.winner_team_id ? '未猜中'
            : (p.predicted_team1_score === m.team1_score && p.predicted_team2_score === m.team2_score ? '比分全中' : '猜中胜者');
        lines.push(`${clean(p.username)}：${p.predicted_team1_score}:${p.predicted_team2_score} · ${outcome} · 本场 ${p.points_earned} 分${event.correction ? `（较上次结算 ${p.delta >= 0 ? '+' : ''}${p.delta}）` : `（+${p.points_earned}）`}`);
    }
    if (!event.predictions.length) lines.push('暂无已绑定并加入本群的成员参与这场竞猜。');
    lines.push('积分已在网站结算，群消息不会重复加分。');
    return lines.join('\n');
}

async function startInteractions(config, file, { saveState, sendMessage, request = siteRequest, sleep, now = Date.now } = {}) {
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, inbox: {}, cursors: {}, deliveries: {} };
    if (state.version !== 1 || !state.inbox || !state.cursors || !state.deliveries) throw new Error('群竞猜状态文件无效，请恢复备份');
    for (const job of Object.values(state.deliveries)) for (const part of job.parts) if (part.status === 'sending') part.status = 'unknown';
    const save = () => saveState(file, state);
    save();
    const hits = new Map();
    const lastPoll = new Map();
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/onebot') { res.writeHead(404).end(); return; }
        const chunks = []; let size = 0;
        try {
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 65536) { res.writeHead(413).end(); req.destroy(); return; }
                chunks.push(chunk);
            }
            const body = Buffer.concat(chunks);
            if (!verifySignature(body, req.headers['x-signature'], config.eventSecret)) { res.writeHead(401).end(); return; }
            const command = parseEvent(JSON.parse(body.toString('utf8')), config, now());
            if (!command) { res.writeHead(200).end('{}'); return; }
            const key = `${command.group}:${command.qq}:${command.request_id}`;
            if (!state.inbox[key]) {
                const memberKey = `${command.group}:${command.qq}`;
                if (!command.silent && (hits.get(memberKey) || 0) > now() - 2000) { res.writeHead(429).end(); return; }
                if (Object.values(state.inbox).filter(job => !job.done).length >= 500) { res.writeHead(503).end(); return; }
                hits.set(memberKey, now());
                for (const [id, stamp] of hits) if (stamp < now() - 60000) hits.delete(id);
                state.inbox[key] = { ...command, createdAt: now(), attempts: 0 };
                save(); // Acknowledge only after recording the inbound command durably.
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        } catch { if (!res.headersSent) res.writeHead(400).end(); }
    });
    server.requestTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.eventPort, '127.0.0.1', resolve); });

    function queue(key, group, text, source) {
        if (!state.deliveries[key]) state.deliveries[key] = { group, source, createdAt: now(),
            parts: splitMessage(text).map(text => ({ text, status: 'pending', attempts: 0 })) };
    }

    async function pump() {
        // Initialize each group's baseline before processing commands that can settle a match.
        for (const group of config.commandGroupIds) {
            if ((lastPoll.get(group) || 0) > now() - 15000) continue;
            lastPoll.set(group, now());
            const cursor = state.cursors[group];
            try {
                const page = await request(config, `settlements?group_id=${group}${cursor === undefined ? '' : `&after=${cursor}`}`);
                if (!Number.isSafeInteger(page.cursor) || !Array.isArray(page.events)) throw new Error('结算接口返回格式异常');
                for (const event of page.events) if (config.games.includes(event.match.game_type)) queue(`settlement:${group}:${event.id}`, group, settlementText(event), 'settlement');
                state.cursors[group] = page.cursor;
                save(); // Advance only together with the durable outbound messages.
            } catch (error) { console.error(`[群竞猜] ${group}: ${error.message}`); }
        }
        for (const [key, command] of Object.entries(state.inbox)) {
            if (command.done || (command.retryAt || 0) > now()) continue;
            if (!config.commandGroupIds.includes(command.group)) { command.done = true; save(); continue; }
            if (now() - command.createdAt > 600000) {
                command.done = true;
                if (!command.silent) queue(`reply:${key}`, command.group, `QQ ${command.qq}：指令处理超时，请查询状态后重新发送。`, 'command');
                delete command.text; save(); continue;
            }
            // Do not run commands before settlement baseline is available.
            if (state.cursors[command.group] === undefined) continue;
            try {
                const result = await request(config, 'command', { group_id: command.group, qq_id: command.qq,
                    request_id: command.request_id, text: command.text });
                if (typeof result.text !== 'string') throw new Error('指令响应格式错误');
                if (!command.silent) queue(`reply:${key}`, command.group, `QQ ${command.qq}：\n${result.text}`, 'command');
                command.done = true; delete command.text; save();
            } catch (error) {
                command.attempts++; command.retryAt = now() + Math.min(60000, 2000 * 2 ** Math.min(command.attempts, 5));
                if ([400, 403].includes(error.status)) {
                    command.done = true; delete command.text;
                    if (!command.silent) queue(`reply:${key}`, command.group, `QQ ${command.qq}：本群或指令未获网站授权，请联系管理员。`, 'command');
                }
                save(); console.error(`[群竞猜] ${error.message}`);
            }
        }
        // Limit a pass so a backlog cannot starve incoming commands and ordinary reminders.
        let sent = 0;
        for (const job of Object.values(state.deliveries)) {
            if (!config.commandGroupIds.includes(job.group) || now() - job.createdAt > 2 * 86400000) continue;
            for (const part of job.parts) {
                if (sent >= 10) break;
                if (['unknown', 'sending'].includes(part.status)) break;
                if (part.status === 'sent') continue;
                if (part.attempts >= 3 || (part.retryAt || 0) > now()) break;
                part.status = 'sending'; part.attempts++; save();
                let outcome;
                try { outcome = await sendMessage(config, job.group, part.text); }
                catch { outcome = { status: 'unknown', error: '发送异常，请核对群消息' }; }
                Object.assign(part, outcome, { retryAt: now() + 60000 * 2 ** part.attempts }); save();
                console.log(`[群竞猜] ${job.group} ${job.source}: ${part.status}`);
                sent++; await sleep(3000);
                if (part.status !== 'sent') break;
            }
        }
        for (const [key, command] of Object.entries(state.inbox)) if (command.done && command.createdAt < now() - 86400000) delete state.inbox[key];
        for (const [key, job] of Object.entries(state.deliveries)) if (job.createdAt < now() - 14 * 86400000) delete state.deliveries[key];
        save();
    }
    return { pump, close: () => new Promise(resolve => server.close(resolve)), server };
}

module.exports = { verifySignature, parseEvent, settlementText, startInteractions };
