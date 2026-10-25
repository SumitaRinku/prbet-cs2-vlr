const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const express = require('express');
const { parseBracketPayload } = require('../server/services/bracketModel');

// 用内存库加载指定模块，避免测试触碰真实 data/database.sqlite。
function loadModule(relative, db) {
    const filename = path.resolve(__dirname, '..', relative);
    const module = { exports: {} };
    const nativeRequire = createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module,
        __dirname: path.dirname(filename),
        Buffer,
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        process: { env: { ADMIN_PASSWORD: 'test-password-only' } },
        console: { log() {}, warn() {}, error() {} },
        require(name) {
            if (['./database', '../config/database'].includes(name)) return db;
            if (name === '../utils/settlement') return { settleMatch() {}, recalculateUserScores() {} };
            if (name === '../services/settings') return { getPreviewDays: () => 180 };
            return nativeRequire(name);
        }
    }, { filename });
    return module.exports;
}

function fixture() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const init = loadModule('server/config/init-db.js', db);
    init.ensureDatabase();
    db.exec(`
        INSERT INTO tournaments(id, name, game_type, is_active) VALUES(1, 'PGL Masters', 'cs2', 1);
        INSERT INTO teams(id, name, game_type) VALUES(1, 'Alpha', 'cs2'), (2, 'Beta', 'cs2');
        INSERT INTO matches(id, tournament_id, team1_id, team2_id, format, match_time,
            status, external_source, external_id, stage_name, stage_slug, stage_external_id)
        VALUES(1, 1, 1, 2, 'BO3', '2026-10-29T08:00:00Z', 'upcoming', 'pandascore', 'cs2:1753690',
            'Playoffs', 'pgl-playoffs', '22228');
    `);
    init.ensureDatabase();
    return { db, init };
}

test('parseBracketPayload converts official bracket payload to nodes and edges', () => {
    const rows = [
        {
            id: 10,
            name: 'Grand final: A vs B',
            status: 'not_started',
            scheduled_at: '2026-10-31T11:00:00Z',
            opponents: [
                { opponent: { id: 1, name: 'Alpha', acronym: 'AL', image_url: 'https://cdn/alpha.png' } },
                { opponent: { id: 2, name: 'Beta', slug: 'beta' } }
            ],
            previous_matches: [
                { type: 'winner', match_id: 8 },
                { type: 'winner', match_id: 9 },
                { type: 'winner', match_id: 8 }
            ]
        },
        {
            id: 9,
            name: 'Lower final: TBD vs TBD',
            status: 'not_started',
            opponents: [],
            previous_matches: [{ type: 'loser', match_id: 7 }, { type: 'decider', match_id: 6 }]
        }
    ];

    const { nodes, edges } = parseBracketPayload(rows, 'valorant');

    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].external_match_id, 'valorant:10');
    assert.equal(nodes[0].panda_match_id, '10');
    assert.equal(nodes[0].position, 0);
    assert.equal(nodes[0].scheduled_at, '2026-10-31T11:00:00.000Z');
    assert.equal(nodes[0].team1_name, 'Alpha');
    assert.equal(nodes[0].team1_short_name, 'AL');
    assert.equal(nodes[0].team1_logo_url, 'https://cdn/alpha.png');
    assert.equal(nodes[0].team2_short_name, 'beta');
    assert.equal(nodes[1].team1_name, null);

    // 重复 previous_matches 去重；decider 等非 winner/loser 类型忽略。
    assert.deepEqual(edges.map(edge => `${edge.match_external_id}|${edge.source_external_match_id}|${edge.source_type}`).sort(), [
        'valorant:10|valorant:8|winner',
        'valorant:10|valorant:9|winner',
        'valorant:9|valorant:7|loser'
    ]);
});

test('migration creates bracket tables and backfills existing stages', () => {
    const { db, init } = fixture();
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
        for (const table of ['tournament_stages', 'bracket_nodes', 'bracket_edges']) {
            assert.ok(tables.includes(table), `${table} 应存在`);
        }

        const stage = db.prepare('SELECT * FROM tournament_stages WHERE external_source = ? AND external_id = ?')
            .get('pandascore', '22228');
        assert.equal(stage.tournament_id, 1);
        assert.equal(stage.name, 'Playoffs');
        assert.equal(stage.slug, 'pgl-playoffs');
        assert.equal(stage.has_bracket, 0);

        // 幂等：重复迁移不会产生重复阶段
        init.ensureDatabase();
        assert.equal(db.prepare('SELECT COUNT(*) count FROM tournament_stages WHERE external_id = ?').get('22228').count, 1);
    } finally {
        db.close();
    }
});

function fakeResponse(data) {
    return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        json: async () => data,
        text: async () => JSON.stringify(data)
    };
}

