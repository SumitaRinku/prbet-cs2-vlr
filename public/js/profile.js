// 个人中心：概览（身份 + 统计 + 近期状态）+ 标签页（我的预测 / 账号设置，同步 URL hash）。
// 预测记录为单一响应式行：桌面一行展示，移动端自动折成上下两段，不再区分紧凑/详细视图。
const PREDICTION_PAGE_SIZE = 20;
const RECENT_FORM_SIZE = 10;

const profileState = {
    predictions: [],
    stats: null,
    filter: '',
    game: '',
    tournament: '',
    visibleCount: PREDICTION_PAGE_SIZE,
    tab: 'records'
};

const el = id => document.getElementById(id);

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// ---------- 单条预测的结果判定 ----------

// 返回 forfeit / pending / exact（比分全中）/ correct（猜中胜者）/ wrong
function outcome(p) {
    if (p.match_is_forfeit) return 'forfeit';
    if (p.match_status !== 'finished' || p.points_earned === null) return 'pending';
    if ((p.points_earned || 0) === 0) return 'wrong';
    return p.predicted_team1_score === p.actual_team1_score && p.predicted_team2_score === p.actual_team2_score ? 'exact' : 'correct';
}

const OUTCOME_LABEL = { forfeit: '弃权', pending: '待结算', exact: '比分全中', correct: '猜中胜者', wrong: '未得分' };

// ---------- 状态筛选（chips + 计数） ----------

const PF_FILTERS = [
    { key: '', label: '全部', match: () => true },
    { key: 'pending', label: '待结算', match: p => outcome(p) === 'pending' },
    { key: 'scored', label: '已得分', match: p => ['exact', 'correct'].includes(outcome(p)) },
    { key: 'exact', label: '比分全中', match: p => outcome(p) === 'exact' },
    { key: 'missed', label: '未得分', match: p => outcome(p) === 'wrong' },
    { key: 'forfeit', label: '弃权', match: p => outcome(p) === 'forfeit' }
];

const activeFilter = () => PF_FILTERS.find(f => f.key === profileState.filter) || PF_FILTERS[0];

// 游戏 / 赛事维度（状态 chips 的计数也只统计这个范围）
const inScope = p => (!profileState.game || p.game_type === profileState.game)
    && (!profileState.tournament || p.tournament_name === profileState.tournament);

const filteredPredictions = () => profileState.predictions.filter(p => inScope(p) && activeFilter().match(p));

function renderFilterChips() {
    const host = el('pfChips');
    if (!host) return;
    const scoped = profileState.predictions.filter(inScope);
    host.innerHTML = PF_FILTERS.map(({ key, label, match }) => {
        const active = profileState.filter === key;
        return `<button type="button" class="pc-chip ${active ? 'active' : ''}" aria-pressed="${active}" onclick="setProfileFilter('${key}')">
            <span>${label}</span><b>${scoped.filter(match).length}</b>
        </button>`;
    }).join('');
}

