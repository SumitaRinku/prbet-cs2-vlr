// Pure graph/result helpers shared by the browser and Node regression tests.
(function (root) {
    'use strict';
    function result(match) {
        const number = value => value === null || value === undefined || value === '' ? null
            : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
        const scores = [number(match.team1_score), number(match.team2_score)];
        const finished = match.status === 'finished';
        let winner = 0;
        if (finished && match.winner_team_id != null) {
            if (match.team1_id != null && String(match.winner_team_id) === String(match.team1_id)) winner = 1;
            else if (match.team2_id != null && String(match.winner_team_id) === String(match.team2_id)) winner = 2;
        }
        if (finished && !winner && scores.every(score => score !== null) && scores[0] !== scores[1]) winner = scores[0] > scores[1] ? 1 : 2;
        return { finished, winner, scores };
    }

    function graph(matches, inputEdges = [], hint = () => null) {
        const byId = new Map(matches.map(match => [match.__official_id, match]));
        const diagnostics = { danglingEdges: 0, invalidEdges: 0, duplicateEdges: 0, cyclicNodes: 0 };
        const seen = new Set(), edges = [];
        for (const edge of inputEdges) {
            const from = edge.source_external_match_id, to = edge.match_external_id;
            if (!byId.has(from) || !byId.has(to)) { diagnostics.danglingEdges++; continue; }
            if (from === to || !['winner', 'loser'].includes(edge.source_type)) { diagnostics.invalidEdges++; continue; }
            const key = JSON.stringify([from, to, edge.source_type]);
            if (seen.has(key)) { diagnostics.duplicateEdges++; continue; }
            seen.add(key); edges.push(edge);
        }
        const hints = [...new Set(matches.map(hint).filter(Number.isFinite))].sort((a, b) => a - b);
        const hintRank = new Map(hints.map((value, index) => [value, index]));
        function rankEdges(validEdges) {
            const ranks = new Map(), depths = new Map(), incoming = new Map(), outgoing = new Map();
            for (const id of byId.keys()) { incoming.set(id, 0); outgoing.set(id, []); }
            for (const edge of validEdges) {
                incoming.set(edge.match_external_id, incoming.get(edge.match_external_id) + 1);
                outgoing.get(edge.source_external_match_id).push(edge.match_external_id);
            }
            const queue = [...byId.keys()].filter(id => incoming.get(id) === 0);
            for (const id of queue) {
                const semantic = hintRank.get(hint(byId.get(id))) ?? 0;
                ranks.set(id, Math.max(ranks.get(id) || 0, semantic));
                depths.set(id, depths.get(id) || 0);
                for (const target of outgoing.get(id)) {
                    ranks.set(target, Math.max(ranks.get(target) || 0, ranks.get(id) + 1));
                    depths.set(target, Math.max(depths.get(target) || 0, depths.get(id) + 1));
                    incoming.set(target, incoming.get(target) - 1);
                    if (incoming.get(target) === 0) queue.push(target);
                }
            }
            return { ranks, depths, blocked: new Set([...incoming].filter(([, count]) => count > 0).map(([id]) => id)) };
        }
        let validEdges = edges, ranked = rankEdges(edges);
        if (ranked.blocked.size) {
            diagnostics.cyclicNodes = ranked.blocked.size;
            // Preserve every card, but don't invent routes through an invalid component.
            validEdges = edges.filter(edge => !ranked.blocked.has(edge.source_external_match_id) && !ranked.blocked.has(edge.match_external_id));
            ranked = rankEdges(validEdges);
        }
        return { matches, edges: validEdges, ranks: ranked.ranks, depths: ranked.depths, diagnostics };
    }

    function layout(model, metrics, laneFor = () => 'main', compare = () => 0) {
        const { cardW, cardH, xGap, yGap, startX, startY } = metrics;
        const keys = [...new Set(model.ranks.values())].sort((a, b) => a - b);
        const columns = new Map(keys.map((key, index) => [key, index]));
        const lanes = new Map(), laneOrder = ['main', 'upper', 'lower', 'other'];
        const incoming = new Map();
        for (const edge of model.edges) {
            if (!incoming.has(edge.match_external_id)) incoming.set(edge.match_external_id, []);
            incoming.get(edge.match_external_id).push(edge.source_external_match_id);
        }
        for (const match of model.matches) {
            const lane = laneFor(match), column = columns.get(model.ranks.get(match.__official_id));
            if (!lanes.has(lane)) lanes.set(lane, new Map());
            const bucket = lanes.get(lane);
            if (!bucket.has(column)) bucket.set(column, []);
            bucket.get(column).push(match);
        }
        const bands = new Map(); let bottom = startY;
        for (const lane of laneOrder.filter(key => lanes.has(key))) {
            const count = Math.max(1, ...[...lanes.get(lane).values()].map(rows => rows.length));
            const height = count * (cardH + yGap) - yGap;
            bands.set(lane, { top: bottom, height }); bottom += height + 64;
        }
        const finalCenter = (startY + Math.max(startY + cardH, bottom - 64)) / 2;
        if (lanes.has('final')) bands.set('final', { top: Math.max(startY, finalCenter - cardH / 2), height: cardH });
        const positions = new Map();
        for (let column = 0; column < keys.length; column++) {
            for (const [lane, bucket] of lanes) {
                const band = bands.get(lane);
                const rows = (bucket.get(column) || []).map(match => {
                    const parents = (incoming.get(match.__official_id) || []).map(id => positions.get(id)).filter(Boolean);
                    const sameLane = parents.filter(parent => parent.lane === lane);
                    const anchors = lane === 'final' ? parents : sameLane;
                    const y = anchors.length ? anchors.reduce((sum, parent) => sum + parent.y, 0) / anchors.length : null;
                    return { match, desired: y === null ? null : Math.max(band.top, y) };
                }).sort((a, b) => (a.desired ?? Infinity) - (b.desired ?? Infinity) || compare(a.match, b.match));
                let cursor = band.top;
                for (const [index, item] of rows.entries()) {
                    const lastAvailable = band.top + Math.max(band.height, rows.length * (cardH + yGap) - yGap) - cardH - (rows.length - index - 1) * (cardH + yGap);
                    const y = Math.min(Math.max(cursor, item.desired ?? cursor), lastAvailable);
                    positions.set(item.match.__official_id, { x: startX + column * (cardW + xGap), y, lane });
                    cursor = y + cardH + yGap;
                }
            }
        }
        const cardBottom = Math.max(startY, ...[...positions.values()].map(position => position.y + cardH));
        // Prefer a monotone elbow across empty columns; reserve the outer rail for real obstacles.
        function clearRoute(points) {
            return points.slice(1).every(([x2, y2], index) => {
                const [x1, y1] = points[index];
                return [...positions.values()].every(card => x1 === x2
                    ? !(x1 > card.x && x1 < card.x + cardW && Math.max(y1, y2) > card.y && Math.min(y1, y2) < card.y + cardH)
                    : !(y1 > card.y && y1 < card.y + cardH && Math.max(x1, x2) > card.x && Math.min(x1, x2) < card.x + cardW));
            });
        }
        let rail = 0;
        const lines = model.edges.map(edge => {
            const source = positions.get(edge.source_external_match_id), target = positions.get(edge.match_external_id);
            const x1 = source.x + cardW, x2 = target.x;
            const y1 = source.y + cardH / 2, y2 = target.y + cardH / 2;
            // Route along the target column's gutter, keeping long edges clear of intervening cards.
            const gutter = x2 - Math.max(10, xGap / (edge.source_type === 'loser' ? 3 : 2));
            const targetElbow = [[x1, y1], [gutter, y1], [gutter, y2], [x2, y2]];
            const sourceGutter = x1 + xGap / 2;
            const sourceElbow = [[x1, y1], [sourceGutter, y1], [sourceGutter, y2], [x2, y2]];
            let d;
            if (clearRoute(targetElbow)) d = `M${x1},${y1} H${gutter} V${y2} H${x2}`;
            else if (clearRoute(sourceElbow)) d = `M${x1},${y1} H${sourceGutter} V${y2} H${x2}`;
            else {
                const routeY = cardBottom + 12 + rail++ * 5;
                d = `M${x1},${y1} H${x1 + 8} V${routeY} H${gutter} V${y2} H${x2}`;
            }
            return { ...edge, d };
        });
        return {
            positions, lines, bands,
            columns: keys.map((key, index) => ({ x: startX + index * (cardW + xGap), matches: model.matches.filter(match => model.ranks.get(match.__official_id) === key) })),
            width: Math.max(cardW + startX * 2, keys.length * (cardW + xGap) - xGap + startX * 2),
            height: Math.max(180, cardBottom + 28 + rail * 5)
        };
    }
    function scrollState(starts, left, width, contentWidth, cardWidth = 180) {
        const columns = [...new Set(starts.filter(Number.isFinite))].sort((a, b) => a - b);
        const max = Math.max(0, contentWidth - width);
        const position = Math.max(0, Math.min(max, left));
        const visibleFirst = columns.findIndex((x, i) => x + (Array.isArray(cardWidth) ? cardWidth[i] ?? 180 : cardWidth) > position + 2);
        const first = visibleFirst < 0 ? Math.max(0, columns.length - 1) : visibleFirst;
        let last = first;
        columns.forEach((x, i) => { if (x < position + width - 2) last = i; });
        return { overflow: max > 2, previous: position > 2, next: position < max - 2,
            first, last: Math.max(first, last), total: columns.length, left: position, max };
    }
    // Monotone horizontal projection preserves existing orthogonal routes and vertical alignment.
    function columnProjection(columns, collapsed, compactWidth = 72) {
        const ordered = [...columns].sort((a, b) => a.x - b.x);
        return x => {
            let shift = 0;
            for (const column of ordered) {
                if (!collapsed.has(column.x)) continue;
                const width = Math.min(compactWidth, column.width);
                if (x <= column.x) break;
                if (x < column.x + column.width) return column.x - shift + (x - column.x) * width / column.width;
                shift += column.width - width;
            }
            return x - shift;
        };
    }
    function autoCollapsedColumns(columns, width, available, manual = new Map(), compactWidth = 72) {
        const collapsed = new Set(columns.filter(column => manual.get(column.x) === true).map(column => column.x));
        let remaining = width - columns.filter(column => collapsed.has(column.x)).reduce((sum, column) => sum + Math.max(0, column.width - compactWidth), 0);
        const candidates = columns.filter(column => !manual.has(column.x)).sort((a, b) => a.priority - b.priority || a.x - b.x);
        for (const column of candidates) {
            if (remaining <= available + 1) break;
            collapsed.add(column.x);
            remaining -= Math.max(0, column.width - compactWidth);
        }
        return collapsed;
    }
    const api = { result, graph, layout, scrollState, columnProjection, autoCollapsedColumns };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.BracketGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
