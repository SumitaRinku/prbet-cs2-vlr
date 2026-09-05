// 个人中心 v2：状态驱动渲染。
// 功能与旧版一致（登录态 / 统计概览 / 修改密码 / 预测记录筛选 + 分页 + 分享），
// 结构调整为：概览头部 + 标签页（预测记录 / 账号设置，同步 URL hash）。
const PREDICTION_PAGE_SIZE = 20;

const profileState = {
    predictions: [],
    stats: null,
    filter: '',
    game: '',
    tournament: '',
    // 紧凑视图为默认：长列表一条一行更高效，可切回详细卡片
    view: localStorage.getItem('profileViewMode') === 'cards' ? 'cards' : 'compact',
    visibleCount: PREDICTION_PAGE_SIZE,
    tab: 'records'
};

const el = id => document.getElementById(id);

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// ---------- 状态筛选（chips + 计数） ----------

const PF_FILTERS = [
    { key: '', label: '全部', match: () => true },
    { key: 'pending', label: '待结算', match: p => p.match_status !== 'finished' && !p.match_is_forfeit },
    { key: 'finished', label: '已结算', match: p => p.match_status === 'finished' },
    { key: 'scored', label: '已得分', match: p => p.match_status === 'finished' && (p.points_earned || 0) > 0 },
    { key: 'missed', label: '未得分', match: p => p.match_status === 'finished' && !p.match_is_forfeit && (p.points_earned || 0) === 0 },
    { key: 'forfeit', label: '弃权', match: p => Boolean(p.match_is_forfeit) }
];

function activeFilter() {
    return PF_FILTERS.find(f => f.key === profileState.filter) || PF_FILTERS[0];
}

function filteredPredictions() {
    return profileState.predictions.filter(p =>
        activeFilter().match(p)
        && (!profileState.game || p.game_type === profileState.game)
        && (!profileState.tournament || p.tournament_name === profileState.tournament)
    );
}

function renderFilterChips() {
    const host = el('pfChips');
    if (!host) return;
    // chips 计数跟随游戏/赛事下拉联动，只统计当前维度下的记录
    const scoped = profileState.predictions.filter(p =>
        (!profileState.game || p.game_type === profileState.game)
        && (!profileState.tournament || p.tournament_name === profileState.tournament)
    );
    host.innerHTML = PF_FILTERS.map(({ key, label, match }) => {
        const count = scoped.filter(match).length;
        return `<button type="button" class="pf-chip ${profileState.filter === key ? 'active' : ''}" onclick="setProfileFilter('${key}')">
            <span>${label}</span><b>${count}</b>
        </button>`;
    }).join('');
}

// 游戏 / 赛事下拉：选项由预测记录动态生成，赛事列表跟随游戏筛选联动
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

function setProfileFilter(key) {
    profileState.filter = key;
    profileState.visibleCount = PREDICTION_PAGE_SIZE;
    renderFilterChips();
    renderPredictions();
}

function setProfileGame(game) {
    profileState.game = game;
    profileState.tournament = '';
    profileState.visibleCount = PREDICTION_PAGE_SIZE;
    renderFilterChips();
    renderFilterSelects();
    renderPredictions();
}

function setProfileTournament(tournament) {
    profileState.tournament = tournament;
    profileState.visibleCount = PREDICTION_PAGE_SIZE;
    renderFilterChips();
    renderFilterSelects();
    renderPredictions();
}

// 视图切换：紧凑（默认，一行一条）/ 详细卡片，选择记忆在 localStorage
function setProfileView(view) {
    profileState.view = view === 'cards' ? 'cards' : 'compact';
    localStorage.setItem('profileViewMode', profileState.view);
    document.querySelectorAll('[data-pf-view]').forEach(button => {
        button.classList.toggle('active', button.dataset.pfView === profileState.view);
    });
    renderPredictions();
}

// ---------- 预测卡片 ----------

function predictionStatus(prediction) {
    if (prediction.match_is_forfeit) return '<span class="record-status forfeit">弃权不计分</span>';
    if (prediction.match_status !== 'finished') return '<span class="record-status pending">待结算</span>';
    if ((prediction.points_earned || 0) > 0) return '<span class="record-status correct">已得分</span>';
    return '<span class="record-status wrong">未得分</span>';
}

function actualScore(prediction) {
    if (prediction.match_is_forfeit) return '<span class="muted">弃权</span>';
    if (prediction.match_status !== 'finished') return '<span class="muted">未结束</span>';
    return `<strong>${prediction.actual_team1_score} : ${prediction.actual_team2_score}</strong>`;
}

