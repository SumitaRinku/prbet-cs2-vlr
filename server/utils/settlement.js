const db = require('../config/database');
const { calculatePoints } = require('./scoring');

// 重新计算某场已结束比赛全部预测的得分。幂等：重复调用结果一致，
// 因此赛果被修正后再次结算也能得到正确分数。
function settleMatch(matchId) {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match || match.status !== 'finished') return 0;
    const predictions = db.prepare('SELECT * FROM predictions WHERE match_id = ?').all(matchId);
    const update = db.prepare('UPDATE predictions SET points_earned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const prediction of predictions) update.run(calculatePoints(prediction, match), prediction.id);
    return predictions.length;
}

// 依据 points_earned 重建所有用户的 total_score。权威且幂等，
// 是唯一的总分来源，避免增量累加导致的漂移。
function recalculateUserScores() {
    db.prepare('UPDATE users SET total_score = 0').run();
    const scores = db.prepare(`
        SELECT user_id, SUM(COALESCE(points_earned, 0)) total
        FROM predictions
        GROUP BY user_id
    `).all();
    const update = db.prepare('UPDATE users SET total_score = ? WHERE id = ?');
    for (const row of scores) update.run(row.total || 0, row.user_id);
}

module.exports = { settleMatch, recalculateUserScores };
