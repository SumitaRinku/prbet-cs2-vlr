const express = require('express');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.get('/my', authenticateToken, (req, res) => {
    const predictions = db.prepare(`
        SELECT p.*, m.format, m.tournament_id, m.name match_name, m.match_time, m.status match_status, m.is_forfeit match_is_forfeit, m.team1_score actual_team1_score, m.team2_score actual_team2_score,
            t1.id team1_id, t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url,
            t2.id team2_id, t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url,
            pw.name predicted_winner_name, tour.name tournament_name, tour.game_type
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        JOIN teams pw ON pw.id = p.predicted_winner_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE p.user_id = ?
        ORDER BY m.match_time DESC
    `).all(req.user.id);

    // 统计口径与排行榜一致：活跃赛事 + 已结束（弃权不计分、不计入得分率）
    const stats = db.prepare(`
        SELECT COUNT(*) total,
            SUM(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 AND tour.is_active = 1 THEN 1 ELSE 0 END) settled,
            SUM(CASE WHEN m.status = 'finished' AND tour.is_active = 1 THEN COALESCE(p.points_earned, 0) ELSE 0 END) points,
            SUM(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 AND tour.is_active = 1 AND p.points_earned > 0 THEN 1 ELSE 0 END) correct
        FROM predictions p JOIN matches m ON m.id = p.match_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE p.user_id = ?
    `).get(req.user.id);
    res.json({ predictions, stats });
});

router.get('/history', authenticateToken, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const history = db.prepare(`
        SELECT h.*, m.name match_name, m.match_time, t1.name team1_name, t2.name team2_name,
            pw.name predicted_winner_name
        FROM prediction_history h
        JOIN matches m ON m.id = h.match_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        JOIN teams pw ON pw.id = h.predicted_winner_id
        WHERE h.user_id = ?
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT ?
    `).all(req.user.id, limit);
    res.json({ history });
});

module.exports = router;
