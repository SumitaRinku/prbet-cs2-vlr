// Standalone Node.js 20+ worker: no npm install required on Windows.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: sleep } = require('node:timers/promises');
const { DAY, iso, bounds, freshness, splitMessage, dailyReport, plan } = require('./core');

function readConfig(file) {
    const config = { games: ['cs2', 'valorant'], dailyTime: '12:00', dayStart: '06:00', earlyMinutes: 10,
        reminderMinutes: 30, weeklyEnabled: true, weeklyTime: '20:00', resultsLimit: 12,
        freshnessMinutes: 20, pollSeconds: 60, lockPort: 39173, dryRun: true,
        ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
    for (const name of ['siteUrl', 'napcatUrl']) {
        const url = new URL(config[name]);
        if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} 必须是无账号密码、无查询参数的 HTTP(S) 地址`);
        if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`${name} 非本机连接必须使用 HTTPS`);
        config[name] = config[name].replace(/\/+$/, '');
    }
    for (const name of ['feedToken', 'napcatToken']) {
        if (typeof config[name] !== 'string' || config[name].length < 8 || config[name].includes('填写')) throw new Error(`请配置 ${name}（至少 8 字符）`);
    }
    if (!Array.isArray(config.groupIds) || !config.groupIds.length || config.groupIds.some(id => typeof id !== 'string' || !/^[1-9]\d{4,15}$/.test(id))) throw new Error('groupIds 必须填写字符串形式的QQ群号');
    config.groupIds = [...new Set(config.groupIds)];
    if (!Array.isArray(config.games) || !config.games.length || config.games.some(game => !['cs2', 'valorant'].includes(game))) throw new Error('games 只支持 cs2 / valorant');
    for (const name of ['dailyTime', 'dayStart', 'weeklyTime']) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config[name])) throw new Error(`${name} 应为 HH:mm`);
    }
    if (config.dayStart >= config.dailyTime) throw new Error('dayStart 必须早于 dailyTime');
    for (const [name, min, max] of [['earlyMinutes', 0, 60], ['reminderMinutes', 0, 120], ['resultsLimit', 1, 100],
        ['freshnessMinutes', 5, 1440], ['pollSeconds', 15, 300], ['lockPort', 1024, 65535]]) {
        if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max) throw new Error(`${name} 必须是 ${min}—${max} 的整数`);
    }
    for (const name of ['dryRun', 'weeklyEnabled']) if (typeof config[name] !== 'boolean') throw new Error(`${name} 必须为 true 或 false`);
    return config;
}

async function fetchFeed(config, now, ids = []) {
    const url = new URL(`${config.siteUrl}/api/bot/schedule`);
    url.searchParams.set('from', iso(bounds(now, config).previous));
    url.searchParams.set('to', iso(now + 7 * DAY));
    if (ids.length) url.searchParams.set('ids', ids.join(','));
    const response = await fetch(url, { headers: { Authorization: `Bearer ${config.feedToken}` },
        redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`网站赛程接口 HTTP ${response.status}（检查网站部署、令牌和同步状态）`);
    const feed = await response.json();
    if (feed.version !== 1 || !Array.isArray(feed.matches) || !Array.isArray(feed.sync) || !Array.isArray(feed.unavailable_ids)) throw new Error('网站赛程接口格式不匹配，请部署最新代码');
    if (Math.abs(Date.parse(feed.generated_at) - now) > 120000 || !Number.isFinite(Date.parse(feed.generated_at))) throw new Error('网站响应时间异常，请检查两台服务器时钟与缓存');
    return feed;
}

async function sendMessage(config, groupId, text) {
    let response;
    try {
        response = await fetch(`${config.napcatUrl}/send_group_msg`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.napcatToken}` },
            body: JSON.stringify({ group_id: groupId, message: [{ type: 'text', data: { text } }] })
        });
    } catch {
        return { status: 'unknown', error: 'NapCat 连接失败或超时，发送结果不确定；请核对群消息' };
    }
    // Auth/route rejection is a known non-send. Other transport errors may be ambiguous.
    if ([400, 401, 403, 404, 429].includes(response.status)) return { status: 'failed', error: `NapCat HTTP ${response.status}` };
    if (!response.ok) return { status: 'unknown', error: `NapCat HTTP ${response.status}，发送结果不确定` };
    let data;
    try { data = await response.json(); } catch { return { status: 'unknown', error: 'NapCat 响应不是 JSON' }; }
    if (data.status === 'ok' && data.retcode === 0 && data.data?.message_id != null) {
        return { status: 'sent', messageId: String(data.data.message_id) };
    }
    if (data.status === 'failed') return { status: 'failed', error: `NapCat 拒绝发送，retcode=${Number(data.retcode)}` };
    return { status: 'unknown', error: 'NapCat 未返回明确成功回执' };
}

