const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { createRateLimiter } = require('../middleware/rateLimit');
const { runCommand, policy } = require('../services/botCommands');

function createBotRouter(db, getToken = () => process.env.BOT_FEED_TOKEN || '') {
    const router = express.Router();
    router.use(createRateLimiter({ windowMs: 60000, max: 300 }));
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const token = getToken();
        if (!token) return res.status(503).json({ error: 'Bot feed disabled: configure BOT_FEED_TOKEN' });
        const actual = Buffer.from(req.get('authorization') || '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });
    router.get('/schedule', (req, res) => {
        const from = Date.parse(req.query.from), to = Date.parse(req.query.to);
        const ids = req.query.ids ? String(req.query.ids).split(',') : [];
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 10 * 86400000
            || ids.length > 500 || ids.some(id => !/^[1-9]\d{0,14}$/.test(id))) {
            return res.status(400).json({ error: 'Invalid window (max 10 days) or ids (max 500)' });
        }
        const result = db.transaction(() => {
            const rows = db.prepare(`SELECT m.id, m.tournament_id, m.match_time, m.time_confirmed,
                m.status, m.format, m.stage_name, m.betting_enabled, m.is_forfeit,
                m.team1_id, m.team2_id, m.team1_score, m.team2_score, m.winner_team_id,
                m.external_source, m.last_synced_at,
                t.name tournament_name, t.short_name tournament_short_name, t.game_type,
                a.name team1_name, b.name team2_name
                FROM matches m JOIN tournaments t ON t.id = m.tournament_id
                JOIN teams a ON a.id = m.team1_id JOIN teams b ON b.id = m.team2_id
                WHERE t.is_active = 1 AND (
                    (julianday(m.match_time) >= julianday(?) AND julianday(m.match_time) < julianday(?))
                    ${ids.length ? `OR m.id IN (${ids.map(() => '?').join(',')})` : ''})
                ORDER BY julianday(m.match_time), m.id LIMIT 10001`)
                .all(new Date(from).toISOString(), new Date(to).toISOString(), ...ids);
            return { rows, sync: db.prepare('SELECT game_type, last_success_at FROM bot_sync_state').all() };
        })();
        // Fail explicitly instead of silently truncating a daily report.
        if (result.rows.length > 10000) return res.status(413).json({ error: 'Schedule exceeds 10000 rows; narrow the window' });
        const found = new Set(result.rows.map(row => String(row.id)));
        res.json({ version: 1, generated_at: new Date().toISOString(), matches: result.rows,
            sync: result.sync, unavailable_ids: ids.filter(id => !found.has(id)) });
    });
    router.post('/command', (req, res, next) => {
        try { res.json(runCommand(db, req.body)); }
        catch (error) { if (error.expected) res.status(400).json({ error: error.message }); else next(error); }
    });
    router.get('/settlements', (req, res) => {
        const group = String(req.query.group_id || '');
        if (!policy().groups.includes(group)) return res.status(403).json({ error: '本群未启用竞猜功能' });
        const latest = db.prepare('SELECT COALESCE(MAX(id),0) id FROM bot_settlement_events').get().id;
        if (req.query.after === undefined) return res.json({ cursor: latest, events: [] });
        if (!/^\d{1,15}$/.test(String(req.query.after))) return res.status(400).json({ error: 'Invalid cursor' });
        const after = Number(req.query.after);
        if (after > latest) return res.status(409).json({ error: '结算游标超过服务器记录，请检查是否恢复了旧数据库' });
        const events = db.prepare('SELECT * FROM bot_settlement_events WHERE id>? ORDER BY id LIMIT 50').all(after);
        const members = db.prepare(`SELECT b.user_id,g.joined_at FROM bot_group_members g
            JOIN bot_bindings b ON b.qq_id=g.qq_id WHERE g.group_id=?`).all(group);
        const selected = events.map(event => {
            const payload = JSON.parse(event.payload);
            const permitted = new Set(members.filter(m => m.joined_at <= event.created_at).map(m => m.user_id));
            payload.predictions = payload.predictions.filter(p => permitted.has(p.user_id));
            return { id: event.id, ...payload };
        });
        res.json({ cursor: events.length ? events[events.length - 1].id : after, events: selected });
    });
    return router;
}

module.exports = { createBotRouter };
