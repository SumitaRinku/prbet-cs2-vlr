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

function predictionOutcome(p, m) {
    if (m.is_forfeit) return '弃权不计分';
    if (p.predicted_winner_id !== m.winner_team_id) return '未猜中';
    return p.predicted_team1_score === m.team1_score && p.predicted_team2_score === m.team2_score ? '比分全中' : '猜中胜者';
}

function settlementText(event) {
    const m = event.match;
    const clean = s => String(s).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160);
    const lines = [`【${event.correction ? '赛果更正' : '比赛结算'} · #${m.id}】`, clean(m.tournament_name),
        `${clean(m.team1_name)} ${m.team1_score}:${m.team2_score} ${clean(m.team2_name)}${m.is_forfeit ? '（弃权，不计分）' : ''}`, '', '本群竞猜结果'];
    for (const p of event.predictions) {
        lines.push(`${clean(p.username)}：${p.predicted_team1_score}:${p.predicted_team2_score} · ${predictionOutcome(p, m)} · 本场 ${p.points_earned} 分${event.correction ? `（较上次结算 ${p.delta >= 0 ? '+' : ''}${p.delta}）` : `（+${p.points_earned}）`}`);
    }
    if (!event.predictions.length) lines.push('暂无已绑定并加入本群的成员参与这场竞猜。');
    lines.push('积分已在网站结算，群消息不会重复加分。');
    return lines.join('\n');
}

// 同一短窗口内的多场结算合并为一条播报，避免逐条刷屏。
function mergedSettlementText(events) {
    const clean = s => String(s).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160);
    const hasCorrection = events.some(e => e.correction);
    const lines = [`【${hasCorrection ? '赛果更正与结算' : '比赛结算'} · 共 ${events.length} 场】`];
    for (const event of events) {
        const m = event.match;
        lines.push('', `#${m.id} ${clean(m.tournament_name)}${event.correction ? '（赛果更正）' : ''}`,
            `${clean(m.team1_name)} ${m.team1_score}:${m.team2_score} ${clean(m.team2_name)}${m.is_forfeit ? '（弃权，不计分）' : ''}`);
        if (event.predictions.length) {
            for (const p of event.predictions)
                lines.push(`· ${clean(p.username)}：${p.predicted_team1_score}:${p.predicted_team2_score} · ${predictionOutcome(p, m)} · 本场 ${p.points_earned} 分${event.correction ? `（较上次结算 ${p.delta >= 0 ? '+' : ''}${p.delta}）` : `（+${p.points_earned}）`}`);
        } else lines.push('· 暂无本群成员参与这场竞猜');
    }
    lines.push('', '积分已在网站结算，群消息不会重复加分。');
    return lines.join('\n');
}

