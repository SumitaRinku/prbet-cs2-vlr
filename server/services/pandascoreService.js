const db = require('../config/database');
const { settleMatch, recalculateUserScores } = require('../utils/settlement');

const SOURCE = 'pandascore';
const BASE_URL = process.env.PANDASCORE_BASE_URL || 'https://api.pandascore.co';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const PER_PAGE = 100;
const MAX_PAGES = 10;
const DEFAULT_LOOKAHEAD_DAYS = 7;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const GAMES = {
    cs2: { endpoint: '/csgo/matches', label: 'CS2' },
    valorant: { endpoint: '/valorant/matches', label: 'Valorant' }
};
let timer = null;
let running = false;

// ===== 同步异常告警 =====
// 自动同步（startup/scheduled）连续异常时推送到 webhook，避免静默断同步导致
// 比赛与赛果长期不更新。异常 = 整轮拉取失败，或任一游戏部分失败；连续 2 轮
// 触发首次告警，之后每 10 轮提醒一次；恢复正常后发送一次恢复通知。
// 手动同步（manual/cli）不算异常轮次——管理员就在现场，无需推送。
// 配置：ALERT_WEBHOOK_URL。支持 Server酱（URL 含 sctapi.ftqq.com，form 表单）、
// Bark（POST JSON {title, body}）与通用 JSON webhook（POST {title, message, body}）。
let degradedRounds = 0;

function alertWebhookUrl() {
    return (process.env.ALERT_WEBHOOK_URL || '').trim();
}

async function sendAlertNotification(title, message) {
    const url = alertWebhookUrl();
    if (!url) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const headers = { 'Content-Type': 'application/json' };
        let body = JSON.stringify({ title, message, body: message });
        if (url.includes('sctapi.ftqq.com')) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = new URLSearchParams({ title, desp: message }).toString();
        }
        await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    } catch (error) {
        console.error('[PandaScore] 告警推送失败:', error.message);
    } finally {
        clearTimeout(timer);
    }
}

async function noteDegradedRound(message) {
    degradedRounds++;
    if (degradedRounds === 2 || (degradedRounds > 2 && (degradedRounds - 2) % 10 === 0)) {
        await sendAlertNotification('PandaScore 同步异常', `已连续 ${degradedRounds} 轮同步异常：${message}`);
    }
}

function token() {
    return process.env.PANDASCORE_API_TOKEN || process.env.PANDASCORE_TOKEN || '';
}

function intervalMs() {
    const value = Number(process.env.PANDASCORE_SYNC_INTERVAL_MS);
    return Number.isFinite(value) && value > 0 ? Math.max(value, MIN_INTERVAL_MS) : DEFAULT_INTERVAL_MS;
}

function lookaheadDays() {
    const value = Number(process.env.PANDASCORE_SYNC_LOOKAHEAD_DAYS);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 7) : DEFAULT_LOOKAHEAD_DAYS;
}

