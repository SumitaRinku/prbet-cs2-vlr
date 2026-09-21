const crypto = require('node:crypto');
const DAY = 86400000;
const OFFSET = 8 * 3600000; // Beijing has no DST.
const iso = ms => new Date(ms).toISOString();
const dateKey = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);
const midnight = ms => Date.parse(`${dateKey(ms)}T00:00:00+08:00`);
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const at = (day, time) => day + minutes(time) * 60000;
const label = ms => new Date(ms + OFFSET).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/');
const clean = value => String(value || '').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160);
const gameLabel = game => game === 'cs2' ? 'CS2' : 'Valorant';
const title = m => `${gameLabel(m.game_type)} · ${clean(m.tournament_short_name || m.tournament_name)}`;
const versus = m => `${clean(m.team1_name)} vs ${clean(m.team2_name)}`;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const snapshot = m => ({ id: m.id, match_time: m.match_time, team1_name: m.team1_name,
    team2_name: m.team2_name, status: m.status, game_type: m.game_type,
    tournament_name: m.tournament_name, time_confirmed: m.time_confirmed });
const isFixture = m => m.time_confirmed === 1 && !['cancelled', 'postponed'].includes(m.status);
const between = (m, start, end) => Date.parse(m.match_time) >= start && Date.parse(m.match_time) < end;

function bounds(now, config, day = midnight(now)) {
    const start = at(day, config.dayStart);
    return { day, start, end: start + DAY, previous: start - DAY };
}

function dailyDue(matches, day, config) {
    const normal = at(day, config.dailyTime);
    const early = matches.filter(m => isFixture(m) && between(m, at(day, config.dayStart), normal));
    return early.length ? Math.min(...early.map(m => Date.parse(m.match_time))) - config.earlyMinutes * 60000 : normal;
}

function freshness(feed, config, now) {
    const maxAge = config.freshnessMinutes * 60000;
    return config.games.filter(game => {
        const stamp = feed.sync.find(row => row.game_type === game)?.last_success_at;
        const age = now - Date.parse(stamp);
        return !Number.isFinite(age) || age < -60000 || age > maxAge;
    });
}

function splitMessage(text, max = 1200) {
    const parts = [];
    let current = '';
    for (const line of text.split('\n')) {
        // Also bound unusually long individual lines.
        for (let offset = 0; offset < Math.max(1, line.length); offset += max - 30) {
            const piece = line.slice(offset, offset + max - 30);
            if (current.length + piece.length + 1 > max - 30) { parts.push(current); current = ''; }
            current += (current ? '\n' : '') + piece;
        }
    }
    if (current) parts.push(current);
    return parts.length > 1 ? parts.map((part, i) => `（${i + 1}/${parts.length}）\n${part}`) : parts;
}

function fixtureLine(m, now, reportDay) {
    const time = Date.parse(m.match_time);
    const nextDay = reportDay !== undefined && midnight(time) > reportDay;
    const status = m.status === 'finished' ? ' · 已结束' : m.status === 'ongoing' ? ' · 进行中'
        : time <= now ? ' · 已过计划时间' : '';
    return `${nextDay ? '次日 ' : ''}${label(time)}  ${versus(m)} · ${m.format}${status}`;
}

function groupedFixtures(matches, now, day) {
    const groups = new Map();
    for (const m of matches) {
        const key = `${m.game_type}:${m.tournament_id}`;
        if (!groups.has(key)) groups.set(key, { name: title(m), matches: [] });
        groups.get(key).matches.push(m);
    }
    return [...groups.values()].flatMap(group => ['', group.name, ...group.matches.map(m => fixtureLine(m, now, day))]);
}

function previewLines(matches, start, end, now) {
    const future = matches.filter(m => isFixture(m) && m.status === 'upcoming' && between(m, start, end));
    if (!future.length) return ['未来七天暂无已公布赛程。'];
    const groups = new Map();
    for (const m of future) {
        if (!groups.has(m.tournament_id)) groups.set(m.tournament_id, []);
        groups.get(m.tournament_id).push(m);
    }
    return [...groups.values()].flatMap(rows => [
        '', title(rows[0]),
        ...rows.slice(0, 4).map(m => fixtureLine(m, now)),
        ...(rows.length > 4 ? [`其余 ${rows.length - 4} 场见网站`] : [])
    ]);
}

