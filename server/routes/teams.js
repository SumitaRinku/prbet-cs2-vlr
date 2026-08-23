const express = require('express');
const db = require('../config/database');

const router = express.Router();
const NOT_TBD = "t.name <> 'TBD'";

// 队伍列表排序白名单：聚合列别名（match_count/win_count 等）在 SQLite 中可用于 ORDER BY；
// 无比赛记录的队伍除"已赛最多/名称"外一律沉底。
const TEAM_SORTS = {
    recent: 'CASE WHEN match_count > 0 THEN 0 ELSE 1 END, last_match_time DESC, t.name COLLATE NOCASE ASC',
    win_rate: 'CASE WHEN match_count > 0 THEN 0 ELSE 1 END, CASE WHEN match_count > 0 THEN win_count * 100.0 / match_count ELSE 0 END DESC, win_count DESC, t.name COLLATE NOCASE ASC',
    wins: 'CASE WHEN match_count > 0 THEN 0 ELSE 1 END, win_count DESC, match_count ASC, t.name COLLATE NOCASE ASC',
    played: 'match_count DESC, last_match_time DESC, t.name COLLATE NOCASE ASC',
    name: 't.name COLLATE NOCASE ASC'
};

function parseLimit(value, fallback = 20, max = 100) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function placementForMatches(matches, teamId) {
    const clean = value => String(value || '').trim().toLowerCase();
    const stageLabel = match => `${clean(match.stage_name)} ${clean(match.stage_slug)} ${clean(match.match_name)}`;
    const final = matches.find(match => {
        const name = clean(match.match_name);
        const stage = clean(match.stage_name);
        const slug = clean(match.stage_slug);
        return /grand[-_ ]?final|总决赛/.test(`${name} ${stage} ${slug}`)
            || /^(final|finals|决赛)(:|\s|$)/.test(name)
            || (!name && /^(final|grand[-_ ]?final|总决赛)$/.test(stage || slug));
    });
    if (final) {
        return final.winner_team_id === teamId ? '冠军' : '亚军';
    }
    const semifinal = matches.some(match => /semi[-_ ]?final|半决赛/.test(stageLabel(match)));
    if (semifinal) return '四强';
    const quarterfinal = matches.some(match => /quarter[-_ ]?final|四分之一|八强/.test(stageLabel(match)));
    if (quarterfinal) return '八强';
    return matches.length ? '已参赛' : '待确认';
}

function teamSummary(row) {
    return {
        id: row.id,
        name: row.name,
        short_name: row.short_name,
        logo_url: row.logo_url,
        dark_logo_url: row.dark_logo_url || null,
        country: row.country,
        game_type: row.game_type,
        external_source: row.external_source
    };
}

router.get('/', (req, res) => {
    const { game_type, q } = req.query;
    const sort = TEAM_SORTS[req.query.sort] ? req.query.sort : 'recent';
    const activity = ['active', 'upcoming'].includes(req.query.activity) ? req.query.activity : '';
    const params = [];
    let where = `WHERE ${NOT_TBD}`;
    if (game_type && ['cs2', 'valorant'].includes(game_type)) {
        where += ' AND t.game_type = ?';
        params.push(game_type);
    }
    if (q) {
        where += ' AND (LOWER(t.name) LIKE ? OR LOWER(COALESCE(t.short_name, \'\')) LIKE ?)';
        const keyword = `%${String(q).trim().toLowerCase()}%`;
        params.push(keyword, keyword);
    }
    let having = '';
    if (activity === 'active') having = 'HAVING match_count > 0';
    else if (activity === 'upcoming') having = 'HAVING upcoming_count > 0';
    const limit = parseLimit(req.query.limit, 60, 100);
    const teams = db.prepare(`
        SELECT t.*,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN m.id END) match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 AND m.winner_team_id = t.id THEN m.id END) win_count,
            COUNT(DISTINCT CASE WHEN m.status = 'upcoming' THEN m.id END) upcoming_count,
            MAX(CASE WHEN m.status = 'finished' THEN m.match_time END) last_match_time
        FROM teams t
        LEFT JOIN matches m ON (m.team1_id = t.id OR m.team2_id = t.id)
            AND EXISTS (SELECT 1 FROM tournaments tour WHERE tour.id = m.tournament_id AND tour.is_active = 1)
        ${where}
        GROUP BY t.id
        ${having}
        ORDER BY ${TEAM_SORTS[sort]}
        LIMIT ?
    `).all(...params, limit);
    res.json({ teams });
});

