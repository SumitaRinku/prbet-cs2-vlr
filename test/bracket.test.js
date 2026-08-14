const assert = require('node:assert/strict');
const test = require('node:test');

const {
    bracketKind,
    bracketTeamState,
    buildBracketModel,
    doubleElimRounds,
    matchesByBracketKind,
    playoffGroupsFromMatches,
    stageMatches
} = require('../public/js/bracket');

function match(id, name, stageName = 'Playoffs', stageExternalId = 1) {
    return {
        id,
        name,
        stage_name: stageName,
        stage_external_id: stageExternalId,
        match_time: `2026-01-${String((id % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
        status: 'finished',
        team1_name: `Team ${id}A`,
        team2_name: `Team ${id}B`
    };
}

function assertComplete(model, matches) {
    const ids = model.stages.flatMap(stage => stageMatches(stage)).map(item => item.id);
    assert.equal(model.diagnostics.inputCount, matches.length);
    assert.equal(model.diagnostics.renderedCount, matches.length);
    assert.equal(model.diagnostics.uniqueRenderedCount, matches.length);
    assert.equal(new Set(ids).size, matches.length);
}

test('Round of 16 remains Round of 16 instead of being inferred as semifinals', () => {
    const matches = Array.from({ length: 4 }, (_, index) => match(index + 1, `Round of 16 match ${index + 1}: TBD vs TBD`));
    const groups = playoffGroupsFromMatches(matches);
    assert.deepEqual(groups.map(group => group.label), ['Round of 16']);
    assert.equal(groups[0].matches.length, 4);
});

test('Lower Bracket Round 1 is recognized and retained', () => {
    const round = bracketKind(match(1, 'Lower Bracket Round 1 Match 1: A vs B'));
    assert.deepEqual(round, { side: 'lower', round: 1, label: 'Round 1', kind: 'lower-round-1' });

    const matches = [
        ...Array.from({ length: 4 }, (_, index) => match(10 + index, `Upper Bracket Quarterfinals ${index + 1}: A vs B`)),
        ...Array.from({ length: 2 }, (_, index) => match(20 + index, `Lower Bracket Round 1 Match ${index + 1}: A vs B`)),
        ...Array.from({ length: 2 }, (_, index) => match(30 + index, `Upper Bracket Semifinals ${index + 1}: A vs B`)),
        ...Array.from({ length: 2 }, (_, index) => match(40 + index, `Lower Bracket Quarterfinals ${index + 1}: A vs B`)),
        match(50, 'Upper Bracket Final: A vs B'),
        match(51, 'Lower Bracket Semifinal: A vs B'),
        match(52, 'Lower Bracket Final: A vs B'),
        match(53, 'Grand final: A vs B')
    ];
    const model = buildBracketModel(matches);
    assertComplete(model, matches);
    assert.equal(model.format, 'double-elimination');
    assert.ok(model.stages.flatMap(stage => stageMatches(stage)).some(item => item.name.includes('Lower Bracket Round 1')));
});

test('bracket rounds follow explicit match positions instead of API time order', () => {
    const matches = [
        match(1, 'Upper bracket quarterfinal 2: A vs B'),
        match(2, 'Upper bracket quarterfinal 4: C vs D'),
        match(3, 'Upper bracket quarterfinal 1: E vs F'),
        match(4, 'Upper bracket quarterfinal 3: G vs H')
    ];
    const rounds = doubleElimRounds(matchesByBracketKind(matches), 'upper');
    assert.deepEqual(rounds[0].matches.map(item => item.name.match(/quarterfinal (\d+)/i)[1]), ['1', '2', '3', '4']);
});

test('unfinished bracket teams stay fully visible and flow markers follow results', () => {
    const pending = match(90, 'Upper bracket semifinal 1: A vs B');
    pending.status = 'upcoming';
    assert.deepEqual(bracketTeamState(pending, 1, 'drop'), { finished: false, won: false, tone: 'pending', marker: null });

    const finished = match(91, 'Upper bracket quarterfinal 1: A vs B');
    finished.team1_score = 1;
    finished.team2_score = 0;
    assert.equal(bracketTeamState(finished, 2, 'drop').marker, 'drop');
    assert.equal(bracketTeamState(finished, 1, 'advance').marker, 'advance');
});

test('standard 33-match Swiss stage and 4-2-1 playoffs remain complete', () => {
    const counts = [8, 8, 8, 6, 3];
    const swiss = counts.flatMap((count, roundIndex) => Array.from({ length: count }, (_, index) =>
        match(roundIndex * 100 + index + 1, `Round ${roundIndex + 1}: A vs B`, 'Stage 1 Swiss', 101)));
    const playoffs = [
        ...Array.from({ length: 4 }, (_, index) => match(600 + index, `Quarterfinal ${index + 1}: A vs B`, 'Playoffs', 102)),
        ...Array.from({ length: 2 }, (_, index) => match(700 + index, `Semifinal ${index + 1}: A vs B`, 'Playoffs', 102)),
        match(800, 'Grand final: A vs B', 'Playoffs', 102)
    ];
    const matches = [...swiss, ...playoffs];
    const model = buildBracketModel(matches);
    assertComplete(model, matches);
    const swissStage = model.stages.find(stage => stage.type === 'swiss-stage');
    assert.ok(swissStage);
    assert.deepEqual(swissStage.groups.map(group => group.matches.length), counts);
    const playoffStage = model.stages.find(stage => stage.label === 'Playoffs');
    assert.deepEqual(playoffGroupsFromMatches(playoffStage.matches).map(group => group.matches.length), [4, 2, 1]);
});

test('VCT-style Swiss plus double elimination is separated by stage metadata', () => {
    const swiss = [
        ...Array.from({ length: 4 }, (_, index) => match(900 + index, 'Round 1: A vs B', 'Round 1', 0)),
        ...Array.from({ length: 4 }, (_, index) => match(910 + index, 'Round 2: A vs B', 'Round 2', 0)),
        ...Array.from({ length: 2 }, (_, index) => match(920 + index, 'Round 3: A vs B', 'Round 3', 0))
    ];
    const doubleElim = [
        ...Array.from({ length: 4 }, (_, index) => match(1000 + index, `Upper Bracket Quarterfinal ${index + 1}: A vs B`, 'Quarterfinals', 500)),
        ...Array.from({ length: 2 }, (_, index) => match(1010 + index, `Lower Bracket Round 1 Match ${index + 1}: A vs B`, 'Round 1', 500)),
        ...Array.from({ length: 2 }, (_, index) => match(1020 + index, `Upper Bracket Semifinal ${index + 1}: A vs B`, 'Semifinals', 500)),
        ...Array.from({ length: 2 }, (_, index) => match(1030 + index, `Lower Bracket Quarterfinal ${index + 1}: A vs B`, 'Quarterfinals', 500)),
        match(1040, 'Upper Bracket Final: A vs B', 'Finals', 500),
        match(1041, 'Lower Bracket Semifinal: A vs B', 'Semifinals', 500),
        match(1042, 'Lower Bracket Final: A vs B', 'Finals', 500),
        match(1043, 'Grand final: A vs B', 'Grand Final', 500)
    ];
    const matches = [...swiss, ...doubleElim];
    const model = buildBracketModel(matches);
    assertComplete(model, matches);
    assert.ok(model.stages.some(stage => stage.type === 'double-elim-bracket'));
    assert.ok(model.stages.some(stage => stage.type === 'swiss-stage'));
});
