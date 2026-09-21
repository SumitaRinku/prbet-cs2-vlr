const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const Database = require('better-sqlite3');
const { dailyDue, dailyReport, freshness, plan, midnight, splitMessage } = require('../bot/core');
const { tick, loadState, saveState, sendMessage } = require('../bot/run');
const { createBotRouter } = require('../server/routes/bot');
const { ensureBotSchema } = require('../server/config/bot-schema');

const stamp = time => Date.parse(time);
const config = { siteUrl: 'https://example.test', groupIds: ['123456'], games: ['cs2', 'valorant'],
    dayStart: '06:00', dailyTime: '12:00', earlyMinutes: 10, reminderMinutes: 30,
    weeklyEnabled: true, weeklyTime: '20:00', resultsLimit: 12, freshnessMinutes: 20 };
const now = stamp('2026-09-22T12:00:00+08:00');
function match(id, time, extra = {}) {
    return { id, tournament_id: 1, tournament_name: 'Test Cup', game_type: 'cs2',
        match_time: new Date(stamp(time)).toISOString(), time_confirmed: 1,
        team1_name: 'Alpha', team2_name: 'Beta', status: 'upcoming', format: 'BO3',
        team1_score: null, team2_score: null, external_source: null, ...extra };
}
function feed(matches = [], at = now) {
    return { version: 1, generated_at: new Date(at).toISOString(), matches,
        sync: ['cs2', 'valorant'].map(game_type => ({ game_type, last_success_at: new Date(at).toISOString() })), unavailable_ids: [] };
}

test('early daily ignores predawn, includes 06:00, and keeps noon boundary', () => {
    const day = midnight(now);
    assert.equal(dailyDue([match(1, '2026-09-22T02:00:00+08:00')], day, config), now);
    assert.equal(dailyDue([match(1, '2026-09-22T09:00:00+08:00')], day, config), stamp('2026-09-22T08:50:00+08:00'));
    assert.equal(dailyDue([match(1, '2026-09-22T06:00:00+08:00')], day, config), stamp('2026-09-22T05:50:00+08:00'));
    assert.equal(dailyDue([match(1, '2026-09-22T12:00:00+08:00')], day, config), now);
    assert.equal(dailyDue([match(1, '2026-09-22T09:00:00+08:00', { time_confirmed: 0 })], day, config), now);
    assert.equal(dailyDue([match(1, '2026-09-22T09:00:00+08:00', { status: 'cancelled' })], day, config), now);
});

test('daily includes next predawn, excludes next 06:00, and reports yesterday scores', () => {
    const report = dailyReport(feed([
        match(1, '2026-09-21T06:00:00+08:00', { status: 'finished', team1_score: 2, team2_score: 1 }),
        match(2, '2026-09-22T05:59:00+08:00', { status: 'finished', team1_score: 1, team2_score: 0, is_forfeit: 1 }),
        match(3, '2026-09-22T18:00:00+08:00'),
        match(4, '2026-09-23T05:59:00+08:00'),
        match(5, '2026-09-23T06:00:00+08:00', { team1_name: 'TomorrowMorning' })
    ]), config, now);
    assert.match(report.text, /Alpha 2:1 Beta/);
    assert.match(report.text, /Alpha 1:0 Beta（弃权）/);
    assert.match(report.text, /次日 09\/23 05:59/);
    assert.doesNotMatch(report.text, /TomorrowMorning/);
    assert.deepEqual(report.watched.map(m => m.id), [3, 4]);
});

test('no current fixtures falls back to future and pending results are never invented', () => {
    const report = dailyReport(feed([
        match(1, '2026-09-21T18:00:00+08:00', { status: 'finished' }),
        match(2, '2026-09-24T18:00:00+08:00')
    ]), config, now).text;
    assert.match(report, /赛果待更新/);
    assert.match(report, /为你预告后续赛事/);
    assert.match(report, /09\/24 18:00/);
    assert.doesNotMatch(report, /null:null|0:0/);
});

test('only next predawn fixtures still generate today schedule', () => {
    const report = dailyReport(feed([match(1, '2026-09-23T02:00:00+08:00')]), config, now).text;
    assert.match(report, /次日 09\/23 02:00/);
    assert.doesNotMatch(report, /今日暂无/);
});

test('05:50 schedules the correct calendar report; stale past fixtures do not remind', () => {
    const early = stamp('2026-09-22T05:50:00+08:00');
    const jobs = plan(feed([match(1, '2026-09-22T06:00:00+08:00')], early), config, early);
    assert.ok(jobs.some(job => job.key === 'daily:2026-09-22'));
    const excluded = [match(1, '2026-09-22T11:00:00+08:00'),
        match(2, '2026-09-22T12:20:00+08:00', { team1_name: 'TBD' }),
        match(3, '2026-09-22T12:20:00+08:00', { status: 'postponed' })];
    assert.equal(plan(feed(excluded), config, now).filter(job => job.kind === 'reminder').length, 0);
});