function requestTimeoutMs() {
    const value = Number(process.env.PANDASCORE_REQUEST_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
}

function iso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function statusOf(match) {
    if (match.status === 'not_started') return 'upcoming';
    if (match.status === 'running') return 'ongoing';
    if (match.status === 'finished') return 'finished';
    if (match.status === 'canceled' || match.status === 'cancelled') return 'cancelled';
    if (match.status === 'postponed') return 'postponed';
    return 'upcoming';
}

function formatOf(match) {
    const games = Number(match.number_of_games || 3);
    if (games >= 5) return 'BO5';
    if (games <= 1) return 'BO1';
    return 'BO3';
}

function stageFromMatch(match) {
    const stage = match.tournament || {};
    return {
        name: stage.name || stage.full_name || null,
        slug: stage.slug || null,
        external_id: stage.id ? String(stage.id) : null
    };
}

// 未定对阵的占位队伍标记。每个 game_type 复用同一条 TBD 记录，
// 避免为每个未定位置新建队伍。external_id 固定为 <game>:__tbd__。
const TBD_MARKER = '__tbd__';

function teamFromOpponent(opponent) {
    if (!opponent || !opponent.opponent) return null;
    const team = opponent.opponent;
    return {
        external_id: team.id ? String(team.id) : null,
        name: team.name || 'Unknown Team',
        short_name: team.acronym || team.slug || null,
        logo_url: team.image_url || null,
        dark_logo_url: team.dark_mode_image_url || null,
        country: team.location || null
    };
}

// TBD 占位队伍统一使用的 logo（带问号的盾牌）。
const TBD_LOGO_URL = '/images/team-tbd.svg';

// 取得（或首次创建）某游戏类型的 TBD 占位队伍，返回其 id。
function ensureTbdTeam(gameType, now) {
    const externalId = `${gameType}:${TBD_MARKER}`;
    const existing = db.prepare('SELECT id FROM teams WHERE external_source = ? AND external_id = ?').get(SOURCE, externalId);
    if (existing) {
        // 幂等补齐 logo：老数据可能没有 logo，这里统一回填。
        db.prepare('UPDATE teams SET logo_url = ? WHERE id = ? AND (logo_url IS NULL OR logo_url <> ?)')
            .run(TBD_LOGO_URL, existing.id, TBD_LOGO_URL);
        return existing.id;
    }
    const inserted = db.prepare(`INSERT INTO teams (name, game_type, short_name, logo_url, country, external_source, external_id, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('TBD', gameType, 'TBD', TBD_LOGO_URL, null, SOURCE, externalId, now);
    return inserted.lastInsertRowid;
}

function scoreFor(match, teamExternalId) {
    const results = Array.isArray(match.results) ? match.results : [];
    const row = results.find(result => String(result.team_id) === String(teamExternalId));
    return row && Number.isFinite(Number(row.score)) ? Number(row.score) : null;
}

function legacyExternalId(canonicalExternalId, gameType) {
    const prefix = `${gameType}:`;
    return canonicalExternalId && canonicalExternalId.startsWith(prefix) ? canonicalExternalId.slice(prefix.length) : null;
}

function findOrUpgradeExternalId(table, canonicalExternalId, gameType, now) {
    if (!canonicalExternalId) return null;

    const existing = db.prepare(`SELECT id FROM ${table} WHERE external_source = ? AND external_id = ?`)
        .get(SOURCE, canonicalExternalId);
    if (existing) return existing;

    const legacyId = legacyExternalId(canonicalExternalId, gameType);
    if (!legacyId) return null;

    const legacy = db.prepare(`SELECT id FROM ${table} WHERE external_source = ? AND external_id = ?`)
        .get(SOURCE, legacyId);
    if (!legacy) return null;

    db.prepare(`UPDATE ${table} SET external_id = ?, last_synced_at = ? WHERE id = ?`)
        .run(canonicalExternalId, now, legacy.id);
    return legacy;
}

const RETRY_DELAY_MS = 2000;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(pathname, params) {
    if (!token()) throw new Error('PANDASCORE_API_TOKEN 未配置');
    // query 手工拼接：range[begin_at]=start,end 中的方括号与逗号必须保持字面量。
    // URLSearchParams 会把逗号编码为 %2C，PandaScore 会报 400 Range Error
    // （"Beginning and end aren't be separated by a comma"）。这里的参数值
    // 均为数字 / ISO 日期 / 排序字段，无需编码。
    const query = Object.entries(params || {})
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
    const url = new URL(query ? `${pathname}?${query}` : pathname, BASE_URL);

    const doFetch = async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
        try {
            return await fetch(url, {
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token()}`
                }
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`PandaScore 请求超时：${requestTimeoutMs()}ms，URL=${url.toString()}`);
            }
            throw new Error(`PandaScore 请求失败：${error.message}，URL=${url.toString()}`);
        } finally {
            clearTimeout(timeout);
        }
    };

    // 失败重试一次：PandaScore 偶发 400/500（瞬时故障），重试可吸收大部分抖动
    // ????????? 429/5xx ???????4xx ?????????
    let response;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            response = await doFetch();
            if (response.ok) break;
            if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
            const retryAfter = Number(response.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 30000) : RETRY_DELAY_MS * (2 ** attempt);
            await delay(waitMs);
        } catch (error) {
            lastError = error;
            if (attempt === 2) throw error;
            await delay(RETRY_DELAY_MS * (2 ** attempt));
        }
    }
    if (lastError && !response) throw lastError;
    if (!response || !response.ok) {
        const body = response ? await response.text() : '';
        throw new Error('PandaScore ???? ' + (response ? response.status : '') + ': ' + body.slice(0, 400));
    }

    return response.json();
}