async function startInteractions(config, file, { saveState, sendMessage, request = siteRequest, sleep, now = Date.now } = {}) {
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, inbox: {}, cursors: {}, deliveries: {} };
    if (state.version !== 1 || !state.inbox || !state.cursors || !state.deliveries) throw new Error('群竞猜状态文件无效，请恢复备份');
    if (!state.pendingSettlements || typeof state.pendingSettlements !== 'object') state.pendingSettlements = {};
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

    async function initializeBaselines() {
        for (const group of config.commandGroupIds) {
            if (state.cursors[group] !== undefined || (lastPoll.get(group) || 0) > now() - 15000) continue;
            lastPoll.set(group, now());
            try {
                const page = await request(config, `settlements?group_id=${group}`);
                if (!Number.isSafeInteger(page.cursor) || !Array.isArray(page.events)) throw new Error('结算接口返回格式异常');
                state.cursors[group] = page.cursor;
                save();
            } catch (error) { console.error(`[群竞猜] ${group}: ${error.message}`); }
        }
    }

    async function processCommands(limit) {
        let processed = 0;
        for (const [key, command] of Object.entries(state.inbox)) {
            if (processed >= limit) break;
            if (command.done || (command.retryAt || 0) > now()) continue;
            // A group's unavailable baseline must not block commands for other groups.
            if (config.commandGroupIds.includes(command.group) && state.cursors[command.group] === undefined && now() - command.createdAt <= 600000) continue;
            processed++;
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
        return processed;
    }

    function nextDelivery(source) {
        for (const job of Object.values(state.deliveries)) {
            if (job.source !== source) continue;
            if (!config.commandGroupIds.includes(job.group) || now() - job.createdAt > 2 * 86400000) continue;
            for (const part of job.parts) {
                if (['unknown', 'sending'].includes(part.status)) break;
                if (part.status === 'sent') continue;
                if (part.attempts >= 3 || (part.retryAt || 0) > now()) break;
                return { job, part };
            }
        }
        return null;
    }

    async function deliver({ job, part }) {
        part.status = 'sending'; part.attempts++; save();
        let outcome;
        try { outcome = await sendMessage(config, job.group, part.text); }
        catch { outcome = { status: 'unknown', error: '发送异常，请核对群消息' }; }
        Object.assign(part, outcome, { retryAt: now() + 60000 * 2 ** part.attempts }); save();
        console.log(`[群竞猜] ${job.group} ${job.source}: ${part.status}`);
        await sleep(3000);
    }

    function pruneAndSave() {
        for (const [key, command] of Object.entries(state.inbox)) if (command.done && command.createdAt < now() - 86400000) delete state.inbox[key];
        for (const [key, job] of Object.entries(state.deliveries)) if (job.createdAt < now() - 14 * 86400000) delete state.deliveries[key];
        save();
    }

    async function pump({ commandsOnly = false } = {}) {
        // Baselines must precede commands that can settle a match, including during a report.
        await initializeBaselines();
        let processed = 0, sent = 0;
        async function sendReplies() {
            while (sent < 10) {
                const count = processed < 10 ? await processCommands(1) : 0;
                processed += count;
                const delivery = nextDelivery('command');
                if (!delivery) {
                    if (count && processed < 10) continue;
                    break;
                }
                await deliver(delivery);
                sent++;
                // Re-read the inbox after every send so new commands can interrupt notifications.
            }
        }
        await sendReplies();
        if (commandsOnly || sent >= 10) { pruneAndSave(); return; }

        const pending = state.pendingSettlements;
        for (const group of config.commandGroupIds) {
            if (state.cursors[group] === undefined || (lastPoll.get(group) || 0) > now() - 15000) continue;
            lastPoll.set(group, now());
            try {
                const page = await request(config, `settlements?group_id=${group}&after=${state.cursors[group]}`);
                if (!Number.isSafeInteger(page.cursor) || !Array.isArray(page.events)) throw new Error('结算接口返回格式异常');
                for (const event of page.events) if (config.games.includes(event.match.game_type)) {
                    const buffer = pending[group] || (pending[group] = { events: [], firstAt: now() });
                    buffer.events.push(event);
                }
                state.cursors[group] = page.cursor;
                save(); // Cursor and buffer remain atomic across restarts.
            } catch (error) { console.error(`[群竞猜] ${group}: ${error.message}`); }
        }
        for (const [group, buffer] of Object.entries(pending)) {
            if (!config.commandGroupIds.includes(group)) { delete pending[group]; continue; }
            if (buffer.events.length < 5 && now() - buffer.firstAt < 10000) continue;
            queue(`settlement:${group}:${buffer.events.map(e => e.id).join('.')}`, group,
                buffer.events.length === 1 ? settlementText(buffer.events[0]) : mergedSettlementText(buffer.events), 'settlement');
            delete pending[group];
        }
        await sendReplies(); // Commands received while polling take precedence too.
        // Only one notification part per pass, then yield back to the main loop.
        const notification = sent < 10 ? nextDelivery('settlement') : null;
        if (notification) { await deliver(notification); sent++; await sendReplies(); }
        pruneAndSave();
    }
    return { pump, close: () => new Promise(resolve => server.close(resolve)), server };
}

module.exports = { verifySignature, parseEvent, settlementText, mergedSettlementText, startInteractions };
