const test = require('node:test');
const assert = require('node:assert/strict');
const { tournamentStatus, sortTournaments } = require('../public/js/tournament-order');

const now = Date.parse('2026-10-27T12:00:00Z');

test('archive lists ongoing events first, then nearest upcoming and recently finished events', () => {
    const events = [
        { name: 'old major', effective_tier: 1, begin_at: '2026-06-01', end_at: '2026-06-20', match_count: 10, finished_count: 10 },
        { name: 'future later', begin_at: '2026-11-10', match_count: 5, finished_count: 0 },
        { name: 'recent', begin_at: '2026-10-01', end_at: '2026-10-25', match_count: 5, finished_count: 5 },
        { name: 'future soon', begin_at: '2026-11-01', match_count: 5, finished_count: 0 },
        { name: 'ongoing', begin_at: '2026-10-24', match_count: 5, finished_count: 3 }
    ];
    assert.deepEqual(sortTournaments(events, now).map(event => event.name),
        ['ongoing', 'future soon', 'future later', 'recent', 'old major']);
    assert.equal(events[0].name, 'old major');
});

test('sorting uses the same status as the card and puts missing dates last', () => {
    const live = { name: 'live', ongoing_count: 1, match_count: 2 };
    const unknown = { name: 'unknown', match_count: 0 };
    const upcoming = { name: 'upcoming', begin_at: '2026-11-01', match_count: 2 };
    assert.equal(tournamentStatus(live, now), 'ongoing');
    assert.equal(tournamentStatus({ match_count: 0, finished_count: 0 }, now), 'upcoming');
    assert.deepEqual(sortTournaments([unknown, upcoming, live], now).map(event => event.name), ['live', 'upcoming', 'unknown']);
});
