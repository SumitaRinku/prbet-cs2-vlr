const db = require('../config/database');
const { calculatePoints } = require('./scoring');

// 连胜加成档位：连胜轮数达到阈值后，该轮每场预测的额外加分
function streakBonusPoints(streak) {
    if (streak >= 8) return 3;
    if (streak >= 5) return 2;
    if (streak >= 3) return 1;
    return 0;
}

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

// 依据 points_earned + streak_bonus 重建所有用户的 total_score。权威且幂等，
// 是唯一的总分来源，避免增量累加导致的漂移。
function recalculateUserScores() {
    db.prepare('UPDATE users SET total_score = 0').run();
    const scores = db.prepare(`
        SELECT user_id, SUM(COALESCE(points_earned, 0) + COALESCE(streak_bonus, 0)) total
        FROM predictions
        GROUP BY user_id
    `).all();
    const update = db.prepare('UPDATE users SET total_score = ? WHERE id = ?');
    for (const row of scores) update.run(row.total || 0, row.user_id);
}

// ===== 连胜机制 =====
// 范围：连胜在每个赛事内独立累计（赛事已绑定单一游戏，即"单游戏单赛事"）。
// 一轮：同一开赛时间（match_time 相同）的多场比赛为一轮，解决同时开赛的判定问题——
//   一轮内用户全部预测正确才 +1，任意猜错则清零。
// 跳过：轮内还有未结算预测时该轮暂不计入；弃权场不参与判定（既不清零也不累加）。
// 加成：连胜达到 3/5/8 轮起，该轮每场（非弃权）预测额外 +1/+2/+3 分，记入 streak_bonus。

// 内部：对按 match_time 排序的单用户单赛事预测行，按轮重算连胜并回写加成。
// 返回 { current, best, changed }。行结构：{ id?, points_earned, match_time, is_forfeit }
// id 缺失时仅计算不写库（供只读查询复用）。
function applyStreakRounds(rows) {
    // IS NOT 可正确处理 NULL（无加成 -> 有加成也算变化），与 settleMatch 同模式
    const update = db.prepare('UPDATE predictions SET streak_bonus = ? WHERE id = ? AND streak_bonus IS NOT ?');
    let changed = 0;
    const write = (row, bonus) => { if (row.id !== undefined) changed += update.run(bonus, row.id, bonus).changes; };
    let streak = 0;
    let best = 0;
    // 按 match_time 分轮（行已按时间排序）
    let index = 0;
    while (index < rows.length) {
        const time = rows[index].match_time;
        let end = index;
        while (end < rows.length && rows[end].match_time === time) end++;
        const group = rows.slice(index, end);
        index = end;

        if (!group.some(row => row.points_earned === null)) {
            const effective = group.filter(row => !row.is_forfeit);
            if (effective.length) {
                streak = effective.every(row => row.points_earned > 0) ? streak + 1 : 0;
                best = Math.max(best, streak);
                const bonus = streakBonusPoints(streak);
                for (const row of group) write(row, row.is_forfeit ? null : bonus);
                continue;
            }
        }
        // 未结算完的轮 / 全弃权轮：不参与连胜，加成清空（幂等重写）
        for (const row of group) write(row, null);
    }
    return { current: streak, best, changed };
}

// 重算某赛事内所有用户的连胜加成。幂等：结果只依赖当前已结算数据，
// 赛果修正后再次调用会得到一致的加成。返回 changed（加成变化的条数）。
function recalculateStreakBonuses(tournamentId) {
    const rows = db.prepare(`
        SELECT p.id, p.user_id, p.points_earned, m.match_time, m.is_forfeit
        FROM predictions p JOIN matches m ON m.id = p.match_id
        WHERE m.tournament_id = ?
        ORDER BY p.user_id, m.match_time ASC, p.id ASC
    `).all(tournamentId);
    let changed = 0;
    // 按用户分段依次处理（行已按 user_id 排序）
    let start = 0;
    while (start < rows.length) {
        let end = start;
        while (end < rows.length && rows[end].user_id === rows[start].user_id) end++;
        changed += applyStreakRounds(rows.slice(start, end));
        start = end;
    }
    return { changed };
}

// 查询用户在各赛事的连胜状态：当前连胜与历史最长
function getUserStreaks(userId) {
    const rows = db.prepare(`
        SELECT m.tournament_id, tour.name tournament_name, tour.game_type,
            p.points_earned, m.match_time, m.is_forfeit
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE p.user_id = ?
        ORDER BY m.tournament_id, m.match_time ASC, p.id ASC
    `).all(userId);
    const result = [];
    let start = 0;
    while (start < rows.length) {
        let end = start;
        while (end < rows.length && rows[end].tournament_id === rows[start].tournament_id) end++;
        // applyStreakRounds 只读入参的 points_earned/is_forfeit/match_time，
        // 这里传入的行没有 id 字段，UPDATE 不会命中任何行，仅用于计算
        const { current, best } = applyStreakRounds(rows.slice(start, end));
        result.push({ tournament_id: rows[start].tournament_id, tournament_name: rows[start].tournament_name, game_type: rows[start].game_type, current, best });
        start = end;
    }
    return result;
}

module.exports = { settleMatch, recalculateUserScores, recalculateStreakBonuses, getUserStreaks, streakBonusPoints };