function predictionCard(prediction) {
    const team1 = prediction.team1_short_name || prediction.team1_name;
    const team2 = prediction.team2_short_name || prediction.team2_name;
    const points = prediction.match_is_forfeit
        ? '弃权不计分'
        : prediction.points_earned === null
            ? '待结算'
            : `+${prediction.points_earned} 分`;
    return `<article class="prediction-card">
        <div class="prediction-card-head">
            <div>
                <span class="game-pill ${prediction.game_type || ''}">${gameName(prediction.game_type)}</span>
                <span class="match-format">${escapeHtml(prediction.format)}</span>
                <strong>${escapeHtml(prediction.tournament_name)}</strong>
            </div>
            <div class="prediction-card-actions">
                ${predictionStatus(prediction)}
                <button class="link-btn share-trigger" type="button" onclick="sharePredictionFromProfile(${prediction.match_id})" title="生成分享图">分享</button>
            </div>
        </div>
        <div class="prediction-matchup">
            <div>${logoHtml(prediction.team1_logo_url, prediction.team1_dark_logo_url)}<strong>${escapeHtml(team1)}</strong></div>
            <div class="prediction-score">
                <span>预测 ${prediction.predicted_team1_score} : ${prediction.predicted_team2_score}</span>
                <b>${actualScore(prediction)}</b>
            </div>
            <div>${logoHtml(prediction.team2_logo_url, prediction.team2_dark_logo_url)}<strong>${escapeHtml(team2)}</strong></div>
        </div>
        <div class="prediction-card-foot">
            <span>${escapeHtml(prediction.match_name || '常规赛程')}</span>
            <span>${formatDateTime(prediction.match_time)}</span>
            <span>预测胜者：${escapeHtml(prediction.predicted_winner_name)}</span>
            <b>${points}</b>
        </div>
    </article>`;
}

// 紧凑行：一条预测占一行（游戏 / 赛事 / 对阵+预测比分 / 实际比分 / 得分 / 状态 / 分享）
function compactRow(prediction) {
    const team1 = prediction.team1_short_name || prediction.team1_name;
    const team2 = prediction.team2_short_name || prediction.team2_name;
    const actual = prediction.match_is_forfeit
        ? '<span class="muted">弃权</span>'
        : prediction.match_status !== 'finished'
            ? '<span class="muted">未结束</span>'
            : `<b>${prediction.actual_team1_score}:${prediction.actual_team2_score}</b>`;
    const points = prediction.match_is_forfeit
        ? '<span class="muted">—</span>'
        : prediction.points_earned === null
            ? '<span class="muted">待结算</span>'
            : `<b>+${prediction.points_earned}</b>`;
    return `<div class="pf-row">
        <span class="game-pill ${prediction.game_type || ''}">${gameName(prediction.game_type)}</span>
        <span class="pf-row-tournament" title="${escapeHtml(prediction.tournament_name)}">${escapeHtml(prediction.tournament_name)}</span>
        <div class="pf-row-match">
            ${logoHtml(prediction.team1_logo_url, prediction.team1_dark_logo_url)}<b>${escapeHtml(team1)}</b>
            <span class="pf-row-predict" title="预测比分">${prediction.predicted_team1_score}:${prediction.predicted_team2_score}</span>
            <b>${escapeHtml(team2)}</b>${logoHtml(prediction.team2_logo_url, prediction.team2_dark_logo_url)}
        </div>
        <span class="pf-row-actual" title="实际比分">${actual}</span>
        <span class="pf-row-points">${points}</span>
        ${predictionStatus(prediction)}
        <button class="link-btn share-trigger" type="button" onclick="sharePredictionFromProfile(${prediction.match_id})" title="生成分享图">分享</button>
    </div>`;
}

function renderPredictions() {
    const listEl = el('predictionList');
    if (!listEl) return;
    const countEl = el('recordCount');
    const predictions = filteredPredictions();
    if (countEl) countEl.textContent = predictions.length ? `${predictions.length} 条记录` : '';
    if (!predictions.length) {
        const hint = profileState.predictions.length
            ? '当前筛选下暂无记录，换个筛选条件试试。'
            : '提交预测后会在这里显示。';
        listEl.className = 'prediction-list';
        listEl.innerHTML = `<div class="empty-state"><h3>${profileState.predictions.length ? '暂无匹配记录' : '暂无预测记录'}</h3><p>${hint}</p></div>`;
        return;
    }
    // 分页渲染：全量渲染上百条会拖慢长列表（移动端尤甚）
    const visible = predictions.slice(0, profileState.visibleCount);
    const remaining = predictions.length - visible.length;
    const compact = profileState.view === 'compact';
    listEl.className = compact ? 'pf-compact-list' : 'prediction-list';
    listEl.innerHTML = visible.map(compact ? compactRow : predictionCard).join('')
        + (remaining > 0 ? `<button type="button" class="ghost load-more-btn" onclick="loadMorePredictions()">显示更多（剩余 ${remaining} 条）</button>` : '');
}

function loadMorePredictions() {
    profileState.visibleCount += PREDICTION_PAGE_SIZE;
    renderPredictions();
}

// ---------- 概览头部 ----------