test('per-game freshness rejects missing and stale games', () => {
    const data = feed();
    data.sync[1].last_success_at = '2026-09-01T00:00:00Z';
    assert.deepEqual(freshness(data, config, now), ['valorant']);
    assert.deepEqual(freshness({ sync: [] }, config, now), ['cs2', 'valorant']);
});

test('weekly forecast triggers on Sunday only and expires after two hours', () => {
    const sunday = stamp('2026-09-27T20:00:00+08:00');
    assert.ok(plan(feed([], sunday), config, sunday).some(job => job.kind === 'weekly'));
    const monday = stamp('2026-09-28T20:00:00+08:00');
    assert.ok(!plan(feed([], monday), config, monday).some(job => job.kind === 'weekly'));
    const late = stamp('2026-09-27T22:01:00+08:00');
    assert.ok(!plan(feed([], late), config, late).some(job => job.kind === 'weekly'));
});

test('reschedule and disappearance generate explicit corrections for notified matches', () => {
    const old = match(1, '2026-09-22T18:00:00+08:00');
    const moved = match(1, '2026-09-24T18:00:00+08:00');
    assert.match(plan(feed([moved]), config, now, { 1: old }).find(job => job.kind === 'change').text, /09\/24 18:00/);
    const removed = feed(); removed.unavailable_ids = ['1'];
    assert.match(plan(removed, config, now, { 1: old }).find(job => job.kind === 'change').text, /下架/);
});

