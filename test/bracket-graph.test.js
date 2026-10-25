const test = require('node:test');
const assert = require('node:assert/strict');
const { graph, layout, result, scrollState, columnProjection, autoCollapsedColumns } = require('../public/js/bracket-graph');
const { buildTournamentStagesWithOfficial, stageDiagram, bracketTeamState } = require('../public/js/bracket');
global.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
global.logoHtml = () => '';
const metrics = { cardW: 188, cardH: 68, xGap: 44, yGap: 24, startX: 16, startY: 48 };
const node = (id, name, extra = {}) => ({ id, external_id: `cs2:${id}`, __official_id: `cs2:${id}`,
    stage_external_id: '1', name, status: 'upcoming', team1_name: `Alpha ${id}`, team2_name: 'Beta', ...extra });
const edge = (from, to, type = 'winner') => ({ source_external_match_id: `cs2:${from}`, match_external_id: `cs2:${to}`, source_type: type });
const official = (nodes, edges = []) => ({ external_id: '1', name: 'Playoffs', has_bracket: 1,
    nodes: nodes.map(n => ({ external_match_id: n.external_id, local_match_id: n.id, name: n.name, status: n.status,
        team1_name: n.team1_name, team2_name: n.team2_name })), edges });

test('folding multiple columns preserves gutters and connection anchors without accumulating drift', () => {
    const columns = [{ x: 16, width: 176 }, { x: 228, width: 176 }, { x: 440, width: 176 }];
    const project = columnProjection(columns, new Set([16, 228]));
    assert.equal(project(16), 16);
    assert.equal(project(192), 88);
    assert.equal(project(228), 124);
    assert.equal(project(404), 196);
    assert.equal(project(440), 232);
    assert.equal(project(210) - project(192), 18);
    const coordinates = [0, 16, 100, 192, 210, 228, 404, 440, 616, 640];
    assert.deepEqual(coordinates.map(columnProjection(columns, new Set())), coordinates);
    assert.ok(coordinates.every((x, i) => !i || project(x) > project(coordinates[i - 1])));
    const visible = scrollState([16, 124, 336], 210, 200, 600, [72, 176, 176]);
    assert.equal(visible.first, 1, 'a partly visible expanded column must remain in the visible-round range');
});

test('dependencies take precedence over conflicting or missing round names', () => {
    const matches = [node(1, 'Round 1'), node(2, 'Unlabelled'), node(3, 'Final')];
    const model = graph(matches, [edge(1, 2), edge(2, 3)], m => m.id === 1 ? 1 : m.id === 3 ? 90 : null);
    const view = layout(model, metrics);
    assert.ok(view.positions.get('cs2:1').x < view.positions.get('cs2:2').x);
    assert.ok(view.positions.get('cs2:2').x < view.positions.get('cs2:3').x);
    assert.equal(view.lines.length, 2);
});

test('automatic folding prefers completed and TBD columns, respects manual expansion and restores on wide screens', () => {
    const columns = [
        { x: 16, width: 176, priority: 3 }, // live
        { x: 228, width: 176, priority: 0 }, // completed
        { x: 440, width: 176, priority: 1 }, // TBD
        { x: 652, width: 176, priority: 2 } // upcoming
    ];
    assert.deepEqual([...autoCollapsedColumns(columns, 844, 700)], [228, 440]);
    assert.deepEqual([...autoCollapsedColumns(columns, 844, 500)], [228, 440, 652, 16]);
    const manual = new Map([[228, false]]);
    assert.deepEqual([...autoCollapsedColumns(columns, 844, 700, manual)], [440, 652]);
    assert.equal(autoCollapsedColumns(columns, 844, 900).size, 0);
    assert.deepEqual([...autoCollapsedColumns(columns, 844, 900, new Map([[228, true]]))], [228]);
});