// 游戏 / 赛事下拉：选项由预测记录动态生成，赛事列表跟随游戏联动
function renderFilterSelects() {
    const gameSel = el('pfGame');
    const tSel = el('pfTournament');
    if (!gameSel || !tSel) return;
    const games = [...new Set(profileState.predictions.map(p => p.game_type).filter(Boolean))];
    gameSel.innerHTML = '<option value="">全部游戏</option>'
        + games.map(g => `<option value="${g}"${profileState.game === g ? ' selected' : ''}>${gameName(g)}</option>`).join('');
    const tournaments = [...new Set(profileState.predictions
        .filter(p => !profileState.game || p.game_type === profileState.game)
        .map(p => p.tournament_name).filter(Boolean))];
    if (profileState.tournament && !tournaments.includes(profileState.tournament)) profileState.tournament = '';
    tSel.innerHTML = '<option value="">全部赛事</option>'
        + tournaments.map(t => `<option value="${escapeHtml(t)}"${profileState.tournament === t ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
    tSel.disabled = tournaments.length <= 1 && !profileState.tournament;
}

function refreshRecords() {
    profileState.visibleCount = PREDICTION_PAGE_SIZE;
    renderFilterChips();
    renderFilterSelects();
    renderPredictions();
}

function setProfileFilter(key) {
    profileState.filter = key;
    refreshRecords();
}

function setProfileGame(game) {
    profileState.game = game;
    profileState.tournament = '';
    refreshRecords();
}

function setProfileTournament(tournament) {
    profileState.tournament = tournament;
    refreshRecords();
}

// ---------- 预测记录行 ----------

function teamCell(p, side, winnerId) {
    const name = p[`team${side}_short_name`] || p[`team${side}_name`];
    const picked = p.predicted_winner_id === p[`team${side}_id`];
    const won = winnerId !== null && winnerId === p[`team${side}_id`];
    return `<div class="pc-team pc-team-${side} ${picked ? 'picked' : ''} ${won ? 'won' : ''}" title="${escapeHtml(p[`team${side}_name`])}${picked ? '（你的预测胜者）' : ''}">
        ${logoHtml(p[`team${side}_logo_url`], p[`team${side}_dark_logo_url`])}
        <strong>${escapeHtml(name)}</strong>
    </div>`;
}

// 实际胜者：以比分判断（弃权局比分按 1-0 记录，同样适用）
function winnerOf(p) {
    if (p.match_status !== 'finished' || p.actual_team1_score === null || p.actual_team2_score === null) return null;
    if (p.actual_team1_score === p.actual_team2_score) return null;
    return p.actual_team1_score > p.actual_team2_score ? p.team1_id : p.team2_id;
}

function predictionRow(p) {
    const state = outcome(p);
    const actual = p.match_status === 'finished' && p.actual_team1_score !== null
        ? `${p.actual_team1_score}:${p.actual_team2_score}`
        : '—';
    const points = state === 'pending' ? '' : state === 'forfeit' ? '不计分' : `+${p.points_earned || 0}`;
    return `<article class="pc-rec ${state}">
        <div class="pc-rec-meta">
            <span class="game-pill ${p.game_type || ''}">${gameName(p.game_type)}</span>
            <span class="pc-rec-tournament" title="${escapeHtml(p.tournament_name)}">${escapeHtml(p.tournament_name)}</span>
            <time datetime="${escapeHtml(p.match_time)}">${formatDateTime(p.match_time)}</time>
            <span class="pc-rec-format">${escapeHtml(p.format || '')}</span>
        </div>
        <div class="pc-rec-match">
            ${teamCell(p, 1, winnerOf(p))}
            <div class="pc-rec-score">
                <span class="pc-pick" title="我的预测">${p.predicted_team1_score}:${p.predicted_team2_score}</span>
                <span class="pc-actual" title="实际比分">${actual}</span>
            </div>
            ${teamCell(p, 2, winnerOf(p))}
        </div>
        <div class="pc-rec-result">
            <span class="pc-badge ${state}">${OUTCOME_LABEL[state]}</span>
            ${points ? `<b class="pc-points">${points}</b>` : ''}
            <button class="pc-share" type="button" onclick="sharePredictionFromProfile(${p.match_id})" aria-label="生成分享图" title="生成分享图">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7l-6.7 3.4a3 3 0 1 0 0 3.2L15 17a3 3 0 1 0 3-1Z"/></svg>
                <span>分享</span>
            </button>
        </div>
    </article>`;
}

function renderPredictions() {
    const listEl = el('predictionList');
    if (!listEl) return;
    const predictions = filteredPredictions();
    const countEl = el('recordCount');
    if (countEl) countEl.textContent = `${predictions.length} 条`;
    if (!predictions.length) {
        const any = profileState.predictions.length > 0;
        listEl.innerHTML = `<div class="pc-empty"><h3>${any ? '暂无匹配记录' : '暂无预测记录'}</h3>
            <p>${any ? '换个筛选条件试试。' : '去<a href="/">比赛竞猜</a>提交预测后，会在这里显示。'}</p></div>`;
        return;
    }
    // 分页渲染：全量渲染上百条会拖慢长列表（移动端尤甚）
    const visible = predictions.slice(0, profileState.visibleCount);
    const remaining = predictions.length - visible.length;
    listEl.innerHTML = visible.map(predictionRow).join('')
        + (remaining > 0 ? `<button type="button" class="ghost pc-more" onclick="loadMorePredictions()">显示更多（剩余 ${remaining} 条）</button>` : '');
}

function loadMorePredictions() {
    profileState.visibleCount += PREDICTION_PAGE_SIZE;
    renderPredictions();
}

// ---------- 概览 ----------

function renderHero() {
    const heroEl = el('profileHero');
    if (!heroEl || !sharedState.user) return;
    const stats = profileState.stats || {};
    const settled = stats.settled || 0;
    const rate = settled ? Math.round(((stats.correct || 0) / settled) * 100) : 0;
    const exact = profileState.predictions.filter(p => outcome(p) === 'exact').length;
    const pending = profileState.predictions.filter(p => outcome(p) === 'pending').length;
    const user = sharedState.user;
    const initial = String(user.username || '?').trim().charAt(0).toUpperCase();
    // 近期状态：按开赛时间最近的已结算（非弃权）预测，从左到右由近及远
    const recent = profileState.predictions
        .filter(p => ['exact', 'correct', 'wrong'].includes(outcome(p)))
        .slice(0, RECENT_FORM_SIZE);
    const form = recent.length
        ? recent.map(p => {
            const state = outcome(p);
            const team1 = p.team1_short_name || p.team1_name;
            const team2 = p.team2_short_name || p.team2_name;
            return `<i class="pc-dot ${state}" title="${escapeHtml(`${team1} vs ${team2} · ${OUTCOME_LABEL[state]}`)}"></i>`;
        }).join('')
        : '<em>暂无已结算预测</em>';
    heroEl.innerHTML = `
        <div class="pc-id">
            <div class="pc-avatar" aria-hidden="true">${escapeHtml(initial)}</div>
            <div class="pc-id-text">
                <h2>${escapeHtml(user.username)}</h2>
                <p><span class="pc-role ${user.role === 'admin' ? 'admin' : ''}">${user.role === 'admin' ? '管理员' : '用户'}</span>账号积分 <b>${user.total_score || 0}</b></p>
            </div>
        </div>
        <dl class="pc-stats">
            <div><dt>总预测</dt><dd>${stats.total || 0}</dd></div>
            <div><dt>待结算</dt><dd>${pending}</dd></div>
            <div><dt>得分率</dt><dd>${rate}<small>%</small></dd></div>
            <div><dt>比分全中</dt><dd>${exact}</dd></div>
            <div><dt>累计得分</dt><dd>${stats.points || 0}</dd></div>
        </dl>
        <div class="pc-form-strip" aria-label="近期 ${recent.length} 场结果">
            <span>近期状态</span>
            <div class="pc-dots">${form}</div>
        </div>`;
}

// ---------- 标签页（状态同步 URL hash，刷新/分享不丢） ----------

function setProfileTab(tab, updateHash = true) {
    profileState.tab = tab === 'settings' ? 'settings' : 'records';
    document.querySelectorAll('[data-profile-tab]').forEach(button => {
        const active = button.dataset.profileTab === profileState.tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        button.tabIndex = active ? 0 : -1;
    });
    const recordsEl = el('profileTabRecords');
    const settingsEl = el('profileTabSettings');
    if (recordsEl) recordsEl.hidden = profileState.tab !== 'records';
    if (settingsEl) settingsEl.hidden = profileState.tab !== 'settings';
    if (updateHash) {
        // replaceState：切换标签不新增历史记录，后退直接离开个人中心
        history.replaceState(null, '', location.pathname + location.search + (profileState.tab === 'settings' ? '#settings' : ''));
    }
}

window.addEventListener('hashchange', () => setProfileTab(location.hash === '#settings' ? 'settings' : 'records', false));

// 标签页键盘操作：左右方向键切换（WAI-ARIA tabs 模式）
document.querySelector('.pc-tabs')?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const next = profileState.tab === 'records' ? 'settings' : 'records';
    setProfileTab(next);
    document.querySelector(`[data-profile-tab="${next}"]`)?.focus();
    event.preventDefault();
});

// ---------- 管理员：排行榜公开开关 ----------

function renderVisibility() {
    const section = el('visibilitySection');
    if (!section) return;
    const isAdmin = sharedState.user?.role === 'admin';
    section.hidden = !isAdmin;
    if (!isAdmin) return;
    const toggle = el('visibilityToggle');
    // 旧登录态的 localStorage user 可能没有 predictions_public 字段，用 /auth/me 校准一次
    if (sharedState.user.predictions_public === undefined) {
        sharedApi('/auth/me')
            .then(data => {
                sharedState.user = { ...sharedState.user, ...data.user };
                localStorage.setItem('user', JSON.stringify(sharedState.user));
                toggle.checked = Boolean(sharedState.user.predictions_public);
            })
            .catch(() => {});
    } else {
        toggle.checked = Boolean(sharedState.user.predictions_public);
    }
}

function showFeedback(id, message, tone) {
    const box = el(id);
    if (!box) return;
    box.textContent = message;
    box.className = `pc-feedback ${tone || ''}`;
    box.hidden = !message;
}

async function togglePredictionsPublic(publicPredictions) {
    showFeedback('visibilityFeedback', '保存中…');
    try {
        const data = await sharedApi('/auth/visibility', { method: 'PUT', body: { predictions_public: publicPredictions ? 1 : 0 } });
        sharedState.user = { ...sharedState.user, ...data.user };
        localStorage.setItem('user', JSON.stringify(sharedState.user));
        showFeedback('visibilityFeedback', publicPredictions ? '已公开：排行榜将展示你的成绩' : '已隐藏：排行榜不再展示你的成绩', 'ok');
    } catch (error) {
        el('visibilityToggle').checked = !publicPredictions;
        showFeedback('visibilityFeedback', error.message, 'err');
    }
}

// ---------- 修改密码（内联反馈，不用 alert） ----------

async function changePassword(event) {
    event.preventDefault();
    const oldValue = el('oldPassword').value;
    const newValue = el('newPassword').value;
    if (!newValue || newValue.length < 6) { showFeedback('pfFeedback', '新密码至少 6 位', 'err'); return; }
    if (newValue !== el('newPasswordConfirm').value) { showFeedback('pfFeedback', '两次输入的新密码不一致', 'err'); return; }
    const button = event.submitter || event.target.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    try {
        const data = await sharedApi('/auth/password', { method: 'PUT', body: { old_password: oldValue, new_password: newValue } });
        sharedState.token = data.token;
        localStorage.setItem('token', data.token);
        el('oldPassword').value = el('newPassword').value = el('newPasswordConfirm').value = '';
        showFeedback('pfFeedback', '密码已修改', 'ok');
    } catch (error) {
        showFeedback('pfFeedback', error.message, 'err');
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------- 数据加载 ----------

async function loadProfile() {
    if (!sharedState.user) {
        el('loginRequired').hidden = false;
        el('profileContent').hidden = true;
        return;
    }
    el('loginRequired').hidden = true;
    el('profileContent').hidden = false;
    el('predictionList').innerHTML = '<div class="pc-loading">加载预测记录…</div>';
    const data = await sharedApi('/predictions/my');
    profileState.predictions = data.predictions || [];
    profileState.stats = data.stats;
    profileState.filter = '';
    profileState.game = '';
    profileState.tournament = '';
    renderHero();
    renderVisibility();
    refreshRecords();
}

// ---------- 分享图桥接（share.js 通过 window.getMatchForShare / getShareContext 取数） ----------

// 把预测记录转换为分享卡所需的 match 结构（字段名与 app.js 的赛程 match 对齐）
window.getMatchForShare = matchId => {
    const p = profileState.predictions.find(item => String(item.match_id) === String(matchId));
    if (!p) return null;
    return {
        id: p.match_id,
        name: p.match_name,
        tournament_name: p.tournament_name,
        tournament_id: p.tournament_id,
        match_time: p.match_time,
        is_forfeit: p.match_is_forfeit,
        team1_id: p.team1_id,
        team2_id: p.team2_id,
        team1_name: p.team1_name,
        team1_short_name: p.team1_short_name,
        team1_logo_url: p.team1_logo_url,
        team1_dark_logo_url: p.team1_dark_logo_url,
        team2_name: p.team2_name,
        team2_short_name: p.team2_short_name,
        team2_logo_url: p.team2_logo_url,
        team2_dark_logo_url: p.team2_dark_logo_url,
        team1_score: p.actual_team1_score,
        team2_score: p.actual_team2_score,
        user_prediction: {
            predicted_team1_score: p.predicted_team1_score,
            predicted_team2_score: p.predicted_team2_score,
            predicted_winner_id: p.predicted_winner_id,
            points_earned: p.points_earned
        }
    };
};

window.getShareContext = () => ({ user: sharedState.user });

function sharePredictionFromProfile(matchId) {
    if (typeof window.sharePrediction === 'function') window.sharePrediction(matchId);
}

// ---------- 启动 ----------

window.sharePredictionFromProfile = sharePredictionFromProfile;
window.loadMorePredictions = loadMorePredictions;
window.setProfileFilter = setProfileFilter;
window.setProfileGame = setProfileGame;
window.setProfileTournament = setProfileTournament;
window.togglePredictionsPublic = togglePredictionsPublic;
window.setProfileTab = setProfileTab;
el('passwordForm')?.addEventListener('submit', changePassword);
window.addEventListener('auth-changed', () => loadProfile().catch(showLoadError));
setProfileTab(location.hash === '#settings' ? 'settings' : 'records', false);

function showLoadError(error) {
    el('profileContent').hidden = false;
    el('predictionList').innerHTML = `<div class="pc-empty"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
}

loadProfile().catch(showLoadError);