function dailyReport(feed, config, now, day = midnight(now)) {
    const matches = feed.matches.filter(m => config.games.includes(m.game_type))
        .sort((a, b) => Date.parse(a.match_time) - Date.parse(b.match_time) || a.id - b.id);
    const { start, end, previous } = bounds(now, config, day);
    const yesterday = matches.filter(m => between(m, previous, start));
    const finished = yesterday.filter(m => m.status === 'finished' && m.team1_score !== null && m.team2_score !== null);
    const pending = yesterday.filter(m => ['upcoming', 'ongoing'].includes(m.status)
        || (m.status === 'finished' && (m.team1_score === null || m.team2_score === null)));
    const lines = [`【赛事日报 · ${dateKey(day)}】`, '时间：北京时间', '',
        '昨日简报', `截至 ${label(now)}`];
    const resultGroups = new Map();
    for (const m of finished.slice(0, config.resultsLimit)) {
        const key = `${m.game_type}:${m.tournament_id}`;
        if (!resultGroups.has(key)) resultGroups.set(key, { name: title(m), matches: [] });
        resultGroups.get(key).matches.push(m);
    }
    for (const group of resultGroups.values()) {
        lines.push('', group.name);
        for (const m of group.matches) {
            lines.push(`${clean(m.team1_name)} ${m.team1_score}:${m.team2_score} ${clean(m.team2_name)}${m.is_forfeit ? '（弃权）' : ''}`);
        }
    }
    if (!finished.length) lines.push('暂无已确认赛果。');
    if (finished.length > config.resultsLimit) lines.push(`另有 ${finished.length - config.resultsLimit} 场赛果，详见网站。`);
    if (pending.length) lines.push(`${pending.length} 场尚未结束或赛果待更新。`);
    const cancelled = yesterday.filter(m => ['cancelled', 'postponed'].includes(m.status)).length;
    if (cancelled) lines.push(`${cancelled} 场取消或延期。`);
    const today = matches.filter(m => isFixture(m) && between(m, start, end));
    lines.push('', '今日赛程');
    if (today.length) lines.push(...groupedFixtures(today, now, day));
    else {
        lines.push('今日暂无已确认比赛，为你预告后续赛事：',
            ...previewLines(matches, end, now + 7 * DAY, now));
    }
    const unknown = matches.filter(m => m.time_confirmed !== 1 && m.status === 'upcoming' && between(m, start, end)).length;
    if (unknown) lines.push(`另有 ${unknown} 场开赛时间待确认，未列入定时赛程。`);
    lines.push('', '赛程以最新公告为准。', `${config.siteUrl}/tournaments.html`);
    return { text: lines.join('\n'), watched: today.filter(m => Date.parse(m.match_time) > now).map(snapshot) };
}

function plan(feed, config, now, watched = {}) {
    const matches = feed.matches.filter(m => config.games.includes(m.game_type));
    const jobs = [];
    // Check both calendar dates: a 06:00 match's report is due at 05:50.
    for (const day of [midnight(now), midnight(now) + DAY]) {
        const due = dailyDue(matches, day, config);
        if (now >= due && now <= due + 2 * 3600000) {
            jobs.push({ key: `daily:${dateKey(day)}`, kind: 'daily', expires: due + 2 * 3600000,
                ...dailyReport(feed, config, now, day) });
        }
    }
    for (const m of matches) {
        const time = Date.parse(m.match_time), remaining = time - now;
        const syncedAge = now - Date.parse(m.last_synced_at);
        const fresh = m.external_source !== 'pandascore' || (Number.isFinite(syncedAge) && syncedAge >= -60000 && syncedAge <= config.freshnessMinutes * 60000);
        if (config.reminderMinutes > 0 && isFixture(m) && m.status === 'upcoming' && fresh
            && remaining > 0 && remaining <= config.reminderMinutes * 60000
            && m.team1_name !== 'TBD' && m.team2_name !== 'TBD') {
            jobs.push({ key: `reminder:${m.id}:${iso(time)}`, kind: 'reminder', expires: time,
                watched: [snapshot(m)], text: [
                    `【即将开赛 · 约 ${Math.ceil(remaining / 60000)} 分钟后】`, title(m),
                    `${versus(m)} · ${m.format}`, `${label(time)}（北京时间）`,
                    ...(m.betting_enabled ? ['赛前可参与预测'] : []),
                    `${config.siteUrl}/tournaments.html?tournament=${m.tournament_id}`
                ].join('\n') });
        }
    }
    const day = midnight(now), weeklyDue = at(day, config.weeklyTime);
    if (config.weeklyEnabled && new Date(day + OFFSET).getUTCDay() === 0 && now >= weeklyDue && now <= weeklyDue + 2 * 3600000) {
        jobs.push({ key: `weekly:${dateKey(day)}`, kind: 'weekly', expires: weeklyDue + 2 * 3600000, watched: [],
            text: ['【未来七天赛事预告】', '北京时间 · 仅含目前已同步赛程',
                ...previewLines(matches, now, now + 7 * DAY, now), '', `${config.siteUrl}/tournaments.html`].join('\n') });
    }
    const byId = new Map(matches.map(m => [String(m.id), m]));
    for (const [id, old] of Object.entries(watched)) {
        const m = byId.get(id);
        if (!m && !feed.unavailable_ids.includes(id)) continue;
        const next = m ? snapshot(m) : { ...old, status: 'unavailable' };
        const changed = next.match_time !== old.match_time || next.team1_name !== old.team1_name
            || next.team2_name !== old.team2_name || next.time_confirmed !== old.time_confirmed
            || (['cancelled', 'postponed', 'unavailable'].includes(next.status) && next.status !== old.status);
        if (!changed) continue;
        const state = { cancelled: '已取消', postponed: '已延期', unavailable: '已下架或停止展示' }[next.status];
        jobs.push({ key: `change:${id}:${fingerprint(next)}`, kind: 'change', expires: now + 2 * 3600000,
            watched: [next], text: ['【赛程更新】', title(old), `${old.team1_name} vs ${old.team2_name}`,
                `原定：${label(Date.parse(old.match_time))}`,
                state || (next.time_confirmed !== 1 ? '开赛时间待确认' : `现为：${label(Date.parse(next.match_time))}  ${next.team1_name} vs ${next.team2_name}`),
                `${config.siteUrl}/tournaments.html`].join('\n') });
    }
    return jobs;
}

module.exports = { DAY, iso, dateKey, midnight, bounds, dailyDue, freshness, splitMessage, dailyReport, plan };