router.get('/:id', (req, res) => {
    const team = db.prepare(`SELECT t.* FROM teams t WHERE t.id = ? AND ${NOT_TBD}`).get(req.params.id);
    if (!team) return res.status(404).json({ error: '队伍不存在' });

    const recentMatches = db.prepare(`
        SELECT m.id, m.name match_name, m.format, m.match_time, m.status, m.is_forfeit,
            m.team1_id, m.team2_id, m.team1_score, m.team2_score, m.winner_team_id,
            m.stage_name, m.stage_slug, tour.id tournament_id, tour.name tournament_name,
            t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE (m.team1_id = ? OR m.team2_id = ?) AND tour.is_active = 1
        ORDER BY datetime(m.match_time) DESC
        LIMIT ?
    `).all(team.id, team.id, parseLimit(req.query.match_limit, 30, 100));

    const tournamentRows = db.prepare(`
        SELECT tour.id tournament_id, tour.name tournament_name, tour.game_type,
            MIN(m.match_time) first_match_time, MAX(m.match_time) last_match_time,
            COUNT(DISTINCT m.id) match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN m.id END) finished_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 AND m.winner_team_id = ? THEN m.id END) win_count
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE (m.team1_id = ? OR m.team2_id = ?) AND tour.is_active = 1
        GROUP BY tour.id
        ORDER BY datetime(last_match_time) DESC
        LIMIT ?
    `).all(team.id, team.id, team.id, parseLimit(req.query.tournament_limit, 20, 50));

    const placementMatches = db.prepare(`
        SELECT m.tournament_id, m.name match_name, m.stage_name, m.stage_slug, m.winner_team_id
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE (m.team1_id = ? OR m.team2_id = ?) AND m.status = 'finished' AND tour.is_active = 1
        ORDER BY datetime(m.match_time) DESC
        LIMIT 500
    `).all(team.id, team.id);

    const stats = db.prepare(`
        SELECT
            COUNT(DISTINCT CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN m.id END) match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 AND m.winner_team_id = ? THEN m.id END) win_count,
            COUNT(DISTINCT CASE WHEN m.status = 'upcoming' THEN m.id END) upcoming_count
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE (m.team1_id = ? OR m.team2_id = ?) AND tour.is_active = 1
    `).get(team.id, team.id, team.id);

    const tournaments = tournamentRows.map(row => {
        const matches = placementMatches.filter(match => match.tournament_id === row.tournament_id);
        const finished = row.finished_count || 0;
        return {
            ...row,
            placement: row.finished_count < row.match_count ? '进行中' : placementForMatches(matches, team.id),
            win_count: row.win_count || 0,
            loss_count: Math.max(finished - (row.win_count || 0), 0),
            win_rate: finished ? Math.round(((row.win_count || 0) / finished) * 100) : 0
        };
    });

    const matchCount = stats.match_count || 0;
    const winCount = stats.win_count || 0;
    res.json({
        team: teamSummary(team),
        stats: {
            match_count: matchCount,
            win_count: winCount,
            loss_count: matchCount - winCount,
            win_rate: matchCount ? Math.round((winCount / matchCount) * 100) : 0,
            upcoming_count: stats.upcoming_count || 0
        },
        tournaments,
        matches: recentMatches
    });
});

module.exports = router;
