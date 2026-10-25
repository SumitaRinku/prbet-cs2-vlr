const assert = require('node:assert/strict');
const test = require('node:test');

const {
    bracketKind,
    bracketTeamState,
    buildBracketModel,
    buildTournamentStagesWithOfficial,
    detectSwiss16,
    doubleElimRounds,
    isGslGroupStage,
    looksLikeSwissStage,
    matchesByBracketKind,
    playoffGroupsFromMatches,
    playoffRoundLabel,
    roundGroupsFromMatches,
    stageDiagram,
    stageMatches,
    swissRoundBuckets
} = require('../public/js/bracket');

// stageDiagram 渲染时依赖宿主页提供的全局函数。
global.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
global.logoHtml = () => 'LOGO';
global.focusTournamentMatch = () => {};

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

function officialNode(matchRow) {
    return {
        external_match_id: `cs2:${matchRow.id}`,
        panda_match_id: String(matchRow.id),
        local_match_id: matchRow.id,
        name: matchRow.name,
        status: 'finished',
        scheduled_at: matchRow.match_time,
        position: 0,
        team1_name: matchRow.team1_name,
        team1_short_name: matchRow.team1_name,
        team2_name: matchRow.team2_name,
        team2_short_name: matchRow.team2_name
    };
}

function officialStage(externalId, name, matches, edges = [], hasBracket = 1) {
    return {
        external_id: String(externalId),
        name,
        has_bracket: hasBracket,
        nodes: matches.map(officialNode),
        edges
    };
}

test('Group Stage with Swiss rounds is recognized as Swiss instead of an empty group', () => {
    const counts = [8, 8, 8, 6, 3];
    const matches = counts.flatMap((count, roundIndex) => Array.from({ length: count }, (_, index) =>
        match(2000 + roundIndex * 100 + index, `Round ${roundIndex + 1}: A vs B`, 'Group Stage', 22222)));
    assert.equal(looksLikeSwissStage(matches, 'Group Stage'), true);
    assert.equal(looksLikeSwissStage([match(1, 'A vs B', 'Group A', 22265)], 'Group A'), false);

    const stages = buildTournamentStagesWithOfficial(matches, [officialStage(22222, 'Group Stage', matches, [], 0)], { gameType: 'cs2' });
    assert.equal(stages.length, 1);
    assert.equal(stages[0].type, 'swiss-stage');
    assert.deepEqual(stages[0].groups.map(group => group.matches.length), counts);
});

test('official edges drive single-elim, double-elim and GSL group stages', () => {
    const singles = [
        match(3001, 'Quarterfinal 1: A vs B', 'Playoffs', 22228),
        match(3002, 'Quarterfinal 2: C vs D', 'Playoffs', 22228),
        match(3003, 'Semifinal 1: A vs C', 'Playoffs', 22228),
        match(3004, 'Grand final: A vs D', 'Playoffs', 22228)
    ];
    const singleEdges = [
        { match_external_id: 'cs2:3003', source_external_match_id: 'cs2:3001', source_type: 'winner' },
        { match_external_id: 'cs2:3003', source_external_match_id: 'cs2:3002', source_type: 'winner' },
        { match_external_id: 'cs2:3004', source_external_match_id: 'cs2:3003', source_type: 'winner' }
    ];
    const single = buildTournamentStagesWithOfficial(singles, [officialStage(22228, 'Playoffs', singles, singleEdges)], { gameType: 'cs2' });
    assert.equal(single[0].type, 'official-single');
    assert.equal(single[0].officialMatches.length, 4);
    assert.equal(single[0].edges.length, 3);

    const upper = [
        match(3101, 'Upper bracket round 1 match 1: A vs B', 'Playoffs', 22229),
        match(3102, 'Upper bracket round 1 match 2: C vs D', 'Playoffs', 22229),
        match(3103, 'Upper bracket final: A vs C', 'Playoffs', 22229)
    ];
    const lower = [
        match(3111, 'Lower bracket round 1 match 1: B vs D', 'Playoffs', 22229),
        match(3112, 'Lower bracket final: B vs C', 'Playoffs', 22229)
    ];
    const grand = match(3121, 'Grand final: A vs B', 'Playoffs', 22229);
    const doubleMatches = [...upper, ...lower, grand];
    const doubleEdges = [
        { match_external_id: 'cs2:3103', source_external_match_id: 'cs2:3101', source_type: 'winner' },
        { match_external_id: 'cs2:3103', source_external_match_id: 'cs2:3102', source_type: 'winner' },
        { match_external_id: 'cs2:3111', source_external_match_id: 'cs2:3101', source_type: 'loser' },
        { match_external_id: 'cs2:3112', source_external_match_id: 'cs2:3111', source_type: 'winner' },
        { match_external_id: 'cs2:3121', source_external_match_id: 'cs2:3103', source_type: 'winner' },
        { match_external_id: 'cs2:3121', source_external_match_id: 'cs2:3112', source_type: 'winner' }
    ];
    const double = buildTournamentStagesWithOfficial(doubleMatches, [officialStage(22229, 'Playoffs', doubleMatches, doubleEdges)], { gameType: 'cs2' });
    assert.equal(double[0].type, 'official-double');

    // GSL 组：没有 Upper/Lower 与轮次名，edges 推导出 Round 1/2/3。
    const gsl = [
        match(3201, 'Opening 1: A vs B', 'Group 1', 21626, 0),
        match(3202, 'Opening 2: C vs D', 'Group 1', 21626, 0),
        match(3203, 'Winners match: A vs C', 'Group 1', 21626, 0),
        match(3204, 'Elimination match: B vs D', 'Group 1', 21626, 0),
        match(3205, 'Decider match: B vs C', 'Group 1', 21626, 0)
    ];
    const gslEdges = [
        { match_external_id: 'cs2:3203', source_external_match_id: 'cs2:3201', source_type: 'winner' },
        { match_external_id: 'cs2:3203', source_external_match_id: 'cs2:3202', source_type: 'winner' },
        { match_external_id: 'cs2:3204', source_external_match_id: 'cs2:3201', source_type: 'loser' },
        { match_external_id: 'cs2:3204', source_external_match_id: 'cs2:3202', source_type: 'loser' },
        { match_external_id: 'cs2:3205', source_external_match_id: 'cs2:3203', source_type: 'loser' },
        { match_external_id: 'cs2:3205', source_external_match_id: 'cs2:3204', source_type: 'winner' }
    ];
    const gslStage = buildTournamentStagesWithOfficial(gsl, [officialStage(21626, 'Group 1', gsl, gslEdges, 0)], { gameType: 'cs2' });
    assert.equal(gslStage[0].type, 'gsl-group');
});

