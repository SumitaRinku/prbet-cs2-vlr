const express = require('express');
const db = require('../config/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const { isValidScore, possibleScores } = require('../utils/scoring');

const router = express.Router();

// 排除含 TBD 占位队的未定对局（方案1：首页/列表只显示可参与的比赛，
// 完整赛制结构由赛事详情页的赛程图展示）。占位队来自 pandascore 且 name='TBD'。
const NOT_TBD = "t1.name <> 'TBD' AND t2.name <> 'TBD'";

function isTbdMatch(match) {
    return db.prepare("SELECT 1 FROM teams WHERE id IN (?, ?) AND name = 'TBD' LIMIT 1").get(match.team1_id, match.team2_id);
}

function matchSelect(where = '1=1') {
    return `
        SELECT m.*, tour.name tournament_name, tour.game_type,
            t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url,
            (SELECT COUNT(*) FROM predictions p WHERE p.match_id = m.id) prediction_count
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE ${where}
    `;
}

router.get('/', optionalAuth, (req, res) => {
    const { status, game_type, tournament_id } = req.query;
    const params = [];
    let where = `tour.is_active = 1 AND ${NOT_TBD}`;
    if (status) {
        where += ' AND m.status = ?';
        params.push(status);
    }
    if (game_type) {
        where += ' AND tour.game_type = ?';
        params.push(game_type);
    }
    if (tournament_id) {
        where += ' AND m.tournament_id = ?';
        params.push(tournament_id);
    }

    const matches = db.prepare(`${matchSelect(where)} ORDER BY m.match_time ASC LIMIT 200`).all(...params);
    if (req.user) {
        const predictions = db.prepare('SELECT * FROM predictions WHERE user_id = ?').all(req.user.id);
        const map = new Map(predictions.map(prediction => [prediction.match_id, prediction]));
        for (const match of matches) match.user_prediction = map.get(match.id) || null;
    }
    res.json({ matches });
});

router.get('/upcoming', optionalAuth, (req, res) => {
    const { game_type, tournament_id } = req.query;
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const params = [cutoff];
    let where = `(m.status IN ('upcoming', 'ongoing') OR (m.status = 'finished' AND datetime(m.match_time) >= datetime(?))) AND tour.is_active = 1 AND ${NOT_TBD}`;
    if (game_type) {
        where += ' AND tour.game_type = ?';
        params.push(game_type);
    }
    if (tournament_id) {
        where += ' AND m.tournament_id = ?';
        params.push(tournament_id);
    }
    const matches = db.prepare(`${matchSelect(where)} ORDER BY CASE m.status WHEN 'finished' THEN 0 WHEN 'ongoing' THEN 1 ELSE 2 END, CASE WHEN m.status = 'finished' THEN m.match_time END DESC, CASE WHEN m.status != 'finished' THEN m.match_time END ASC LIMIT 100`).all(...params);
    if (req.user) {
        const predictions = db.prepare('SELECT * FROM predictions WHERE user_id = ?').all(req.user.id);
        const map = new Map(predictions.map(prediction => [prediction.match_id, prediction]));
        for (const match of matches) match.user_prediction = map.get(match.id) || null;
    }
    res.json({ matches });
});

router.get('/:id', optionalAuth, (req, res) => {
    const match = db.prepare(matchSelect('m.id = ? AND tour.is_active = 1')).get(req.params.id);
    if (!match) return res.status(404).json({ error: '比赛不存在' });
    match.possible_scores = possibleScores(match.format);
    if (req.user) match.user_prediction = db.prepare('SELECT * FROM predictions WHERE user_id = ? AND match_id = ?').get(req.user.id, match.id) || null;
    res.json({ match });
});

router.get('/:id/predictions', (req, res) => {
    const match = db.prepare(matchSelect('m.id = ? AND tour.is_active = 1')).get(req.params.id);
    if (!match) return res.status(404).json({ error: '比赛不存在' });
    if (match.status !== 'finished') return res.status(400).json({ error: '只有已结算比赛可以查看预测详情' });

    const predictions = db.prepare(`
        SELECT p.id, p.user_id, p.predicted_team1_score, p.predicted_team2_score, p.points_earned, p.created_at,
            u.username, pw.name predicted_winner_name
        FROM predictions p
        JOIN users u ON u.id = p.user_id
        JOIN teams pw ON pw.id = p.predicted_winner_id
        WHERE p.match_id = ?
        ORDER BY COALESCE(p.points_earned, 0) DESC, p.created_at ASC
    `).all(match.id);

    res.json({ match, predictions });
});

router.post('/:id/predictions', authenticateToken, (req, res) => {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
    if (!match) return res.status(404).json({ error: '比赛不存在' });
    if (isTbdMatch(match)) return res.status(400).json({ error: '对阵未确定，暂不可预测' });
    if (match.status !== 'upcoming' || !match.betting_enabled) return res.status(400).json({ error: '该比赛当前不可预测' });
    if (new Date(match.match_time) <= new Date()) return res.status(400).json({ error: '比赛已开始，无法预测' });

    const winnerId = Number(req.body.predicted_winner_id);
    const s1 = Number(req.body.predicted_team1_score);
    const s2 = Number(req.body.predicted_team2_score);
    if (winnerId !== match.team1_id && winnerId !== match.team2_id) return res.status(400).json({ error: '无效的获胜队伍' });
    if (!isValidScore(s1, s2, match.format)) return res.status(400).json({ error: '无效比分' });
    const scoreWinner = s1 > s2 ? match.team1_id : match.team2_id;
    if (winnerId !== scoreWinner) return res.status(400).json({ error: '获胜队伍与比分不一致' });

    const existing = db.prepare('SELECT id FROM predictions WHERE user_id = ? AND match_id = ?').get(req.user.id, match.id);
    if (existing) {
        db.prepare('UPDATE predictions SET predicted_winner_id = ?, predicted_team1_score = ?, predicted_team2_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(winnerId, s1, s2, existing.id);
        return res.json({ message: '预测已更新' });
    }

    db.prepare('INSERT INTO predictions (user_id, match_id, predicted_winner_id, predicted_team1_score, predicted_team2_score) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, match.id, winnerId, s1, s2);
    res.status(201).json({ message: '预测已提交' });
});

module.exports = router;
