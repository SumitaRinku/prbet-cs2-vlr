const express = require('express');
const db = require('../config/database');

const router = express.Router();

const LEADERBOARD_SELECT = `
    SELECT u.id, u.username,
        COALESCE(SUM(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN p.points_earned ELSE 0 END), 0) total_score,
        COUNT(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN 1 END) prediction_count,
        COUNT(p.id) total_predictions,
        CASE WHEN COUNT(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN 1 END) > 0
            THEN ROUND(100.0 * SUM(CASE WHEN p.points_earned > 0 THEN 1 ELSE 0 END) / COUNT(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN 1 END), 1)
            ELSE 0 END success_rate
    FROM users u
    JOIN predictions p ON p.user_id = u.id
    JOIN matches m ON m.id = p.match_id
    JOIN tournaments tour ON tour.id = m.tournament_id
`;

function pageParams(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
    return { page, pageSize };
}

function runLeaderboard(where, params, page, pageSize) {
    const base = `${LEADERBOARD_SELECT} WHERE ${where} GROUP BY u.id HAVING prediction_count > 0`;
    const total = db.prepare(`SELECT COUNT(*) total FROM (${base})`).get(...params).total;
    const leaderboard = db.prepare(`${base} ORDER BY total_score DESC, success_rate DESC, prediction_count DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize);
    leaderboard.forEach((user, index) => { user.rank = (page - 1) * pageSize + index + 1; });
    return { leaderboard, total, page, page_size: pageSize };
}

function escapeCsv(value) {
    const str = String(value ?? '');
    if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

router.get('/', (req, res) => {
    const { game_type } = req.query;
    const params = [];
    let where = "u.role = 'user' AND tour.is_active = 1";
    if (game_type) { where += ' AND tour.game_type = ?'; params.push(game_type); }
    const { page, pageSize } = pageParams(req.query);
    res.json(runLeaderboard(where, params, page, pageSize));
});

// 导出成绩 CSV：可按 game_type（按游戏）或 tournament_id（按赛事）筛选。
router.get('/export', (req, res) => {
    const { game_type, tournament_id } = req.query;
    const params = [];
    let where = "u.role = 'user'";
    if (game_type) { where += ' AND tour.game_type = ?'; params.push(game_type); }
    if (tournament_id) { where += ' AND m.tournament_id = ?'; params.push(tournament_id); }
    const base = `${LEADERBOARD_SELECT} WHERE ${where} GROUP BY u.id HAVING prediction_count > 0`;
    const rows = db.prepare(`${base} ORDER BY total_score DESC, success_rate DESC, prediction_count DESC`).all(...params);

    const header = ['排名', '用户名', '总积分', '已结算预测数', '得分率(%)'];
    const csv = [header, ...rows.map((row, index) => [index + 1, row.username, row.total_score, row.prediction_count, row.success_rate])]
        .map(line => line.map(escapeCsv).join(','))
        .join('\r\n');

    res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="leaderboard.csv"'
    });
    res.send(String.fromCharCode(0xFEFF) + csv); // BOM 让 Excel 正确识别 UTF-8 中文
});

router.get('/tournament/:id', (req, res) => {
    const tournament = db.prepare('SELECT id, name, game_type FROM tournaments WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });
    const { page, pageSize } = pageParams(req.query);
    const result = runLeaderboard("u.role = 'user' AND m.tournament_id = ?", [tournament.id], page, pageSize);
    res.json({ tournament, ...result });
});

router.get('/users/:id/details', (req, res) => {
    const { game_type, tournament_id } = req.query;
    const user = db.prepare("SELECT id, username FROM users WHERE id = ? AND role = 'user'").get(req.params.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const params = [user.id];
    let where = "p.user_id = ? AND m.status = 'finished' AND tour.is_active = 1";
    if (game_type) {
        where += ' AND tour.game_type = ?';
        params.push(game_type);
    }
    if (tournament_id) {
        where += ' AND m.tournament_id = ?';
        params.push(tournament_id);
    }

    const predictions = db.prepare(`
        SELECT p.id, p.predicted_team1_score, p.predicted_team2_score, p.points_earned,
            m.id match_id, m.name match_name, m.match_time, m.format, m.is_forfeit, m.team1_score, m.team2_score,
            tour.name tournament_name, tour.game_type,
            t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url,
            pw.name predicted_winner_name
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        JOIN teams pw ON pw.id = p.predicted_winner_id
        WHERE ${where}
        ORDER BY m.match_time DESC, p.id DESC
    `).all(...params);

    const summary = predictions.reduce((total, row) => {
        if (row.is_forfeit) return total;
        total.total_score += row.points_earned || 0;
        total.prediction_count++;
        if ((row.points_earned || 0) > 0) total.scored_count++;
        return total;
    }, { total_score: 0, prediction_count: 0, scored_count: 0 });
    summary.success_rate = summary.prediction_count ? Math.round((summary.scored_count / summary.prediction_count) * 1000) / 10 : 0;

    res.json({ user, summary, predictions });
});

module.exports = router;
