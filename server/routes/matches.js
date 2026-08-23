const express = require('express');
const db = require('../config/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const { isValidScore, possibleScores } = require('../utils/scoring');

const router = express.Router();
const HOME_FINISHED_DAYS = 1;
const HOME_PHASE_SQL = `CASE
    WHEN m.status = 'finished' THEN 'finished'
    WHEN m.status = 'ongoing' OR (m.status = 'upcoming' AND datetime(m.match_time) <= datetime('now')) THEN 'ongoing'
    ELSE 'upcoming'
END`;

// 排除含 TBD 占位队的未定对局（方案1：首页/列表只显示可参与的比赛，
// 完整赛制结构由赛事详情页的赛程图展示）。占位队来自 pandascore 且 name='TBD'。
const NOT_TBD = "t1.name <> 'TBD' AND t2.name <> 'TBD'";

function isTbdMatch(match) {
    return db.prepare("SELECT 1 FROM teams WHERE id IN (?, ?) AND name = 'TBD' LIMIT 1").get(match.team1_id, match.team2_id);
}

function matchSelect(where = '1=1') {
    return `
        SELECT m.*, tour.name tournament_name, tour.game_type, tour.logo_url tournament_logo_url,
            t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url,
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
    const status = ['finished', 'ongoing', 'upcoming'].includes(req.query.status) ? req.query.status : '';
    const cutoff = new Date(Date.now() - HOME_FINISHED_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const baseParams = [cutoff];
    let baseWhere = `(m.status IN ('upcoming', 'ongoing') OR (m.status = 'finished' AND datetime(m.match_time) >= datetime(?))) AND tour.is_active = 1 AND ${NOT_TBD}`;
    if (game_type) {
        baseWhere += ' AND tour.game_type = ?';
        baseParams.push(game_type);
    }

    const statusCountWhere = tournament_id ? `${baseWhere} AND m.tournament_id = ?` : baseWhere;
    const statusCountParams = tournament_id ? [...baseParams, tournament_id] : [...baseParams];
    const statusRows = db.prepare(`
        SELECT ${HOME_PHASE_SQL} phase, COUNT(*) count
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE ${statusCountWhere}
        GROUP BY phase
    `).all(...statusCountParams);

    // 赛事导航保持稳定，不随状态筛选隐藏；每个赛事上的数量表示首页时间窗口内的总场次。
    const tournamentWhere = baseWhere;
    const tournamentParams = [...baseParams];
    const tournaments = db.prepare(`
        SELECT tour.id, tour.name, tour.game_type, tour.logo_url,
            COUNT(*) match_count,
            SUM(CASE WHEN ${HOME_PHASE_SQL} = 'finished' THEN 1 ELSE 0 END) finished_count,
            SUM(CASE WHEN ${HOME_PHASE_SQL} = 'ongoing' THEN 1 ELSE 0 END) ongoing_count,
            SUM(CASE WHEN ${HOME_PHASE_SQL} = 'upcoming' THEN 1 ELSE 0 END) upcoming_count,
            SUM(CASE WHEN ${HOME_PHASE_SQL} != 'finished' THEN 1 ELSE 0 END) unfinished_count,
            MIN(CASE WHEN ${HOME_PHASE_SQL} != 'finished' THEN datetime(m.match_time) END) next_match_time,
            MAX(datetime(m.match_time)) last_match_time
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE ${tournamentWhere}
        GROUP BY tour.id
        ORDER BY CASE WHEN ongoing_count > 0 THEN 0 WHEN upcoming_count > 0 THEN 1 ELSE 2 END,
            next_match_time ASC, last_match_time DESC, tour.name COLLATE NOCASE ASC
    `).all(...tournamentParams);

    const params = [...baseParams];
    let where = baseWhere;
    if (tournament_id) {
        where += ' AND m.tournament_id = ?';
        params.push(tournament_id);
    }
    if (status) {
        where += ` AND ${HOME_PHASE_SQL} = ?`;
        params.push(status);
    }
    const matches = db.prepare(`${matchSelect(where)} ORDER BY
        CASE ${HOME_PHASE_SQL} WHEN 'ongoing' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
        CASE WHEN ${HOME_PHASE_SQL} = 'finished' THEN datetime(m.match_time) END DESC,
        CASE WHEN ${HOME_PHASE_SQL} != 'finished' THEN datetime(m.match_time) END ASC
        LIMIT 200`).all(...params);
    for (const match of matches) {
        match.display_status = match.status === 'finished'
            ? 'finished'
            : (match.status === 'ongoing' || new Date(match.match_time) <= new Date() ? 'ongoing' : 'upcoming');
    }
    if (req.user) {
        const predictions = db.prepare('SELECT * FROM predictions WHERE user_id = ?').all(req.user.id);
        const map = new Map(predictions.map(prediction => [prediction.match_id, prediction]));
        for (const match of matches) match.user_prediction = map.get(match.id) || null;
    }
    const counts = { finished: 0, ongoing: 0, upcoming: 0 };
    for (const row of statusRows) counts[row.phase] = row.count;
    res.json({
        matches,
        filters: {
            status_counts: { ...counts, all: counts.finished + counts.ongoing + counts.upcoming },
            tournaments,
            finished_window_days: HOME_FINISHED_DAYS
        }
    });
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

// 取消预测：开赛前可撤销已提交的预测。
router.delete('/:id/predictions', authenticateToken, (req, res) => {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
    if (!match) return res.status(404).json({ error: '比赛不存在' });
    if (match.status !== 'upcoming') return res.status(400).json({ error: '比赛已开始或已结束，无法取消预测' });
    if (new Date(match.match_time) <= new Date()) return res.status(400).json({ error: '比赛已开始，无法取消预测' });
    const result = db.prepare('DELETE FROM predictions WHERE user_id = ? AND match_id = ?').run(req.user.id, match.id);
    if (result.changes === 0) return res.status(404).json({ error: '你尚未对该比赛做出预测' });
    res.json({ message: '预测已取消' });
});

// 对阵历史 / 双方近期战绩：比赛详情弹窗展示两队近况与交手记录。
router.get('/:id/head2head', (req, res) => {
    const match = db.prepare(matchSelect('m.id = ?')).get(req.params.id);
    if (!match) return res.status(404).json({ error: '比赛不存在' });

    const recentFor = (teamId) => db.prepare(`
        SELECT m.team1_id, m.team2_id, m.team1_score, m.team2_score, m.winner_team_id, m.match_time,
            t1.short_name team1_short_name, t1.name team1_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url,
            t2.short_name team2_short_name, t2.name team2_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url,
            tour.id tournament_id, tour.name tournament_name
        FROM matches m
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE m.status = 'finished' AND m.is_forfeit = 0 AND m.id != ?
            AND (m.team1_id = ? OR m.team2_id = ?)
        ORDER BY m.match_time DESC
        LIMIT 10
    `).all(match.id, teamId, teamId).map(row => {
        const isTeam1 = row.team1_id === teamId;
        return {
            match_time: row.match_time,
            tournament_id: row.tournament_id,
            tournament_name: row.tournament_name,
            opponent_id: isTeam1 ? row.team2_id : row.team1_id,
            opponent: isTeam1 ? (row.team2_short_name || row.team2_name) : (row.team1_short_name || row.team1_name),
            opponent_logo_url: isTeam1 ? row.team2_logo_url : row.team1_logo_url,
            opponent_dark_logo_url: isTeam1 ? row.team2_dark_logo_url : row.team1_dark_logo_url,
            result: row.winner_team_id === teamId ? 'W' : 'L',
            score: isTeam1 ? `${row.team1_score}-${row.team2_score}` : `${row.team2_score}-${row.team1_score}`
        };
    });

    const recordOf = (recent) => {
        const wins = recent.filter(r => r.result === 'W').length;
        const losses = recent.filter(r => r.result === 'L').length;
        return { wins, losses, label: `${wins}W-${losses}L`, recent };
    };

    const h2hRows = db.prepare(`
        SELECT m.team1_id, m.team2_id, m.team1_score, m.team2_score, m.winner_team_id, m.match_time,
            tour.name tournament_name
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE m.status = 'finished' AND m.is_forfeit = 0 AND m.id != ?
            AND ((m.team1_id = ? AND m.team2_id = ?) OR (m.team1_id = ? AND m.team2_id = ?))
        ORDER BY m.match_time DESC
        LIMIT 10
    `).all(match.id, match.team1_id, match.team2_id, match.team2_id, match.team1_id);

    const headToHead = h2hRows.map(row => {
        const team1AtHome = row.team1_id === match.team1_id;
        return {
            team1_score: team1AtHome ? row.team1_score : row.team2_score,
            team2_score: team1AtHome ? row.team2_score : row.team1_score,
            winner: row.winner_team_id === match.team1_id ? 'team1' : (row.winner_team_id === match.team2_id ? 'team2' : null),
            match_time: row.match_time,
            tournament_name: row.tournament_name
        };
    });

    res.json({
        match: {
            id: match.id,
            team1_id: match.team1_id,
            team2_id: match.team2_id,
            team1_name: match.team1_short_name || match.team1_name,
            team2_name: match.team2_short_name || match.team2_name,
            team1_logo_url: match.team1_logo_url,
            team1_dark_logo_url: match.team1_dark_logo_url,
            team2_logo_url: match.team2_logo_url,
            team2_dark_logo_url: match.team2_dark_logo_url,
            match_time: match.match_time,
            format: match.format
        },
        team1: recordOf(recentFor(match.team1_id)),
        team2: recordOf(recentFor(match.team2_id)),
        head_to_head: headToHead
    });
});

module.exports = router;