function renderHero() {
    const heroEl = el('profileHero');
    if (!heroEl || !sharedState.user) return;
    const stats = profileState.stats || {};
    const total = stats.total || 0;
    const settled = stats.settled || 0;
    const correct = stats.correct || 0;
    const rate = settled ? Math.round((correct / settled) * 100) : 0;
    const initial = String(sharedState.user.username || '?').trim().charAt(0).toUpperCase();
    heroEl.innerHTML = `
        <div class="profile-hero-id">
            <div class="profile-avatar" aria-hidden="true">${escapeHtml(initial)}</div>
            <div class="profile-hero-text">
                <h2>${escapeHtml(sharedState.user.username)}</h2>
                <p><span class="profile-role-chip ${sharedState.user.role === 'admin' ? 'admin' : ''}">${escapeHtml(sharedState.user.role)}</span>账号积分 <b>${sharedState.user.total_score || 0}</b></p>
            </div>
        </div>
        <div class="profile-stats">
            <span><b>${total}</b>总预测</span>
            <span><b>${settled}</b>已结算</span>
            <span><b>${stats.points || 0}</b>总积分</span>
            <span><b>${rate}%</b>得分率</span>
        </div>`;
}

// ---------- 标签页（状态同步 URL hash，刷新/分享不丢） ----------

function setProfileTab(tab, updateHash = true) {
    profileState.tab = tab === 'settings' ? 'settings' : 'records';
    document.querySelectorAll('[data-profile-tab]').forEach(button => {
        const active = button.dataset.profileTab === profileState.tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const recordsEl = el('profileTabRecords');
    const settingsEl = el('profileTabSettings');
    if (recordsEl) recordsEl.hidden = profileState.tab !== 'records';
    if (settingsEl) settingsEl.hidden = profileState.tab !== 'settings';
    if (updateHash) {
        if (profileState.tab === 'settings') location.hash = 'settings';
        else history.replaceState(null, '', location.pathname + location.search);
    }
}

window.addEventListener('hashchange', () => setProfileTab(location.hash === '#settings' ? 'settings' : 'records', false));

// ---------- 数据加载 ----------

// 管理员专属：排行榜默认隐藏管理员，可自愿公开（普通用户始终公开，不显示该区块）
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

async function togglePredictionsPublic(publicPredictions) {
    const feedback = el('visibilityFeedback');
    if (feedback) { feedback.textContent = '保存中…'; feedback.className = 'pf-feedback'; feedback.hidden = false; }
    try {
        const data = await sharedApi('/auth/visibility', { method: 'PUT', body: { predictions_public: publicPredictions ? 1 : 0 } });
        sharedState.user = { ...sharedState.user, ...data.user };
        localStorage.setItem('user', JSON.stringify(sharedState.user));
        if (feedback) {
            feedback.textContent = publicPredictions ? '已公开：排行榜将展示你的成绩' : '已隐藏：排行榜不再展示你的成绩';
            feedback.className = 'pf-feedback ok';
        }
    } catch (error) {
        el('visibilityToggle').checked = !publicPredictions;
        if (feedback) {
            feedback.textContent = error.message;
            feedback.className = 'pf-feedback err';
        }
    }
}

async function loadProfile() {
    if (!sharedState.user) {
        el('loginRequired').hidden = false;
        el('profileContent').hidden = true;
        return;
    }
    el('loginRequired').hidden = true;
    el('profileContent').hidden = false;
    const data = await sharedApi('/predictions/my');
    profileState.predictions = data.predictions || [];
    profileState.stats = data.stats;
    profileState.filter = '';
    profileState.game = '';
    profileState.tournament = '';
    profileState.visibleCount = PREDICTION_PAGE_SIZE;
    renderHero();
    renderVisibility();
    renderFilterChips();
    renderFilterSelects();
    // setProfileView 内部会触发一次 renderPredictions
    setProfileView(profileState.view);
}

// ---------- 修改密码（内联反馈，不用 alert） ----------

function pfFeedback(message, tone) {
    const box = el('pfFeedback');
    if (!box) return;
    box.textContent = message;
    box.className = `pf-feedback ${tone || ''}`;
    box.hidden = !message;
}

async function changePassword(event) {
    event.preventDefault();
    const oldValue = el('oldPassword').value;
    const newValue = el('newPassword').value;
    if (!newValue || newValue.length < 6) { pfFeedback('新密码至少6位', 'err'); return; }
    if (newValue !== el('newPasswordConfirm').value) { pfFeedback('两次输入的新密码不一致', 'err'); return; }
    try {
        await sharedApi('/auth/password', { method: 'PUT', body: { old_password: oldValue, new_password: newValue } });
        el('oldPassword').value = el('newPassword').value = el('newPasswordConfirm').value = '';
        pfFeedback('密码已修改', 'ok');
    } catch (error) {
        pfFeedback(error.message, 'err');
    }
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
window.setProfileView = setProfileView;
window.togglePredictionsPublic = togglePredictionsPublic;
window.setProfileTab = setProfileTab;
el('passwordForm')?.addEventListener('submit', changePassword);
window.addEventListener('auth-changed', loadProfile);
setProfileTab(location.hash === '#settings' ? 'settings' : 'records', false);
loadProfile().catch(error => {
    el('profileContent').hidden = false;
    el('predictionList').innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
});
