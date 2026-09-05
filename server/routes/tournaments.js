const express = require('express');
const db = require('../config/database');
const { TIER_SQL } = require('../services/tournamentTier');

const router = express.Router();

// 厂牌关键词归类（赛事回看筛选用）：按数组顺序首次命中生效，顺序即优先级。
// Valorant 的 EWC 必须排在赛区关键词之前，否则"EWC电竞世界杯2026 美洲预选赛"会误归 AMER。
// 未命中返回 null，前端归入"其他"。仅查询时计算，不落库。
const BRAND_RULES = {
    cs2: [
        ['BLAST', ['blast']],
        ['IEM', ['iem']],
        ['PGL', ['pgl']],
        ['EPL', ['esl pro league', 'epl']],
        ['XPL', ['xse pro league', 'xpl']],
        ['Stake', ['stake']],
        ['PWE', ['perfect world', 'cac', '完美世界']],
        ['EWC', ['esports world cup', 'ewc', '电竞世界杯']]
    ],
    valorant: [
        ['Masters', ['masters', '大师赛']],
        ['Champions', ['champions', '冠军赛']],
        ['EWC', ['esports world cup', 'ewc', '电竞世界杯']],
        ['EMEA', ['emea']],
        ['CN', ['china', 'cn es', '中国']],
        ['AMER', ['americas', 'amer', '美洲']],
        ['Pacific', ['pacific', '太平洋']]
    ]
};

function brandOf(name, gameType) {
    const rules = BRAND_RULES[gameType] || [];
    const lower = String(name || '').toLowerCase();
    for (const [brand, keys] of rules) {
        if (keys.some(key => lower.includes(key))) return brand;
    }
    return null;
}

function matchRows(tournamentId) {
    return db.prepare(`
        SELECT m.*, t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url,
            (SELECT COUNT(*) FROM predictions p WHERE p.match_id = m.id) prediction_count,
            (SELECT COUNT(*) FROM predictions p WHERE p.match_id = m.id AND p.points_earned > 0) correct_prediction_count
        FROM matches m
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE m.tournament_id = ?
        ORDER BY m.match_time DESC
    `).all(tournamentId);
}

router.get('/', (req, res) => {
    const { game_type, status } = req.query;
    const params = [];
    let where = 't.is_active = 1';
    if (game_type) {
        where += ' AND t.game_type = ?';
        params.push(game_type);
    }

    let having = '';
    if (status === 'finished') {
        having = 'HAVING match_count > 0 AND unfinished_count = 0';
    } else if (status === 'ongoing') {
        having = 'HAVING unfinished_count > 0';
    }

    const tournaments = db.prepare(`
        SELECT t.*, ${TIER_SQL} effective_tier,
            COUNT(DISTINCT m.id) match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' THEN m.id END) finished_count,
            COUNT(DISTINCT CASE WHEN m.status = 'ongoing' OR (m.status = 'upcoming' AND datetime(m.match_time) <= datetime('now')) THEN m.id END) ongoing_count,
            COUNT(DISTINCT CASE WHEN m.status = 'upcoming' AND datetime(m.match_time) > datetime('now') THEN m.id END) upcoming_count,
            COUNT(DISTINCT CASE WHEN m.status IN ('upcoming', 'ongoing') THEN m.id END) unfinished_count,
            COUNT(p.id) prediction_count
        FROM tournaments t
        LEFT JOIN matches m ON m.tournament_id = t.id
        LEFT JOIN predictions p ON p.match_id = m.id
        WHERE ${where}
        GROUP BY t.id
        ${having}
        ORDER BY effective_tier ASC, COALESCE(t.begin_at, t.created_at) DESC
    `).all(...params);

    // 厂牌为查询时按名称关键词推断，不落库（见文件头 BRAND_RULES）
    tournaments.forEach(t => { t.brand = brandOf(t.name, t.game_type); });
    res.json({ tournaments });
});

router.get('/:id', (req, res) => {
    const tournament = db.prepare(`
        SELECT t.*, ${TIER_SQL} effective_tier,
            COUNT(DISTINCT m.id) match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' THEN m.id END) finished_count,
            COUNT(DISTINCT CASE WHEN m.status = 'ongoing' OR (m.status = 'upcoming' AND datetime(m.match_time) <= datetime('now')) THEN m.id END) ongoing_count,
            COUNT(DISTINCT CASE WHEN m.status = 'upcoming' AND datetime(m.match_time) > datetime('now') THEN m.id END) upcoming_count,
            COUNT(DISTINCT CASE WHEN m.status IN ('upcoming', 'ongoing') THEN m.id END) unfinished_count,
            COUNT(p.id) prediction_count
        FROM tournaments t
        LEFT JOIN matches m ON m.tournament_id = t.id
        LEFT JOIN predictions p ON p.match_id = m.id
        WHERE t.id = ? AND t.is_active = 1
        GROUP BY t.id
    `).get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });
    res.json({ tournament, matches: matchRows(tournament.id) });
});

router.get('/:id/leaderboard', (req, res) => {
    const tournament = db.prepare('SELECT id, name, game_type FROM tournaments WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });

    const leaderboard = db.prepare(`
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
        WHERE u.role = 'user' AND m.tournament_id = ?
        GROUP BY u.id
        HAVING prediction_count > 0
        ORDER BY total_score DESC, success_rate DESC, prediction_count DESC
        LIMIT 100
    `).all(tournament.id);
    leaderboard.forEach((user, index) => user.rank = index + 1);
    res.json({ tournament, leaderboard });
});

router.get('/:id/predictions', (req, res) => {
    const tournament = db.prepare('SELECT id, name FROM tournaments WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });
    const predictions = db.prepare(`
        SELECT p.*, u.username, m.status match_status, m.match_time, m.team1_score, m.team2_score,
            t1.name team1_name, t2.name team2_name, pw.name predicted_winner_name
        FROM predictions p
        JOIN users u ON u.id = p.user_id
        JOIN matches m ON m.id = p.match_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        JOIN teams pw ON pw.id = p.predicted_winner_id
        WHERE m.tournament_id = ? AND m.status = 'finished'
        ORDER BY m.match_time DESC, p.points_earned DESC, p.created_at ASC
    `).all(tournament.id);
    res.json({ tournament, predictions });
});

module.exports = router;