function loadState(file) {
    if (!fs.existsSync(file)) return { version: 1, jobs: {}, watched: {} };
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || !state.jobs || !state.watched) throw new Error('发送记录损坏；请恢复备份，不要直接删除记录以免重复发送');
    for (const job of Object.values(state.jobs)) {
        for (const part of job.parts) if (part.status === 'sending') part.status = 'unknown';
    }
    return state;
}

function saveState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
}

function pruneState(state, now) {
    for (const [key, job] of Object.entries(state.jobs)) if (job.expires < now - 14 * DAY) delete state.jobs[key];
    for (const watches of Object.values(state.watched)) {
        for (const [id, m] of Object.entries(watches)) if (Date.parse(m.match_time) < now - 2 * DAY) delete watches[id];
    }
}

async function tick(config, state, file, dependencies = {}) {
    const now = dependencies.now ?? Date.now();
    const getFeed = dependencies.fetchFeed || fetchFeed;
    const send = dependencies.sendMessage || sendMessage;
    const delay = dependencies.sleep || sleep;
    pruneState(state, now);
    const ids = [...new Set(Object.values(state.watched).flatMap(watches => Object.keys(watches)))];
    // Fetch extra tracked matches in bounded batches, keeping the full window each time.
    const feed = await getFeed(config, now, ids.slice(0, 500));
    for (let offset = 500; offset < ids.length; offset += 500) {
        const extra = await getFeed(config, now, ids.slice(offset, offset + 500));
        const existing = new Set(feed.matches.map(m => m.id));
        feed.matches.push(...extra.matches.filter(m => !existing.has(m.id)));
        feed.unavailable_ids.push(...extra.unavailable_ids);
    }
    const stale = freshness(feed, config, now);
    if (stale.length) throw new Error(`暂停发送：${stale.join(', ')} 同步超过 ${config.freshnessMinutes} 分钟未成功，或尚未完成升级后的首次同步`);
    for (const group of config.groupIds) {
        const watched = state.watched[group] ||= {};
        const candidates = plan(feed, config, now, watched);
        const activeKeys = new Set(candidates.map(job => `${group}|${job.key}`));
        for (const candidate of candidates) {
            const key = `${group}|${candidate.key}`;
            if (!state.jobs[key]) state.jobs[key] = { ...candidate, group, createdAt: now,
                parts: splitMessage(candidate.text).map(text => ({ text, status: 'pending', attempts: 0 })) };
        }
        saveState(file, state); // Freeze each report and all its parts before the first send.
        for (const [key, job] of Object.entries(state.jobs)) {
            if (job.group !== group || now > job.expires) continue;
            if (['reminder', 'change'].includes(job.kind) && !activeKeys.has(key)) continue;
            // Keep changed schedules/reminders current while they are still wholly unsent.
            const latest = candidates.find(candidate => `${group}|${candidate.key}` === key);
            if (latest && ['reminder', 'change'].includes(job.kind) && job.parts.every(part => ['pending', 'failed'].includes(part.status))) {
                const texts = splitMessage(latest.text);
                job.parts = texts.map((text, i) => ({ ...job.parts[i], text, status: job.parts[i]?.status || 'pending', attempts: job.parts[i]?.attempts || 0 }));
                job.watched = latest.watched;
            }
            for (const part of job.parts) {
                if (['unknown', 'sending'].includes(part.status)) break;
                if (part.status === 'sent') continue;
                if (part.attempts >= 3 || (part.retryAt || 0) > now) break;
                if (Date.now() > job.expires && dependencies.now === undefined) break;
                if (dependencies.now === undefined && freshness(feed, config, Date.now()).length) {
                    throw new Error('本轮发送期间数据已过期，等待下一轮重新拉取');
                }
                part.status = 'sending'; part.attempts++;
                saveState(file, state);
                const outcome = await send(config, group, part.text);
                Object.assign(part, outcome, { updatedAt: Date.now(), retryAt: now + 60000 * 2 ** part.attempts });
                saveState(file, state);
                console.log(`[${new Date().toISOString()}] ${key}: ${part.status}${part.error ? ` (${part.error})` : ''}`);
                await delay(3000);
                if (part.status !== 'sent') break;
            }
            if (job.parts.every(part => part.status === 'sent') && !job.recorded) {
                for (const m of job.watched) watched[String(m.id)] = m;
                job.recorded = true;
                saveState(file, state);
            }
        }
    }
}

