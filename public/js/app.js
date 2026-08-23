const state = {
    token: localStorage.getItem('token'),
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    matches: [],
    tournaments: [],
    game: localStorage.getItem('gameFilter') || 'cs2',
    tournament: localStorage.getItem('homeTournamentFilter') || '',
    status: localStorage.getItem('homeStatusFilter') || '',
    filterCounts: { all: 0, finished: 0, ongoing: 0, upcoming: 0 },
    bracketCollapsed: localStorage.getItem('homeBracketCollapsed') !== '0',
    matchesRequestId: 0,
    bracketRequestId: 0
};

const userPanelEl = document.querySelector('#userPanel');
const gameSwitchEl = document.querySelector('#gameSwitch');
const tournamentFilterEl = document.querySelector('#tournamentFilter');
const tournamentFiltersEl = document.querySelector('#tournamentFilters');
const statusFiltersEl = document.querySelector('#statusFilters');
const matchFilterSummaryEl = document.querySelector('#matchFilterSummary');
const matchResultsTitleEl = document.querySelector('#matchResultsTitle');
const matchResultsMetaEl = document.querySelector('#matchResultsMeta');
const clearMatchFiltersEl = document.querySelector('#clearMatchFilters');
const matchesEl = document.querySelector('#matches');
const homeBracketEl = document.querySelector('#homeBracket');
const detailModalEl = document.querySelector('#detailModal');
const detailModalBodyEl = document.querySelector('#detailModalBody');

