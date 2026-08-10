const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { syncPandascoreMatches, syncStatus } = require('../services/pandascoreService');
const { isValidScore } = require('../utils/scoring');
const { settleMatch, recalculateUserScores } = require('../utils/settlement');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

function parseLimit(value, fallback = 300) {
    const limit = Number(value);
    return Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : fallback;
}

function applyTournamentActiveState(tournamentId, isActive) {
    if (isActive) {
        db.prepare("UPDATE matches SET betting_enabled = 1 WHERE tournament_id = ? AND status = 'upcoming' AND datetime(match_time) > datetime('now')")
            .run(tournamentId);
        return;
    }

    db.prepare("UPDATE matches SET betting_enabled = 0 WHERE tournament_id = ? AND status != 'finished'")
        .run(tournamentId);
}

router.get('/stats', (req, res) => {
    const { game_type } = req.query;
    const gameFilter = game_type ? ' WHERE game_type = ?' : '';
    const gameParams = game_type ? [game_type] : [];
    res.json({
        users: db.prepare("SELECT COUNT(*) count FROM users WHERE role = 'user'").get().count,
        tournaments: db.prepare(`SELECT COUNT(*) count FROM tournaments${gameFilter}`).get(...gameParams).count,
        teams: db.prepare(`SELECT COUNT(*) count FROM teams${gameFilter}`).get(...gameParams).count,
        matches: db.prepare(`SELECT COUNT(*) count FROM matches m JOIN tournaments t ON t.id = m.tournament_id${game_type ? ' WHERE t.game_type = ?' : ''}`).get(...gameParams).count,
        predictions: db.prepare('SELECT COUNT(*) count FROM predictions').get().count,
        sync: syncStatus()
    });
});

router.get('/sync/status', (req, res) => res.json({ sync: syncStatus() }));

router.post('/sync/pandascore', async (req, res) => {
    try {
        res.json(await syncPandascoreMatches('manual'));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/users', (req, res) => {
    const users = db.prepare(`
        SELECT u.id, u.username, u.role, u.total_score, u.created_at, COUNT(p.id) prediction_count
        FROM users u
        LEFT JOIN predictions p ON p.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at DESC
    `).all();
    res.json({ users });
});

router.post('/users', (req, res) => {
    const { username, password, role = 'user' } = req.body;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: '用户名格式不正确' });
    if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: '角色无效' });
    try {
        const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, bcrypt.hashSync(password, 10), role);
        res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: '用户名已存在' });
        res.status(500).json({ error: '创建用户失败' });
    }
});

router.put('/users/:id/role', (req, res) => {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: '角色无效' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.username === 'admin' && role !== 'admin') return res.status(400).json({ error: '不能降级默认管理员' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    res.json({ message: '角色已更新' });
});

router.put('/users/:id/password', (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
    res.json({ message: '密码已重置' });
});

router.delete('/users/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.username === 'admin') return res.status(400).json({ error: '不能删除默认管理员' });
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    recalculateUserScores();
    res.json({ message: '用户已删除' });
});

router.get('/tournaments', (req, res) => {
    const { game_type } = req.query;
    const params = [];
    let where = '1=1';
    if (game_type) {
        where += ' AND t.game_type = ?';
        params.push(game_type);
    }
    const tournaments = db.prepare(`
        SELECT t.*, COUNT(m.id) match_count
        FROM tournaments t
        LEFT JOIN matches m ON m.tournament_id = t.id
        WHERE ${where}
        GROUP BY t.id
        ORDER BY COALESCE(t.begin_at, t.created_at) DESC
    `).all(...params);
    res.json({ tournaments });
});

