const assert = require('node:assert/strict');
const test = require('node:test');

const { calculatePoints, isValidScore, maxScore, possibleScores } = require('../server/utils/scoring');

// match/prediction 工厂：默认 BO3、team1 以 2-1 获胜
function match(overrides = {}) {
    return {
        status: 'finished',
        is_forfeit: 0,
        format: 'BO3',
        team1_id: 1,
        team2_id: 2,
        team1_score: 2,
        team2_score: 1,
        winner_team_id: 1,
        ...overrides
    };
}

function prediction(overrides = {}) {
    return {
        predicted_winner_id: 1,
        predicted_team1_score: 2,
        predicted_team2_score: 1,
        ...overrides
    };
}

test('exact score earns maxScore, winner-only earns 1, wrong winner earns 0', () => {
    assert.equal(calculatePoints(prediction(), match()), 2);
    assert.equal(calculatePoints(prediction({ predicted_team1_score: 2, predicted_team2_score: 0 }), match()), 1);
    assert.equal(calculatePoints(prediction({ predicted_winner_id: 2 }), match()), 0);
});

test('maxScore follows format: BO1=1, BO3=2, BO5=3', () => {
    assert.equal(maxScore('BO1'), 1);
    assert.equal(maxScore('BO3'), 2);
    assert.equal(maxScore('BO5'), 3);
    assert.equal(calculatePoints(prediction({ predicted_team1_score: 3, predicted_team2_score: 2 }), match({ format: 'BO5', team1_score: 3, team2_score: 2 })), 3);
    assert.equal(calculatePoints(prediction({ predicted_team1_score: 1, predicted_team2_score: 0 }), match({ format: 'BO1', team1_score: 1, team2_score: 0 })), 1);
});

test('winner_team_id is authoritative even when scores disagree', () => {
    // 比分 2-1 偏向 team1，但胜者记录为 team2：以胜者为准
    const m = match({ winner_team_id: 2 });
    assert.equal(calculatePoints(prediction({ predicted_winner_id: 2 }), m), 2);
    assert.equal(calculatePoints(prediction(), m), 0);
});

test('missing winner falls back to score comparison; ties/missing scores stay unsettled', () => {
    assert.equal(calculatePoints(prediction(), match({ winner_team_id: null })), 2);
    assert.equal(calculatePoints(prediction({ predicted_winner_id: 2 }), match({ winner_team_id: null, team1_score: 1, team2_score: 2 })), 1);
    assert.equal(calculatePoints(prediction(), match({ winner_team_id: null, team1_score: 1, team2_score: 1 })), null);
    assert.equal(calculatePoints(prediction(), match({ winner_team_id: null, team1_score: null, team2_score: null })), null);
});

test('forfeit matches score 0 for everyone; unfinished matches stay unsettled', () => {
    assert.equal(calculatePoints(prediction(), match({ is_forfeit: 1, team1_score: 1, team2_score: 0 })), 0);
    assert.equal(calculatePoints(prediction(), match({ status: 'ongoing' })), null);
    assert.equal(calculatePoints(prediction(), match({ status: 'upcoming' })), null);
});

test('team order swap flips positional score comparison (remap is required on swap)', () => {
    // 预测 A(1) 2-1 胜；队伍对调后 A 是 team2、实际 1-2。
    // 若不同步对调 predicted_team1/2_score，精确加分将错判为基础分。
    const swapped = match({ team1_id: 2, team2_id: 1, team1_score: 1, team2_score: 2 });
    assert.equal(calculatePoints(prediction(), swapped), 1);
    // 对调后的正确存储形态：predicted_team1_score=1, predicted_team2_score=2
    assert.equal(calculatePoints(prediction({ predicted_team1_score: 1, predicted_team2_score: 2 }), swapped), 2);
});

test('isValidScore enforces format-legitimate results', () => {
    assert.equal(isValidScore(2, 0, 'BO3'), true);
    assert.equal(isValidScore(2, 1, 'BO3'), true);
    assert.equal(isValidScore(1, 0, 'BO1'), true);
    assert.equal(isValidScore(3, 2, 'BO5'), true);
    // 平局、超胜场、未达胜场、非整数、负数均非法
    assert.equal(isValidScore(1, 1, 'BO3'), false);
    assert.equal(isValidScore(3, 0, 'BO3'), false);
    assert.equal(isValidScore(2, 0, 'BO5'), false);
    assert.equal(isValidScore(2.5, 1, 'BO3'), false);
    assert.equal(isValidScore(-1, 0, 'BO3'), false);
    assert.equal(isValidScore(2, 0, 'BO1'), false);
});

test('possibleScores covers exactly the legal results of each format', () => {
    for (const format of ['BO1', 'BO3', 'BO5']) {
        const scores = possibleScores(format);
        for (const [a, b] of scores) {
            assert.equal(isValidScore(a, b, format), true, `${a}-${b} should be valid ${format}`);
        }
        // 合法比分总数 = 胜方 2..N 的组合 ×2（BO1 为 1-0/0-1）
        assert.equal(scores.length, format === 'BO1' ? 2 : format === 'BO5' ? 6 : 4);
    }
});