async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    // token 过期/失效：清理登录态（登录、注册接口的 401 是凭据错误，不触发登出）
    if (res.status === 401 && state.token && !path.startsWith('/auth/')) {
        logout();
        throw new Error('登录已过期，请重新登录');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatDateTime(value) {
    return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-') : '';
}

function gameName(game) {
    return game === 'valorant' ? 'Valorant' : game === 'cs2' ? 'CS2' : '全部游戏';
}

function saveAuth(data) {
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    renderUser();
    loadAll();
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    state.token = null;
    state.user = null;
    renderUser();
    loadAll();
}

function renderUser() {
    if (!userPanelEl) return;
    if (!state.user) {
        userPanelEl.innerHTML = `
            <input id="username" placeholder="用户名">
            <input id="password" placeholder="密码" type="password">
            <button onclick="login()">登录</button>
            <button onclick="register()">注册</button>
        `;
        return;
    }
    userPanelEl.innerHTML = `<span>${escapeHtml(state.user.username)} · ${escapeHtml(state.user.role)} · ${state.user.total_score || 0}分</span><button onclick="logout()">退出</button>${state.user.role === 'admin' ? '<a class="button" href="/admin/">管理后台</a>' : ''}`;
}

async function login() {
    try {
        saveAuth(await api('/auth/login', { method: 'POST', body: { username: username.value, password: password.value } }));
    } catch (error) { alert(error.message); }
}

async function register() {
    try {
        saveAuth(await api('/auth/register', { method: 'POST', body: { username: username.value, password: password.value } }));
    } catch (error) { alert(error.message); }
}

function proxiedLogoUrl(url) {
    if (!url) return '';
    // 本地/相对路径（如 TBD 占位盾牌 /images/team-tbd.svg）直接引用，不走外部 logo 代理。
    if (/^\/(?!\/)/.test(url) || url.startsWith('data:')) return url;
    return `/api/images/team-logo?url=${encodeURIComponent(url)}`;
}

function logo(url, darkUrl) {
    // 暗色主题优先 PandaScore 暗色队标（白色版），主题切换由 tournament-logos.js 换源
    const light = proxiedLogoUrl(url);
    const dark = proxiedLogoUrl(darkUrl);
    const useDark = dark && document.documentElement.getAttribute('data-theme') === 'dark';
    const src = useDark ? dark : light;
    if (!src) return '<div class="placeholder">TEAM</div>';
    return `<img src="${src}" data-team-logo data-light="${light || ''}" data-dark="${dark || ''}" data-try="${useDark ? 'dark' : 'light'}" data-variant="${useDark ? 'dark' : 'light'}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="teamLogoError(this)">`;
}
// bracket.js 依赖的环境全局：主页用 logo 的等价实现提供 logoHtml。
window.logoHtml = logo;

// 赛事厂牌 logo 的匹配与渲染在 /js/tournament-logos.js（公共模块，需先于本文件加载），
// 主页与 shared 页共用同一份映射：tournamentLogoUrl / tournamentLogo。

function cardState(match, prediction) {
    const displayStatus = match.display_status || (match.status === 'finished' ? 'finished' : new Date(match.match_time) <= new Date() ? 'ongoing' : 'upcoming');
    if (match.is_forfeit) return {
        className: 'match-forfeit',
        label: '弃权',
        phase: '对手弃权',
        hint: '本场因弃权按 1-0 判定，已结算但不计入积分。'
    };
    if (displayStatus === 'finished') return {
        className: 'match-finished',
        label: '已结束',
        phase: '赛果已出',
        hint: ''
    };
    if (displayStatus === 'ongoing') return {
        className: 'match-settling',
        label: '进行中',
        phase: '比赛进行中',
        hint: ''
    };
    if (match.betting_enabled && prediction) return {
        className: 'match-picked',
        label: '即将开始',
        phase: '赛前',
        hint: ''
    };
    if (match.betting_enabled) return {
        className: 'match-open',
        label: '即将开始',
        phase: '赛前',
        hint: ''
    };
    return {
        className: 'match-closed',
        label: '即将开始',
        phase: '暂未开放',
        hint: ''
    };
}

function timeInfo(value) {
    const date = new Date(value);
    const diff = date - new Date();
    const exact = formatDateTime(value);
    if (diff <= 0) return { countdown: '进行中', exact };
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return { countdown: `${minutes}分钟后`, exact };
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return { countdown: `${hours}小时${minutes % 60}分钟后`, exact };
    return { countdown: `${Math.floor(hours / 24)}天${hours % 24}小时后`, exact };
}

// 即将开始：秒表倒计时文本，xdxh / xhxm / xmxs，到点显示「进行中」
function countdownText(matchTime) {
    const diff = new Date(matchTime) - new Date();
    if (diff <= 0) return '进行中';
    const totalSec = Math.floor(diff / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d > 0) return `${d}d${h}h`;
    if (h > 0) return `${h}h${m}m`;
    return `${m}m${s}s`;
}

// 每秒刷新所有 [data-countdown] 徽标；秒表图标走 ::before，textContent 只更新数字
// 最后 1 分钟挂 cd-urgent 类（呼吸 + 红色），到点或超时自动移除
function startCountdownTicker() {
    if (window.__countdownTicker) return;
    window.__countdownTicker = setInterval(() => {
        document.querySelectorAll('[data-countdown]').forEach(el => {
            const time = el.getAttribute('data-countdown');
            el.textContent = countdownText(time);
            const diff = new Date(time) - new Date();
            el.classList.toggle('cd-urgent', diff > 0 && diff < 60000);
        });
    }, 1000);
}

function scorePairs(format) {
    if (format === 'BO1') return [[1, 0], [0, 1]];
    if (format === 'BO5') return [[3, 0], [3, 1], [3, 2], [0, 3], [1, 3], [2, 3]];
    return [[2, 0], [2, 1], [0, 2], [1, 2]];
}

function scoreButtons(match, prediction) {
    return scorePairs(match.format).map(([a, b]) => {
        const winner = a > b ? match.team1_id : match.team2_id;
        const picked = prediction && prediction.predicted_team1_score === a && prediction.predicted_team2_score === b;
        const winnerName = a > b ? (match.team1_short_name || match.team1_name) : (match.team2_short_name || match.team2_name);
        return `<button class="score-pick ${picked ? 'picked' : ''}" onclick="event.stopPropagation(); predict(${match.id}, ${a}, ${b}, ${winner})">
            <strong>${a}-${b}</strong>
            <span>${escapeHtml(winnerName)}</span>
        </button>`;
    }).join('');
}

function matchCard(match) {
    const prediction = match.user_prediction;
    const canPredict = state.user && match.status === 'upcoming' && match.betting_enabled && new Date(match.match_time) > new Date();
    const canCancel = state.user && prediction && match.status === 'upcoming' && new Date(match.match_time) > new Date();
    const info = timeInfo(match.match_time);
    const displayStatus = match.display_status || (match.status === 'finished' ? 'finished' : new Date(match.match_time) <= new Date() ? 'ongoing' : 'upcoming');
    const isFinished = displayStatus === 'finished';
    const stateInfo = cardState(match, prediction);
    const rawStageLabel = match.name || match.stage_name || '常规赛';
    const stageLabel = rawStageLabel.replace(/:\s*[^:]+\s+vs\s+[^:]+$/i, '').trim() || match.stage_name || '常规赛';
    const team1Winner = isFinished && match.team1_score > match.team2_score;
    const team2Winner = isFinished && match.team2_score > match.team1_score;
    const predictionClass = prediction ? (match.is_forfeit ? 'forfeit' : prediction.points_earned > 0 ? 'correct' : prediction.points_earned === 0 ? 'wrong' : 'pending') : '';
    const cancelHtml = canCancel ? `<button class="link-btn danger" onclick="event.stopPropagation(); cancelPrediction(${match.id})">取消预测</button>` : '';
    const predictionFormHtml = canPredict
        ? `<div class="prediction-form" onclick="event.stopPropagation()"><label>选择比分</label><div class="score-picks">${scoreButtons(match, prediction)}</div>${cancelHtml}</div>`
        : (canCancel ? `<div class="prediction-form" onclick="event.stopPropagation()">${cancelHtml}</div>` : '');
    return `
        <article id="home-match-${match.id}" class="match-card ${stateInfo.className} ${match.game_type || ''} ${isFinished ? 'clickable' : ''}" ${isFinished ? `onclick="showMatchPredictions(${match.id})"` : ''}>
            <div class="match-header">
                <div class="match-tournament">
                    <span class="game-pill ${match.game_type || ''}">${gameName(match.game_type)}</span>
                    <span class="match-format">${escapeHtml(match.format)}</span>
                    <span class="tournament-name" title="${escapeHtml(match.tournament_name || '')}">${tournamentLogo(match.tournament_name, match.game_type, match.tournament_logo_url)}${escapeHtml(match.tournament_name || '')}</span>
                </div>
                <span class="match-status ${stateInfo.className}"${displayStatus === 'upcoming' ? ` data-countdown="${match.match_time}"` : ''}>${displayStatus === 'upcoming' ? countdownText(match.match_time) : stateInfo.label}</span>
            </div>
            <div class="match-stage">
                <strong>${escapeHtml(stageLabel)}</strong>
                <span>${info.exact}</span>
            </div>
            <div class="match-teams">
                <a class="team team-left team-link ${team1Winner ? 'winner' : ''}" href="/teams.html?team=${match.team1_id}" onclick="event.stopPropagation()">
                    ${logo(match.team1_logo_url, match.team1_dark_logo_url)}
                    <div><strong>${escapeHtml(match.team1_short_name || match.team1_name)}</strong><small>${escapeHtml(match.team1_name)}</small></div>
                </a>
                <div class="match-center">${isFinished ? `<div class="match-score"><span class="${team1Winner ? 'winner' : ''}">${match.team1_score}</span><em>:</em><span class="${team2Winner ? 'winner' : ''}">${match.team2_score}</span></div>` : '<div class="match-vs">VS</div>'}</div>
                <a class="team team-right team-link ${team2Winner ? 'winner' : ''}" href="/teams.html?team=${match.team2_id}" onclick="event.stopPropagation()">
                    ${logo(match.team2_logo_url, match.team2_dark_logo_url)}
                    <div><strong>${escapeHtml(match.team2_short_name || match.team2_name)}</strong><small>${escapeHtml(match.team2_name)}</small></div>
                </a>
            </div>
            <div class="match-footer"><span>${match.prediction_count || 0} 人预测</span><button class="link-btn h2h-trigger" onclick="event.stopPropagation(); showMatchHead2Head(${match.id})">对阵历史</button></div>
            ${prediction ? `<div class="user-prediction ${predictionClass}"><strong>我的预测</strong><span>${prediction.predicted_team1_score} : ${prediction.predicted_team2_score}</span>${match.is_forfeit ? '<b>弃权不计分</b>' : prediction.points_earned !== null ? `<b>+${prediction.points_earned} 分</b>` : '<b>待结算</b>'}</div>` : ''}
            ${predictionFormHtml}
        </article>`;
}

async function predict(matchId, s1, s2, winner) {
    try {
        await api(`/matches/${matchId}/predictions`, { method: 'POST', body: { predicted_team1_score: s1, predicted_team2_score: s2, predicted_winner_id: winner } });
        await loadMatches({ animate: false });
    } catch (error) { alert(error.message); }
}

async function cancelPrediction(matchId) {
    try {
        await api(`/matches/${matchId}/predictions`, { method: 'DELETE' });
        await loadMatches({ animate: false });
    } catch (error) { alert(error.message); }
}

function recentListHtml(items) {
    if (!items.length) return '<div class="h2h-empty">暂无已结算比赛</div>';
    return items.map(item => {
        const isWin = item.result === 'W';
        return `<li class="h2h-form-row">
            <span class="h2h-result ${isWin ? 'win' : 'loss'}">${isWin ? '胜' : '负'}</span>
            <a class="h2h-opp" href="/teams.html?team=${item.opponent_id}">${logo(item.opponent_logo_url, item.opponent_dark_logo_url)}<span>vs ${escapeHtml(item.opponent)}</span></a>
            <span class="h2h-score">${escapeHtml(item.score)}</span>
            <time class="h2h-date">${formatDateTime(item.match_time)}</time>
        </li>`;
    }).join('');
}

async function showMatchHead2Head(matchId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    try {
        const data = await api(`/matches/${matchId}/head2head`);
        const m = data.match;
        const formPanel = (team, side) => {
            const teamId = m[`${side}_id`];
            const name = m[`${side}_name`];
            const logoUrl = m[`${side}_logo_url`];
            const darkLogoUrl = m[`${side}_dark_logo_url`];
            const rate = team.wins + team.losses ? Math.round(team.wins / (team.wins + team.losses) * 100) : 0;
            return `
            <section class="h2h-panel">
                <header class="h2h-panel-head">
                    <a class="h2h-team-identity" href="/teams.html?team=${teamId}">${logo(logoUrl, darkLogoUrl)}<span><b>${escapeHtml(name)}</b><small>查看队伍详情</small></span></a>
                    <div class="h2h-record"><b>${rate}%</b><span>近况胜率 · ${team.wins}胜 ${team.losses}负</span></div>
                </header>
                <ol class="h2h-form">${recentListHtml(team.recent)}</ol>
            </section>`;
        };
        const h2hList = data.head_to_head.length
            ? data.head_to_head.map(h => {
                const team1Won = h.winner === 'team1';
                return `<li class="h2h-match-row">
                    <span class="h2h-score-line">
                        <b class="${team1Won ? 'win' : 'loss'}">${escapeHtml(m.team1_name)}</b>
                        <span>${h.team1_score} - ${h.team2_score}</span>
                        <b class="${team1Won ? 'loss' : 'win'}">${escapeHtml(m.team2_name)}</b>
                    </span>
                    <span class="h2h-tournament">${escapeHtml(h.tournament_name || '')}</span>
                    <time class="h2h-match-date">${formatDateTime(h.match_time)}</time>
                </li>`;
            }).join('')
            : '<div class="h2h-empty">两队暂无交手记录</div>';
        detailModalBodyEl.innerHTML = `
            <div class="h2h-hero">
                <a href="/teams.html?team=${m.team1_id}">${logo(m.team1_logo_url, m.team1_dark_logo_url)}<strong>${escapeHtml(m.team1_name)}</strong></a>
                <div><span>HEAD TO HEAD</span><b>VS</b><small>${m.format} · ${formatDateTime(m.match_time)}</small></div>
                <a href="/teams.html?team=${m.team2_id}">${logo(m.team2_logo_url, m.team2_dark_logo_url)}<strong>${escapeHtml(m.team2_name)}</strong></a>
            </div>
            <div class="h2h-grid">${formPanel(data.team1, 'team1')}${formPanel(data.team2, 'team2')}</div>
            <section class="h2h-panel h2h-h2h">
                <header class="h2h-section-head"><div><span>DIRECT MEETINGS</span><h3>交手记录</h3></div><b>${data.head_to_head.length} 场</b></header>
                <ol class="h2h-matches">${h2hList}</ol>
            </section>
        `;
        detailModalEl.hidden = false;
        document.body.classList.add('modal-open');
    } catch (error) {
        alert(error.message);
    }
}

async function loadMatches(opts = {}) {
    if (!matchesEl) return;
    const requestId = ++state.matchesRequestId;
    const params = new URLSearchParams();
    if (state.game) params.set('game_type', state.game);
    if (state.tournament) params.set('tournament_id', state.tournament);
    if (state.status) params.set('status', state.status);
    const data = await api(`/matches/upcoming${params.toString() ? `?${params}` : ''}`);
    if (requestId !== state.matchesRequestId) return;
    state.matches = data.matches || [];
    state.filterCounts = data.filters?.status_counts || { all: 0, finished: 0, ongoing: 0, upcoming: 0 };
    state.tournaments = data.filters?.tournaments || [];
    const validTournament = !state.tournament || state.tournaments.some(tournament => String(tournament.id) === String(state.tournament));
    if (!validTournament) {
        state.tournament = '';
        localStorage.setItem('homeTournamentFilter', '');
        return loadMatches(opts);
    }
    renderHomeFilters(data.filters || {});
    renderMatchResults(opts);
}

async function loadTournamentOptions() {
    await loadMatches();
}

const statusFilterOptions = [
    { value: '', label: '全部比赛', key: 'all' },
    { value: 'ongoing', label: '进行中', key: 'ongoing' },
    { value: 'upcoming', label: '即将开始', key: 'upcoming' },
    { value: 'finished', label: '已结束', key: 'finished' }
];

function renderHomeFilters(filters) {
    if (statusFiltersEl) {
        statusFiltersEl.innerHTML = statusFilterOptions.map(option => `
            <button type="button" class="status-filter ${state.status === option.value ? 'active' : ''}" onclick="setMatchStatus('${option.value}')" aria-pressed="${state.status === option.value}">
                <span>${option.label}</span>
            </button>`).join('');
    }
    const allTournamentCount = state.tournaments.reduce((total, tournament) => total + (tournament.match_count || 0), 0);
    const tournamentButton = tournament => `<button type="button" class="tournament-filter ${String(state.tournament) === String(tournament.id) ? 'active' : ''}" onclick="setTournament('${tournament.id}')" title="${escapeHtml(tournament.name)}">
        ${tournamentLogo(tournament.name, tournament.game_type, tournament.logo_url)}<span>${escapeHtml(tournament.name)}</span><b>${tournament.match_count || 0}</b>
    </button>`;
    if (tournamentFiltersEl) {
        tournamentFiltersEl.innerHTML = `<button type="button" class="tournament-filter ${state.tournament ? '' : 'active'}" onclick="setTournament('')"><span>全部赛事</span><b>${allTournamentCount}</b></button>${state.tournaments.map(tournamentButton).join('')}`;
    }
    if (tournamentFilterEl) {
        tournamentFilterEl.innerHTML = '<option value="">全部赛事</option>' + state.tournaments.map(tournament => `<option value="${tournament.id}">${escapeHtml(tournament.name)} (${tournament.match_count || 0})</option>`).join('');
        tournamentFilterEl.value = state.tournament;
    }
    const finishedDays = filters.finished_window_days || 1;
    const finishedWindow = finishedDays === 1 ? '最近 24 小时' : `最近 ${finishedDays} 天`;
    if (matchFilterSummaryEl) matchFilterSummaryEl.textContent = `未结束比赛 + ${finishedWindow}已结束比赛`;
}

function statusLabel(value) {
    return statusFilterOptions.find(option => option.value === value)?.label || '全部比赛';
}

function renderMatchResults(opts = {}) {
    // 入场动画门控：整页/切游戏加载播放入场动画（.anim-in），
    // 预测提交、取消预测等局部刷新不重播，避免整列表闪动。
    const animate = opts.animate !== false;
    if (animate) matchesEl.classList.add('anim-in');
    else matchesEl.classList.remove('anim-in');
    const selectedTournament = state.tournaments.find(tournament => String(tournament.id) === String(state.tournament));
    const titleParts = [selectedTournament?.name || '全部赛事', statusLabel(state.status)];
    if (matchResultsTitleEl) matchResultsTitleEl.textContent = titleParts.join(' · ');
    if (matchResultsMetaEl) matchResultsMetaEl.textContent = `${state.matches.length} 场 · ${gameName(state.game)}`;
    if (clearMatchFiltersEl) clearMatchFiltersEl.hidden = !state.status && !state.tournament;
    matchesEl.classList.toggle('grouped', !state.tournament);
    if (!state.matches.length) {
        matchesEl.innerHTML = '<div class="empty-state"><h3>当前筛选下暂无比赛</h3><p>请切换状态或赛事。</p></div>';
        return;
    }
    if (state.tournament) {
        matchesEl.innerHTML = state.matches.map(matchCard).join('');
        return;
    }
    const groups = [];
    const groupMap = new Map();
    for (const match of state.matches) {
        let group = groupMap.get(match.tournament_id);
        if (!group) {
            group = { id: match.tournament_id, name: match.tournament_name, game: match.game_type, logo: match.tournament_logo_url, matches: [] };
            groupMap.set(match.tournament_id, group);
            groups.push(group);
        }
        group.matches.push(match);
    }
    matchesEl.innerHTML = groups.map(group => `<section class="home-tournament-group">
        <header class="home-tournament-group-head">
            <button type="button" onclick="setTournament('${group.id}')">${tournamentLogo(group.name, group.game, group.logo)}<span>${escapeHtml(group.name)}</span></button>
            ${streakBadgeHtml(state.myStreaks?.[String(group.id)] || 0)}
        </header>
        <div class="home-tournament-matches">${group.matches.map(matchCard).join('')}</div>
    </section>`).join('');
}

async function loadLeaderboard() {}

// 拉取当前用户各赛事连胜（未登录静默跳过），供赛事组徽标展示
async function loadMine() {
    if (!state.token) return;
    try {
        const data = await api('/predictions/streaks/me');
        state.myStreaks = Object.fromEntries((data.streaks || []).map(item => [String(item.tournament_id), item.current]));
        renderMatchResults({ animate: false });
    } catch (error) { /* 连胜信息获取失败不影响主流程 */ }
}

// 选定要在主页展示赛程图的赛事：优先当前筛选，否则取第一个仍有未结束比赛的赛事。
function pickHomeBracketTournament() {
    if (state.tournament) return state.tournament;
    const list = state.tournaments || [];
    const active = list.find(t => (t.unfinished_count || 0) > 0);
    return active ? String(active.id) : (list[0] ? String(list[0].id) : '');
}

function renderHomeBracketShell(name, bodyHtml) {
    if (!homeBracketEl) return;
    if (!bodyHtml) { homeBracketEl.hidden = true; homeBracketEl.innerHTML = ''; return; }
    const collapsed = state.bracketCollapsed;
    homeBracketEl.hidden = false;
    homeBracketEl.classList.toggle('collapsed', collapsed);
    homeBracketEl.innerHTML = `
        <div class="home-bracket-head" onclick="toggleHomeBracket()" role="button" tabindex="0"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleHomeBracket();}">
            <div class="home-bracket-title"><strong>赛程图</strong><span>${escapeHtml(name || '')}</span></div>
            <span class="home-bracket-toggle">${collapsed ? '展开 ▾' : '收起 ▴'}</span>
        </div>
        <div class="home-bracket-body">${bodyHtml}</div>`;
}

function toggleHomeBracket() {
    state.bracketCollapsed = !state.bracketCollapsed;
    localStorage.setItem('homeBracketCollapsed', state.bracketCollapsed ? '1' : '0');
    if (!homeBracketEl) return;
    homeBracketEl.classList.toggle('collapsed', state.bracketCollapsed);
    const toggle = homeBracketEl.querySelector('.home-bracket-toggle');
    if (toggle) toggle.textContent = state.bracketCollapsed ? '展开 ▾' : '收起 ▴';
}

async function loadHomeBracket() {
    if (!homeBracketEl || typeof tournamentBracketSections !== 'function') return;
    const id = pickHomeBracketTournament();
    const requestId = ++state.bracketRequestId;
    if (!id) { renderHomeBracketShell('', ''); return; }
    try {
        const data = await api(`/tournaments/${id}`);
        if (requestId !== state.bracketRequestId || String(id) !== String(pickHomeBracketTournament())) return;
        const sections = tournamentBracketSections(data.matches || []);
        renderHomeBracketShell(data.tournament && data.tournament.name, sections);
    } catch (error) {
        if (requestId !== state.bracketRequestId) return;
        // 赛程图为辅助信息，加载失败静默隐藏，不打断主流程。
        console.error('home bracket:', error.message);
        renderHomeBracketShell('', '');
    }
}

// bracket.js 生成的图节点 onclick 调用 focusTournamentMatch：主页滚动并高亮对应比赛卡片。
async function focusTournamentMatch(matchId) {
    const card = document.getElementById(`home-match-${matchId}`);
    if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('match-row-highlight');
        requestAnimationFrame(() => card.classList.add('match-row-highlight'));
        window.setTimeout(() => card.classList.remove('match-row-highlight'), 1800);
        return;
    }
    try {
        const data = await api(`/matches/${matchId}`);
        const match = data.match;
        const visibleTournament = (state.tournaments || []).some(tournament => String(tournament.id) === String(match.tournament_id));
        if (!visibleTournament || match.team1_name === 'TBD' || match.team2_name === 'TBD') {
            location.href = `/tournaments.html?tournament=${match.tournament_id}#match-row-${matchId}`;
            return;
        }
        state.tournament = String(match.tournament_id);
        state.status = match.display_status || (match.status === 'finished' ? 'finished' : new Date(match.match_time) <= new Date() ? 'ongoing' : 'upcoming');
        localStorage.setItem('homeTournamentFilter', state.tournament);
        localStorage.setItem('homeStatusFilter', state.status);
        await loadMatches();
        const loadedCard = document.getElementById(`home-match-${matchId}`);
        if (!loadedCard) {
            location.href = `/tournaments.html?tournament=${match.tournament_id}#match-row-${matchId}`;
            return;
        }
        loadedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        loadedCard.classList.add('match-row-highlight');
        window.setTimeout(() => loadedCard.classList.remove('match-row-highlight'), 1800);
    } catch (error) {
        alert(error.message);
    }
}
window.toggleHomeBracket = toggleHomeBracket;
window.focusTournamentMatch = focusTournamentMatch;