test('Round of N ordering stays before quarter-finals', () => {
    assert.equal(playoffRoundLabel({ name: 'Round of 32 match 1' }).order, 30);
    assert.equal(playoffRoundLabel({ name: 'Round of 16 match 1' }).order, 40);
    assert.equal(playoffRoundLabel({ name: 'Quarterfinal 1' }).order, 70);
});

function tbdMatch(id, round) {
    return {
        ...match(id, `Round ${round}: TBD vs TBD`, 'Group Stage', 22222),
        status: 'upcoming',
        team1_name: 'TBD',
        team2_name: 'TBD'
    };
}

test('unplayed Swiss rounds are placed into skeleton buckets instead of an extra 0-0 bucket', () => {
    const counts = [8, 8, 8, 6, 3];
    const matches = counts.flatMap((count, roundIndex) =>
        Array.from({ length: count }, (_, index) => tbdMatch(4000 + roundIndex * 100 + index, roundIndex + 1)));
    const groups = roundGroupsFromMatches(matches);
    assert.equal(detectSwiss16(groups), true);

    const buckets = swissRoundBuckets(groups, true);
    assert.deepEqual(buckets.map(group => group.buckets.reduce((sum, bucket) => sum + bucket.matches.length, 0)), counts);
    assert.deepEqual(buckets[1].buckets.map(bucket => bucket.label), ['1-0组', '0-1组']);
    assert.deepEqual(buckets[2].buckets.map(bucket => bucket.label), ['2-0组', '1-1组', '0-2组']);
    assert.deepEqual(buckets[3].buckets.map(bucket => bucket.label), ['2-1组', '1-2组']);
    assert.deepEqual(buckets[4].buckets.map(bucket => bucket.label), ['2-2组']);
    // 只有 R1 允许出现 0-0 桶
    assert.equal(buckets.slice(1).some(group => group.buckets.some(bucket => bucket.label === '0-0组')), false);
});

test('Swiss stage uses official nodes to fill future rounds while metrics stay local', () => {
    const counts = [8, 8, 8, 6, 3];
    const all = counts.flatMap((count, roundIndex) =>
        Array.from({ length: count }, (_, index) => tbdMatch(5000 + roundIndex * 100 + index, roundIndex + 1)));
    const local = all.slice(0, 24);
    const stages = buildTournamentStagesWithOfficial(local, [officialStage(22222, 'Group Stage', all, [], 0)], { gameType: 'cs2' });
    const stage = stages[0];
    assert.equal(stage.type, 'swiss-stage');
    assert.deepEqual(stage.groups.map(group => group.matches.length), counts);
    assert.equal(stage.metricsMatches.length, 24);
});