async function fetchMatches(gameType) {
    const game = GAMES[gameType];
    // Yesterday's 06:00-to-06:00 report may include matches older than 24 hours.
    const start = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + lookaheadDays() * 24 * 60 * 60 * 1000).toISOString();
    const rows = [];

    console.log(`[PandaScore] 拉取 ${game.label} 比赛：${start} -> ${end}`);

    for (let page = 1; page <= MAX_PAGES; page++) {
        console.log(`[PandaScore] 请求第 ${page} 页`);
        const data = await fetchJson(game.endpoint, {
            'page[number]': page,
            'page[size]': PER_PAGE,
            'range[begin_at]': `${start},${end}`,
            sort: 'begin_at'
        });
        console.log(`[PandaScore] 第 ${page} 页返回 ${Array.isArray(data) ? data.length : 0} 条`);
        if (!Array.isArray(data)) throw new Error('PandaScore 返回了非数组赛程');
        if (data.length === 0) break;
        rows.push(...data.map(row => ({ ...row, __gameType: gameType })));
        if (data.length < PER_PAGE) break;
        if (page === MAX_PAGES) throw new Error('PandaScore 赛程超过分页上限，不能视为完整同步');
    }

    return rows;
}

function upsertTournament(match, now) {
    const gameType = match.__gameType || 'cs2';
    const serie = match.serie || {};
    const league = match.league || {};
    const externalId = `${gameType}:${serie.id || league.id || match.serie_id || match.league_id}`;

    // PandaScore 三层结构：league（赛事品牌，如 "ESL Pro League"）> serie（届/赛季，
    // full_name 通常只是 "Season 21 2026" 甚至 "2026"）> tournament（阶段）。
    // 展示名必须拼上 league.name，否则只剩赛季标签，出现 "2026" 这种残缺名。
    const serieLabel = serie.full_name || serie.name || '';
    const leagueName = league.name || '';
    let name;
    if (leagueName && serieLabel) {
        // 个别 serie 标签本身已含品牌名，避免重复拼接
        name = serieLabel.toLowerCase().includes(leagueName.toLowerCase())
            ? serieLabel
            : `${leagueName} ${serieLabel}`;
    } else {
        name = leagueName || serieLabel || `PandaScore ${GAMES[gameType]?.label || gameType}`;
    }

    const existing = findOrUpgradeExternalId('tournaments', externalId ? String(externalId) : null, gameType, now);
    if (existing) {
        // 管理员手动上传的 logo（/uploads/ 本地文件）不被同步覆盖，与 name_locked 同样的保护思路
        db.prepare(`UPDATE tournaments SET name = CASE WHEN name_locked = 1 THEN name ELSE ? END, game_type = ?, begin_at = COALESCE(?, begin_at), end_at = COALESCE(?, end_at), logo_url = CASE WHEN tournaments.logo_url LIKE '/uploads/%' THEN tournaments.logo_url ELSE COALESCE(?, logo_url) END, last_synced_at = ? WHERE id = ?`)
            .run(name, gameType, iso(serie.begin_at || match.begin_at), iso(serie.end_at), league.image_url || null, now, existing.id);
        return existing.id;
    }

    const inserted = db.prepare(`INSERT INTO tournaments (name, game_type, is_active, name_locked, begin_at, end_at, logo_url, external_source, external_id, last_synced_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`).run(
        name,
        gameType,
        iso(serie.begin_at || match.begin_at),
        iso(serie.end_at),
        league.image_url || null,
        SOURCE,
        externalId ? String(externalId) : null,
        now
    );
    return inserted.lastInsertRowid;
}