router.post('/tournaments', (req, res) => {
    const { name, game_type = 'cs2', begin_at, end_at, is_active = 1 } = req.body;
    if (!name) return res.status(400).json({ error: '赛事名称不能为空' });
    if (!['cs2', 'valorant'].includes(game_type)) return res.status(400).json({ error: '游戏类型无效' });
    const result = db.prepare('INSERT INTO tournaments (name, game_type, is_active, name_locked, begin_at, end_at) VALUES (?, ?, ?, 1, ?, ?)').run(name, game_type, is_active ? 1 : 0, begin_at || null, end_at || null);
    res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/tournaments/:id', (req, res) => {
    const { name, game_type, begin_at, end_at, is_active } = req.body;
    if (game_type && !['cs2', 'valorant'].includes(game_type)) return res.status(400).json({ error: '游戏类型无效' });
    const existing = db.prepare('SELECT id, is_active FROM tournaments WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '赛事不存在' });
    const result = db.prepare(`
        UPDATE tournaments SET name = COALESCE(?, name), name_locked = CASE WHEN ? IS NULL THEN name_locked ELSE 1 END, game_type = COALESCE(?, game_type), is_active = COALESCE(?, is_active), begin_at = COALESCE(?, begin_at), end_at = COALESCE(?, end_at) WHERE id = ?
    `).run(name || null, name || null, game_type || null, is_active === undefined ? null : (is_active ? 1 : 0), begin_at || null, end_at || null, req.params.id);
    if (is_active !== undefined && existing.is_active !== (is_active ? 1 : 0)) applyTournamentActiveState(existing.id, is_active ? 1 : 0);
    res.json({ message: '赛事已更新' });
});

router.put('/tournaments/:id/toggle-active', (req, res) => {
    const tournament = db.prepare('SELECT id, is_active FROM tournaments WHERE id = ?').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });
    const next = tournament.is_active ? 0 : 1;
    db.prepare('UPDATE tournaments SET is_active = ? WHERE id = ?').run(next, tournament.id);
    applyTournamentActiveState(tournament.id, next);
    res.json({ is_active: next });
});

router.delete('/tournaments/:id', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) count FROM matches WHERE tournament_id = ?').get(req.params.id).count;
    if (count > 0) return res.status(400).json({ error: '该赛事下还有比赛，不能删除' });
    const result = db.prepare('DELETE FROM tournaments WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '赛事不存在' });
    res.json({ message: '赛事已删除' });
});

router.get('/teams', (req, res) => {
    const { game_type } = req.query;
    const params = [];
    let where = '1=1';
    if (game_type) {
        where += ' AND game_type = ?';
        params.push(game_type);
    }
    const teams = db.prepare(`SELECT * FROM teams WHERE ${where} ORDER BY name ASC LIMIT 1000`).all(...params);
    res.json({ teams });
});

router.post('/teams', (req, res) => {
    const { name, game_type = 'cs2', short_name, logo_url, country } = req.body;
    if (!name) return res.status(400).json({ error: '队伍名称不能为空' });
    if (!['cs2', 'valorant'].includes(game_type)) return res.status(400).json({ error: '游戏类型无效' });
    const result = db.prepare('INSERT INTO teams (name, game_type, short_name, logo_url, country) VALUES (?, ?, ?, ?, ?)').run(name, game_type, short_name || null, logo_url || null, country || null);
    res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/teams/:id', (req, res) => {
    const { name, game_type, short_name, logo_url, country } = req.body;
    if (game_type && !['cs2', 'valorant'].includes(game_type)) return res.status(400).json({ error: '游戏类型无效' });
    const result = db.prepare(`
        UPDATE teams SET name = COALESCE(?, name), game_type = COALESCE(?, game_type), short_name = COALESCE(?, short_name), logo_url = COALESCE(?, logo_url), country = COALESCE(?, country) WHERE id = ?
    `).run(name || null, game_type || null, short_name || null, logo_url || null, country || null, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '队伍不存在' });
    res.json({ message: '队伍已更新' });
});

router.delete('/teams/:id', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) count FROM matches WHERE team1_id = ? OR team2_id = ?').get(req.params.id, req.params.id).count;
    if (count > 0) return res.status(400).json({ error: '队伍有关联比赛，不能删除' });
    const result = db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '队伍不存在' });
    res.json({ message: '队伍已删除' });
});

router.get('/matches', (req, res) => {
    const { game_type, status, limit } = req.query;
    const params = [];
    let where = '1=1';
    if (game_type) {
        where += ' AND tour.game_type = ?';
        params.push(game_type);
    }
    if (status) {
        where += ' AND m.status = ?';
        params.push(status);
    }
    params.push(parseLimit(limit));
    const matches = db.prepare(`
        SELECT m.*, tour.name tournament_name, tour.game_type, t1.name team1_name, t2.name team2_name
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE ${where}
        ORDER BY m.match_time DESC LIMIT ?
    `).all(...params);
    res.json({ matches });
});