async function acquireLock(port) {
    const server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
        server.once('error', () => reject(new Error(`端口 ${port} 已被占用：可能已有推送程序在运行`)));
        server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    return server;
}

async function main() {
    const args = process.argv.slice(2);
    const configIndex = args.indexOf('--config');
    const file = path.resolve(configIndex >= 0 ? args[configIndex + 1] : path.join(__dirname, 'config.json'));
    const config = readConfig(file);
    const stateFile = path.join(path.dirname(file), 'data', 'delivery.json');
    if (args.includes('--status')) {
        const state = loadState(stateFile);
        for (const [key, job] of Object.entries(state.jobs)) console.log(key, job.parts.map(part => part.status).join(', '));
        return;
    }
    if (args.includes('--preview') || config.dryRun) {
        const now = Date.now(), feed = await fetchFeed(config, now);
        const stale = freshness(feed, config, now);
        if (stale.length) console.log(`【仅预览】数据过期：${stale.join(', ')}；正式推送将暂停。`);
        console.log(dailyReport(feed, config, now).text);
        console.log('\n仅预览，未向QQ群发送消息。确认后将 config.json 中 dryRun 改为 false。');
        return;
    }
    const lock = await acquireLock(config.lockPort);
    try {
        const state = loadState(stateFile);
        saveState(stateFile, state);
        if (args.includes('--test')) {
            const key = `test:${Date.now()}`;
            for (const group of config.groupIds) {
                state.jobs[`${group}|${key}`] = { key, group, kind: 'test', expires: Date.now() + 60000, watched: [],
                    parts: [{ text: '【赛事提醒连接测试】NapCat 群消息发送正常。', status: 'sending', attempts: 1 }] };
                saveState(stateFile, state);
                Object.assign(state.jobs[`${group}|${key}`].parts[0], await sendMessage(config, group, '【赛事提醒连接测试】NapCat 群消息发送正常。'));
                saveState(stateFile, state);
                console.log(`测试群 ${group}: ${state.jobs[`${group}|${key}`].parts[0].status}`);
                await sleep(3000);
            }
            return;
        }
        do {
            try { await tick(config, state, stateFile); }
            catch (error) { console.error(`[${new Date().toISOString()}] ${error.message}`); if (args.includes('--once')) process.exitCode = 1; }
            if (args.includes('--once')) break;
            await sleep(config.pollSeconds * 1000);
        } while (true);
    } finally { lock.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { readConfig, fetchFeed, sendMessage, loadState, saveState, tick };