test('invalid graph components are reported without dropping cards or looping', () => {
    const matches = [node(1, 'A'), node(2, 'B'), node(3, 'C')];
    const model = graph(matches, [edge(1, 2), edge(1, 2), edge(2, 1), edge(2, 3), edge(99, 1), edge(1, 1), edge(1, 3, 'bad')]);
    assert.equal(model.diagnostics.danglingEdges, 1);
    assert.equal(model.diagnostics.duplicateEdges, 1);
    assert.equal(model.diagnostics.invalidEdges, 2);
    assert.equal(model.diagnostics.cyclicNodes, 3);
    const view = layout(model, metrics);
    assert.equal(view.positions.size, 3);
    assert.equal(view.lines.length, 0);
    assert.ok([...view.positions.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('double elimination marks losing teams with a down arrow and draws only winner connections', () => {
    const matches = [node(1, 'Upper bracket round 1'), node(2, 'Upper bracket final'),
        node(3, 'Lower bracket round 1'), node(4, 'Lower bracket final'), node(5, 'Grand final')];
    const edges = [edge(1, 2), edge(1, 3, 'loser'), edge(2, 4, 'loser'), edge(3, 4), edge(2, 5), edge(4, 5)];
    Object.assign(matches[0], { status: 'finished', team1_id: 10, team2_id: 20, winner_team_id: 10, team1_score: 2, team2_score: 0 });
    const stage = buildTournamentStagesWithOfficial(matches, [official(matches, edges)])[0];
    const html = stageDiagram(stage);
    assert.equal(stage.type, 'official-double');
    assert.equal((html.match(/class="bracket-edge /g) || []).length, edges.filter(e => e.source_type === 'winner').length);
    assert.doesNotMatch(html, /class="bracket-edge loser"/);
    assert.equal((html.match(/class="bracket-drop" title=/g) || []).length, 1);
    assert.match(html, /pb2-team loser[\s\S]*?<strong><i class="bracket-drop"[^>]*>↓<\/i>0<\/strong>/);
    assert.equal((html.match(/class="official-canvas"/g) || []).length, 1);
});

test('upper finalist crosses empty later columns directly to the grand final', () => {
    const matches = [node(1, 'Upper final'), node(2, 'Lower round 1'), node(3, 'Lower semi'), node(4, 'Lower final'), node(5, 'Grand final')];
    const model = graph(matches, [edge(1, 5), edge(2, 3), edge(3, 4), edge(4, 5)]);
    for (const cardW of [156, 176]) {
        const view = layout(model, { ...metrics, cardW, cardH: 60 }, m => m.id === 1 ? 'upper' : m.id === 5 ? 'final' : 'lower');
        const line = view.lines.find(e => e.source_external_match_id === 'cs2:1');
        const source = view.positions.get('cs2:1'), target = view.positions.get('cs2:5');
        assert.ok(target.x > source.x + 2 * cardW);
        const verticals = [...line.d.matchAll(/V(-?[\d.]+)/g)].map(m => Number(m[1]));
        assert.deepEqual(verticals, [target.y + 30], 'empty upper corridor must not detour below the lower bracket');
    }
});

test('partial official snapshots retain all local cards and signal missing relations', () => {
    const matches = [node(1, 'Semifinal'), node(2, 'Final')];
    const stage = buildTournamentStagesWithOfficial(matches, [official(matches.slice(0, 1))])[0];
    assert.equal(stage.officialMatches.length, 2);
    const html = stageDiagram(stage);
    assert.ok(html.includes('Alpha 1') && html.includes('Alpha 2'));
    assert.match(html, /部分晋级关系待确认/);
    assert.match(html, /bracket-unlinked/);
    assert.equal((html.match(/data-bracket-match=/g) || []).length, 2);
});

test('missing finished results remain neutral and never become a fabricated zero score', () => {
    const n = node(1, 'Final', { status: 'finished' });
    const stage = buildTournamentStagesWithOfficial([], [official([n])])[0];
    const html = stageDiagram(stage);
    assert.match(html, /赛果待更新/);
    assert.equal((html.match(/<strong>—<\/strong>/g) || []).length, 2);
    assert.doesNotMatch(html, /pb2-team loser|pb2-team winner/);
    assert.equal(bracketTeamState(n, 1).tone, 'pending');
});

test('authoritative winners agree across the card, scores and Swiss result helpers', () => {
    const m = node(1, 'Final', { status: 'finished', team1_id: 10, team2_id: 20, winner_team_id: 20, team1_score: 2, team2_score: 1 });
    assert.equal(result(m).winner, 2);
    assert.equal(bracketTeamState(m, 2).tone, 'winner');
    assert.equal(bracketTeamState(m, 1).tone, 'loser');
    assert.deepEqual(result({ ...m, winner_team_id: null, team1_score: null, team2_score: null }).scores, [null, null]);
    assert.equal(result({ ...m, status: 'upcoming' }).winner, 0);
});

test('layout remains collision-free across compact and desktop metrics with byes and mixed lanes', () => {
    const matches = Array.from({ length: 7 }, (_, i) => node(i + 1, `Match ${i + 1}`));
    const edges = [edge(1, 3), edge(2, 3), edge(1, 4, 'loser'), edge(2, 4, 'loser'), edge(3, 5, 'loser'), edge(4, 5), edge(3, 7), edge(5, 6), edge(6, 7)];
    const model = graph(matches, edges);
    for (const cardW of [164, 188]) {
        const view = layout(model, { ...metrics, cardW }, m => m.id <= 3 ? 'upper' : m.id === 7 ? 'final' : 'lower');
        assert.equal(view.lines.length, edges.length);
        const positions = [...view.positions.values()];
        for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
            const x = Math.abs(positions[a].x - positions[b].x), y = Math.abs(positions[a].y - positions[b].y);
            assert.ok(x >= cardW || y >= metrics.cardH, 'cards must not overlap');
        }
        for (const e of edges) assert.ok(view.positions.get(e.source_external_match_id).x < view.positions.get(e.match_external_id).x);
        // Orthogonal connections must stay in the gutters, including long bye/cross-lane edges.
        for (const line of view.lines) {
            let x = 0, y = 0;
            for (const token of line.d.matchAll(/([MHV])(-?[\d.]+)(?:,(-?[\d.]+))?/g)) {
                const nextX = token[1] === 'V' ? x : Number(token[2]);
                const nextY = token[1] === 'H' ? y : Number(token[1] === 'M' ? token[3] : token[2]);
                if (token[1] !== 'M') for (const card of positions) {
                    const crosses = x === nextX
                        ? x > card.x && x < card.x + cardW && Math.max(y, nextY) > card.y && Math.min(y, nextY) < card.y + metrics.cardH
                        : y > card.y && y < card.y + metrics.cardH && Math.max(x, nextX) > card.x && Math.min(x, nextX) < card.x + cardW;
                    assert.ok(!crosses, 'connection must not pass through a card');
                }
                x = nextX; y = nextY;
            }
        }
    }
});

test('Swiss stages retain all rounds when official edges are also available', () => {
    const matches = [8, 8, 8, 6, 3].flatMap((count, r) => Array.from({ length: count }, (_, i) =>
        node(r * 100 + i + 1, `Round ${r + 1}: TBD vs TBD`, { stage_name: 'Swiss Stage', team1_name: 'TBD', team2_name: 'TBD' })));
    const stage = buildTournamentStagesWithOfficial(matches, [{ ...official(matches, [edge(1, 101)]), name: 'Swiss Stage' }])[0];
    assert.equal(stage.type, 'swiss-stage');
    assert.deepEqual(stage.groups.map(group => group.matches.length), [8, 8, 8, 6, 3]);
});

test('narrow screen navigation reports visible rounds and disables arrows at each edge', () => {
    const starts = [16, 212, 408];
    const first = scrollState(starts, 0, 358, 596, 164);
    assert.equal(first.overflow, true);
    assert.equal(first.previous, false); assert.equal(first.next, true);
    assert.deepEqual([first.first, first.last, first.total], [0, 1, 3]);
    const last = scrollState(starts, 238, 358, 596, 164);
    assert.equal(last.previous, true); assert.equal(last.next, false);
    assert.deepEqual([last.first, last.last], [1, 2]);
    const fits = scrollState(starts, 0, 900, 596, 164);
    assert.equal(fits.overflow, false);
    assert.equal(fits.previous, false); assert.equal(fits.next, false);
    assert.equal(scrollState([], -10, 0, 0).total, 0);
});

test('Swiss cards expose confirmed scores, winning side and named qualification results', () => {
    const matches = [1, 2, 3].map(round => node(round, `Round ${round}`, {
        status: 'finished', team1_id: 10, team2_id: 20 + round, winner_team_id: 10,
        team1_name: 'Alpha', team2_name: `Beta ${round}`, team1_score: 2, team2_score: 0
    }));
    const groups = matches.map((m, index) => ({ round: index + 1, label: `Round ${index + 1}`, matches: [m] }));
    groups.push({ round: 4, label: 'Round 4', matches: [node(4, 'Round 4', { team1_name: 'TBD', team2_name: 'TBD' })] });
    const html = stageDiagram({ type: 'swiss-stage', label: 'Swiss', groups });
    assert.match(html, /bracket-swiss/);
    assert.doesNotMatch(html, /data-swiss-detail|详细视图/);
    assert.match(html, /aria-label="Alpha 2:0 Beta 1"/);
    assert.equal((html.match(/class="sw2-vs scored">2:0/g) || []).length, 3);
    assert.match(html, /3:0 晋级/);
    assert.match(html, /sw2-result-team" title="Alpha"[^>]*>.*?<b>Alpha<\/b>/s);
    const corrected = { ...matches[0], winner_team_id: 21 };
    const correctedHtml = stageDiagram({ type: 'swiss-stage', label: 'Swiss', groups: [{ round: 1, label: 'Round 1', matches: [corrected] }] });
    assert.match(correctedHtml, /sw2-side winner[^>]*>.*?<b>Beta 1<\/b>/s);
    const unknown = { ...matches[0], team1_score: null, team2_score: null, winner_team_id: null };
    const unknownHtml = stageDiagram({ type: 'swiss-stage', label: 'Swiss', groups: [{ round: 1, label: 'Round 1', matches: [unknown] }] });
    assert.doesNotMatch(unknownHtml, /sw2-vs scored|sw2-side winner/);
});
