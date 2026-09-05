// ===== 管理后台 =====
// 依赖 /js/tournament-logos.js（须先加载）：tournamentLogo / tournamentLogoUrl

const state = {
    token: localStorage.getItem('token'),
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    game: localStorage.getItem('adminGameFilter') || '',
    tournaments: [],
    teams: [],
    matches: [],
    users: [],
    predictions: [],
    // 每个表格当前渲染的行数上限（移动端卡片式行很高，全量渲染会拖垮长列表）
    rowLimits: {}
};

const ROW_PAGE_SIZE = 60;

// ---------- 基础 ----------

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

function fmt(value) {
    return value ? new Date(value).toLocaleString() : '';
}

function dateOnly(value) {
    return value ? String(value).slice(0, 10) : '';
}

// datetime-local 需要 yyyy-MM-ddTHH:mm 本地格式，toISOString 会带 Z 且是 UTC
function toLocalDateTimeInput(value) {
    if (!value) return '';
    const d = new Date(value);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function teamLogoSrc(url) {
    if (!url) return '';
    // 本地/相对路径（如 TBD 占位盾牌 /images/team-tbd.svg）直接引用，不走外部 logo 代理。
    if (/^\/(?!\/)/.test(url) || url.startsWith('data:')) return url;
    return `/api/images/team-logo?url=${encodeURIComponent(url)}`;
}

// 赛事 logo：与前台完全一致的优先级（手动上传 > 名称匹配精选映射），
// 数据库里的 PandaScore 远程 logo_url 不在前台使用，后台同样不展示。
function tournamentLogoImg(name, gameType, logoUrl) {
    return tournamentLogo(name, gameType, logoUrl && logoUrl.startsWith('/uploads/') ? logoUrl : null);
}

function fieldValue(id) {
    const el = document.querySelector(`#${id}`);
    return el ? el.value : '';
}

function sourceOf(row) {
    return row.external_source || 'manual';
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

// ---------- 登录 ----------

function renderAuth() {
    const el = document.querySelector('#auth');
    if (!state.user) {
        el.innerHTML = '<input id="username" placeholder="用户名"><input id="password" type="password" placeholder="密码"><button onclick="login()">登录</button>';
    } else {
        el.innerHTML = `<span>${escapeHtml(state.user.username)}${state.user.role === 'admin' ? ' · 管理员' : ''}</span><button onclick="logout()">退出</button>`;
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

// ---------- 导航 ----------

const ADMIN_TABS = ['matches', 'tournaments', 'teams', 'users', 'predictions'];

function showTab(name, { updateHash = true } = {}) {
    if (!ADMIN_TABS.includes(name)) name = 'matches';
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelector(`#tab-${name}`).classList.add('active');
    document.querySelectorAll('.admin-nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
    if (updateHash) location.hash = `tab-${name}`;
}

function initTabFromHash() {
    const name = (location.hash.match(/^#tab-([a-z]+)/) || [])[1];
    showTab(name || 'matches', { updateHash: false });
}

// 新增表单折叠开关（section-head 按钮与 details 联动）
function toggleCreateForm(id) {
    const details = document.getElementById(id);
    if (details) details.open = !details.open;
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

// ---------- 模态框 ----------

let modalSubmitHandler = null;

function openAdminModal({ title, hint = '', body, submitText = '保存', onSubmit }) {
    document.getElementById('adminModalTitle').textContent = title;
    document.getElementById('adminModalHint').textContent = hint;
    document.getElementById('adminModalBody').innerHTML = body;
    const submitBtn = document.getElementById('adminModalSubmit');
    submitBtn.textContent = submitText;
    modalSubmitHandler = onSubmit;
    document.getElementById('adminModal').hidden = false;
    document.body.classList.add('modal-open');
    // 自动聚焦第一个输入
    const first = document.querySelector('#adminModalBody input, #adminModalBody select, #adminModalBody textarea');
    if (first) first.focus();
}

function closeAdminModal() {
    document.getElementById('adminModal').hidden = true;
    modalSubmitHandler = null;
    document.body.classList.remove('modal-open');
}

async function submitAdminModal() {
    if (!modalSubmitHandler) return;
    const handler = modalSubmitHandler;
    try {
        await handler();
        closeAdminModal();
    } catch (error) {
        alert(error.message || '操作失败');
    }
}

// 模态框内表单控件：label + 控件 的统一行
function modalField(label, controlHtml) {
    return `<div class="admin-modal-field"><label>${escapeHtml(label)}</label>${controlHtml}</div>`;
}

// ---------- 同步 ----------

async function syncNow() {
    const info = document.getElementById('syncInfo');
    const badge = document.getElementById('syncBadge');
    try {
        badge.textContent = '同步中…';
        await api('/admin/sync/pandascore', { method: 'POST' });
        badge.textContent = '同步完成';
        await loadAdmin();
    } catch (error) {
        badge.textContent = '同步失败';
        info.hidden = false;
        info.textContent = error.message;
    }
}

// ---------- 数据加载 ----------

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

// ---------- 统计渲染 ----------

const STAT_LABELS = {
    users: '注册用户',
    tournaments: '赛事',
    teams: '队伍',
    matches: '比赛',
    predictions: '预测总数'
};

const SYNC_STATUS_LABELS = { running: '进行中', success: '成功', failed: '失败', skipped: '跳过' };

function renderStats(data) {
    stats.innerHTML = Object.entries(data)
        .filter(([k]) => k !== 'sync')
        .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${STAT_LABELS[k] || k}</span></div>`)
        .join('');
    renderSyncStatus(data.sync || {});
}

function renderSyncStatus(sync) {
    const badge = document.getElementById('syncBadge');
    const info = document.getElementById('syncInfo');
    if (!sync.configured) {
        badge.textContent = '未配置同步';
        badge.className = 'admin-sync-badge warn';
        info.hidden = true;
        return;
    }
    if (!sync.enabled) {
        badge.textContent = '同步已停用';
        badge.className = 'admin-sync-badge warn';
        info.hidden = true;
        return;
    }
    if (sync.running) {
        badge.textContent = '同步进行中';
        badge.className = 'admin-sync-badge live';
        info.hidden = true;
        return;
    }
    const run = sync.last_run;
    if (!run) {
        badge.textContent = '等待首次同步';
        badge.className = 'admin-sync-badge';
        info.hidden = true;
        return;
    }
    badge.textContent = `上次同步${SYNC_STATUS_LABELS[run.status] || run.status}`;
    badge.className = `admin-sync-badge ${run.status === 'success' ? 'ok' : run.status === 'failed' ? 'bad' : 'warn'}`;
    const parts = [`开始：${fmt(run.started_at)}`];
    if (run.finished_at) parts.push(`完成：${fmt(run.finished_at)}`);
    if (run.status === 'success') parts.push(`写入 赛事 ${run.tournaments_upserted} / 队伍 ${run.teams_upserted} / 比赛 ${run.matches_upserted}`);
    if (run.message) parts.push(`消息：${run.message}`);
    info.textContent = parts.join(' · ');
    info.hidden = false;
}

// ---------- 筛选 ----------

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

// ---------- 表格渲染 ----------

function emptyRow(colCount, text = '当前筛选下暂无数据') {
    return `<tr class="admin-empty-row"><td colspan="${colCount}">${escapeHtml(text)}</td></tr>`;
}

// 行分页：默认渲染前 ROW_PAGE_SIZE 行，超出部分点"显示更多"追加
function rowLimitOf(tab) {
    return state.rowLimits[tab] || ROW_PAGE_SIZE;
}

function moreRowsRow(tab, total, colCount) {
    const limit = rowLimitOf(tab);
    if (total <= limit) return '';
    return `<tr class="admin-more-row"><td colspan="${colCount}"><button class="ghost" onclick="loadMoreRows('${tab}')">显示更多（剩余 ${total - limit} 条）</button></td></tr>`;
}

function loadMoreRows(tab) {
    state.rowLimits[tab] = rowLimitOf(tab) + ROW_PAGE_SIZE;
    applyAdminFilters();
}

function renderMatches(rows) {
    matches.innerHTML = rows.length ? rows.slice(0, rowLimitOf('matches')).map(m => `<tr class="${m.status === 'cancelled' ? 'disabled-row' : ''}">
        <td data-label="ID">${m.id}</td><td data-label="游戏">${escapeHtml(m.game_type)}</td><td data-label="赛事">${escapeHtml(m.tournament_name)}</td><td data-label="对阵">${escapeHtml(m.team1_name)} vs ${escapeHtml(m.team2_name)}</td><td data-label="赛制">${escapeHtml(m.format)}</td><td data-label="时间">${fmt(m.match_time)}</td><td data-label="状态">${m.is_forfeit ? '弃权' : escapeHtml(m.status)}</td><td data-label="比分">${m.team1_score ?? ''}-${m.team2_score ?? ''}</td>
        <td data-label="操作" class="actions">${actionButton(m.betting_enabled ? '关预测' : '开预测', `toggleBetting(${m.id})`)}${actionButton('录赛果', `setResult(${m.id})`)}${actionButton('设弃权', `setForfeit(${m.id})`)}${actionButton('编辑', `editMatch(${m.id})`)}${actionButton('删除', `deleteMatch(${m.id})`, true)}</td>
    </tr>`).join('') + moreRowsRow('matches', rows.length, 9) : emptyRow(9);
}

// 赛事级别列：显示推断结果（高级/普通/低级），手动固定过的加 ● 标记
function adminTierCell(t) {
    const tier = t.effective_tier;
    const label = tier === 1 ? '高级' : tier === 3 ? '低级' : '普通';
    const cls = tier === 1 ? 'tier-top' : tier === 3 ? 'tier-low' : '';
    const manual = t.tier !== null && t.tier !== undefined ? ' <span class="tier-manual" title="手动设置，同步不覆盖">●</span>' : '';
    return `<span class="tier-badge ${cls}">${label}</span>${manual}`;
}

function renderTournaments(rows) {
    tournaments.innerHTML = rows.length ? rows.slice(0, rowLimitOf('tournaments')).map(t => `<tr class="${t.is_active ? '' : 'disabled-row'}">
        <td data-label="ID">${t.id}</td><td data-label="名称">${tournamentLogoImg(t.name, t.game_type, t.logo_url)}${escapeHtml(t.name)}</td><td data-label="游戏">${escapeHtml(t.game_type)}</td><td data-label="状态">${t.is_active ? '启用' : '禁用'}</td><td data-label="级别">${adminTierCell(t)}</td><td data-label="开始">${dateOnly(t.begin_at)}</td><td data-label="结束">${dateOnly(t.end_at)}</td><td data-label="比赛数">${t.match_count}</td><td data-label="来源">${escapeHtml(sourceOf(t) === 'pandascore' ? '自动同步' : '手动')}</td>
        <td data-label="操作" class="actions">${actionButton(t.is_active ? '禁用' : '启用', `toggleTournament(${t.id})`, !t.is_active)}${actionButton('编辑', `editTournament(${t.id})`)}${actionButton('传Logo', `uploadTournamentLogo(${t.id})`)}${t.logo_url && t.logo_url.startsWith('/uploads/') ? actionButton('删Logo', `removeTournamentLogo(${t.id})`, true) : ''}${actionButton('删除', `deleteTournament(${t.id})`, true)}</td>
    </tr>`).join('') + moreRowsRow('tournaments', rows.length, 10) : emptyRow(10);
}

function renderTeams(rows) {
    teams.innerHTML = rows.length ? rows.slice(0, rowLimitOf('teams')).map(t => `<tr>
        <td data-label="ID">${t.id}</td><td data-label="队伍">${t.logo_url ? `<img class="tiny-logo" src="${escapeHtml(teamLogoSrc(t.logo_url))}" alt="">` : ''}${escapeHtml(t.name)}</td><td data-label="游戏">${escapeHtml(t.game_type)}</td><td data-label="简称">${escapeHtml(t.short_name || '')}</td><td data-label="国家">${escapeHtml(t.country || '')}</td><td data-label="来源">${escapeHtml(sourceOf(t) === 'pandascore' ? '自动同步' : '手动')}</td>
        <td data-label="操作" class="actions">${actionButton('编辑', `editTeam(${t.id})`)}${actionButton('删除', `deleteTeam(${t.id})`, true)}</td>
    </tr>`).join('') + moreRowsRow('teams', rows.length, 7) : emptyRow(7);
}

function renderUsers(rows) {
    users.innerHTML = rows.length ? rows.slice(0, rowLimitOf('users')).map(u => `<tr>
        <td data-label="ID">${u.id}</td><td data-label="用户名">${escapeHtml(u.username)}</td><td data-label="角色">${u.role === 'admin' ? '管理员' : '用户'}</td><td data-label="积分">${u.total_score}</td><td data-label="预测数">${u.prediction_count}</td><td data-label="注册时间">${fmt(u.created_at)}</td>
        <td data-label="操作" class="actions">${actionButton(u.role === 'admin' ? '设用户' : '设管理', `toggleRole(${u.id}, '${escapeHtml(u.role)}')`)}${actionButton('重置密码', `resetPassword(${u.id})`)}${actionButton('删除', `deleteUser(${u.id})`, true)}</td>
    </tr>`).join('') + moreRowsRow('users', rows.length, 7) : emptyRow(7);
}

function renderPredictions(rows) {
    predictions.innerHTML = rows.length ? rows.slice(0, rowLimitOf('predictions')).map(p => `<tr>
        <td data-label="ID">${p.id}</td><td data-label="用户">${escapeHtml(p.username)}</td><td data-label="比赛">${escapeHtml(p.team1_name)} vs ${escapeHtml(p.team2_name)}</td><td data-label="预测">${p.predicted_team1_score}-${p.predicted_team2_score} / ${escapeHtml(p.predicted_winner_name)}</td><td data-label="状态">${p.match_is_forfeit ? '弃权' : escapeHtml(p.match_status)}</td><td data-label="得分">${p.match_is_forfeit ? '弃权不计分' : (p.points_earned ?? '未结算')}</td><td data-label="提交时间">${fmt(p.created_at)}</td>
        <td data-label="操作" class="actions">${actionButton('删除', `deletePrediction(${p.id})`, true)}</td>
    </tr>`).join('') + moreRowsRow('predictions', rows.length, 8) : emptyRow(8);
}

// ---------- 赛事操作 ----------

async function createTournament() {
    await api('/admin/tournaments', { method: 'POST', body: { name: tourName.value, short_name: tourShort?.value || '', game_type: tourGame.value, begin_at: tourBegin.value, end_at: tourEnd.value, is_active: 1 } });
    tourName.value = '';
    document.getElementById('tournamentCreate').open = false;
    await loadAdmin();
}

function editTournament(id) {
    const row = state.tournaments.find(item => item.id === id);
    if (!row) { alert('赛事不存在，请刷新'); return; }
    const tierValue = row.tier === null || row.tier === undefined ? '' : String(row.tier);
    openAdminModal({
        title: '编辑赛事',
        hint: `ID ${row.id} · ${row.match_count || 0} 场比赛 · 来源：${sourceOf(row) === 'pandascore' ? '自动同步' : '手动'}`,
        body: [
            modalField('名称', `<input id="mTourName" value="${escapeHtml(row.name)}">`),
            modalField('简称（主页筛选/移动端展示）', `<input id="mTourShort" value="${escapeHtml(row.short_name || '')}" placeholder="如：IEM 科隆">`),
            modalField('游戏', `<select id="mTourGame"><option value="cs2"${row.game_type === 'cs2' ? ' selected' : ''}>CS2</option><option value="valorant"${row.game_type === 'valorant' ? ' selected' : ''}>Valorant</option></select>`),
            modalField('级别（赛事回看排序；手动设置后同步不覆盖）', `<select id="mTourTier"><option value=""${tierValue === '' ? ' selected' : ''}>自动（按名称关键词：Major/Masters/Champions/大师赛→高级，Qualifier/预选赛→低级）</option><option value="1"${tierValue === '1' ? ' selected' : ''}>高级（Major 级）</option><option value="2"${tierValue === '2' ? ' selected' : ''}>普通</option><option value="3"${tierValue === '3' ? ' selected' : ''}>低级（预选赛级）</option></select>`),
            modalField('开始日期', `<input id="mTourBegin" type="date" value="${dateOnly(row.begin_at)}">`),
            modalField('结束日期', `<input id="mTourEnd" type="date" value="${dateOnly(row.end_at)}">`),
            modalField('启用状态', `<select id="mTourActive"><option value="1"${row.is_active ? ' selected' : ''}>启用</option><option value="0"${row.is_active ? '' : ' selected'}>禁用</option></select>`)
        ].join(''),
        onSubmit: async () => {
            await api(`/admin/tournaments/${id}`, { method: 'PUT', body: {
                name: mTourName.value,
                short_name: mTourShort.value,
                game_type: mTourGame.value,
                tier: mTourTier.value === '' ? null : Number(mTourTier.value),
                begin_at: mTourBegin.value || null,
                end_at: mTourEnd.value || null,
                is_active: mTourActive.value === '1'
            } });
            await loadAdmin();
        }
    });
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

// 手动上传赛事 logo：二进制直传（不走 JSON api 帮手），成功后覆盖名称匹配的默认 logo
async function uploadTournamentLogo(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
        // 回调里的异常不会被外层 withErrorAlert 捕获，这里自行兜底提示
        try {
            const res = await fetch(`/api/admin/tournaments/${id}/logo`, {
                method: 'PUT',
                headers: { 'Content-Type': file.type || 'application/octet-stream', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
                body: file
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 401 && state.token) { logout(); throw new Error('登录已过期，请重新登录'); }
            if (!res.ok) throw new Error(data.error || '上传失败');
            await loadAdmin();
        } catch (error) {
            alert(error.message || '上传失败');
        }
    };
    input.click();
}

async function removeTournamentLogo(id) {
    if (!confirm('确认清除手动 logo？清除后将回退到名称匹配的默认 logo。')) return;
    await api(`/admin/tournaments/${id}/logo`, { method: 'DELETE' });
    await loadAdmin();
}

// ---------- 队伍操作 ----------

async function createTeam() {
    await api('/admin/teams', { method: 'POST', body: { name: teamName.value, game_type: teamGame.value, short_name: teamShort.value, logo_url: teamLogo.value, country: teamCountry.value } });
    teamName.value = teamShort.value = teamLogo.value = teamCountry.value = '';
    document.getElementById('teamCreate').open = false;
    await loadAdmin();
}

function editTeam(id) {
    const row = state.teams.find(item => item.id === id);
    if (!row) { alert('队伍不存在，请刷新'); return; }
    openAdminModal({
        title: '编辑队伍',
        hint: `ID ${row.id} · 来源：${sourceOf(row) === 'pandascore' ? '自动同步' : '手动'}`,
        body: [
            modalField('名称', `<input id="mTeamName" value="${escapeHtml(row.name)}">`),
            modalField('游戏', `<select id="mTeamGame"><option value="cs2"${row.game_type === 'cs2' ? ' selected' : ''}>CS2</option><option value="valorant"${row.game_type === 'valorant' ? ' selected' : ''}>Valorant</option></select>`),
            modalField('简称', `<input id="mTeamShort" value="${escapeHtml(row.short_name || '')}">`),
            modalField('Logo URL', `<input id="mTeamLogo" value="${escapeHtml(row.logo_url || '')}" placeholder="https://...">`),
            modalField('国家/地区', `<input id="mTeamCountry" value="${escapeHtml(row.country || '')}">`)
        ].join(''),
        onSubmit: async () => {
            await api(`/admin/teams/${id}`, { method: 'PUT', body: {
                name: mTeamName.value,
                game_type: mTeamGame.value,
                short_name: mTeamShort.value,
                logo_url: mTeamLogo.value,
                country: mTeamCountry.value
            } });
            await loadAdmin();
        }
    });
}

async function deleteTeam(id) {
    if (!confirm('确认删除队伍？')) return;
    await api(`/admin/teams/${id}`, { method: 'DELETE' });
    await loadAdmin();
}

// ---------- 比赛操作 ----------

async function createMatch() {
    await api('/admin/matches', { method: 'POST', body: { tournament_id: matchTournament.value, team1_id: matchTeam1.value, team2_id: matchTeam2.value, format: matchFormat.value, match_time: new Date(matchTime.value).toISOString(), name: matchName.value } });
    matchName.value = '';
    document.getElementById('matchCreate').open = false;
    await loadAdmin();
}

function editMatch(id) {
    const row = state.matches.find(item => item.id === id);
    if (!row) { alert('比赛不存在，请刷新'); return; }
    openAdminModal({
        title: '编辑比赛',
        hint: `${escapeHtml(row.team1_name)} vs ${escapeHtml(row.team2_name)} · ${escapeHtml(row.tournament_name)}`,
        body: [
            modalField('状态', `<select id="mMatchStatus">${['upcoming', 'ongoing', 'finished', 'cancelled', 'postponed'].map(s => `<option value="${s}"${row.status === s ? ' selected' : ''}>${({ upcoming: '未开始', ongoing: '进行中', finished: '已结算', cancelled: '已取消', postponed: '已延期' })[s]}</option>`).join('')}</select>`),
            modalField('赛制', `<select id="mMatchFormat">${['BO1', 'BO3', 'BO5'].map(f => `<option${row.format === f ? ' selected' : ''}>${f}</option>`).join('')}</select>`),
            modalField('时间', `<input id="mMatchTime" type="datetime-local" value="${toLocalDateTimeInput(row.match_time)}">`),
            modalField('备注/阶段', `<input id="mMatchName" value="${escapeHtml(row.name || '')}">`)
        ].join(''),
        onSubmit: async () => {
            const time = mMatchTime.value ? new Date(mMatchTime.value).toISOString() : null;
            await api(`/admin/matches/${id}`, { method: 'PUT', body: {
                status: mMatchStatus.value,
                format: mMatchFormat.value,
                match_time: time,
                name: mMatchName.value || null
            } });
            await loadAdmin();
        }
    });
}

function setResult(id) {
    const row = state.matches.find(item => item.id === id);
    if (!row) { alert('比赛不存在，请刷新'); return; }
    openAdminModal({
        title: '录入赛果',
        hint: `${escapeHtml(row.team1_name)} vs ${escapeHtml(row.team2_name)} · ${escapeHtml(row.format)} · 录入后自动结算预测积分`,
        body: `<div class="admin-score-input">
            <div class="admin-score-team">${escapeHtml(row.team1_name)}</div>
            ${modalField('队伍 1 比分', `<input id="mScore1" type="number" min="0" inputmode="numeric" value="${row.team1_score ?? 0}">`)}
            <div class="admin-score-sep">-</div>
            ${modalField('队伍 2 比分', `<input id="mScore2" type="number" min="0" inputmode="numeric" value="${row.team2_score ?? 0}">`)}
            <div class="admin-score-team">${escapeHtml(row.team2_name)}</div>
        </div>`,
        submitText: '录入并结算',
        onSubmit: async () => {
            const s1 = Number(mScore1.value);
            const s2 = Number(mScore2.value);
            if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 < 0 || s2 < 0) throw new Error('比分必须是非负整数');
            await api(`/admin/matches/${id}/result`, { method: 'PUT', body: { team1_score: s1, team2_score: s2 } });
            await loadAdmin();
        }
    });
}

function setForfeit(id) {
    const row = state.matches.find(item => item.id === id);
    if (!row) { alert('比赛不存在，请刷新'); return; }
    openAdminModal({
        title: '设置弃权',
        hint: `${escapeHtml(row.team1_name)} vs ${escapeHtml(row.team2_name)} · 弃权按 1-0 处理，不计积分`,
        body: `<div class="admin-forfeit-options">
            <label><input type="radio" name="forfeitWinner" value="1" checked> ${escapeHtml(row.team1_name)} 胜（对方弃权）</label>
            <label><input type="radio" name="forfeitWinner" value="2"> ${escapeHtml(row.team2_name)} 胜（对方弃权）</label>
        </div>`,
        submitText: '确认弃权',
        onSubmit: async () => {
            const choice = document.querySelector('input[name="forfeitWinner"]:checked').value;
            const winnerTeamId = choice === '1' ? row.team1_id : row.team2_id;
            await api(`/admin/matches/${id}/forfeit`, { method: 'PUT', body: { winner_team_id: winnerTeamId } });
            await loadAdmin();
        }
    });
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

// ---------- 用户操作 ----------

async function createUser() {
    await api('/admin/users', { method: 'POST', body: { username: newUsername.value, password: newPassword.value, role: newRole.value } });
    newUsername.value = newPassword.value = '';
    document.getElementById('userCreate').open = false;
    await loadAdmin();
}

async function toggleRole(id, role) {
    await api(`/admin/users/${id}/role`, { method: 'PUT', body: { role: role === 'admin' ? 'user' : 'admin' } });
    await loadAdmin();
}

function resetPassword(id) {
    const row = state.users.find(item => item.id === id);
    if (!row) { alert('用户不存在，请刷新'); return; }
    openAdminModal({
        title: '重置密码',
        hint: `用户：${row.username}`,
        body: modalField('新密码（至少 6 位）', '<input id="mNewPassword" type="password" placeholder="新密码">'),
        submitText: '重置',
        onSubmit: async () => {
            if (!mNewPassword.value || mNewPassword.value.length < 6) throw new Error('密码至少 6 位');
            await api(`/admin/users/${id}/password`, { method: 'PUT', body: { password: mNewPassword.value } });
        }
    });
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

// ---------- 启动 ----------

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

const adminActions = { login, logout, syncNow, createTournament, editTournament, toggleTournament, deleteTournament, uploadTournamentLogo, removeTournamentLogo, createTeam, editTeam, deleteTeam, createMatch, editMatch, setResult, setForfeit, toggleBetting, deleteMatch, createUser, toggleRole, resetPassword, deleteUser, deletePrediction };
for (const key of Object.keys(adminActions)) adminActions[key] = withErrorAlert(adminActions[key]);

Object.assign(window, adminActions, { showTab, setGame, applyAdminFilters, toggleCreateForm, closeAdminModal, submitAdminModal, loadMoreRows });

document.getElementById('adminModalSubmit').addEventListener('click', submitAdminModal);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.getElementById('adminModal').hidden) closeAdminModal();
});
window.addEventListener('hashchange', initTabFromHash);

renderAuth();
initTabFromHash();
loadAdmin().catch(error => console.warn(error.message));
