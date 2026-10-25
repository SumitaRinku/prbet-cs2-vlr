// 官方 bracket 数据规范化（纯函数，不依赖数据库/网络）。
// PandaScore: GET /tournaments/{id}/brackets 返回比赛数组，
// 每场通过 previous_matches 声明参赛队来自上一场的胜者还是败者。

function isoValue(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function canonicalBracketMatchId(gameType, matchId) {
    return `${gameType || 'cs2'}:${matchId}`;
}

function bracketTeamFromOpponent(opponent) {
    const team = opponent && opponent.opponent;
    if (!team) {
        return {
            external_id: null, name: null, short_name: null,
            logo_url: null, dark_logo_url: null
        };
    }
    return {
        external_id: team.id ? String(team.id) : null,
        name: team.name || null,
        short_name: team.acronym || team.slug || null,
        logo_url: team.image_url || null,
        dark_logo_url: team.dark_mode_image_url || null
    };
}

function parseBracketPayload(rows, gameType) {
    const nodes = [];
    const edges = [];
    const nodeKeys = new Set();
    const edgeKeys = new Set();
    (rows || []).forEach((row, index) => {
        if (!row || !row.id) return;
        const externalMatchId = canonicalBracketMatchId(gameType, row.id);
        if (nodeKeys.has(externalMatchId)) return;
        nodeKeys.add(externalMatchId);
        const opponents = Array.isArray(row.opponents) ? row.opponents : [];
        const team1 = bracketTeamFromOpponent(opponents[0]);
        const team2 = bracketTeamFromOpponent(opponents[1]);
        nodes.push({
            external_match_id: externalMatchId,
            panda_match_id: String(row.id),
            name: row.name || null,
            status: row.status || null,
            scheduled_at: isoValue(row.scheduled_at) || isoValue(row.begin_at) || null,
            position: index,
            team1_external_id: team1.external_id,
            team1_name: team1.name,
            team1_short_name: team1.short_name,
            team1_logo_url: team1.logo_url,
            team1_dark_logo_url: team1.dark_logo_url,
            team2_external_id: team2.external_id,
            team2_name: team2.name,
            team2_short_name: team2.short_name,
            team2_logo_url: team2.logo_url,
            team2_dark_logo_url: team2.dark_logo_url
        });
        for (const previous of Array.isArray(row.previous_matches) ? row.previous_matches : []) {
            if (!previous || !previous.match_id) continue;
            if (previous.type !== 'winner' && previous.type !== 'loser') continue;
            const sourceExternalId = canonicalBracketMatchId(gameType, previous.match_id);
            const key = `${externalMatchId}|${sourceExternalId}|${previous.type}`;
            if (edgeKeys.has(key)) continue;
            edgeKeys.add(key);
            edges.push({
                match_external_id: externalMatchId,
                source_external_match_id: sourceExternalId,
                source_type: previous.type
            });
        }
    });
    return { nodes, edges };
}

module.exports = { canonicalBracketMatchId, parseBracketPayload };