test('GSL group is recognized from Winners/Elimination/Decider names even without edges', () => {
    const gsl = [
        match(3201, 'Opening 1: A vs B', 'Group 1', 21626, 0),
        match(3202, 'Opening 2: C vs D', 'Group 1', 21626, 0),
        match(3203, 'Winners match: A vs C', 'Group 1', 21626, 0),
        match(3204, 'Elimination match: B vs D', 'Group 1', 21626, 0),
        match(3205, 'Decider match: B vs C', 'Group 1', 21626, 0)
    ];
    assert.equal(isGslGroupStage(gsl), true);
    const stages = buildTournamentStagesWithOfficial(gsl, [officialStage(21626, 'Group 1', gsl, [], 0)], { gameType: 'cs2' });
    assert.equal(stages[0].type, 'gsl-group');
});

test('GSL diagram uses Opening / Winners-Elimination / Decider semantic columns', () => {
    const gsl = [
        match(3301, 'A vs B', 'Group 1', 21626, 0),
        match(3302, 'C vs D', 'Group 1', 21626, 0),
        match(3303, "Winners' match: A vs C", 'Group 1', 21626, 0),
        match(3304, 'Elimination match: B vs D', 'Group 1', 21626, 0),
        match(3305, 'Decider match: B vs C', 'Group 1', 21626, 0)
    ];
    const edges = [
        { match_external_id: 'cs2:3303', source_external_match_id: 'cs2:3301', source_type: 'winner' },
        { match_external_id: 'cs2:3303', source_external_match_id: 'cs2:3302', source_type: 'winner' },
        { match_external_id: 'cs2:3304', source_external_match_id: 'cs2:3301', source_type: 'loser' },
        { match_external_id: 'cs2:3304', source_external_match_id: 'cs2:3302', source_type: 'loser' },
        { match_external_id: 'cs2:3305', source_external_match_id: 'cs2:3303', source_type: 'loser' },
        { match_external_id: 'cs2:3305', source_external_match_id: 'cs2:3304', source_type: 'winner' }
    ];
    const stage = buildTournamentStagesWithOfficial(gsl, [officialStage(21626, 'Group 1', gsl, edges, 0)], { gameType: 'cs2' })[0];
    const html = stageDiagram(stage);
    assert.match(html, /Opening round/);
    assert.match(html, /Winners(?:&#39;|') match/);
    assert.match(html, /Elimination match/);
    assert.match(html, /Decider match/);
    // 仅绘制胜者晋级线，败者去向用比分旁箭头标识。
    assert.equal((html.match(/<path d="/g) || []).length, 3);
    assert.doesNotMatch(html, /class="bracket-edge loser"/);
});

test('third place match is separated from the Grand Final column', () => {
    const matches = [
        match(3401, 'Semifinal 1: A vs B', 'Playoffs', 22133),
        match(3402, 'Semifinal 2: C vs D', 'Playoffs', 22133),
        match(3403, 'Grand Final: A vs C', 'Playoffs', 22133),
        match(3404, '3rd Place Match: B vs D', 'Playoffs', 22133)
    ];
    const edges = [
        { match_external_id: 'cs2:3403', source_external_match_id: 'cs2:3401', source_type: 'winner' },
        { match_external_id: 'cs2:3403', source_external_match_id: 'cs2:3402', source_type: 'winner' },
        { match_external_id: 'cs2:3404', source_external_match_id: 'cs2:3401', source_type: 'loser' },
        { match_external_id: 'cs2:3404', source_external_match_id: 'cs2:3402', source_type: 'loser' }
    ];
    const stage = buildTournamentStagesWithOfficial(matches, [officialStage(22133, 'Playoffs', matches, edges, 0)], { gameType: 'cs2' })[0];
    const html = stageDiagram(stage);
    assert.match(html, /official-lane-label">3rd Place/);
    assert.match(html, /Semi-finals/);
    assert.match(html, /Grand final/);
    assert.equal((html.match(/official-final-slot/g) || []).length, 1);
    assert.equal((html.match(/pb2-title[^>]*>Finals</g) || []).length, 0);
    // Assert geometry rather than pinning a particular visual skin's pixel dimensions.
    const positions = [...html.matchAll(/data-bracket-match="cs2:(340[123])" style="left:(\d+)px;top:(\d+)px/g)];
    const y = new Map(positions.map(item => [item[1], Number(item[3])]));
    assert.equal(y.get('3403'), (y.get('3401') + y.get('3402')) / 2);
});