function upsertTeam(team, gameType, now) {
    const externalId = team.external_id ? `${gameType}:${team.external_id}` : null;
    const existing = findOrUpgradeExternalId('teams', externalId, gameType, now);
    if (existing) {
        // dark_logo_url 直接覆盖：null 表示数据源确认无暗色版，需清空让前端回退
        db.prepare(`UPDATE teams SET name = ?, game_type = ?, short_name = COALESCE(?, short_name), logo_url = COALESCE(?, logo_url), dark_logo_url = ?, country = COALESCE(?, country), last_synced_at = ? WHERE id = ?`)
            .run(team.name, gameType, team.short_name, team.logo_url, team.dark_logo_url, team.country, now, existing.id);
        return existing.id;
    }

    const byName = db.prepare('SELECT id FROM teams WHERE name = ? AND game_type = ?').get(team.name, gameType);
    if (byName) {
        db.prepare(`UPDATE teams SET external_source = COALESCE(external_source, ?), external_id = COALESCE(external_id, ?), short_name = COALESCE(?, short_name), logo_url = COALESCE(?, logo_url), dark_logo_url = ?, last_synced_at = ? WHERE id = ?`)
            .run(SOURCE, externalId, team.short_name, team.logo_url, team.dark_logo_url, now, byName.id);
        return byName.id;
    }

    const inserted = db.prepare(`INSERT INTO teams (name, game_type, short_name, logo_url, dark_logo_url, country, external_source, external_id, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(team.name, gameType, team.short_name, team.logo_url, team.dark_logo_url, team.country, SOURCE, externalId, now);
    return inserted.lastInsertRowid;
}

function pruneExpiredInactiveTournaments(now) {
    // 只清理从未有人预测过的赛事：删除会沿外键级联到 matches 和 predictions，
    // 有预测的赛事即使被禁用也必须保留，否则用户的预测记录和得分明细会被抹掉。
    const rows = db.prepare(`
        SELECT id
        FROM tournaments
        WHERE external_source = ?
            AND is_active = 0
            AND end_at IS NOT NULL
            AND datetime(end_at) < datetime(?)
            AND NOT EXISTS (
                SELECT 1 FROM predictions p
                JOIN matches m ON m.id = p.match_id
                WHERE m.tournament_id = tournaments.id
            )
    `).all(SOURCE, now);

    const remove = db.prepare('DELETE FROM tournaments WHERE id = ?');
    for (const row of rows) remove.run(row.id);
    return rows.length;
}

function upsertMatch(match, now) {
    const gameType = match.__gameType || 'cs2';
    const opponents = Array.isArray(match.opponents) ? match.opponents : [];
    const team1 = teamFromOpponent(opponents[0]);
    const team2 = teamFromOpponent(opponents[1]);

    // 已确定的一方若解析出 Unknown Team（数据异常）仍跳过；
    // 但整场未定（opponents 为空）不再跳过，改用 TBD 占位入库，以便赛程图展示完整结构。
    if ((team1 && team1.name === 'Unknown Team') || (team2 && team2.name === 'Unknown Team')) return { skipped: true };

    const tournamentId = upsertTournament(match, now);
    if (!tournamentId) return { skipped: true, disabled: true };
    const tournament = db.prepare('SELECT is_active FROM tournaments WHERE id = ?').get(tournamentId);
    const tournamentActive = !tournament || tournament.is_active === 1;

    // 任一方未定则用 TBD 占位；此类比赛强制关闭下注。
    const team1IsTbd = !team1;
    const team2IsTbd = !team2;
    const hasTbd = team1IsTbd || team2IsTbd;
    const team1Id = team1IsTbd ? ensureTbdTeam(gameType, now) : upsertTeam(team1, gameType, now);
    const team2Id = team2IsTbd ? ensureTbdTeam(gameType, now) : upsertTeam(team2, gameType, now);
    // 两个真实队伍相同才是数据异常；两侧都 TBD（team1Id===team2Id）是正常的未定局，不能跳过。
    if (!hasTbd && team1Id === team2Id) return { skipped: true };

    const status = statusOf(match);
    const format = formatOf(match);
    const winnerId = hasTbd ? null : (String(match.winner_id || '') === String(team1.external_id) ? team1Id : String(match.winner_id || '') === String(team2.external_id) ? team2Id : null);
    // PandaScore 的弃权局：status=canceled 且有胜者（对手弃权）。按 1-0 记录、标记弃权、
    // 视作已结束以便结算（calculatePoints 对 is_forfeit 返回 0，故不计入积分）。
    const isForfeit = status === 'cancelled' && !hasTbd && winnerId !== null;
    const effectiveStatus = isForfeit ? 'finished' : status;
    const syncResults = !hasTbd && status === 'finished' && process.env.PANDASCORE_SYNC_RESULTS !== 'false';
    const team1Score = isForfeit ? (winnerId === team1Id ? 1 : 0) : (syncResults ? scoreFor(match, team1.external_id) : null);
    const team2Score = isForfeit ? (winnerId === team2Id ? 1 : 0) : (syncResults ? scoreFor(match, team2.external_id) : null);
    const stage = stageFromMatch(match);
    const sourceTime = iso(match.scheduled_at) || iso(match.begin_at);
    const matchTime = sourceTime || now;
    const externalId = `${gameType}:${match.id}`;
    const existingRef = findOrUpgradeExternalId('matches', externalId, gameType, now);
    const existing = existingRef ? db.prepare('SELECT * FROM matches WHERE id = ?').get(existingRef.id) : null;
    // TBD 比赛一律不可下注；确定的比赛沿用原有开关逻辑。
    const canBet = tournamentActive && !hasTbd;

    if (existing) {
        // 管理员经 /result、/forfeit 锁定的赛果是最终结果：同步只补齐 stage 元数据，
        // 不覆盖比分/胜者/状态/弃权标记（否则同步窗口内的人工修正会被数据源回滚）。
        // 积分在录入赛果时已结算，锁定后无需重算。
        if (existing.result_locked) {
            db.prepare('UPDATE matches SET stage_name = ?, stage_slug = ?, stage_external_id = ?, last_synced_at = ?, time_confirmed = CASE WHEN ? = match_time THEN 1 ELSE time_confirmed END WHERE id = ?')
                .run(stage.name, stage.slug, stage.external_id, now, sourceTime, existing.id);
            return { id: existing.id, finished: false, settle: false };
        }
        const wasFinished = existing.status === 'finished';
        // 判断该比赛「此前是否为 TBD 占位」：只因对阵未定而被强制关闭下注的比赛，
        // 一旦对阵确定应自动重新开放，而不是沿用那个被迫的 0。
        const wasTbd = !!db.prepare("SELECT 1 FROM teams WHERE id IN (?, ?) AND name = 'TBD' LIMIT 1")
            .get(existing.team1_id, existing.team2_id);
        // PandaScore 翻转主客队顺序时，预测比分按位置存储，必须同步对调存量预测，
        // 否则精确比分加分与展示都会错位（胜者按 ID 比较，不受影响）。
        if (!hasTbd && Number(team1Id) !== Number(team2Id)
            && Number(existing.team1_id) === Number(team2Id)
            && Number(existing.team2_id) === Number(team1Id)) {
            db.prepare('UPDATE predictions SET predicted_team1_score = predicted_team2_score, predicted_team2_score = predicted_team1_score WHERE match_id = ?')
                .run(existing.id);
        }
        let bettingEnabled;
        if (!canBet || effectiveStatus !== 'upcoming') {
            bettingEnabled = 0; // TBD、赛事非活跃或已开赛/结束：一律关闭
        } else if (wasTbd) {
            bettingEnabled = 1; // 从 TBD 转为确定对阵：重新开放下注
        } else {
            bettingEnabled = existing.betting_enabled; // 常规确定比赛：沿用现值，尊重管理员手动开关
        }
        db.prepare(`
            UPDATE matches SET tournament_id = ?, team1_id = ?, team2_id = ?, name = ?, format = ?, match_time = ?, status = ?, is_forfeit = ?, raw_status = ?,
                stage_name = ?, stage_slug = ?, stage_external_id = ?,
                team1_score = COALESCE(?, team1_score), team2_score = COALESCE(?, team2_score), winner_team_id = COALESCE(?, winner_team_id),
                betting_enabled = ?, last_synced_at = ?, time_confirmed = ?
            WHERE id = ?
        `).run(tournamentId, team1Id, team2Id, match.name || null, format, matchTime, effectiveStatus, isForfeit ? 1 : 0, match.status || null, stage.name, stage.slug, stage.external_id, team1Score, team2Score, winnerId, bettingEnabled, now, sourceTime ? 1 : 0, existing.id);
        return { id: existing.id, finished: !wasFinished && effectiveStatus === 'finished', settle: effectiveStatus === 'finished' };
    }

    const inserted = db.prepare(`
        INSERT INTO matches (tournament_id, team1_id, team2_id, name, format, match_time, status, is_forfeit, raw_status, stage_name, stage_slug, stage_external_id, team1_score, team2_score, winner_team_id, betting_enabled, external_source, external_id, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tournamentId, team1Id, team2Id, match.name || null, format, matchTime, effectiveStatus, isForfeit ? 1 : 0, match.status || null, stage.name, stage.slug, stage.external_id, team1Score, team2Score, winnerId, canBet && effectiveStatus === 'upcoming' ? 1 : 0, SOURCE, externalId, now);
    db.prepare('UPDATE matches SET time_confirmed = ? WHERE id = ?').run(sourceTime ? 1 : 0, inserted.lastInsertRowid);
    return { id: inserted.lastInsertRowid, finished: effectiveStatus === 'finished', settle: effectiveStatus === 'finished' };
}

async function syncPandascoreMatches(mode = 'manual') {
    if (running) return { status: 'skipped', message: '已有同步任务正在运行' };
    running = true;
    const run = db.prepare('INSERT INTO sync_runs (source, mode, status) VALUES (?, ?, ?)').run(SOURCE, mode, 'running');

    try {
        console.log(`[PandaScore] 开始同步，mode=${mode}`);
        const beforeTeams = db.prepare('SELECT COUNT(*) count FROM teams WHERE external_source = ?').get(SOURCE).count;
        const beforeTours = db.prepare('SELECT COUNT(*) count FROM tournaments WHERE external_source = ?').get(SOURCE).count;
        // 各游戏独立拉取：单游戏失败不影响其他游戏入库（部分成功优于全部失败）
        const gameKeys = Object.keys(GAMES);
        const settled = await Promise.allSettled(gameKeys.map(fetchMatches));
        const failures = [];
        const rows = [];
        settled.forEach((outcome, index) => {
            if (outcome.status === 'fulfilled') rows.push(...outcome.value);
            else failures.push(`${GAMES[gameKeys[index]].label}：${outcome.reason.message}`);
        });
        if (failures.length === gameKeys.length) {
            throw new Error(`全部游戏拉取失败：${failures.join('；')}`);
        }
        if (failures.length) console.error(`[PandaScore] 部分游戏拉取失败：${failures.join('；')}`);
        // 异常轮次计数与告警：干净成功清零（必要时先发恢复通知），部分失败计入连续异常
        if (failures.length === 0) {
            if (mode !== 'manual' && degradedRounds >= 2) {
                await sendAlertNotification('PandaScore 同步恢复', `此前连续 ${degradedRounds} 轮同步异常，现已恢复正常。`);
            }
            degradedRounds = 0;
        } else if (mode !== 'manual') {
            await noteDegradedRound(failures.join('；'));
        }
        console.log(`[PandaScore] API 拉取完成，共 ${rows.length} 场，开始写入数据库`);
        const now = new Date().toISOString();
        let matchesUpserted = 0;
        let matchesFinished = 0;

        const tx = db.transaction(() => {
            let scoresChanged = false;
            for (const row of rows) {
                const result = upsertMatch(row, now);
                if (!result.skipped) {
                    matchesUpserted++;
                    if (result.finished) matchesFinished++;
                    // 对所有已结束比赛重新结算（幂等），这样赛果被修正后也会更新得分；
                    // 只有分数实际变化时才重建总分，避免每次同步都全量重算
                    if (result.settle) {
                        const { changed } = settleMatch(result.id);
                        if (changed) scoresChanged = true;
                    }
                }
            }
            pruneExpiredInactiveTournaments(now);
            // 全部预测算完后统一重建总分，作为唯一权威来源，避免增量漂移
            if (scoresChanged) recalculateUserScores();
            // Mark only games whose entire fetch and transaction succeeded.
            const markSynced = db.prepare(`INSERT INTO bot_sync_state (game_type, last_success_at)
                VALUES (?, ?) ON CONFLICT(game_type) DO UPDATE SET last_success_at = excluded.last_success_at`);
            settled.forEach((outcome, index) => {
                if (outcome.status === 'fulfilled') markSynced.run(gameKeys[index], now);
            });
        });
        tx();

        const teams = Math.max(db.prepare('SELECT COUNT(*) count FROM teams WHERE external_source = ?').get(SOURCE).count - beforeTeams, 0);
        const tournaments = Math.max(db.prepare('SELECT COUNT(*) count FROM tournaments WHERE external_source = ?').get(SOURCE).count - beforeTours, 0);
        const message = `同步完成，读取 ${rows.length} 场比赛${failures.length ? `（部分失败：${failures.join('；')}）` : ''}`;
        // sync_runs.status 的 CHECK 约束不含 partial：数据已入库的部分按 success 记录，
        // 失败详情写入 message；API 返回 partial 供前端区分展示。
        db.prepare(`UPDATE sync_runs SET status = 'success', message = ?, finished_at = CURRENT_TIMESTAMP, tournaments_upserted = ?, teams_upserted = ?, matches_upserted = ?, matches_finished = ? WHERE id = ?`)
            .run(message, tournaments, teams, matchesUpserted, matchesFinished, run.lastInsertRowid);
        console.log(`[PandaScore] ${message}`);
        return { status: failures.length ? 'partial' : 'success', message, tournaments_upserted: tournaments, teams_upserted: teams, matches_upserted: matchesUpserted, matches_finished: matchesFinished };
    } catch (error) {
        db.prepare(`UPDATE sync_runs SET status = 'failed', message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error.message, run.lastInsertRowid);
        if (mode !== 'manual') await noteDegradedRound(error.message);
        throw error;
    } finally {
        running = false;
    }
}

function syncStatus() {
    return {
        enabled: process.env.PANDASCORE_SYNC_ENABLED !== 'false',
        configured: !!token(),
        games: Object.keys(GAMES),
        interval_ms: intervalMs(),
        lookahead_days: lookaheadDays(),
        running,
        last_run: db.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1').get() || null
    };
}

function startPandascoreSyncService() {
    if (process.env.PANDASCORE_SYNC_ENABLED === 'false') return;
    if (!token()) {
        console.log('[PandaScore] token not configured, sync disabled');
        return;
    }
    if (timer) return;

    syncPandascoreMatches('startup').catch(error => console.error('[PandaScore]', error.message));
    timer = setInterval(() => syncPandascoreMatches('scheduled').catch(error => console.error('[PandaScore]', error.message)), intervalMs());
    console.log(`[PandaScore] sync enabled every ${intervalMs() / 1000}s`);
}

module.exports = { syncPandascoreMatches, syncStatus, startPandascoreSyncService };
