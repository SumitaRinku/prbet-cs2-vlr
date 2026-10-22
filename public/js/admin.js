// ===== 管理后台 =====
// 依赖 /js/tournament-logos.js（须先加载）：tournamentLogo
// 结构：状态 → 基础工具 → 提示/对话框 → 登录 → 数据加载 → 页签渲染 → 操作 → 事件委托

const TABS = ['overview', 'matches', 'tournaments', 'previews', 'teams', 'users', 'predictions'];
const PAGE_SIZE = 50;

function readStoredUser() {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
}

const state = {
    token: localStorage.getItem('token'),
    user: readStoredUser(),
    game: localStorage.getItem('adminGameFilter') || '',
    tab: 'overview',
    loading: false,
    loaded: false,
    stats: null,
    tournaments: [],
    teams: [],
    matches: [],
    users: [],
    predictions: [],
    previews: [],
    // 每个页签独立的筛选条件；切页签不丢
    filters: {
        matches: { q: '', tournament: '', status: '', betting: '', todo: false },
        tournaments: { q: '', active: '', source: '', tier: '' },
        previews: { q: '', visible: '' },
        teams: { q: '', source: '' },
        users: { q: '', role: '' },
        predictions: { q: '', status: '' }
    },
    // 每个表格当前展示的行数（长列表分段渲染）
    limits: {}
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

// ---------- 基础 ----------

async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    // 文件（File/Blob）原样直传，其余按 JSON 编码
    if (body !== undefined && !(body instanceof Blob)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, { ...options, headers, body });
    // token 过期/失效：清理登录态（登录接口的 401 是凭据错误，不触发登出）
    if (res.status === 401 && state.token && !path.startsWith('/auth/')) {
        logout();
        throw new Error('登录已过期，请重新登录');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const pad = n => String(n).padStart(2, '0');

// 与前台一致：当年显示 MM-DD HH:mm，非当年补两位年份
function fmtTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    const year = d.getFullYear() === new Date().getFullYear() ? '' : `${String(d.getFullYear()).slice(2)}-`;
    return `${year}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateOnly(value) {
    return value ? String(value).slice(0, 10) : '';
}

// datetime-local 需要 yyyy-MM-ddTHH:mm 本地格式，toISOString 会带 Z 且是 UTC
function toLocalInput(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function teamLogoSrc(url) {
    if (!url) return '';
    // 本地/相对路径（如 TBD 占位盾牌）直接引用，不走外部 logo 代理
    if (/^\/(?!\/)/.test(url) || url.startsWith('data:')) return url;
    return `/api/images/team-logo?url=${encodeURIComponent(url)}`;
}

function teamLogoImg(url) {
    const src = teamLogoSrc(url);
    return src
        ? `<img class="ops-logo" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
        : '<span class="ops-logo ops-logo-empty"></span>';
}

// 赛事 logo：与前台一致（手动上传 > 名称匹配精选映射），PandaScore 远程 logo 不使用
function tournamentLogoImg(t) {
    const html = tournamentLogo(t.name, t.game_type, t.logo_url && t.logo_url.startsWith('/uploads/') ? t.logo_url : null);
    return html ? `<span class="ops-tlogo">${html}</span>` : '<span class="ops-tlogo ops-logo-empty"></span>';
}

// 未来赛事预告没有本地 logo_url，按赛事名匹配精选厂牌 logo
function previewLogo(p) {
    const html = tournamentLogo(p.name, p.game_type);
    return html ? `<span class="ops-tlogo">${html}</span>` : '<span class="ops-tlogo ops-logo-empty"></span>';
}

const GAME_LABELS = { cs2: 'CS2', valorant: 'Valorant' };
const STATUS_LABELS = { upcoming: '未开始', ongoing: '进行中', finished: '已结算', cancelled: '已取消', postponed: '已延期' };
const sourceOf = row => row.external_source || 'manual';
const sourceLabel = row => (sourceOf(row) === 'pandascore' ? '自动同步' : '手动');

function gamePill(game) {
    return `<span class="game-pill ${esc(game)}">${esc(GAME_LABELS[game] || game)}</span>`;
}

// 已开赛但仍未结算：最需要管理员处理的比赛
function isOverdue(match) {
    return (match.status === 'upcoming' || match.status === 'ongoing') && new Date(match.match_time).getTime() <= Date.now();
}

function matchStatusPill(match) {
    if (match.is_forfeit) return '<span class="ops-pill warn">弃权</span>';
    if (isOverdue(match)) return '<span class="ops-pill bad">待结算</span>';
    const cls = { upcoming: 'info', ongoing: 'live', finished: 'muted', cancelled: 'muted', postponed: 'warn' }[match.status] || 'muted';
    return `<span class="ops-pill ${cls}">${esc(STATUS_LABELS[match.status] || match.status)}</span>`;
}

// 各赛制的合法比分（录赛果快捷按钮），与服务端 isValidScore 口径一致
function legalScores(format) {
    const wins = { BO1: 1, BO3: 2, BO5: 3 }[format] || 2;
    const list = [];
    for (let lose = 0; lose < wins; lose++) list.push([wins, lose]);
    for (let lose = wins - 1; lose >= 0; lose--) list.push([lose, wins]);
    return list;
}

// ---------- 提示 ----------

function toast(message, type = 'ok') {
    const box = $('#opsToasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `ops-toast ${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
}

// ---------- 对话框（表单编辑与二次确认共用） ----------

const modal = { onSubmit: null, busy: false };

function openModal({ title, hint = '', body, submitText = '保存', danger = false, onSubmit, onOpen }) {
    $('#opsModalTitle').textContent = title;
    $('#opsModalHint').textContent = hint;
    $('#opsModalForm').innerHTML = body;
    const submit = $('#opsModalSubmit');
    submit.textContent = submitText;
    submit.classList.toggle('danger', danger);
    submit.disabled = false;
    $('#opsModalError').hidden = true;
    modal.onSubmit = onSubmit;
    modal.busy = false;
    $('#opsModal').hidden = false;
    document.body.classList.add('modal-open');
    if (onOpen) onOpen($('#opsModalForm'));
    const first = $('#opsModalForm').querySelector('input:not([type=radio]):not([type=hidden]), select, textarea');
    if (first) first.focus();
}

function closeModal() {
    if (modal.busy) return;
    $('#opsModal').hidden = true;
    $('#opsModalForm').innerHTML = '';
    modal.onSubmit = null;
    document.body.classList.remove('modal-open');
}

async function submitModal(event) {
    event.preventDefault();
    if (!modal.onSubmit || modal.busy) return;
    const form = $('#opsModalForm');
    const data = Object.fromEntries(new FormData(form).entries());
    const submit = $('#opsModalSubmit');
    modal.busy = true;
    submit.disabled = true;
    try {
        const message = await modal.onSubmit(data, form);
        modal.busy = false;
        closeModal();
        if (message) toast(message);
    } catch (error) {
        modal.busy = false;
        submit.disabled = false;
        // 错误留在对话框内显示，便于修改后重试
        const box = $('#opsModalError');
        box.textContent = error.message || '操作失败';
        box.hidden = false;
    }
}

// 危险操作的二次确认：沿用同一对话框
function confirmAction({ title, message, confirmText = '确认', danger = true, run }) {
    openModal({ title, body: `<p class="ops-confirm-text">${esc(message)}</p>`, submitText: confirmText, danger, onSubmit: run });
}

// 表单控件：统一用 name 取值（FormData），不依赖全局 id
function field(label, control, { hint = '', wide = false } = {}) {
    return `<label class="ops-field${wide ? ' wide' : ''}"><span>${esc(label)}</span>${control}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}

function input(name, value = '', attrs = '') {
    return `<input name="${name}" value="${esc(value)}" ${attrs}>`;
}

function select(name, options, current = '') {
    return `<select name="${name}">${options.map(([value, label]) => `<option value="${esc(value)}"${String(value) === String(current ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

const GAME_OPTIONS = [['cs2', 'CS2'], ['valorant', 'Valorant']];

// ---------- 登录 ----------

function isAdmin() {
    return Boolean(state.token && state.user && state.user.role === 'admin');
}

// 顶栏用户区：渲染到独立子节点，保留 theme.js 追加的主题切换按钮
function renderAuth() {
    const host = $('#auth');
    if (!host) return;
    let slot = $('#opsAuthSlot');
    if (!slot) {
        slot = document.createElement('span');
        slot.id = 'opsAuthSlot';
        slot.className = 'ops-auth-slot';
        host.prepend(slot);
    }
    slot.innerHTML = state.user
        ? `<span class="ops-user">${esc(state.user.username)}${state.user.role === 'admin' ? '<em>管理员</em>' : ''}</span><button type="button" class="ops-btn ghost sm" data-act="logout">退出</button>`
        : '';
}

function renderGate() {
    const gate = $('#opsGate');
    const app = $('#opsApp');
    if (isAdmin()) {
        gate.hidden = true;
        app.hidden = false;
        return;
    }
    app.hidden = true;
    gate.hidden = false;
    gate.innerHTML = state.user
        ? `<div class="ops-gate-card">
            <h2>无访问权限</h2>
            <p>当前账号 <b>${esc(state.user.username)}</b> 不是管理员。</p>
            <div class="ops-gate-actions"><a class="ops-btn ghost" href="/">返回首页</a><button type="button" class="ops-btn" data-act="logout">切换账号</button></div>
        </div>`
        : `<form class="ops-gate-card" id="opsLoginForm">
            <p class="eyebrow">Admin Console</p>
            <h2>管理员登录</h2>
            ${field('用户名', '<input name="username" autocomplete="username" required>')}
            ${field('密码', '<input name="password" type="password" autocomplete="current-password" required>')}
            <p id="opsLoginError" class="ops-modal-error" hidden></p>
            <button type="submit" class="ops-btn block">登录</button>
        </form>`;
    const first = gate.querySelector('input');
    if (first) first.focus();
}

async function login(event) {
    event.preventDefault();
    const form = event.target;
    const { username, password } = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
        const data = await api('/auth/login', { method: 'POST', body: { username, password } });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        renderAuth();
        renderGate();
        if (isAdmin()) await loadAll();
    } catch (error) {
        const box = $('#opsLoginError');
        box.textContent = error.message;
        box.hidden = false;
        button.disabled = false;
    }
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    state.token = null;
    state.user = null;
    state.loaded = false;
    renderAuth();
    renderGate();
}

// ---------- 导航 ----------

function setTab(name, { updateHash = true } = {}) {
    state.tab = TABS.includes(name) ? name : 'overview';
    $$('#opsNav button[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === state.tab));
    if (updateHash) history.replaceState(null, '', `#${state.tab}`);
    render();
}

// 兼容旧版 #tab-matches 形式的书签
function tabFromHash() {
    const raw = location.hash.replace(/^#(tab-)?/, '');
    return TABS.includes(raw) ? raw : 'overview';
}

function setGame(game) {
    state.game = game;
    localStorage.setItem('adminGameFilter', game);
    // 换游戏后原赛事筛选大概率不存在，重置
    state.filters.matches.tournament = '';
    loadAll();
}

function syncGameSeg() {
    $$('#opsGameSeg button[data-game]').forEach(btn => btn.classList.toggle('active', btn.dataset.game === state.game));
}

function renderNavCounts() {
    const counts = {
        matches: state.matches.length,
        tournaments: state.tournaments.length,
        previews: state.previews.length,
        teams: state.teams.length,
        users: state.users.length,
        predictions: state.predictions.length
    };
    $$('#opsNav b[data-count]').forEach(el => { el.textContent = state.loaded ? counts[el.dataset.count] : ''; });
    // 待结算比赛数：在"比赛"上加红点提示
    const overdue = state.matches.filter(isOverdue).length;
    const matchBtn = $('#opsNav button[data-tab=matches]');
    if (matchBtn) matchBtn.classList.toggle('has-alert', overdue > 0);
}

// ---------- 同步 ----------

const SYNC_STATUS_LABELS = { running: '进行中', success: '成功', failed: '失败', skipped: '跳过' };

function renderSyncStatus(sync = {}) {
    const badge = $('#opsSyncBadge');
    const info = $('#opsSyncInfo');
    // 用户正在编辑时不要覆盖输入框
    const daysInput = $('#opsPreviewDays');
    if (daysInput && document.activeElement !== daysInput) daysInput.value = sync.preview_days ?? '';
    const set = (text, cls = '', detail = '') => {
        badge.textContent = text;
        badge.className = `ops-badge ${cls}`;
        info.textContent = detail;
    };
    const previewRun = sync.preview_last_run;
    const previewDetail = sync.preview_days
        ? `预告前瞻 ${sync.preview_days} 天 · ${previewRun ? `预告${SYNC_STATUS_LABELS[previewRun.status] || previewRun.status} ${fmtTime(previewRun.started_at)}` : '尚未刷新'}`
        : '';
    if (!sync.configured) return set('未配置同步', 'warn', previewDetail);
    if (!sync.enabled) return set('同步已停用', 'warn', previewDetail);
    if (sync.running) return set('同步进行中', 'live', previewDetail);
    const run = sync.last_run;
    if (!run) return set('等待首次同步', '', previewDetail);
    const parts = [`开始 ${fmtTime(run.started_at)}`];
    if (run.finished_at) parts.push(`完成 ${fmtTime(run.finished_at)}`);
    if (run.status === 'success') parts.push(`写入 赛事 ${run.tournaments_upserted} · 队伍 ${run.teams_upserted} · 比赛 ${run.matches_upserted}`);
    if (run.message) parts.push(run.message);
    if (previewDetail) parts.push(previewDetail);
    set(`上次同步${SYNC_STATUS_LABELS[run.status] || run.status}`, run.status === 'success' ? 'ok' : run.status === 'failed' ? 'bad' : 'warn', parts.join(' · '));
}

async function syncNow() {
    const button = $('#opsSyncBtn');
    button.disabled = true;
    renderSyncStatus({ configured: true, enabled: true, running: true });
    try {
        await api('/admin/sync/pandascore', { method: 'POST' });
        toast('同步完成');
    } catch (error) {
        toast(`同步失败：${error.message}`, 'bad');
    } finally {
        button.disabled = false;
        await loadAll();
    }
}

// 保存赛事预告前瞻天数（只影响远期赛事预告，不改变比赛同步窗口）
async function savePreviewDays() {
    const days = Number($('#opsPreviewDays')?.value);
    if (!Number.isInteger(days) || days < 7 || days > 365) throw new Error('预告天数需为 7-365 的整数');
    const data = await api('/admin/sync/settings', { method: 'PUT', body: { preview_days: days } });
    toast(`预告前瞻已设为 ${days} 天`);
    renderSyncStatus(data.sync);
}

// 立即刷新远期赛事预告（赛事级，不导入远期比赛）
async function syncPreviews() {
    const data = await api('/admin/sync/previews', { method: 'POST' });
    toast(data.message || '赛事预告已刷新');
    await loadAll();
}

// ---------- 数据加载 ----------

async function loadAll() {
    if (!isAdmin()) return;
    syncGameSeg();
    state.loading = true;
    if (!state.loaded) $('#opsView').innerHTML = '<div class="ops-loading">加载后台数据…</div>';
    const q = state.game ? `game_type=${encodeURIComponent(state.game)}` : '';
    try {
        const [stats, tournaments, teams, matchGroups, users, predictions, previews] = await Promise.all([
            api(`/admin/stats${q ? `?${q}` : ''}`),
            api(`/admin/tournaments${q ? `?${q}` : ''}`),
            api(`/admin/teams${q ? `?${q}` : ''}`),
            // 接口单次最多 1000 条：按状态分别拉取再合并，保证待处理比赛不被截断；
            // 已结算比赛若超过上限，只保留最近 1000 场
            Promise.all(Object.keys(STATUS_LABELS).map(status =>
                api(`/admin/matches?limit=1000&status=${status}${q ? `&${q}` : ''}`)
                    .then(res => ({ status, rows: res.matches || [] })))),
            api('/admin/users'),
            api('/admin/predictions'),
            api(`/admin/previews${q ? `?${q}` : ''}`)
        ]);
        state.stats = stats;
        state.tournaments = tournaments.tournaments || [];
        state.teams = teams.teams || [];
        state.matches = matchGroups.flatMap(g => g.rows)
            .sort((a, b) => new Date(b.match_time) - new Date(a.match_time));
        state.matchesTruncated = matchGroups.some(g => g.rows.length >= 1000);
        state.users = users.users || [];
        state.predictions = predictions.predictions || [];
        state.previews = previews.previews || [];
        state.loaded = true;
        renderSyncStatus(stats.sync);
    } catch (error) {
        if (!state.loaded) $('#opsView').innerHTML = `<div class="ops-empty">加载失败：${esc(error.message)}</div>`;
        toast(error.message, 'bad');
        return;
    } finally {
        state.loading = false;
    }
    renderNavCounts();
    render();
}

// ---------- 通用表格 ----------

function limitOf(tab) {
    return state.limits[tab] || PAGE_SIZE;
}

// columns: [[标题, 额外 class]]；rows 已筛选；renderRow 返回 <tr>
function tableBlock(tab, columns, rows, renderRow, emptyText = '当前筛选下暂无数据') {
    const limit = limitOf(tab);
    const head = columns.map(([title, cls = '']) => `<th class="${cls}">${esc(title)}</th>`).join('');
    const body = rows.length
        ? rows.slice(0, limit).map(renderRow).join('')
        : `<tr class="ops-empty-row"><td colspan="${columns.length}">${esc(emptyText)}</td></tr>`;
    const more = rows.length > limit
        ? `<button type="button" class="ops-btn ghost sm" data-act="more" data-tab="${tab}">显示更多（剩余 ${rows.length - limit} 条）</button>`
        : '';
    return `<div class="ops-table-meta"><span>共 ${rows.length} 条${rows.length > limit ? ` · 显示前 ${limit} 条` : ''}</span></div>
        <div class="ops-table-wrap"><table class="ops-table ops-table-${tab}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
        ${more ? `<div class="ops-table-more">${more}</div>` : ''}`;
}

// 行内操作按钮：统一 data-act 委托，避免内联 onclick
function act(label, action, id, cls = '') {
    return `<button type="button" class="ops-act ${cls}" data-act="${action}" data-id="${id}">${esc(label)}</button>`;
}

function searchBox(tab, placeholder) {
    return `<label class="ops-search"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3a7.5 7.5 0 1 0 4.55 13.45l4.25 4.25 1.4-1.4-4.25-4.25A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z" fill="currentColor"/></svg><input type="search" data-filter="q" value="${esc(state.filters[tab].q)}" placeholder="${esc(placeholder)}" autocomplete="off"></label>`;
}

function filterSelect(tab, key, options) {
    return `<select data-filter="${key}">${options.map(([value, label]) => `<option value="${esc(value)}"${String(value) === String(state.filters[tab][key]) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function toolbar(title, controls, createAction = '', createLabel = '') {
    return `<div class="ops-panel-head"><h2>${esc(title)}</h2>${createAction ? `<button type="button" class="ops-btn" data-act="${createAction}">+ ${esc(createLabel)}</button>` : ''}</div>
        <div class="ops-toolbar">${controls}</div>`;
}

// ---------- 筛选 ----------

const includesText = (haystack, q) => !q || haystack.toLowerCase().includes(q.trim().toLowerCase());

function filteredMatches() {
    const f = state.filters.matches;
    return state.matches.filter(m => {
        if (f.todo && !isOverdue(m)) return false;
        if (f.tournament && String(m.tournament_id) !== f.tournament) return false;
        if (f.status && m.status !== f.status) return false;
        if (f.betting && String(m.betting_enabled) !== f.betting) return false;
        return includesText(`${m.team1_name} ${m.team2_name} ${m.tournament_name} ${m.name || ''} ${m.id}`, f.q);
    });
}

function filteredTournaments() {
    const f = state.filters.tournaments;
    return state.tournaments.filter(t => {
        if (f.active && String(t.is_active) !== f.active) return false;
        if (f.source && sourceOf(t) !== f.source) return false;
        if (f.tier && String(t.effective_tier) !== f.tier) return false;
        return includesText(`${t.name} ${t.short_name || ''} ${t.id}`, f.q);
    });
}

function filteredPreviews() {
    const f = state.filters.previews;
    return state.previews.filter(p => {
        if (f.visible && String(p.is_visible) !== f.visible) return false;
        return includesText(`${p.name} ${p.game_type} ${p.external_id} ${p.id}`, f.q);
    });
}

function filteredTeams() {
    const f = state.filters.teams;
    return state.teams.filter(t => {
        if (f.source && sourceOf(t) !== f.source) return false;
        return includesText(`${t.name} ${t.short_name || ''} ${t.country || ''} ${t.id}`, f.q);
    });
}

function filteredUsers() {
    const f = state.filters.users;
    return state.users.filter(u => (!f.role || u.role === f.role) && includesText(`${u.username} ${u.id}`, f.q));
}

function filteredPredictions() {
    const f = state.filters.predictions;
    return state.predictions.filter(p => {
        if (f.status === 'finished' && p.match_status !== 'finished') return false;
        if (f.status === 'pending' && p.match_status === 'finished') return false;
        return includesText(`${p.username} ${p.team1_name} ${p.team2_name}`, f.q);
    });
}

// ---------- 概览 ----------

function overviewView() {
    const s = state.stats || {};
    const card = (key, label, tab, sub = '') => `<button type="button" class="ops-stat" data-act="goto" data-tab="${tab}">
        <b>${s[key] ?? 0}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
    const overdue = state.matches.filter(isOverdue).sort((a, b) => new Date(a.match_time) - new Date(b.match_time));
    const now = Date.now();
    const upcoming = state.matches
        .filter(m => m.status === 'upcoming' && new Date(m.match_time).getTime() > now)
        .sort((a, b) => new Date(a.match_time) - new Date(b.match_time))
        .slice(0, 8);
    const disabled = state.tournaments.filter(t => !t.is_active).length;
    const row = (m, actions) => `<li class="ops-brief">
        <span class="ops-brief-time">${fmtTime(m.match_time)}</span>
        <span class="ops-brief-main"><strong>${esc(m.team1_name)} <em>vs</em> ${esc(m.team2_name)}</strong><small>${esc(m.tournament_name)} · ${esc(m.format)}</small></span>
        <span class="ops-brief-act">${actions}</span>
    </li>`;
    return `<section class="ops-panel">
        <div class="ops-panel-head"><h2>概览</h2><span class="ops-muted">${state.game ? esc(GAME_LABELS[state.game]) : '全部游戏'}</span></div>
        <div class="ops-stats">
            ${card('matches', '比赛', 'matches', overdue.length ? `${overdue.length} 场待结算` : '')}
            ${card('tournaments', '赛事', 'tournaments', disabled ? `${disabled} 个已禁用` : '')}
            ${card('teams', '队伍', 'teams')}
            ${card('users', '注册用户', 'users')}
            ${card('predictions', '预测总数', 'predictions')}
        </div>
    </section>
    <div class="ops-overview-grid">
        <section class="ops-panel">
            <div class="ops-panel-head"><h2>待结算比赛</h2>${overdue.length ? `<button type="button" class="ops-btn ghost sm" data-act="goto-todo">查看全部</button>` : ''}</div>
            ${overdue.length
                ? `<ul class="ops-brief-list">${overdue.slice(0, 8).map(m => row(m, act('录赛果', 'match-result', m.id, 'primary') + act('弃权', 'match-forfeit', m.id))).join('')}</ul>`
                : '<div class="ops-empty sm">没有需要处理的比赛</div>'}
        </section>
        <section class="ops-panel">
            <div class="ops-panel-head"><h2>即将开始</h2></div>
            ${upcoming.length
                ? `<ul class="ops-brief-list">${upcoming.map(m => row(m, act(m.betting_enabled ? '预测开' : '预测关', 'match-betting', m.id, m.betting_enabled ? 'on' : 'off'))).join('')}</ul>`
                : '<div class="ops-empty sm">暂无即将开始的比赛</div>'}
        </section>
    </div>`;
}

// ---------- 比赛 ----------

const matchesView = {
    toolbar() {
        const f = state.filters.matches;
        const overdue = state.matches.filter(isOverdue).length;
        return toolbar('比赛管理', `
            ${searchBox('matches', '搜索队伍 / 赛事 / ID')}
            ${filterSelect('matches', 'tournament', [['', '全部赛事'], ...state.tournaments.map(t => [t.id, t.name])])}
            ${filterSelect('matches', 'status', [['', '全部状态'], ...Object.entries(STATUS_LABELS)])}
            ${filterSelect('matches', 'betting', [['', '全部预测状态'], ['1', '预测开启'], ['0', '预测关闭']])}
            <button type="button" class="ops-chip ${f.todo ? 'active' : ''}" data-act="toggle-todo">待结算<b>${overdue}</b></button>
            ${state.matchesTruncated ? '<span class="ops-muted ops-note">已结算比赛仅加载最近 1000 场</span>' : ''}`,
        'match-create', '新增比赛');
    },
    table() {
        return tableBlock('matches', [['时间', 'nowrap'], ['对阵'], ['赛事'], ['赛制', 'center'], ['比分', 'center'], ['状态', 'center'], ['预测', 'center'], ['操作', 'right']], filteredMatches(), m => `
            <tr class="${m.status === 'cancelled' ? 'is-dim' : ''}${isOverdue(m) ? ' is-alert' : ''}">
                <td class="nowrap ops-mono">${fmtTime(m.match_time)}</td>
                <td><div class="ops-cell-main"><strong>${esc(m.team1_name)} <em>vs</em> ${esc(m.team2_name)}</strong><small>#${m.id}${m.name ? ` · ${esc(m.name)}` : ''}</small></div></td>
                <td><div class="ops-cell-main"><span class="ops-ellipsis" title="${esc(m.tournament_name)}">${esc(m.tournament_name)}</span><small>${gamePill(m.game_type)}</small></div></td>
                <td class="center">${esc(m.format)}</td>
                <td class="center ops-mono ops-score">${m.team1_score ?? '–'} : ${m.team2_score ?? '–'}</td>
                <td class="center">${matchStatusPill(m)}</td>
                <td class="center">${act(m.betting_enabled ? '开启' : '关闭', 'match-betting', m.id, `toggle ${m.betting_enabled ? 'on' : 'off'}`)}</td>
                <td class="right"><div class="ops-acts">${act('录赛果', 'match-result', m.id, 'primary')}${act('弃权', 'match-forfeit', m.id)}${act('编辑', 'match-edit', m.id)}${act('删除', 'match-delete', m.id, 'danger')}</div></td>
            </tr>`);
    }
};

// ---------- 赛事 ----------

function tierPill(t) {
    const label = t.effective_tier === 1 ? '高级' : t.effective_tier === 3 ? '低级' : '普通';
    const cls = t.effective_tier === 1 ? 'tier-top' : t.effective_tier === 3 ? 'tier-low' : '';
    const manual = t.tier !== null && t.tier !== undefined ? '<span class="tier-manual" title="手动设置，同步不覆盖">●</span>' : '';
    return `<span class="tier-badge ${cls}">${label}</span>${manual}`;
}

const tournamentsView = {
    toolbar() {
        return toolbar('赛事管理', `
            ${searchBox('tournaments', '搜索赛事名称 / 简称 / ID')}
            ${filterSelect('tournaments', 'active', [['', '全部启用状态'], ['1', '已启用'], ['0', '已禁用']])}
            ${filterSelect('tournaments', 'tier', [['', '全部级别'], ['1', '高级'], ['2', '普通'], ['3', '低级']])}
            ${filterSelect('tournaments', 'source', [['', '全部来源'], ['pandascore', '自动同步'], ['manual', '手动创建']])}`,
        'tournament-create', '新增赛事');
    },
    table() {
        return tableBlock('tournaments', [['赛事'], ['游戏', 'center'], ['级别', 'center'], ['时间', 'nowrap'], ['比赛', 'center'], ['来源', 'center'], ['状态', 'center'], ['操作', 'right']], filteredTournaments(), t => {
            const uploaded = t.logo_url && t.logo_url.startsWith('/uploads/');
            return `<tr class="${t.is_active ? '' : 'is-dim'}">
                <td><div class="ops-cell-id">${tournamentLogoImg(t)}<div class="ops-cell-main"><strong class="ops-ellipsis" title="${esc(t.name)}">${esc(t.name)}</strong><small>#${t.id}${t.short_name ? ` · ${esc(t.short_name)}` : ''}</small></div></div></td>
                <td class="center">${gamePill(t.game_type)}</td>
                <td class="center nowrap">${tierPill(t)}</td>
                <td class="nowrap ops-mono">${dateOnly(t.begin_at) || '—'}<small class="ops-block">${dateOnly(t.end_at) || ''}</small></td>
                <td class="center ops-mono">${t.match_count}</td>
                <td class="center"><span class="ops-pill muted">${sourceLabel(t)}</span></td>
                <td class="center">${act(t.is_active ? '启用' : '禁用', 'tournament-toggle', t.id, `toggle ${t.is_active ? 'on' : 'off'}`)}</td>
                <td class="right"><div class="ops-acts">${act('编辑', 'tournament-edit', t.id)}${act(uploaded ? '换 Logo' : '传 Logo', 'tournament-logo', t.id)}${uploaded ? act('删 Logo', 'tournament-logo-remove', t.id, 'danger') : ''}${act('删除', 'tournament-delete', t.id, 'danger')}</div></td>
            </tr>`;
        });
    }
};

// ---------- 未来赛事预告 ----------

const previewsView = {
    toolbar() {
        return toolbar('未来赛事预告', `
            ${searchBox('previews', '搜索赛事名称 / 游戏')}
            ${filterSelect('previews', 'visible', [['', '全部显示状态'], ['1', '前台显示'], ['0', '已隐藏']])}
            <span class="ops-muted ops-note">仅控制赛事回看页的预告板块，不影响比赛与积分</span>`);
    },
    table() {
        return tableBlock('previews', [['赛事'], ['游戏', 'center'], ['开始', 'nowrap'], ['结束', 'nowrap'], ['前台', 'center']], filteredPreviews(), p => `
            <tr class="${p.is_visible ? '' : 'is-dim'}">
                <td><div class="ops-cell-id">${previewLogo(p)}<div class="ops-cell-main"><strong class="ops-ellipsis" title="${esc(p.name)}">${esc(p.name)}</strong><small>#${p.id} · ${esc(p.external_id)}</small></div></div></td>
                <td class="center">${gamePill(p.game_type)}</td>
                <td class="nowrap ops-mono">${fmtTime(p.begin_at)}</td>
                <td class="nowrap ops-mono">${fmtTime(p.end_at)}</td>
                <td class="center">${act(p.is_visible ? '显示中' : '已隐藏', 'preview-toggle', p.id, `toggle ${p.is_visible ? 'on' : 'off'}`)}</td>
            </tr>`);
    }
};

// ---------- 队伍 ----------

const teamsView = {
    toolbar() {
        return toolbar('队伍管理', `
            ${searchBox('teams', '搜索队伍名称 / 简称 / 国家 / ID')}
            ${filterSelect('teams', 'source', [['', '全部来源'], ['pandascore', '自动同步'], ['manual', '手动创建']])}`,
        'team-create', '新增队伍');
    },
    table() {
        return tableBlock('teams', [['队伍'], ['简称'], ['游戏', 'center'], ['国家/地区', 'center'], ['来源', 'center'], ['操作', 'right']], filteredTeams(), t => `
            <tr>
                <td><div class="ops-cell-id">${teamLogoImg(t.logo_url)}<div class="ops-cell-main"><strong class="ops-ellipsis">${esc(t.name)}</strong><small>#${t.id}</small></div></div></td>
                <td>${esc(t.short_name || '—')}</td>
                <td class="center">${gamePill(t.game_type)}</td>
                <td class="center">${esc(t.country || '—')}</td>
                <td class="center"><span class="ops-pill muted">${sourceLabel(t)}</span></td>
                <td class="right"><div class="ops-acts">${act('编辑', 'team-edit', t.id)}${act('删除', 'team-delete', t.id, 'danger')}</div></td>
            </tr>`);
    }
};

// ---------- 用户 ----------

const usersView = {
    toolbar() {
        return toolbar('用户管理', `
            ${searchBox('users', '搜索用户名 / ID')}
            ${filterSelect('users', 'role', [['', '全部角色'], ['user', '用户'], ['admin', '管理员']])}`,
        'user-create', '新增用户');
    },
    table() {
        return tableBlock('users', [['用户'], ['角色', 'center'], ['积分', 'center'], ['预测数', 'center'], ['注册时间', 'nowrap'], ['操作', 'right']], filteredUsers(), u => {
            const protectedUser = u.username === 'admin';
            return `<tr>
                <td><div class="ops-cell-main"><strong>${esc(u.username)}</strong><small>#${u.id}</small></div></td>
                <td class="center"><span class="ops-pill ${u.role === 'admin' ? 'info' : 'muted'}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
                <td class="center ops-mono"><b>${u.total_score ?? 0}</b></td>
                <td class="center ops-mono">${u.prediction_count ?? 0}</td>
                <td class="nowrap ops-mono">${fmtTime(u.created_at)}</td>
                <td class="right"><div class="ops-acts">${protectedUser ? '' : act(u.role === 'admin' ? '设为用户' : '设为管理', 'user-role', u.id)}${act('重置密码', 'user-password', u.id)}${protectedUser ? '' : act('删除', 'user-delete', u.id, 'danger')}</div></td>
            </tr>`;
        });
    }
};

// ---------- 预测记录 ----------

function predictionStatus(p) {
    if (p.match_is_forfeit) return '<span class="ops-pill warn">弃权</span>';
    if (p.match_status === 'finished') return '<span class="ops-pill muted">已结算</span>';
    return `<span class="ops-pill info">${esc(STATUS_LABELS[p.match_status] || p.match_status)}</span>`;
}

function predictionPoints(p) {
    if (p.match_is_forfeit) return '<span class="ops-muted">不计分</span>';
    if (p.match_status !== 'finished' || p.points_earned === null || p.points_earned === undefined) return '<span class="ops-muted">—</span>';
    return `<b class="${p.points_earned > 0 ? 'ops-pos' : 'ops-zero'}">${p.points_earned > 0 ? '+' : ''}${p.points_earned}</b>`;
}

const predictionsView = {
    toolbar() {
        return toolbar('预测记录', `
            ${searchBox('predictions', '搜索用户或队伍')}
            ${filterSelect('predictions', 'status', [['', '全部结算状态'], ['finished', '已结算'], ['pending', '未结算']])}
            <span class="ops-muted ops-note">仅显示最近 500 条</span>`);
    },
    table() {
        return tableBlock('predictions', [['用户'], ['比赛'], ['预测', 'center'], ['状态', 'center'], ['得分', 'center'], ['提交时间', 'nowrap'], ['操作', 'right']], filteredPredictions(), p => `
            <tr>
                <td><strong>${esc(p.username)}</strong></td>
                <td><div class="ops-cell-main"><span>${esc(p.team1_name)} <em>vs</em> ${esc(p.team2_name)}</span><small>${fmtTime(p.match_time)}</small></div></td>
                <td class="center"><span class="ops-mono ops-score">${p.predicted_team1_score} : ${p.predicted_team2_score}</span><small class="ops-block">${esc(p.predicted_winner_name)} 胜</small></td>
                <td class="center">${predictionStatus(p)}</td>
                <td class="center ops-mono">${predictionPoints(p)}</td>
                <td class="nowrap ops-mono">${fmtTime(p.created_at)}</td>
                <td class="right"><div class="ops-acts">${act('删除', 'prediction-delete', p.id, 'danger')}</div></td>
            </tr>`);
    }
};

const VIEWS = { matches: matchesView, tournaments: tournamentsView, previews: previewsView, teams: teamsView, users: usersView, predictions: predictionsView };

// ---------- 渲染 ----------

// 整页：工具条 + 表格；筛选变化时只重绘表格，避免搜索框失焦
function render() {
    const host = $('#opsView');
    if (!host || !isAdmin() || !state.loaded) return;
    if (state.tab === 'overview') {
        host.innerHTML = overviewView();
        return;
    }
    const view = VIEWS[state.tab];
    host.innerHTML = `<section class="ops-panel" data-panel="${state.tab}">${view.toolbar()}<div class="ops-table-host">${view.table()}</div></section>`;
}

function renderTable() {
    const view = VIEWS[state.tab];
    const host = $('#opsView .ops-table-host');
    if (view && host) host.innerHTML = view.table();
}

// 操作完成后：重新拉取全部数据（比赛结算会联动积分、预测，局部刷新容易不一致）
async function refresh(message) {
    await loadAll();
    return message;
}

// ---------- 比赛操作 ----------

const byId = (list, id) => list.find(row => String(row.id) === String(id));

function requireRow(list, id, label) {
    const row = byId(list, id);
    if (!row) throw new Error(`${label}不存在，请刷新`);
    return row;
}

function teamOptionsFor(game) {
    return state.teams.filter(t => !game || t.game_type === game).map(t => [t.id, `${t.name}${t.short_name ? ` (${t.short_name})` : ''}`]);
}

function createMatch() {
    if (!state.tournaments.length) throw new Error('请先创建赛事');
    const first = state.tournaments[0];
    openModal({
        title: '新增比赛',
        hint: '队伍列表随所选赛事的游戏自动过滤',
        body: `<div class="ops-form-grid">
            ${field('赛事', select('tournament_id', state.tournaments.map(t => [t.id, `${t.name} · ${GAME_LABELS[t.game_type]}`]), first.id), { wide: true })}
            ${field('队伍 1', select('team1_id', teamOptionsFor(first.game_type)))}
            ${field('队伍 2', select('team2_id', teamOptionsFor(first.game_type)))}
            ${field('赛制', select('format', [['BO1', 'BO1'], ['BO3', 'BO3'], ['BO5', 'BO5']], 'BO3'))}
            ${field('开赛时间', input('match_time', '', 'type="datetime-local" required'))}
            ${field('备注 / 阶段', input('name', '', 'placeholder="如：Playoffs · Semifinal"'), { wide: true })}
        </div>`,
        submitText: '创建比赛',
        onOpen(form) {
            // 切换赛事时按游戏重建两个队伍下拉
            form.elements.tournament_id.addEventListener('change', () => {
                const t = byId(state.tournaments, form.elements.tournament_id.value);
                const options = teamOptionsFor(t?.game_type).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
                form.elements.team1_id.innerHTML = options;
                form.elements.team2_id.innerHTML = options;
            });
        },
        async onSubmit(data) {
            if (!data.match_time) throw new Error('请填写开赛时间');
            if (data.team1_id === data.team2_id) throw new Error('两支队伍不能相同');
            await api('/admin/matches', { method: 'POST', body: { ...data, match_time: new Date(data.match_time).toISOString(), name: data.name || null } });
            return refresh('比赛已创建');
        }
    });
}

function editMatch(id) {
    const m = requireRow(state.matches, id, '比赛');
    const finished = m.status === 'finished';
    openModal({
        title: '编辑比赛',
        hint: `#${m.id} · ${m.team1_name} vs ${m.team2_name} · ${m.tournament_name}`,
        body: `<div class="ops-form-grid">
            ${field('状态', select('status', Object.entries(STATUS_LABELS), m.status), { hint: '标记为已结算前需先录入赛果' })}
            ${field('赛制', finished ? `<input value="${esc(m.format)}" disabled><input type="hidden" name="format" value="${esc(m.format)}">` : select('format', [['BO1', 'BO1'], ['BO3', 'BO3'], ['BO5', 'BO5']], m.format), { hint: finished ? '已结算比赛不能修改赛制' : '' })}
            ${field('开赛时间', input('match_time', toLocalInput(m.match_time), 'type="datetime-local"'))}
            ${field('备注 / 阶段', input('name', m.name || ''))}
        </div>`,
        async onSubmit(data) {
            await api(`/admin/matches/${m.id}`, { method: 'PUT', body: {
                status: data.status,
                format: data.format,
                match_time: data.match_time ? new Date(data.match_time).toISOString() : null,
                name: data.name || null
            } });
            return refresh('比赛已更新');
        }
    });
}

function setResult(id) {
    const m = requireRow(state.matches, id, '比赛');
    const chips = legalScores(m.format).map(([a, b]) => `<button type="button" class="ops-chip" data-score="${a}:${b}">${a} : ${b}</button>`).join('');
    openModal({
        title: '录入赛果',
        hint: `${m.format} · 录入后自动结算预测积分，并锁定赛果不被同步覆盖`,
        body: `<div class="ops-score-form">
            <div class="ops-score-team">${esc(m.team1_name)}</div>
            <input name="team1_score" type="number" min="0" max="3" inputmode="numeric" value="${m.team1_score ?? ''}" required aria-label="${esc(m.team1_name)} 比分">
            <span class="ops-score-sep">:</span>
            <input name="team2_score" type="number" min="0" max="3" inputmode="numeric" value="${m.team2_score ?? ''}" required aria-label="${esc(m.team2_name)} 比分">
            <div class="ops-score-team">${esc(m.team2_name)}</div>
        </div>
        <div class="ops-score-chips"><span>快捷比分</span>${chips}</div>`,
        submitText: '录入并结算',
        onOpen(form) {
            form.addEventListener('click', event => {
                const chip = event.target.closest('[data-score]');
                if (!chip) return;
                const [a, b] = chip.dataset.score.split(':');
                form.elements.team1_score.value = a;
                form.elements.team2_score.value = b;
                form.querySelectorAll('[data-score]').forEach(el => el.classList.toggle('active', el === chip));
            });
        },
        async onSubmit(data) {
            const s1 = Number(data.team1_score);
            const s2 = Number(data.team2_score);
            if (data.team1_score === '' || data.team2_score === '' || !Number.isInteger(s1) || !Number.isInteger(s2)) throw new Error('请填写两队比分');
            if (!legalScores(m.format).some(([a, b]) => a === s1 && b === s2)) throw new Error(`比分不符合 ${m.format} 赛制`);
            const result = await api(`/admin/matches/${m.id}/result`, { method: 'PUT', body: { team1_score: s1, team2_score: s2 } });
            return refresh(`赛果已保存，结算 ${result.predictions_processed ?? 0} 条预测`);
        }
    });
}

function setForfeit(id) {
    const m = requireRow(state.matches, id, '比赛');
    openModal({
        title: '设置弃权',
        hint: '弃权按 1-0 记录，所有预测不计积分',
        body: `<div class="ops-radio-list">
            <label><input type="radio" name="winner" value="${m.team1_id}" checked><span><b>${esc(m.team1_name)}</b> 胜（${esc(m.team2_name)} 弃权）</span></label>
            <label><input type="radio" name="winner" value="${m.team2_id}"><span><b>${esc(m.team2_name)}</b> 胜（${esc(m.team1_name)} 弃权）</span></label>
        </div>`,
        submitText: '确认弃权',
        danger: true,
        async onSubmit(data) {
            await api(`/admin/matches/${m.id}/forfeit`, { method: 'PUT', body: { winner_team_id: Number(data.winner) } });
            return refresh('已标记为弃权');
        }
    });
}

async function toggleBetting(id) {
    const result = await api(`/admin/matches/${id}/betting`, { method: 'PUT' });
    toast(result.betting_enabled ? '预测已开启' : '预测已关闭');
    await loadAll();
}

function deleteMatch(id) {
    const m = requireRow(state.matches, id, '比赛');
    confirmAction({
        title: '删除比赛',
        message: `确认删除 ${m.team1_name} vs ${m.team2_name}？该比赛的所有预测会一并删除，用户积分将重新计算。`,
        confirmText: '删除',
        async run() {
            await api(`/admin/matches/${m.id}`, { method: 'DELETE' });
            return refresh('比赛已删除');
        }
    });
}

// ---------- 赛事操作 ----------

const TIER_OPTIONS = [['', '自动（按名称关键词推断）'], ['1', '高级（Major 级）'], ['2', '普通'], ['3', '低级（预选赛级）']];

function tournamentForm(t = {}) {
    const tier = t.tier === null || t.tier === undefined ? '' : String(t.tier);
    return `<div class="ops-form-grid">
        ${field('名称', input('name', t.name || '', 'required'), { wide: true })}
        ${field('简称', input('short_name', t.short_name || '', 'placeholder="如：IEM 科隆"'), { hint: '主页筛选与移动端展示' })}
        ${field('游戏', select('game_type', GAME_OPTIONS, t.game_type || state.game || 'cs2'))}
        ${field('开始日期', input('begin_at', dateOnly(t.begin_at), 'type="date"'))}
        ${field('结束日期', input('end_at', dateOnly(t.end_at), 'type="date"'))}
        ${t.id ? field('级别', select('tier', TIER_OPTIONS, tier), { hint: 'Major/Masters/Champions → 高级，Qualifier/预选赛 → 低级；手动设置后同步不覆盖', wide: true }) : ''}
    </div>`;
}

function createTournament() {
    openModal({
        title: '新增赛事',
        body: tournamentForm(),
        submitText: '创建赛事',
        async onSubmit(data) {
            if (!data.name.trim()) throw new Error('赛事名称不能为空');
            await api('/admin/tournaments', { method: 'POST', body: { ...data, is_active: 1 } });
            return refresh('赛事已创建');
        }
    });
}

function editTournament(id) {
    const t = requireRow(state.tournaments, id, '赛事');
    openModal({
        title: '编辑赛事',
        hint: `#${t.id} · ${t.match_count || 0} 场比赛 · ${sourceLabel(t)}`,
        body: tournamentForm(t),
        async onSubmit(data) {
            if (!data.name.trim()) throw new Error('赛事名称不能为空');
            await api(`/admin/tournaments/${t.id}`, { method: 'PUT', body: {
                ...data,
                tier: data.tier === '' ? null : Number(data.tier),
                begin_at: data.begin_at || null,
                end_at: data.end_at || null
            } });
            return refresh('赛事已更新');
        }
    });
}

async function toggleTournament(id) {
    const t = requireRow(state.tournaments, id, '赛事');
    const run = async () => {
        await api(`/admin/tournaments/${t.id}/toggle-active`, { method: 'PUT' });
        return refresh(t.is_active ? '赛事已禁用' : '赛事已启用');
    };
    if (!t.is_active) {
        toast(await run());
        return;
    }
    confirmAction({
        title: '禁用赛事',
        message: `禁用「${t.name}」后，前台不再展示该赛事，未结束比赛关闭预测，后续自动同步也会跳过它。`,
        confirmText: '禁用',
        run
    });
}

// 切换预告前台显示：隐藏项仍保留在后台列表，便于随时恢复
async function togglePreview(id) {
    const p = requireRow(state.previews, id, '赛事预告');
    const next = p.is_visible ? 0 : 1;
    await api(`/admin/previews/${p.id}/visibility`, { method: 'PUT', body: { is_visible: next } });
    toast(await refresh(next ? '已在前台显示该赛事预告' : '已在前台隐藏该赛事预告'));
}

function deleteTournament(id) {
    const t = requireRow(state.tournaments, id, '赛事');
    if (t.match_count > 0) throw new Error(`该赛事下还有 ${t.match_count} 场比赛，不能删除；可改为禁用`);
    confirmAction({
        title: '删除赛事',
        message: `确认删除「${t.name}」？`,
        confirmText: '删除',
        async run() {
            await api(`/admin/tournaments/${t.id}`, { method: 'DELETE' });
            return refresh('赛事已删除');
        }
    });
}

// 手动上传赛事 logo：二进制直传，成功后覆盖名称匹配的默认 logo
function uploadTournamentLogo(id) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
    picker.onchange = () => runAction(async () => {
        const file = picker.files && picker.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2MB');
        await api(`/admin/tournaments/${id}/logo`, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file
        });
        toast(await refresh('Logo 已上传'));
    });
    picker.click();
}

function removeTournamentLogo(id) {
    confirmAction({
        title: '清除 Logo',
        message: '清除手动上传的 logo？清除后回退到按名称匹配的默认 logo。',
        confirmText: '清除',
        async run() {
            await api(`/admin/tournaments/${id}/logo`, { method: 'DELETE' });
            return refresh('Logo 已清除');
        }
    });
}

// ---------- 队伍操作 ----------

function teamForm(t = {}) {
    return `<div class="ops-form-grid">
        ${field('名称', input('name', t.name || '', 'required'), { wide: true })}
        ${field('简称', input('short_name', t.short_name || ''))}
        ${field('游戏', select('game_type', GAME_OPTIONS, t.game_type || state.game || 'cs2'))}
        ${field('国家/地区', input('country', t.country || '', 'placeholder="如：DE 或 Germany"'))}
        ${field('Logo URL', input('logo_url', t.logo_url || '', 'placeholder="https://..."'), { wide: true })}
    </div>`;
}

function createTeam() {
    openModal({
        title: '新增队伍',
        body: teamForm(),
        submitText: '创建队伍',
        async onSubmit(data) {
            if (!data.name.trim()) throw new Error('队伍名称不能为空');
            await api('/admin/teams', { method: 'POST', body: data });
            return refresh('队伍已创建');
        }
    });
}

function editTeam(id) {
    const t = requireRow(state.teams, id, '队伍');
    openModal({
        title: '编辑队伍',
        // 服务端按 COALESCE 更新：留空表示保留原值，而不是清空
        hint: `#${t.id} · ${sourceLabel(t)} · 留空的字段保持原值`,
        body: teamForm(t),
        async onSubmit(data) {
            await api(`/admin/teams/${t.id}`, { method: 'PUT', body: data });
            return refresh('队伍已更新');
        }
    });
}

function deleteTeam(id) {
    const t = requireRow(state.teams, id, '队伍');
    confirmAction({
        title: '删除队伍',
        message: `确认删除「${t.name}」？有关联比赛的队伍无法删除。`,
        confirmText: '删除',
        async run() {
            await api(`/admin/teams/${t.id}`, { method: 'DELETE' });
            return refresh('队伍已删除');
        }
    });
}

// ---------- 用户操作 ----------

function createUser() {
    openModal({
        title: '新增用户',
        body: `<div class="ops-form-grid">
            ${field('用户名', input('username', '', 'required autocomplete="off"'))}
            ${field('角色', select('role', [['user', '用户'], ['admin', '管理员']], 'user'))}
            ${field('密码', input('password', '', 'type="password" required autocomplete="new-password"'), { hint: '至少 6 位', wide: true })}
        </div>`,
        submitText: '创建用户',
        async onSubmit(data) {
            if (!data.username.trim()) throw new Error('用户名不能为空');
            if (data.password.length < 6) throw new Error('密码至少 6 位');
            await api('/admin/users', { method: 'POST', body: data });
            return refresh('用户已创建');
        }
    });
}

function toggleRole(id) {
    const u = requireRow(state.users, id, '用户');
    const next = u.role === 'admin' ? 'user' : 'admin';
    confirmAction({
        title: next === 'admin' ? '设为管理员' : '取消管理员',
        message: next === 'admin' ? `将「${u.username}」设为管理员？管理员拥有本后台的全部权限。` : `将「${u.username}」降为普通用户？`,
        confirmText: '确认',
        danger: next === 'admin',
        async run() {
            await api(`/admin/users/${u.id}/role`, { method: 'PUT', body: { role: next } });
            return refresh('角色已更新');
        }
    });
}

function resetPassword(id) {
    const u = requireRow(state.users, id, '用户');
    openModal({
        title: '重置密码',
        hint: `用户：${u.username} · 重置后该用户的已登录会话全部失效`,
        body: field('新密码', input('password', '', 'type="password" required autocomplete="new-password"'), { hint: '至少 6 位' }),
        submitText: '重置',
        async onSubmit(data) {
            if (data.password.length < 6) throw new Error('密码至少 6 位');
            await api(`/admin/users/${u.id}/password`, { method: 'PUT', body: { password: data.password } });
            return '密码已重置';
        }
    });
}

function deleteUser(id) {
    const u = requireRow(state.users, id, '用户');
    confirmAction({
        title: '删除用户',
        message: `确认删除「${u.username}」？其全部预测记录会一并删除，排行榜将重新计算。`,
        confirmText: '删除',
        async run() {
            await api(`/admin/users/${u.id}`, { method: 'DELETE' });
            return refresh('用户已删除');
        }
    });
}

function deletePrediction(id) {
    const p = requireRow(state.predictions, id, '预测');
    confirmAction({
        title: '删除预测',
        message: `确认删除「${p.username}」对 ${p.team1_name} vs ${p.team2_name} 的预测？`,
        confirmText: '删除',
        async run() {
            await api(`/admin/predictions/${p.id}`, { method: 'DELETE' });
            return refresh('预测已删除');
        }
    });
}

// ---------- 事件委托 ----------

// 统一错误兜底：操作抛错一律提示，避免静默失败
async function runAction(fn) {
    try {
        await fn();
    } catch (error) {
        toast(error.message || '操作失败', 'bad');
    }
}

const ACTIONS = {
    logout,
    'save-preview-days': savePreviewDays,
    'sync-previews': syncPreviews,
    goto: el => setTab(el.dataset.tab),
    'goto-todo': () => { state.filters.matches.todo = true; setTab('matches'); },
    'toggle-todo': () => { state.filters.matches.todo = !state.filters.matches.todo; render(); },
    more: el => { state.limits[el.dataset.tab] = limitOf(el.dataset.tab) + PAGE_SIZE; renderTable(); },
    'match-create': createMatch,
    'match-edit': el => editMatch(el.dataset.id),
    'match-result': el => setResult(el.dataset.id),
    'match-forfeit': el => setForfeit(el.dataset.id),
    'match-betting': el => toggleBetting(el.dataset.id),
    'match-delete': el => deleteMatch(el.dataset.id),
    'tournament-create': createTournament,
    'tournament-edit': el => editTournament(el.dataset.id),
    'tournament-toggle': el => toggleTournament(el.dataset.id),
    'tournament-delete': el => deleteTournament(el.dataset.id),
    'tournament-logo': el => uploadTournamentLogo(el.dataset.id),
    'tournament-logo-remove': el => removeTournamentLogo(el.dataset.id),
    'preview-toggle': el => togglePreview(el.dataset.id),
    'team-create': createTeam,
    'team-edit': el => editTeam(el.dataset.id),
    'team-delete': el => deleteTeam(el.dataset.id),
    'user-create': createUser,
    'user-role': el => toggleRole(el.dataset.id),
    'user-password': el => resetPassword(el.dataset.id),
    'user-delete': el => deleteUser(el.dataset.id),
    'prediction-delete': el => deletePrediction(el.dataset.id)
};

document.addEventListener('click', event => {
    if (event.target.closest('#opsModal [data-close]')) { closeModal(); return; }
    const tab = event.target.closest('#opsNav button[data-tab]');
    if (tab) { setTab(tab.dataset.tab); return; }
    const game = event.target.closest('#opsGameSeg button[data-game]');
    if (game) { setGame(game.dataset.game); return; }
    const el = event.target.closest('[data-act]');
    if (!el || !ACTIONS[el.dataset.act]) return;
    // 行内按钮防重复点击：异步期间禁用
    if (el.disabled) return;
    el.disabled = true;
    runAction(() => ACTIONS[el.dataset.act](el)).finally(() => { if (el.isConnected) el.disabled = false; });
});

// 筛选控件：写入当前页签的 filters，只重绘表格
function onFilter(event) {
    const el = event.target.closest('[data-filter]');
    if (!el || !state.filters[state.tab]) return;
    state.filters[state.tab][el.dataset.filter] = el.value;
    state.limits[state.tab] = PAGE_SIZE;
    if (el.type === 'search') {
        clearTimeout(onFilter.timer);
        onFilter.timer = setTimeout(renderTable, 120);
    } else {
        renderTable();
    }
}
document.addEventListener('input', onFilter);
document.addEventListener('change', event => { if (event.target.matches('select[data-filter]')) onFilter(event); });

document.addEventListener('submit', event => {
    if (event.target.id === 'opsLoginForm') login(event);
    else if (event.target.id === 'opsModalForm') submitModal(event);
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#opsModal').hidden) closeModal();
});

window.addEventListener('hashchange', () => setTab(tabFromHash(), { updateHash: false }));
$('#opsSyncBtn').addEventListener('click', () => runAction(syncNow));
$('#opsReloadBtn').addEventListener('click', () => runAction(async () => { await loadAll(); toast('已刷新'); }));
// 主题切换后赛事 logo 由 tournament-logos.js 换源；表格无需重绘

// ---------- 启动 ----------

renderAuth();
renderGate();
state.tab = tabFromHash();
$$('#opsNav button[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === state.tab));
loadAll();