function loadPandascoreService(db, fetchImpl) {
    const filename = path.resolve(__dirname, '../server/services/pandascoreService.js');
    const module = { exports: {} };
    const nativeRequire = createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module,
        __dirname: path.dirname(filename),
        Buffer,
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        fetch: fetchImpl,
        process: {
            env: {
                PANDASCORE_API_TOKEN: 'test-token',
                PANDASCORE_BRACKET_SYNC_ENABLED: 'true'
            }
        },
        console: { log() {}, warn() {}, error() {} },
        require(name) {
            if (['./database', '../config/database'].includes(name)) return db;
            if (name === '../utils/settlement') return { settleMatch() {}, recalculateUserScores() {} };
            if (name === './settings') return { getPreviewDays: () => 180 };
            return nativeRequire(name);
        }
    }, { filename });
    return module.exports;
}

test('match sync also fetches and stores official bracket nodes and edges', async () => {
    const { db } = fixture();
    db.prepare(`UPDATE tournaments SET external_source = 'pandascore', external_id = 'cs2:11118',
        name = 'PGL Masters 2026', is_active = 1 WHERE id = 1`).run();

    const matchRow = {
        id: 1753690,
        name: 'Grand final: TBD vs TBD',
        status: 'not_started',
        number_of_games: 3,
        scheduled_at: '2026-10-31T11:00:00Z',
        opponents: [],
        // has_bracket=false 也必须抓取：Week 2 等真实阶段虽然标记 false，但仍有 previous_matches。
        tournament: { id: 22228, name: 'Playoffs', slug: 'pgl-playoffs', has_bracket: false },
        serie: { id: 11118, full_name: '2026', begin_at: '2026-10-20T00:00:00Z', end_at: '2026-11-01T00:00:00Z' },
        league: { id: 5442, name: 'PGL Masters', image_url: null }
    };
    const bracketRows = [
        {
            id: 1753690,
            name: 'Grand final: TBD vs TBD',
            status: 'not_started',
            scheduled_at: '2026-10-31T11:00:00Z',
            opponents: [],
            previous_matches: [
                { type: 'winner', match_id: 1753686 },
                { type: 'winner', match_id: 1753687 }
            ]
        },
        { id: 1753686, name: 'Semifinal 1: TBD vs TBD', status: 'not_started', previous_matches: [] }
    ];
    const fetchImpl = async url => {
        const pathname = new URL(url).pathname;
        if (pathname === '/csgo/matches') return fakeResponse([matchRow]);
        if (pathname === '/valorant/matches') return fakeResponse([]);
        if (pathname === '/tournaments/22228/brackets') return fakeResponse(bracketRows);
        throw new Error(`unexpected url ${url}`);
    };

    const service = loadPandascoreService(db, fetchImpl);
    const result = await service.syncPandascoreMatches('test');

    assert.equal(result.brackets_synced, 1);
    assert.equal(result.brackets_failed, 0);
    const stage = db.prepare('SELECT * FROM tournament_stages WHERE external_id = ?').get('22228');
    assert.equal(stage.has_bracket, 0);
    assert.ok(stage.bracket_synced_at);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM bracket_nodes WHERE stage_id = ?').get(stage.id).count, 2);
    assert.deepEqual(
        db.prepare('SELECT source_type FROM bracket_edges WHERE stage_id = ? ORDER BY source_external_match_id').all(stage.id).map(row => row.source_type),
        ['winner', 'winner']
    );
    db.close();
});

test('brackets API returns stages with nodes, edges and local match links', async () => {
    const { db } = fixture();
    const stageId = db.prepare('SELECT id FROM tournament_stages WHERE external_id = ?').get('22228').id;
    db.prepare(`UPDATE tournament_stages SET has_bracket = 1, bracket_synced_at = '2026-10-24T12:00:00.000Z' WHERE id = ?`).run(stageId);
    db.prepare(`INSERT INTO bracket_nodes
        (stage_id, external_match_id, panda_match_id, name, status, scheduled_at, position, team1_name, team2_name)
        VALUES(?, 'cs2:1753690', '1753690', 'Grand final: TBD vs TBD', 'not_started', '2026-10-31T11:00:00Z', 0, 'TBD', 'TBD'),
              (?, 'cs2:1753686', '1753686', 'Semifinal 1: A vs B', 'finished', '2026-10-30T11:00:00Z', 1, 'Alpha', 'Beta')`)
        .run(stageId, stageId);
    db.prepare(`INSERT INTO bracket_edges (stage_id, match_external_id, source_external_match_id, source_type)
        VALUES(?, 'cs2:1753690', 'cs2:1753686', 'winner')`).run(stageId);

    const router = loadModule('server/routes/tournaments.js', db);
    const app = express();
    app.use('/api/tournaments', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tournaments/1/brackets`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.tournament.id, 1);
        assert.equal(body.stages.length, 1);
        assert.equal(body.stages[0].has_bracket, 1);
        assert.equal(body.stages[0].nodes.length, 2);
        // 本地比赛 external_id = cs2:1753690，应能被节点关联到
        assert.equal(body.stages[0].nodes[0].local_match_id, 1);
        assert.equal(body.stages[0].nodes[1].local_match_id, null);
        assert.deepEqual(body.stages[0].edges, [{
            match_external_id: 'cs2:1753690',
            source_external_match_id: 'cs2:1753686',
            source_type: 'winner'
        }]);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
});