router.post('/matches', (req, res) => {
    const { tournament_id, team1_id, team2_id, name, format = 'BO3', match_time, betting_enabled = 1 } = req.body;
    if (!tournament_id || !team1_id || !team2_id || !match_time) return res.status(400).json({ error: '缺少必填字段' });
    if (Number(team1_id) === Number(team2_id)) return res.status(400).json({ error: '两支队伍不能相同' });
    if (!['BO1', 'BO3', 'BO5'].includes(format)) return res.status(400).json({ error: '赛制无效' });
    const result = db.prepare(`
        INSERT INTO matches (tournament_id, team1_id, team2_id, name, format, match_time, betting_enabled, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'upcoming')
    `).run(tournament_id, team1_id, team2_id, name || null, format, match_time, betting_enabled ? 1 : 0);
    res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/matches/:id', (req, res) => {
    const { tournament_id, team1_id, team2_id, name, format, match_time, status, betting_enabled } = req.body;
    if (format && !['BO1', 'BO3', 'BO5'].includes(format)) return res.status(400).json({ error: '赛制无效' });
    if (status && !['upcoming', 'ongoing', 'finished', 'cancelled', 'postponed'].includes(status)) return res.status(400).json({ error: '状态无效' });
    const result = db.prepare(`
        UPDATE matches SET tournament_id = COALESCE(?, tournament_id), team1_id = COALESCE(?, team1_id), team2_id = COALESCE(?, team2_id),
            name = COALESCE(?, name), format = COALESCE(?, format), match_time = COALESCE(?, match_time), status = COALESCE(?, status),
            betting_enabled = COALESCE(?, betting_enabled)
        WHERE id = ?
    `).run(tournament_id || null, team1_id || null, team2_id || null, name || null, format || null, match_time || null, status || null, betting_enabled === undefined ? null : (betting_enabled ? 1 : 0), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '比赛不存在' });
    res.json({ message: '比赛已更新' });
});

router.put('/matches/:id/result', (req, res) => {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
    if (!match) return res.status(404).json({ error: '比赛不存在' });
    const team1Score = Number(req.body.team1_score);
    const team2Score = Number(req.body.team2_score);
    if (!isValidScore(team1Score, team2Score, match.format)) return res.status(400).json({ error: '比分不符合赛制' });
    const winnerId = team1Score > team2Score ? match.team1_id : match.team2_id;
    const apply = db.transaction(() => {
        db.prepare(`
            UPDATE matches SET team1_score = ?, team2_score = ?, winner_team_id = ?, status = 'finished', betting_enabled = 0 WHERE id = ?
        `).run(team1Score, team2Score, winnerId, match.id);
        const processed = settleMatch(match.id);
        recalculateUserScores();
        return processed;
    });
    const predictions = apply();
    res.json({ message: '赛果已保存', predictions_processed: predictions });
});

router.put('/matches/:id/betting', (req, res) => {
    const match = db.prepare('SELECT id, betting_enabled FROM matches WHERE id = ?').get(req.params.id);
    if (!match) return res.status(404).json({ error: '比赛不存在' });
    const next = match.betting_enabled ? 0 : 1;
    db.prepare('UPDATE matches SET betting_enabled = ? WHERE id = ?').run(next, match.id);
    res.json({ betting_enabled: next });
});

router.delete('/matches/:id', (req, res) => {
    const result = db.prepare('DELETE FROM matches WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '比赛不存在' });
    recalculateUserScores();
    res.json({ message: '比赛已删除' });
});

router.get('/predictions', (req, res) => {
    const predictions = db.prepare(`
        SELECT p.*, u.username, m.match_time, m.status match_status, t1.name team1_name, t2.name team2_name, pw.name predicted_winner_name
        FROM predictions p
        JOIN users u ON u.id = p.user_id
        JOIN matches m ON m.id = p.match_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        JOIN teams pw ON pw.id = p.predicted_winner_id
        ORDER BY p.created_at DESC LIMIT 500
    `).all();
    res.json({ predictions });
});

router.delete('/predictions/:id', (req, res) => {
    const result = db.prepare('DELETE FROM predictions WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '预测不存在' });
    recalculateUserScores();
    res.json({ message: '预测已删除' });
});

module.exports = router;
