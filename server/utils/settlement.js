const db = require('../config/database');
const { calculatePoints } = require('./scoring');

// 重新计算某场已结束比赛全部预测的得分。幂等：重复调用结果一致，
// 因此赛果被修正后再次结算也能得到正确分数。
// 仅在分数实际变化时写库；返回 processed（处理条数）与 changed（变化条数），
// 调用方可据此跳过无谓的全量总分重建。
function settleMatch(matchId) {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match || match.status !== 'finished') return { processed: 0, changed: 0 };
    const predictions = db.prepare('SELECT * FROM predictions WHERE match_id = ?').all(matchId);
    // IS NOT 可正确处理 NULL（未结算 -> 有分数也算变化）
    const update = db.prepare('UPDATE predictions SET points_earned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND points_earned IS NOT ?');
    let changed = 0;
    for (const prediction of predictions) {
        const points = calculatePoints(prediction, match);
        changed += update.run(points, prediction.id, points).changes;
    }
    return { processed: predictions.length, changed };
}

// 依据 points_earned 重建所有用户的 total_score。权威且幂等，
// 是唯一的总分来源，避免增量累加导致的漂移。
// 口径与排行榜一致：只统计活跃赛事下已结束比赛的积分（弃权局积分为 0，
// 天然不计入；赛事停用或比赛状态回退后，其历史积分自动从总分中剔除）。
function recalculateUserScores() {
    db.prepare('UPDATE users SET total_score = 0').run();
    const scores = db.prepare(`
        SELECT p.user_id, SUM(COALESCE(p.points_earned, 0)) total
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE m.status = 'finished' AND tour.is_active = 1
        GROUP BY p.user_id
    `).all();
    const update = db.prepare('UPDATE users SET total_score = ? WHERE id = ?');
    for (const row of scores) update.run(row.total || 0, row.user_id);
}

module.exports = { settleMatch, recalculateUserScores };
