const VALID_GAMES = new Set(['cs2', 'valorant']);
const VALID_FORMATS = new Set(['BO1', 'BO3', 'BO5']);
const VALID_STATUSES = new Set(['upcoming', 'ongoing', 'finished', 'cancelled', 'postponed']);

function validateMatchReferences(db, input) {
    const tournament = db.prepare('SELECT id, game_type FROM tournaments WHERE id = ?').get(input.tournament_id);
    if (!tournament) return '赛事不存在';
    const team1 = db.prepare('SELECT id, game_type FROM teams WHERE id = ?').get(input.team1_id);
    const team2 = db.prepare('SELECT id, game_type FROM teams WHERE id = ?').get(input.team2_id);
    if (!team1 || !team2) return '参赛队伍不存在';
    if (team1.id === team2.id) return '两支队伍不能相同';
    if (tournament.game_type !== team1.game_type || tournament.game_type !== team2.game_type) {
        return '赛事与参赛队伍的游戏类型不一致';
    }
    return null;
}

function validateMatchInput(input, { requireTime = false } = {}) {
    if (!input.tournament_id || !input.team1_id || !input.team2_id || (requireTime && !input.match_time)) return '缺少必填字段';
    if (input.format && !VALID_FORMATS.has(input.format)) return '赛制无效';
    if (input.status && !VALID_STATUSES.has(input.status)) return '状态无效';
    if (input.match_time !== undefined && input.match_time !== null
        && (typeof input.match_time !== 'string'
            || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(input.match_time)
            || Number.isNaN(new Date(input.match_time).getTime()))) return '比赛时间格式无效';
    return null;
}

module.exports = { VALID_GAMES, VALID_FORMATS, VALID_STATUSES, validateMatchInput, validateMatchReferences };
