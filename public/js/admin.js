const state = {
    token: localStorage.getItem('token'),
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    game: localStorage.getItem('adminGameFilter') || '',
    tournaments: [],
    teams: [],
    matches: [],
    users: [],
    predictions: []
};

async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    // token 过期/失效：清理登录态（登录接口的 401 是凭据错误，不触发登出）
    if (res.status === 401 && state.token && !path.startsWith('/auth/')) {
        logout();
        throw new Error('登录已过期，请重新登录');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
}

function query() {
    return state.game ? `?game_type=${state.game}` : '';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderAuth() {
    const el = document.querySelector('#auth');
    if (!state.user) {
        el.innerHTML = '<input id="username" placeholder="用户名"><input id="password" type="password" placeholder="密码"><button onclick="login()">登录</button>';
    } else {
        el.innerHTML = `<span>${escapeHtml(state.user.username)}</span><button onclick="logout()">退出</button>`;
    }
}

async function login() {
    try {
        const data = await api('/auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        renderAuth();
        await loadAdmin();
    } catch (error) { alert(error.message); }
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    state.token = null;
    state.user = null;
    renderAuth();
}

function showTab(name, button) {
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelector(`#tab-${name}`).classList.add('active');
    document.querySelectorAll('.tabs button').forEach(tab => tab.classList.remove('active'));
    button.classList.add('active');
}

function setGame(game) {
    state.game = game;
    localStorage.setItem('adminGameFilter', game);
    syncFormGames();
    loadAdmin();
}

function syncFormGames() {
    if (state.game) {
        tourGame.value = state.game;
        teamGame.value = state.game;
    }
}

async function syncNow() {
    try {
        syncResult.textContent = '同步中，当前会同时拉取 CS2 和 Valorant...';
        const data = await api('/admin/sync/pandascore', { method: 'POST' });
        syncResult.textContent = JSON.stringify(data, null, 2);
        await loadAdmin();
    } catch (error) { syncResult.textContent = error.message; }
}

function fillSelect(select, rows, label) {
    select.innerHTML = rows.map(row => `<option value="${row.id}">${escapeHtml(label(row))}</option>`).join('');
}

function fillSelectWithAll(select, rows, allLabel, label) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + rows.map(row => `<option value="${row.id}">${escapeHtml(label(row))}</option>`).join('');
    if (rows.some(row => String(row.id) === current)) select.value = current;
}

function actionButton(text, fn, danger = false) {
    return `<button class="${danger ? 'danger' : ''}" onclick="${fn}">${text}</button>`;
}

function fmt(value) {
    return value ? new Date(value).toLocaleString() : '';
}

function dateOnly(value) {
    return value ? String(value).slice(0, 10) : '';
}

function teamLogoSrc(url) {
    if (!url) return '';
    // 本地/相对路径（如 TBD 占位盾牌 /images/team-tbd.svg）直接引用，不走外部 logo 代理。
    if (/^\/(?!\/)/.test(url) || url.startsWith('data:')) return url;
    return `/api/images/team-logo?url=${encodeURIComponent(url)}`;
}

function fieldValue(id) {
    const el = document.querySelector(`#${id}`);
    return el ? el.value : '';
}

function sourceOf(row) {
    return row.external_source || 'manual';
}

function filteredMatches() {
    const tournamentId = fieldValue('filterMatchTournament');
    const status = fieldValue('filterMatchStatus');
    const betting = fieldValue('filterMatchBetting');
    return state.matches.filter(row => {
        if (tournamentId && String(row.tournament_id) !== tournamentId) return false;
        if (status && row.status !== status) return false;
        if (betting && String(row.betting_enabled) !== betting) return false;
        return true;
    });
}

function filteredTournaments() {
    const active = fieldValue('filterTournamentActive');
    const source = fieldValue('filterTournamentSource');
    return state.tournaments.filter(row => {
        if (active && String(row.is_active) !== active) return false;
        if (source && sourceOf(row) !== source) return false;
        return true;
    });
}

function filteredTeams() {
    const keyword = fieldValue('filterTeamKeyword').trim().toLowerCase();
    const source = fieldValue('filterTeamSource');
    return state.teams.filter(row => {
        if (keyword && !`${row.name || ''} ${row.short_name || ''}`.toLowerCase().includes(keyword)) return false;
        if (source && sourceOf(row) !== source) return false;
        return true;
    });
}

function filteredUsers() {
    const keyword = fieldValue('filterUserKeyword').trim().toLowerCase();
    const role = fieldValue('filterUserRole');
    return state.users.filter(row => {
        if (keyword && !String(row.username || '').toLowerCase().includes(keyword)) return false;
        if (role && row.role !== role) return false;
        return true;
    });
}

function filteredPredictions() {
    const keyword = fieldValue('filterPredictionKeyword').trim().toLowerCase();
    const status = fieldValue('filterPredictionStatus');
    return state.predictions.filter(row => {
        if (keyword && !`${row.username || ''} ${row.team1_name || ''} ${row.team2_name || ''}`.toLowerCase().includes(keyword)) return false;
        if (status === 'finished' && row.match_status !== 'finished') return false;
        if (status === 'pending' && row.match_status === 'finished') return false;
        return true;
    });
}

function applyAdminFilters() {
    renderMatches(filteredMatches());
    renderTournaments(filteredTournaments());
    renderTeams(filteredTeams());
    renderUsers(filteredUsers());
    renderPredictions(filteredPredictions());
}

async function loadAdmin() {
    if (!state.user) return;
    gameFilter.value = state.game;
    const [stats, tournaments, teams, matches, users, predictions] = await Promise.all([
        api(`/admin/stats${query()}`),
        api(`/admin/tournaments${query()}`),
        api(`/admin/teams${query()}`),
        api(`/admin/matches${query()}`),
        api('/admin/users'),
        api('/admin/predictions')
    ]);
    renderStats(stats);
    state.tournaments = tournaments.tournaments;
    state.teams = teams.teams;
    state.matches = matches.matches;
    state.users = users.users;
    state.predictions = predictions.predictions;
    fillSelect(matchTournament, tournaments.tournaments, row => `${row.name} (${row.game_type})`);
    fillSelect(matchTeam1, teams.teams, row => `${row.name} (${row.game_type})`);
    fillSelect(matchTeam2, teams.teams, row => `${row.name} (${row.game_type})`);
    fillSelectWithAll(document.querySelector('#filterMatchTournament'), tournaments.tournaments, '全部赛事', row => `${row.name} (${row.game_type})`);
    applyAdminFilters();
    syncFormGames();
}

function renderStats(data) {
    stats.innerHTML = Object.entries(data).filter(([k]) => k !== 'sync').map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
    sync.textContent = JSON.stringify(data.sync, null, 2);
}

function renderMatches(rows) {
    matches.innerHTML = rows.map(m => `<tr>
        <td data-label="ID">${m.id}</td><td data-label="游戏">${escapeHtml(m.game_type)}</td><td data-label="赛事">${escapeHtml(m.tournament_name)}</td><td data-label="对阵">${escapeHtml(m.team1_name)} vs ${escapeHtml(m.team2_name)}</td><td data-label="赛制">${escapeHtml(m.format)}</td><td data-label="时间">${fmt(m.match_time)}</td><td data-label="状态">${m.is_forfeit ? '弃权' : escapeHtml(m.status)}</td><td data-label="比分">${m.team1_score ?? ''}-${m.team2_score ?? ''}</td>
        <td data-label="操作" class="actions">${actionButton(m.betting_enabled ? '关预测' : '开预测', `toggleBetting(${m.id})`)}${actionButton('录赛果', `setResult(${m.id})`)}${actionButton('设弃权', `setForfeit(${m.id})`)}${actionButton('编辑', `editMatch(${m.id})`)}${actionButton('删除', `deleteMatch(${m.id})`, true)}</td>
    </tr>`).join('');
}

function renderTournaments(rows) {
    tournaments.innerHTML = rows.map(t => `<tr class="${t.is_active ? '' : 'disabled-row'}">
        <td data-label="ID">${t.id}</td><td data-label="名称">${escapeHtml(t.name)}</td><td data-label="游戏">${escapeHtml(t.game_type)}</td><td data-label="状态">${t.is_active ? '启用' : '禁用'}</td><td data-label="开始">${dateOnly(t.begin_at)}</td><td data-label="结束">${dateOnly(t.end_at)}</td><td data-label="比赛数">${t.match_count}</td><td data-label="来源">${escapeHtml(t.external_source || 'manual')}</td>
        <td data-label="操作" class="actions">${actionButton(t.is_active ? '禁用' : '启用', `toggleTournament(${t.id})`, !t.is_active)}${actionButton('编辑', `editTournament(${t.id})`)}${actionButton('删除', `deleteTournament(${t.id})`, true)}</td>
    </tr>`).join('');
}

function renderTeams(rows) {
    teams.innerHTML = rows.map(t => `<tr>
        <td data-label="ID">${t.id}</td><td data-label="队伍">${t.logo_url ? `<img class="tiny-logo" src="${escapeHtml(teamLogoSrc(t.logo_url))}" alt="">` : ''}${escapeHtml(t.name)}</td><td data-label="游戏">${escapeHtml(t.game_type)}</td><td data-label="简称">${escapeHtml(t.short_name || '')}</td><td data-label="国家">${escapeHtml(t.country || '')}</td><td data-label="来源">${escapeHtml(t.external_source || 'manual')}</td>
        <td data-label="操作" class="actions">${actionButton('编辑', `editTeam(${t.id})`)}${actionButton('删除', `deleteTeam(${t.id})`, true)}</td>
    </tr>`).join('');
}

function renderUsers(rows) {
    users.innerHTML = rows.map(u => `<tr>
        <td data-label="ID">${u.id}</td><td data-label="用户名">${escapeHtml(u.username)}</td><td data-label="角色">${escapeHtml(u.role)}</td><td data-label="积分">${u.total_score}</td><td data-label="预测数">${u.prediction_count}</td><td data-label="注册时间">${fmt(u.created_at)}</td>
        <td data-label="操作" class="actions">${actionButton(u.role === 'admin' ? '设用户' : '设管理', `toggleRole(${u.id}, '${escapeHtml(u.role)}')`)}${actionButton('重置密码', `resetPassword(${u.id})`)}${actionButton('删除', `deleteUser(${u.id})`, true)}</td>
    </tr>`).join('');
}

function renderPredictions(rows) {
    predictions.innerHTML = rows.map(p => `<tr>
        <td data-label="ID">${p.id}</td><td data-label="用户">${escapeHtml(p.username)}</td><td data-label="比赛">${escapeHtml(p.team1_name)} vs ${escapeHtml(p.team2_name)}</td><td data-label="预测">${p.predicted_team1_score}-${p.predicted_team2_score} / ${escapeHtml(p.predicted_winner_name)}</td><td data-label="状态">${p.match_is_forfeit ? '弃权' : escapeHtml(p.match_status)}</td><td data-label="得分">${p.match_is_forfeit ? '弃权不计分' : (p.points_earned ?? '未结算')}</td><td data-label="提交时间">${fmt(p.created_at)}</td>
        <td data-label="操作" class="actions">${actionButton('删除', `deletePrediction(${p.id})`, true)}</td>
    </tr>`).join('');
}

async function createTournament() {
    await api('/admin/tournaments', { method: 'POST', body: { name: tourName.value, game_type: tourGame.value, begin_at: tourBegin.value, end_at: tourEnd.value, is_active: 1 } });
    tourName.value = '';
    await loadAdmin();
}

async function editTournament(id) {
    const row = state.tournaments.find(item => item.id === id);
    if (!row) { alert('赛事不存在，请刷新'); return; }
    const name = prompt('赛事名称', row.name);
    if (name === null) return;
    await api(`/admin/tournaments/${id}`, { method: 'PUT', body: { name, game_type: row.game_type, begin_at: row.begin_at, end_at: row.end_at, is_active: row.is_active } });
    await loadAdmin();
}

async function toggleTournament(id) {
    const row = state.tournaments.find(item => item.id === id);
    if (row?.is_active && !confirm('禁用后该赛事不会在前台展示，后续自动同步也会跳过该赛事。确认禁用？')) return;
    await api(`/admin/tournaments/${id}/toggle-active`, { method: 'PUT' });
    await loadAdmin();
}

async function deleteTournament(id) {
    if (!confirm('确认删除赛事？')) return;
    await api(`/admin/tournaments/${id}`, { method: 'DELETE' });
    await loadAdmin();
}

async function createTeam() {
    await api('/admin/teams', { method: 'POST', body: { name: teamName.value, game_type: teamGame.value, short_name: teamShort.value, logo_url: teamLogo.value, country: teamCountry.value } });
    teamName.value = teamShort.value = teamLogo.value = teamCountry.value = '';
    await loadAdmin();
}

async function editTeam(id) {
    const row = state.teams.find(item => item.id === id);
    if (!row) { alert('队伍不存在，请刷新'); return; }
    const name = prompt('队伍名称', row.name);
    if (name === null) return;
    await api(`/admin/teams/${id}`, { method: 'PUT', body: { ...row, name } });
    await loadAdmin();
}

async function deleteTeam(id) {
    if (!confirm('确认删除队伍？')) return;
    await api(`/admin/teams/${id}`, { method: 'DELETE' });
    await loadAdmin();
}

async function createMatch() {
    await api('/admin/matches', { method: 'POST', body: { tournament_id: matchTournament.value, team1_id: matchTeam1.value, team2_id: matchTeam2.value, format: matchFormat.value, match_time: new Date(matchTime.value).toISOString(), name: matchName.value } });
    matchName.value = '';
    await loadAdmin();
}

async function editMatch(id) {
    const row = state.matches.find(item => item.id === id);
    if (!row) { alert('比赛不存在，请刷新'); return; }
    const status = prompt('状态 upcoming/ongoing/finished/cancelled/postponed', row.status);
    if (status === null) return;
    await api(`/admin/matches/${id}`, { method: 'PUT', body: { status } });
    await loadAdmin();
}

async function setResult(id) {
    const score = prompt('输入比分，例如 2-1');
    if (!score) return;
    const parts = score.split('-').map(s => Number(s.trim()));
    if (parts.length !== 2 || !Number.isInteger(parts[0]) || !Number.isInteger(parts[1])) {
        alert('比分格式不正确，请用「2-1」这种格式');
        return;
    }
    await api(`/admin/matches/${id}/result`, { method: 'PUT', body: { team1_score: parts[0], team2_score: parts[1] } });
    await loadAdmin();
}

async function setForfeit(id) {
    const row = state.matches.find(item => item.id === id);
    if (!row) { alert('比赛不存在，请刷新'); return; }
    const choice = prompt(`弃权判定：胜方是哪支队伍？\n1 = ${row.team1_name}\n2 = ${row.team2_name}`);
    if (choice !== '1' && choice !== '2') { if (choice !== null) alert('请输入 1 或 2'); return; }
    const winnerTeamId = choice === '1' ? row.team1_id : row.team2_id;
    await api(`/admin/matches/${id}/forfeit`, { method: 'PUT', body: { winner_team_id: winnerTeamId } });
    await loadAdmin();
}

async function toggleBetting(id) {
    await api(`/admin/matches/${id}/betting`, { method: 'PUT' });
    await loadAdmin();
}

async function deleteMatch(id) {
    if (!confirm('确认删除比赛？相关预测也会删除。')) return;
    await api(`/admin/matches/${id}`, { method: 'DELETE' });
    await loadAdmin();
}

async function createUser() {
    await api('/admin/users', { method: 'POST', body: { username: newUsername.value, password: newPassword.value, role: newRole.value } });
    newUsername.value = newPassword.value = '';
    await loadAdmin();
}

async function toggleRole(id, role) {
    await api(`/admin/users/${id}/role`, { method: 'PUT', body: { role: role === 'admin' ? 'user' : 'admin' } });
    await loadAdmin();
}

async function resetPassword(id) {
    const password = prompt('输入新密码，至少6位');
    if (!password) return;
    await api(`/admin/users/${id}/password`, { method: 'PUT', body: { password } });
    alert('密码已重置');
}

async function deleteUser(id) {
    if (!confirm('确认删除用户？')) return;
    await api(`/admin/users/${id}`, { method: 'DELETE' });
    await loadAdmin();
}

async function deletePrediction(id) {
    if (!confirm('确认删除预测？')) return;
    await api(`/admin/predictions/${id}`, { method: 'DELETE' });
    await loadAdmin();
}

// 给所有后台操作统一包一层错误提示，避免静默失败（未处理的 promise rejection）
function withErrorAlert(fn) {
    return async (...args) => {
        try {
            await fn(...args);
        } catch (error) {
            alert(error.message || '操作失败');
        }
    };
}

const adminActions = { login, logout, syncNow, createTournament, editTournament, toggleTournament, deleteTournament, createTeam, editTeam, deleteTeam, createMatch, editMatch, setResult, setForfeit, toggleBetting, deleteMatch, createUser, toggleRole, resetPassword, deleteUser, deletePrediction };
for (const key of Object.keys(adminActions)) adminActions[key] = withErrorAlert(adminActions[key]);

Object.assign(window, adminActions, { showTab, setGame, applyAdminFilters });
renderAuth();
loadAdmin().catch(error => console.warn(error.message));
