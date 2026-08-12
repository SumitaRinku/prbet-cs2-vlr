const state = {
    token: localStorage.getItem('token'),
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    matches: [],
    tournaments: [],
    game: localStorage.getItem('gameFilter') || 'cs2',
    tournament: localStorage.getItem('homeTournamentFilter') || '',
    bracketCollapsed: localStorage.getItem('homeBracketCollapsed') === '1'
};

const userPanelEl = document.querySelector('#userPanel');
const gameFilterEl = document.querySelector('#gameFilter');
const tournamentFilterEl = document.querySelector('#tournamentFilter');
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

function logo(url) {
    const src = proxiedLogoUrl(url);
    return src ? `<img src="${src}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'placeholder',textContent:'TEAM'}))">` : '<div class="placeholder">TEAM</div>';
}
// bracket.js 依赖的环境全局：主页用 logo 的等价实现提供 logoHtml。
window.logoHtml = logo;

function cardState(match, prediction) {
    const started = new Date(match.match_time) <= new Date();
    if (match.is_forfeit) return {
        className: 'match-forfeit',
        label: '弃权',
        phase: '对手弃权',
        hint: '本场因弃权按 1-0 判定，已结算但不计入积分。'
    };
    if (match.status === 'finished') return {
        className: 'match-finished',
        label: '已结算',
        phase: '赛果已出',
        hint: '本场比赛已完成结算，可以查看所有人的预测详情。'
    };
    if (match.status === 'ongoing' || started) return {
        className: 'match-settling',
        label: '等待结算',
        phase: match.status === 'ongoing' ? '比赛进行中' : '等待赛果同步',
        hint: prediction ? '你已完成预测，等待比赛结束后结算。' : '比赛已经开始，预测已关闭。'
    };
    if (match.betting_enabled && prediction) return {
        className: 'match-picked',
        label: '已竞猜',
        phase: '预测已提交',
        hint: '开赛前仍可重新提交比分预测。'
    };
    if (match.betting_enabled) return {
        className: 'match-open',
        label: '开放预测',
        phase: '可提交预测',
        hint: '选择比分并提交，开赛前都可以修改。'
    };
    return {
        className: 'match-closed',
        label: '未开放预测',
        phase: '暂未开放',
        hint: '管理员尚未开放本场预测。'
    };
}