// 切换游戏后同步 URL（?game=），刷新/分享可直达当前视图
function updateGameUrl() {
    const url = new URL(location.href);
    if (state.game) url.searchParams.set('game', state.game);
    else url.searchParams.delete('game');
    history.replaceState(null, '', url);
}

// 分段切换控件：高亮当前游戏（CS2 / Valorant / 全部）
function renderGameSwitch() {
    if (!gameSwitchEl) return;
    gameSwitchEl.querySelectorAll('button[data-game]').forEach(btn => {
        const active = (btn.dataset.game || '') === (state.game || '');
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

function bindGameSwitch() {
    if (!gameSwitchEl) return;
    gameSwitchEl.addEventListener('click', event => {
        const btn = event.target.closest('button[data-game]');
        if (btn) setGame(btn.dataset.game || '');
    });
}

// 切换游戏时立即进入加载态：清掉旧游戏的列表与筛选，
// 避免新数据返回前旧内容误导，也防止点击旧赛事按钮触发无效筛选
function renderHomeLoading() {
    state.matches = [];
    state.tournaments = [];
    state.filterCounts = { all: 0, finished: 0, ongoing: 0, upcoming: 0 };
    renderHomeFilters({});
    renderHomeBracketShell('', '');
    if (matchResultsTitleEl) matchResultsTitleEl.textContent = '正在加载…';
    if (matchResultsMetaEl) matchResultsMetaEl.textContent = gameName(state.game);
    if (matchesEl) matchesEl.innerHTML = '<div class="empty-state"><h3>正在加载比赛…</h3><p>切换游戏后重新获取赛程。</p></div>';
}

async function setGame(game) {
    // 点击当前已选中的游戏时不重复加载
    if ((game || '') === (state.game || '')) {
        renderGameSwitch();
        return;
    }
    state.game = game;
    localStorage.setItem('gameFilter', game);
    state.tournament = '';
    localStorage.setItem('homeTournamentFilter', '');
    updateGameUrl();
    renderGameSwitch();
    renderHomeLoading();
    try {
        await loadMatches();
        // 赛程图依赖 loadMatches 填充的赛事列表来挑选展示对象，必须串行
        await loadHomeBracket();
    } catch (error) {
        alert(error.message);
    }
}

function setTournament(tournamentId) {
    state.tournament = tournamentId;
    localStorage.setItem('homeTournamentFilter', tournamentId);
    Promise.all([loadMatches(), loadHomeBracket()]).catch(error => alert(error.message));
}

function setMatchStatus(status) {
    state.status = ['finished', 'ongoing', 'upcoming'].includes(status) ? status : '';
    localStorage.setItem('homeStatusFilter', state.status);
    Promise.all([loadMatches(), loadHomeBracket()]).catch(error => alert(error.message));
}

function clearMatchFilters() {
    state.status = '';
    state.tournament = '';
    localStorage.setItem('homeStatusFilter', '');
    localStorage.setItem('homeTournamentFilter', '');
    Promise.all([loadMatches(), loadHomeBracket()]).catch(error => alert(error.message));
}

function closeDetailModal() {
    if (detailModalEl) detailModalEl.hidden = true;
    if (detailModalBodyEl) detailModalBodyEl.innerHTML = '';
    document.body.classList.remove('modal-open');
}

function predictionDetailRow(prediction) {
    const points = prediction.points_earned ?? 0;
    const cls = points > 0 ? 'correct' : 'wrong';
    return `<li class="detail-row match-prediction-detail ${cls}">
        <strong class="detail-title">${escapeHtml(prediction.username)}</strong>
        <span class="detail-pick">预测 ${prediction.predicted_team1_score}-${prediction.predicted_team2_score} / ${escapeHtml(prediction.predicted_winner_name)}</span>
        <b class="detail-points">+${points} 分</b>
    </li>`;
}

async function showMatchPredictions(matchId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    try {
        const data = await api(`/matches/${matchId}/predictions`);
        const match = data.match;
        detailModalBodyEl.innerHTML = `
            <div class="modal-head">
                <span class="game-pill ${match.game_type || ''}">${gameName(match.game_type)}</span>
                <h2>${escapeHtml(match.team1_name)} ${match.team1_score}-${match.team2_score} ${escapeHtml(match.team2_name)}</h2>
                <p>${escapeHtml(match.tournament_name)} · ${escapeHtml(match.name || '常规赛程')} · ${formatDateTime(match.match_time)}</p>
                ${match.is_forfeit ? '<p class="forfeit-banner">本场因弃权按 1-0 判定，所有预测均不计入积分。</p>' : ''}
            </div>
            <ol class="detail-list">${data.predictions.map(predictionDetailRow).join('') || '<li class="empty-state">暂无预测</li>'}</ol>
        `;
        detailModalEl.hidden = false;
        document.body.classList.add('modal-open');
    } catch (error) {
        alert(error.message);
    }
}

async function loadAll() {
    renderUser();
    await loadMatches();
    await Promise.all([loadHomeBracket(), loadLeaderboard(), loadMine()]);
}

window.login = login;
window.register = register;
window.logout = logout;
window.predict = predict;
window.cancelPrediction = cancelPrediction;
window.showMatchHead2Head = showMatchHead2Head;
window.setGame = setGame;
window.setTournament = setTournament;
window.setMatchStatus = setMatchStatus;
window.clearMatchFilters = clearMatchFilters;
window.showMatchPredictions = showMatchPredictions;
window.closeDetailModal = closeDetailModal;

// URL ?game= 直达：优先于本地记忆，保证分享/刷新后视图一致
const urlGame = new URLSearchParams(location.search).get('game');
if (urlGame !== null && ['cs2', 'valorant'].includes(urlGame)) {
    state.game = urlGame;
    localStorage.setItem('gameFilter', urlGame);
}
renderGameSwitch();
bindGameSwitch();
loadAll().catch(error => alert(error.message));
startCountdownTicker();
