function maxScore(format) {
    return format === 'BO5' ? 3 : 2;
}

function isValidScore(team1Score, team2Score, format) {
    const a = Number(team1Score);
    const b = Number(team2Score);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) {
        return false;
    }

    const winsNeeded = format === 'BO1' ? 1 : format === 'BO5' ? 3 : 2;
    return Math.max(a, b) === winsNeeded && Math.min(a, b) < winsNeeded;
}

function calculatePoints(prediction, match) {
    if (match.status !== 'finished') {
        return null;
    }

    // 弃权局按 1-0 记录但不计入积分：所有预测一律 0 分（已结算、不挂起）。
    if (match.is_forfeit) {
        return 0;
    }

    // 胜者以 winner_team_id 为准；缺失时才回退到比分比较，平局不判胜者
    let actualWinner = match.winner_team_id ?? null;
    if (actualWinner === null) {
        if (match.team1_score === null || match.team2_score === null || match.team1_score === match.team2_score) {
            return null;
        }
        actualWinner = match.team1_score > match.team2_score ? match.team1_id : match.team2_id;
    }

    if (prediction.predicted_winner_id !== actualWinner) {
        return 0;
    }

    // 只有在双方比分都已知且预测完全一致时才给满分，否则给基础分
    if (match.team1_score !== null && match.team2_score !== null
        && prediction.predicted_team1_score === match.team1_score
        && prediction.predicted_team2_score === match.team2_score) {
        return maxScore(match.format);
    }

    return 1;
}

function possibleScores(format) {
    if (format === 'BO1') return [[1, 0], [0, 1]];
    if (format === 'BO5') return [[3, 0], [3, 1], [3, 2], [0, 3], [1, 3], [2, 3]];
    return [[2, 0], [2, 1], [0, 2], [1, 2]];
}

module.exports = { maxScore, isValidScore, calculatePoints, possibleScores };