function timeInfo(value) {
    const date = new Date(value);
    const diff = date - new Date();
    const exact = formatDateTime(value);
    if (diff <= 0) return { countdown: '已开始', exact };
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return { countdown: `${minutes}分钟后`, exact };
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return { countdown: `${hours}小时${minutes % 60}分钟后`, exact };
    return { countdown: `${Math.floor(hours / 24)}天${hours % 24}小时后`, exact };
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
    const isFinished = match.status === 'finished';
    const stateInfo = cardState(match, prediction);
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
                    <span class="tournament-name">${escapeHtml(match.tournament_name)}</span>
                </div>
                <span class="match-status ${stateInfo.className}">${stateInfo.label}</span>
            </div>
            <div class="match-stage">
                <strong>${stateInfo.phase}</strong>
                <span>${info.exact}</span>
            </div>
            <div class="match-state-note">${stateInfo.hint}</div>
            <div class="match-teams">
                <div class="team team-left ${team1Winner ? 'winner' : ''}">
                    ${logo(match.team1_logo_url)}
                    <div><strong>${escapeHtml(match.team1_short_name || match.team1_name)}</strong><small>${escapeHtml(match.team1_name)}</small></div>
                </div>
                <div class="match-center">${isFinished ? `<div class="match-score"><span class="${team1Winner ? 'winner' : ''}">${match.team1_score}</span><em>:</em><span class="${team2Winner ? 'winner' : ''}">${match.team2_score}</span></div>` : '<div class="match-vs">VS</div>'}</div>
                <div class="team team-right ${team2Winner ? 'winner' : ''}">
                    ${logo(match.team2_logo_url)}
                    <div><strong>${escapeHtml(match.team2_short_name || match.team2_name)}</strong><small>${escapeHtml(match.team2_name)}</small></div>
                </div>
            </div>
            <div class="match-footer"><span>${escapeHtml(match.name || '常规赛程')}</span><span>${match.prediction_count || 0} 人预测</span><button class="link-btn" onclick="event.stopPropagation(); showMatchHead2Head(${match.id})">对阵历史</button></div>
            ${prediction ? `<div class="user-prediction ${predictionClass}"><strong>我的预测</strong><span>${prediction.predicted_team1_score} : ${prediction.predicted_team2_score}</span>${match.is_forfeit ? '<b>弃权不计分</b>' : prediction.points_earned !== null ? `<b>+${prediction.points_earned} 分</b>` : '<b>待结算</b>'}</div>` : ''}
            ${isFinished ? '<div class="detail-hint">点击查看所有人的预测详情</div>' : ''}
            ${predictionFormHtml}
        </article>`;
}

async function predict(matchId, s1, s2, winner) {
    try {
        await api(`/matches/${matchId}/predictions`, { method: 'POST', body: { predicted_team1_score: s1, predicted_team2_score: s2, predicted_winner_id: winner } });
        await loadMatches();
    } catch (error) { alert(error.message); }
}

async function cancelPrediction(matchId) {
    try {
        await api(`/matches/${matchId}/predictions`, { method: 'DELETE' });
        await loadMatches();
    } catch (error) { alert(error.message); }
}

function recentListHtml(items) {
    if (!items.length) return '<li class="empty-state">暂无已结算比赛</li>';
    return items.map(item => {
        const cls = item.result === 'W' ? 'win' : 'loss';
        return `<li class="detail-row h2h-row ${cls}">
            <strong class="detail-title">${escapeHtml(item.opponent)}</strong>
            <span class="detail-match">${escapeHtml(item.score)} ${item.result === 'W' ? '胜' : '负'}</span>
            <span class="detail-pick">${escapeHtml(item.tournament_name || '')}</span>
            <b class="detail-points">${formatDateTime(item.match_time)}</b>
        </li>`;
    }).join('');
}

async function showMatchHead2Head(matchId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    try {
        const data = await api(`/matches/${matchId}/head2head`);
        const m = data.match;
        const teamPanel = (team, name) => `
            <div class="h2h-team">
                <h4>${escapeHtml(name)} <span class="h2h-record">${escapeHtml(team.label)}</span></h4>
                <ol class="detail-list">${recentListHtml(team.recent)}</ol>
            </div>`;
        const h2hRows = data.head_to_head.length
            ? data.head_to_head.map(h => {
                const cls = h.winner === 'team1' ? 'win' : 'loss';
                return `<li class="detail-row h2h-row ${cls}">
                    <strong class="detail-title">${escapeHtml(m.team1_name)} ${h.team1_score}-${h.team2_score} ${escapeHtml(m.team2_name)}</strong>
                    <span class="detail-match">${escapeHtml(h.tournament_name || '')}</span>
                    <b class="detail-points">${formatDateTime(h.match_time)}</b>
                </li>`;
            }).join('')
            : '<li class="empty-state">两队暂无交手记录</li>';
        detailModalBodyEl.innerHTML = `
            <div class="modal-head">
                <h2>${escapeHtml(m.team1_name)} vs ${escapeHtml(m.team2_name)}</h2>
                <p>双方近期战绩与交手历史</p>
            </div>
            <div class="h2h-grid">${teamPanel(data.team1, m.team1_name)}${teamPanel(data.team2, m.team2_name)}</div>
            <h3 class="h2h-subtitle">交手历史</h3>
            <ol class="detail-list">${h2hRows}</ol>
        `;
        detailModalEl.hidden = false;
        document.body.classList.add('modal-open');
    } catch (error) {
        alert(error.message);
    }
}

async function loadMatches() {
    if (!matchesEl) return;
    const params = new URLSearchParams();
    if (state.game) params.set('game_type', state.game);
    if (state.tournament) params.set('tournament_id', state.tournament);
    const data = await api(`/matches/upcoming${params.toString() ? `?${params}` : ''}`);
    state.matches = data.matches;
    matchesEl.innerHTML = data.matches.map(matchCard).join('') || '<div class="empty-state"><h3>暂无比赛</h3><p>请等待 PandaScore 同步或切换筛选条件。</p></div>';
}

async function loadTournamentOptions() {
    if (!tournamentFilterEl) return;
    const params = new URLSearchParams();
    if (state.game) params.set('game_type', state.game);
    const data = await api(`/tournaments${params.toString() ? `?${params}` : ''}`);
    state.tournaments = data.tournaments;
    const valid = data.tournaments.some(tournament => String(tournament.id) === String(state.tournament));
    if (!valid) {
        state.tournament = '';
        localStorage.setItem('homeTournamentFilter', '');
    }
    tournamentFilterEl.innerHTML = '<option value="">全部赛事</option>' + data.tournaments.map(tournament => `<option value="${tournament.id}">${escapeHtml(tournament.name)}</option>`).join('');
    tournamentFilterEl.value = state.tournament;
}

async function loadLeaderboard() {}
async function loadMine() {}

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
    if (!id) { renderHomeBracketShell('', ''); return; }
    try {
        const data = await api(`/tournaments/${id}`);
        const sections = tournamentBracketSections(data.matches || []);
        renderHomeBracketShell(data.tournament && data.tournament.name, sections);
    } catch (error) {
        // 赛程图为辅助信息，加载失败静默隐藏，不打断主流程。
        console.error('home bracket:', error.message);
        renderHomeBracketShell('', '');
    }
}

// bracket.js 生成的图节点 onclick 调用 focusTournamentMatch：主页滚动并高亮对应比赛卡片。
function focusTournamentMatch(matchId) {
    const card = document.getElementById(`home-match-${matchId}`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('match-row-highlight');
    requestAnimationFrame(() => card.classList.add('match-row-highlight'));
    window.setTimeout(() => card.classList.remove('match-row-highlight'), 1800);
}
window.toggleHomeBracket = toggleHomeBracket;
window.focusTournamentMatch = focusTournamentMatch;


function setGame(game) {
    state.game = game;
    localStorage.setItem('gameFilter', game);
    loadTournamentOptions().then(loadAll).catch(error => alert(error.message));
}

function setTournament(tournamentId) {
    state.tournament = tournamentId;
    localStorage.setItem('homeTournamentFilter', tournamentId);
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
    await Promise.all([loadMatches(), loadHomeBracket(), loadLeaderboard(), loadMine()]);
}

window.login = login;
window.register = register;
window.logout = logout;
window.predict = predict;
window.cancelPrediction = cancelPrediction;
window.showMatchHead2Head = showMatchHead2Head;
window.setGame = setGame;
window.setTournament = setTournament;
window.showMatchPredictions = showMatchPredictions;
window.closeDetailModal = closeDetailModal;

if (gameFilterEl) gameFilterEl.value = state.game;
loadTournamentOptions().then(loadAll).catch(error => alert(error.message));