test('message splitting bounds text and labels all parts', () => {
    const parts = splitMessage(('测试赛程\n').repeat(1000));
    assert.ok(parts.length > 1);
    assert.ok(parts.every(part => part.length <= 1200));
    assert.match(parts[0], /^（1\//);
});

test('worker persists daily across restart and will not repeat it at noon after early send', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prbet-bot-'));
    const file = path.join(dir, 'state.json');
    try {
        const early = stamp('2026-09-22T08:50:00+08:00');
        const matches = [match(1, '2026-09-22T09:00:00+08:00')];
        let sends = 0;
        const deps = { now: early, fetchFeed: async () => feed(matches, early),
            sendMessage: async () => { sends++; return { status: 'sent', messageId: '1' }; }, sleep: async () => {} };
        const cfg = { ...config, reminderMinutes: 0 };
        await tick(cfg, loadState(file), file, deps);
        await tick(cfg, loadState(file), file, deps);
        await tick(cfg, loadState(file), file, { ...deps, now, fetchFeed: async () => feed(matches) });
        assert.equal(sends, 1);
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('unknown delivery and crash during sending never retry automatically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prbet-bot-'));
    const file = path.join(dir, 'state.json');
    try {
        let sends = 0;
        const deps = { now, fetchFeed: async () => feed(),
            sendMessage: async () => { sends++; return { status: 'unknown', error: 'timeout' }; }, sleep: async () => {} };
        await tick(config, loadState(file), file, deps);
        await tick(config, loadState(file), file, deps);
        assert.equal(sends, 1);
        const state = loadState(file);
        Object.values(state.jobs)[0].parts[0].status = 'sending';
        saveState(file, state);
        assert.equal(Object.values(loadState(file).jobs)[0].parts[0].status, 'unknown');
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('stale feed never sends an empty-day claim', async () => {
    let sends = 0;
    await assert.rejects(tick(config, { jobs: {}, watched: {} }, 'unused', {
        now, fetchFeed: async () => ({ ...feed(), sync: [] }),
        sendMessage: async () => { sends++; }
    }), /暂停发送/);
    assert.equal(sends, 0);
});

async function serve(app, fn) {
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { await fn(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
}

test('OneBot send uses text segments and verifies retcode and message_id', async () => {
    const app = express(); app.use(express.json());
    let mode = 'ok';
    app.post('/send_group_msg', (req, res) => {
        assert.equal(req.get('authorization'), 'Bearer test-token');
        assert.equal(req.body.group_id, '123456');
        assert.deepEqual(req.body.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }]);
        res.json(mode === 'ok' ? { status: 'ok', retcode: 0, data: { message_id: 42 } }
            : mode === 'failed' ? { status: 'failed', retcode: 100 } : { status: 'ok', retcode: 0 });
    });
    await serve(app, async napcatUrl => {
        const cfg = { napcatUrl, napcatToken: 'test-token' };
        assert.deepEqual(await sendMessage(cfg, '123456', '[CQ:at,qq=all]'), { status: 'sent', messageId: '42' });
        mode = 'failed'; assert.equal((await sendMessage(cfg, '123456', '[CQ:at,qq=all]')).status, 'failed');
        mode = 'incomplete'; assert.equal((await sendMessage(cfg, '123456', '[CQ:at,qq=all]')).status, 'unknown');
    });
});

test('bot API authenticates, returns over 200 fixtures, filters disabled and returns watched IDs outside window', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE matches(id INTEGER PRIMARY KEY, tournament_id INTEGER, match_time TEXT, status TEXT,
        format TEXT, stage_name TEXT, betting_enabled INTEGER, is_forfeit INTEGER, team1_id INTEGER,
        team2_id INTEGER, team1_score INTEGER, team2_score INTEGER, winner_team_id INTEGER, external_source TEXT, last_synced_at TEXT);
        CREATE TABLE tournaments(id INTEGER PRIMARY KEY, name TEXT, short_name TEXT, game_type TEXT, is_active INTEGER);
        CREATE TABLE teams(id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO tournaments VALUES(1, 'Cup', NULL, 'cs2', 1), (2, 'Disabled', NULL, 'cs2', 0);
        INSERT INTO teams VALUES(1, 'Alpha'), (2, 'Beta');`);
    ensureBotSchema(db); ensureBotSchema(db);
    const insert = db.prepare(`INSERT INTO matches(id,tournament_id,match_time,team1_id,team2_id,status) VALUES(?,?,?,1,2,'upcoming')`);
    for (let id = 1; id <= 250; id++) insert.run(id, 1, '2026-09-22T18:00:00Z');
    insert.run(251, 2, '2026-09-22T18:00:00Z');
    insert.run(252, 1, '2026-10-20T18:00:00Z');
    let token = 'secret-token';
    const app = express(); app.use('/api/bot', createBotRouter(db, () => token));
    try {
        await serve(app, async base => {
            const url = `${base}/api/bot/schedule?from=2026-09-22T00:00:00Z&to=2026-09-23T00:00:00Z&ids=251,252,999`;
            assert.equal((await fetch(url)).status, 401);
            const headers = { Authorization: 'Bearer secret-token' };
            const response = await fetch(url, { headers });
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const data = await response.json();
            assert.equal(data.matches.length, 251);
            assert.deepEqual(data.unavailable_ids, ['251', '999']);
            assert.ok(data.matches.some(m => m.id === 252));
            assert.equal((await fetch(`${base}/api/bot/schedule?from=bad&to=bad`, { headers })).status, 400);
            token = ''; assert.equal((await fetch(url, { headers })).status, 503);
        });
    } finally { db.close(); }
});

test('real schema and sync insert/update confirm source times and isolate partial game failures', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const load = (relative, extra = {}) => {
        const filename = path.resolve(__dirname, '..', relative);
        const nativeRequire = createRequire(filename);
        const module = { exports: {} };
        const context = { module, console: { log() {}, error() {} }, URL, AbortController, setTimeout, clearTimeout,
            process: { env: { ADMIN_PASSWORD: 'test-only-password', PANDASCORE_API_TOKEN: 'test-only-token' } },
            require(name) {
                if (['./database', '../config/database'].includes(name)) return db;
                if (name === '../utils/settlement') return { settleMatch: () => ({ changed: false }), recalculateUserScores() {} };
                return nativeRequire(name);
            }, ...extra };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
        return module.exports;
    };
    try {
        const init = load('server/config/init-db.js'); init.ensureDatabase(); init.ensureDatabase();
        let sourceTime = '2026-09-22T10:00:00Z';
        let failValorant = false;
        const service = load('server/services/pandascoreService.js', { fetch: async url => {
            if (String(url).includes('/valorant/')) return failValorant
                ? { ok: false, status: 401, text: async () => 'test failure' }
                : { ok: true, json: async () => [] };
            return { ok: true, json: async () => [{ id: 123, status: 'not_started', scheduled_at: sourceTime,
                serie: { id: 4, full_name: '2026' }, league: { id: 3, name: 'Test Cup' },
                opponents: [{ opponent: { id: 1, name: 'Alpha' } }, { opponent: { id: 2, name: 'Beta' } }] }] };
        } });
        assert.equal((await service.syncPandascoreMatches('cli')).status, 'success');
        let row = db.prepare('SELECT * FROM matches').get();
        assert.equal(row.time_confirmed, 1);
        assert.equal(row.match_time, '2026-09-22T10:00:00.000Z');
        assert.equal(db.prepare('SELECT count(*) n FROM bot_sync_state').get().n, 2);
        sourceTime = null;
        failValorant = true;
        db.prepare("UPDATE bot_sync_state SET last_success_at = '2000-01-01T00:00:00Z' WHERE game_type = 'valorant'").run();
        assert.equal((await service.syncPandascoreMatches('cli')).status, 'partial');
        row = db.prepare('SELECT * FROM matches').get();
        assert.equal(row.time_confirmed, 0);
        assert.equal(db.prepare("SELECT last_success_at FROM bot_sync_state WHERE game_type='valorant'").get().last_success_at, '2000-01-01T00:00:00Z');
        sourceTime = '2026-09-22T11:00:00Z';
        await service.syncPandascoreMatches('cli');
        row = db.prepare('SELECT * FROM matches').get();
        assert.equal(row.time_confirmed, 1);
        assert.equal(row.match_time, '2026-09-22T11:00:00.000Z');
    } finally { db.close(); }
});
