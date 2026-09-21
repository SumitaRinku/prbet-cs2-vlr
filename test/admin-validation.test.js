const assert = require('node:assert/strict');
const test = require('node:test');
const { validateMatchInput, validateMatchReferences } = require('../server/utils/matchValidation');
const { recordPredictionHistory } = require('../server/utils/predictionHistory');

test('match input validation rejects invalid format and dates', () => {
    assert.equal(validateMatchInput({ tournament_id: 1, team1_id: 2, team2_id: 3, format: 'BO7', match_time: '2026-01-01' }, { requireTime: true }), '赛制无效');
    assert.equal(validateMatchInput({ tournament_id: 1, team1_id: 2, team2_id: 3, format: 'BO3', match_time: 'bad-date' }, { requireTime: true }), '比赛时间格式无效');
});

test('match reference validation enforces same game and existing teams', () => {
    const rows = {
        tournaments: [{ id: 1, game_type: 'cs2' }],
        teams: [{ id: 2, game_type: 'cs2' }, { id: 3, game_type: 'valorant' }]
    };
    const fakeDb = { prepare(sql) { return { get(id) {
        if (sql.includes('FROM tournaments')) return rows.tournaments.find(row => row.id === Number(id));
        return rows.teams.find(row => row.id === Number(id));
    } }; } };
    assert.equal(validateMatchReferences(fakeDb, { tournament_id: 1, team1_id: 2, team2_id: 3 }), '赛事与参赛队伍的游戏类型不一致');
    assert.equal(validateMatchReferences(fakeDb, { tournament_id: 1, team1_id: 2, team2_id: 99 }), '参赛队伍不存在');
});

test('prediction history records immutable snapshots', () => {
    let values;
    const fakeDb = { prepare() { return { run(...args) { values = args; } }; } };
    recordPredictionHistory(fakeDb, { id: 9, user_id: 1, match_id: 2, predicted_winner_id: 3, predicted_team1_score: 2, predicted_team2_score: 1 }, 'updated');
    assert.deepEqual(values, [9, 1, 2, 'updated', 3, 2, 1]);
});
