const state = {
    game: localStorage.getItem('gameFilter') ?? 'cs2',
    viewMode: localStorage.getItem('tournamentViewMode') === 'compact' ? 'compact' : 'detail',
    tournaments: [],
    brand: localStorage.getItem('tournamentBrandFilter') || '',
    tier: localStorage.getItem('tournamentTierFilter') || '',
    search: '',
    activeTournamentId: new URLSearchParams(location.search).get('tournament') || '',
    previews: [],
    previewDays: 0,
    previewCollapsed: localStorage.getItem('previewCollapsed') === '1'
};

const filterBarEl = document.querySelector('.ar-bar');
const gameSegEl = document.querySelector('#gameSeg');
const statusFilterEl = document.querySelector('#statusFilter');
const tierFilterEl = document.querySelector('#tierFilter');
const searchEl = document.querySelector('#tournamentSearch');
const brandFiltersEl = document.querySelector('#brandFilters');
const viewModeToggleEl = document.querySelector('#viewModeToggle');
const tournamentsEl = document.querySelector('#tournaments');
const tournamentCountEl = document.querySelector('#tournamentCount');
const detailModalEl = document.querySelector('#detailModal');
const detailModalBodyEl = document.querySelector('#detailModalBody');
const previewSectionEl = document.querySelector('#previewSection');
const previewMetaEl = document.querySelector('#previewMeta');
const previewToggleEl = document.querySelector('#previewToggle');
const previewListEl = document.querySelector('#previewList');

if (tierFilterEl) tierFilterEl.value = state.tier;
syncGameSeg();
applyViewMode();

function syncGameSeg() {
    if (!gameSegEl) return;
    gameSegEl.querySelectorAll('button[data-game]').forEach(button => {
        button.classList.toggle('active', button.dataset.game === state.game);
    });
}

function setGame(game) {
    state.game = game;
    state.activeTournamentId = '';
    // 切换游戏后原厂牌大概率不存在于新列表，重置避免空结果
    state.brand = '';
    localStorage.setItem('gameFilter', game);
    localStorage.setItem('tournamentBrandFilter', '');
    syncGameSeg();
    updateTournamentUrl();
    renderTierHint();
    renderPreviews();
    loadTournaments();
}

// ---------- 厂牌 / 级别 / 搜索筛选（对已加载数据客户端过滤，切换即时生效） ----------

// 厂牌 chip 展示顺序（与服务端 BRAND_RULES 对应；全部游戏时取并集）
const BRAND_ORDER = {
    cs2: ['BLAST', 'EPL', 'IEM', 'PGL', 'XPL', 'Stake', 'PWE', 'EWC'],
    valorant: ['Masters', 'Champions', 'EMEA', 'CN', 'AMER', 'Pacific', 'EWC']
};

function setBrand(brand) {
    state.brand = brand;
    localStorage.setItem('tournamentBrandFilter', brand);
    renderBrandChips();
    renderArchiveList();
}

function setTier(tier) {
    state.tier = tier;
    localStorage.setItem('tournamentTierFilter', tier);
    renderArchiveList();
}

// 级别判定口径说明（与后端 tournamentTier.js 的关键词规则对齐），随所选游戏切换
const TIER_HINTS = {
    cs2: '<b>高级</b>：Major 级顶级大赛　<b>普通</b>：BLAST / IEM / EPL 等常规国际赛事　<b>低级</b>：预选赛',
    valorant: '<b>高级</b>：Masters / Champions 国际大赛　<b>普通</b>：赛区联赛（EMEA / CN / AMER / Pacific）　<b>低级</b>：预选赛',
    '': '<b>高级</b>：CS2 Major、Valorant Masters / Champions　<b>普通</b>：其余常规赛事　<b>低级</b>：预选赛'
};

function renderTierHint() {
    const el = document.querySelector('#tierHint');
    if (el) el.innerHTML = TIER_HINTS[state.game] || TIER_HINTS[''];
}

function filteredTournaments() {
    const keyword = state.search.trim().toLowerCase();
    return state.tournaments.filter(t => {
        if (state.brand && (state.brand === '其他' ? t.brand : t.brand !== state.brand)) return false;
        if (state.tier && String(t.effective_tier) !== state.tier) return false;
        if (keyword) {
            const haystack = `${t.name || ''} ${t.short_name || ''}`.toLowerCase();
            if (!haystack.includes(keyword)) return false;
        }
        return true;
    });
}

function renderBrandChips() {
    if (!brandFiltersEl) return;
    const counts = new Map();
    state.tournaments.forEach(t => {
        const key = t.brand || '其他';
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    // 持久化的厂牌在当前列表不存在（如换游戏后残留）时自动回退"全部"
    if (state.brand && !counts.has(state.brand)) {
        state.brand = '';
        localStorage.setItem('tournamentBrandFilter', '');
    }
    const order = BRAND_ORDER.cs2.concat(BRAND_ORDER.valorant.filter(b => !BRAND_ORDER.cs2.includes(b)));
    const keys = [...counts.keys()].sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    const chip = (key, label, count) => `<button type="button" class="ar-chip ${state.brand === key ? 'active' : ''}" onclick="setBrand('${key}')"><span>${escapeHtml(label)}</span><b>${count}</b></button>`;
    brandFiltersEl.innerHTML = chip('', '全部', state.tournaments.length) + keys.map(key => chip(key, key, counts.get(key))).join('');
}

function renderArchiveList() {
    const rows = filteredTournaments();
    if (tournamentCountEl) tournamentCountEl.textContent = `${rows.length} 个赛事`;
    tournamentsEl.innerHTML = rows.map(tournamentCard).join('') || '<div class="ar-empty"><h3>暂无赛事</h3><p>调整游戏、级别或厂牌筛选试试。</p></div>';
    applyViewMode();
}

// ---------- 未来赛事预告（赛事级，不参与积分/回看） ----------

function previewItem(preview) {
    const name = preview.name || '';
    const logo = tournamentLogo(name, preview.game_type) || tournamentMark({ name, game_type: preview.game_type });
    const day = value => formatDateTime(value).split(' ')[0] || '';
    const start = day(preview.begin_at);
    const end = day(preview.end_at);
    const range = start && end && start !== end ? `${start} - ${end}` : (start || end);
    return `<article class="ar-preview-item">
        <span class="ar-preview-logo">${logo}</span>
        <div class="ar-preview-text">
            <h3 title="${escapeHtml(name)}">${escapeHtml(name)}</h3>
            <p><span class="game-pill ${preview.game_type === 'valorant' ? 'valorant' : ''}">${escapeHtml(gameName(preview.game_type))}</span>${range ? `<span>${escapeHtml(range)}</span>` : ''}</p>
        </div>
    </article>`;
}

function renderPreviews() {
    if (!previewSectionEl) return;
    if (state.activeTournamentId) { previewSectionEl.hidden = true; return; }
    const rows = state.previews.filter(preview => !state.game || preview.game_type === state.game);
    if (!rows.length) { previewSectionEl.hidden = true; return; }
    previewSectionEl.hidden = false;
    previewSectionEl.classList.toggle('collapsed', state.previewCollapsed);
    previewMetaEl.textContent = `未来 ${state.previewDays} 天 · ${rows.length} 项赛事`;
    previewToggleEl.textContent = state.previewCollapsed ? '展开' : '收起';
    previewToggleEl.setAttribute('aria-expanded', state.previewCollapsed ? 'false' : 'true');
    previewListEl.innerHTML = rows.map(previewItem).join('');
}

async function loadPreviews() {
    try {
        const data = await sharedApi('/tournaments/previews');
        state.previews = data.previews || [];
        state.previewDays = data.days || 0;
        renderPreviews();
    } catch (error) {
        console.warn('[previews]', error.message);
    }
}

function togglePreviewSection() {
    state.previewCollapsed = !state.previewCollapsed;
    localStorage.setItem('previewCollapsed', state.previewCollapsed ? '1' : '0');
    renderPreviews();
}

function setTournamentViewMode(mode) {
    state.viewMode = mode === 'compact' ? 'compact' : 'detail';
    localStorage.setItem('tournamentViewMode', state.viewMode);
    applyViewMode();
}

function applyViewMode() {
    if (tournamentsEl) {
        tournamentsEl.classList.toggle('ar-compact', state.viewMode === 'compact' && !state.activeTournamentId);
        tournamentsEl.classList.toggle('ar-focus', Boolean(state.activeTournamentId));
    }
    // 筛选栏只作用于列表，详情页隐藏
    if (filterBarEl) filterBarEl.hidden = Boolean(state.activeTournamentId);
    if (!viewModeToggleEl) return;
    viewModeToggleEl.hidden = Boolean(state.activeTournamentId);
    viewModeToggleEl.querySelectorAll('button[data-view-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.viewMode === state.viewMode);
    });
}

function updateTournamentUrl(push = false) {
    const url = new URL(location.href);
    if (state.activeTournamentId) url.searchParams.set('tournament', state.activeTournamentId);
    else url.searchParams.delete('tournament');
    if (push) {
        // 从列表进入详情时新增历史记录，浏览器后退即回到列表
        url.hash = '';
        history.pushState({ fromList: true }, '', url);
    } else history.replaceState(history.state, '', url);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function statusText(match) {
    if (match.is_forfeit) return '弃权';
    if (match.status === 'finished') return '已结算';
    if (match.status === 'ongoing') return '进行中';
    if (match.status === 'cancelled') return '已取消';
    if (match.status === 'postponed') return '已延期';
    return '未开始';
}

function matchScore(match) {
    if (match.status !== 'finished') return '<span class="ar-vs">VS</span>';
    const team1Won = match.team1_score > match.team2_score;
    const team2Won = match.team2_score > match.team1_score;
    return `<strong class="ar-score"><span class="${team1Won ? 'winner' : ''}">${match.team1_score}</span><em>:</em><span class="${team2Won ? 'winner' : ''}">${match.team2_score}</span></strong>`;
}

function teamBlock(match, side) {
    const prefix = side === 1 ? 'team1' : 'team2';
    const name = match[`${prefix}_name`] || 'TBD';
    const shortName = match[`${prefix}_short_name`] || name;
    const logo = match[`${prefix}_logo_url`];
    const darkLogo = match[`${prefix}_dark_logo_url`];
    const won = match.status === 'finished' && ((side === 1 && match.team1_score > match.team2_score) || (side === 2 && match.team2_score > match.team1_score));
    const tbd = name === 'TBD';
    const tag = tbd ? 'div' : 'a';
    const href = tbd ? '' : ` href="/teams.html?team=${match[`${prefix}_id`]}" onclick="event.stopPropagation()"`;
    return `<${tag} class="ar-team ${won ? 'winner' : ''} ${tbd ? 'tbd-team' : ''}"${href} title="${escapeHtml(name)}">
        ${logoHtml(logo, darkLogo)}
        <div><strong>${escapeHtml(shortName)}</strong><small>${escapeHtml(name)}</small></div>
    </${tag}>`;
}

function matchRow(match) {
    const clickable = match.status === 'finished';
    const tbd = isTbdMatch(match);
    const title = match.name || '常规赛程';
    // 已结算：预测详情 + 对阵历史（近况/交手已按该场开赛前过滤，呈现赛前视角）；
    // 未开赛且队伍已定：对阵历史。
    const action = clickable
        ? `<b class="ar-action">查看预测</b><button class="link-btn h2h-trigger" onclick="event.stopPropagation(); showMatchHead2Head(${match.id})">对阵历史</button>`
        : tbd
            ? '<b class="muted">等待队伍产生</b>'
            : `<button class="link-btn h2h-trigger" onclick="showMatchHead2Head(${match.id})">对阵历史</button>`;
    return `<article class="ar-match ${clickable ? 'clickable' : ''} ${tbd ? 'tbd-match' : ''}" id="match-row-${match.id}" data-match-id="${match.id}" ${clickable ? `onclick="showMatchPredictions(${match.id})"` : ''}>
        <div class="ar-match-main">
            <div class="ar-match-info">
                <span class="ar-status ${match.is_forfeit ? 'forfeit' : tbd ? 'tbd' : match.status}">${tbd ? '对阵待定' : statusText(match)}</span>
                <strong>${escapeHtml(title)}</strong>
                <small>${formatDateTime(match.match_time)}</small>
            </div>
            <div class="ar-matchup">
                ${teamBlock(match, 1)}
                <div class="ar-score-wrap">${matchScore(match)}</div>
                ${teamBlock(match, 2)}
            </div>
        </div>
        <div class="ar-match-meta">
            <span>${escapeHtml(match.format || 'BO?')}</span>
            <span>${match.prediction_count || 0} 人预测</span>
            <span>${match.correct_prediction_count || 0} 人得分</span>
            ${action}
        </div>
    </article>`;
}

function stageMap(stages) {
    if (!stages.length) return '';
    return `<div class="tournament-stage-map">${stages.map((group, index) => {
        const metrics = stageItemMetrics(group);
        const done = metrics.total > 0 && metrics.finished >= metrics.total;
        return `<a class="stage-map-node ${done ? 'done' : ''}" href="#stage-${escapeHtml(group.key)}" onclick="openTournamentStage('${escapeHtml(group.key)}', event)">
            <span>${index + 1}</span>
            <strong>${escapeHtml(group.label)}</strong>
            <small>${metrics.finished}/${metrics.total} 已结算</small>
        </a>`;
    }).join('')}</div>`;
}

function roundSection(group) {
    const rows = group.matches || [];
    return `<div class="tournament-round-block">
        <div class="tournament-round-head"><h4>${escapeHtml(group.label)}</h4><span>${stageSubtitle(group.matches)}</span></div>
        <div class="ar-match-list">${rows.map(matchRow).join('')}</div>
    </div>`;
}

function stageSection(group, index = 0) {
    const metrics = stageItemMetrics(group);
    const head = `<summary class="tournament-stage-head">
        <h3>${escapeHtml(group.label)}</h3>
        <span>${metrics.total} 场比赛 · ${metrics.finished} 场已结算 · ${metrics.predictions} 人次预测</span>
    </summary>`;
    const open = index === 0 ? ' open' : '';
    if (group.groups) {
        return `<details class="tournament-stage-block swiss-stage-block" id="stage-${escapeHtml(group.key)}"${open}>
            ${head}
            <div class="tournament-stage-content">
                ${stageDiagram(group)}
                <div class="tournament-round-list">${group.groups.map(roundSection).join('')}</div>
            </div>
        </details>`;
    }
    const roundGroups = roundGroupsFromMatches(group.matches || []);
    if (roundGroups.length >= 1) {
        return `<details class="tournament-stage-block swiss-stage-block" id="stage-${escapeHtml(group.key)}"${open}>
            ${head}
            <div class="tournament-stage-content">
                ${stageDiagram(group, roundGroups)}
                <div class="tournament-round-list">${roundGroups.map(roundSection).join('')}</div>
            </div>
        </details>`;
    }
    return `<details class="tournament-stage-block" id="stage-${escapeHtml(group.key)}"${open}>
        ${head}
        <div class="tournament-stage-content">
            ${stageDiagram(group)}
            <div class="ar-match-list">${(group.matches || []).map(matchRow).join('')}</div>
        </div>
    </details>`;
}

// 赛事级别徽章：高级金色、低级灰色、普通不显示。
// 文字优先取名称中命中的关键词（中英文同义，与 server/services/tournamentTier.js 规则一致），
// 手动设置级别但名称无关键词时按游戏给默认词。
function tierBadge(tournament) {
    const name = tournament.name || '';
    if (tournament.effective_tier === 1) {
        const keyword = name.match(/Major|Masters|Champions|大师赛|冠军赛/i);
        const label = keyword ? keyword[0] : (tournament.game_type === 'valorant' ? 'Masters' : 'Major');
        return `<span class="tier-badge tier-top" title="高级别赛事">${escapeHtml(label)}</span>`;
    }
    if (tournament.effective_tier === 3) {
        const keyword = name.match(/Qualifier|预选赛/i);
        return `<span class="tier-badge tier-low" title="预选赛 / 低级别赛事">${escapeHtml(keyword ? keyword[0] : 'Qualifier')}</span>`;
    }
    return '';
}

// 无上传 logo 时用字母徽标兜底（回看列表里绝大多数赛事只有名称）
function tournamentMark(tournament) {
    const name = String(tournament.short_name || tournament.name || '').trim();
    const letters = name.replace(/[^A-Za-z0-9一-龥]/g, '').slice(0, 2).toUpperCase() || '?';
    return `<span class="ar-mark ${tournament.game_type}">${escapeHtml(letters)}</span>`;
}

function tournamentLogoHtml(tournament) {
    return tournamentLogo(tournament.name, tournament.game_type, tournament.logo_url) || tournamentMark(tournament);
}

// 卡片只显示日期：沿用 formatDateTime 的年份规则，去掉时分
const formatDay = value => formatDateTime(value).split(' ')[0];

function tournamentCard(tournament) {
    const finished = tournament.finished_count || 0;
    const total = tournament.match_count || 0;
    const predictions = tournament.prediction_count || 0;
    const ongoing = tournament.ongoing_count || 0;
    const upcoming = tournament.upcoming_count || 0;
    const isDone = total > 0 && finished >= total;
    const progress = total ? Math.round((finished / total) * 100) : 0;
    const stateLabel = ongoing ? '进行中' : isDone ? '已结束' : '筹备中';
    const stateClass = ongoing ? 'live' : isDone ? 'done' : 'wait';
    return `<article class="ar-card ${tournament.game_type} ${stateClass}" data-id="${tournament.id}" onclick="enterTournament(${tournament.id})" tabindex="0" role="button" aria-label="查看 ${escapeHtml(tournament.name)}">
        <div class="ar-card-logo">${tournamentLogoHtml(tournament)}</div>
        <div class="ar-card-body">
            <div class="ar-card-title">
                <h2 title="${escapeHtml(tournament.name)}">${tournamentNameHtml(tournament.name, tournament.short_name)}</h2>
                <span class="ar-state ${stateClass}">${ongoing ? `<i class="ar-live-dot"></i>${ongoing} 场进行中` : stateLabel}</span>
            </div>
            <p class="ar-card-meta">
                <span class="game-pill ${tournament.game_type}">${gameName(tournament.game_type)}</span>
                ${tierBadge(tournament)}
                <span>${formatDay(tournament.begin_at)}${tournament.end_at ? ` - ${formatDay(tournament.end_at)}` : ''}</span>
            </p>
            <div class="ar-progress" title="完成 ${progress}%"><i style="width:${progress}%"></i></div>
            <div class="ar-card-stats">
                <span><b>${total}</b>比赛</span>
                ${isDone ? '' : `<span><b>${finished}</b>已结算</span>`}
                ${upcoming ? `<span><b>${upcoming}</b>待开始</span>` : ''}
                <span><b>${predictions}</b>人次预测</span>
                <span class="ar-pct">${progress}%</span>
            </div>
        </div>
        <span class="ar-open" aria-hidden="true">›</span>
    </article>`;
}

function tournamentDetailPage(data) {
    const tournament = data.tournament;
    const matches = data.matches || [];
    const finished = tournament.finished_count || matches.filter(match => match.status === 'finished').length;
    const total = tournament.match_count || matches.length;
    const predictions = tournament.prediction_count || matches.reduce((sum, match) => sum + (match.prediction_count || 0), 0);
    const model = buildBracketModel(matches);
    const stages = model.stages;
    const stageTotal = stages.reduce((sum, stage) => sum + stageMatches(stage).length, 0);
    const integrityNotice = stageTotal === matches.length
        ? ''
        : `<div class="bracket-integrity-warning">赛程数据不完整：已归类 ${stageTotal}/${matches.length} 场</div>`;
    return `<section class="ar-focus">
        <header class="ar-focus-head ${tournament.game_type}">
            <button class="ar-back" onclick="backToTournamentList()">‹ 返回赛事列表</button>
            <div class="ar-focus-id">
                <span class="ar-focus-logo">${tournamentLogoHtml(tournament)}</span>
                <div class="ar-focus-text">
                    <div class="ar-focus-tags"><span class="game-pill ${tournament.game_type}">${gameName(tournament.game_type)}</span>${tierBadge(tournament)}<span>${formatDateTime(tournament.begin_at)}${tournament.end_at ? ` - ${formatDateTime(tournament.end_at)}` : ''}</span></div>
                    <h2 title="${escapeHtml(tournament.name)}">${tournamentNameHtml(tournament.name, tournament.short_name)}</h2>
                </div>
            </div>
            <dl class="ar-focus-stats">
                <div><dt>比赛</dt><dd>${total}</dd></div>
                <div><dt>已结算</dt><dd>${finished}</dd></div>
                <div><dt>预测人次</dt><dd>${predictions}</dd></div>
            </dl>
        </header>
        ${integrityNotice}
        ${stageMap(stages)}
        <div class="ar-focus-stages">${stages.map(stageSection).join('') || '<div class="ar-empty"><h3>暂无比赛</h3></div>'}</div>
    </section>`;
}

let lastBracketCompactMode = isCompactBracketViewport();
window.addEventListener('resize', () => {
    const compact = isCompactBracketViewport();
    if (compact === lastBracketCompactMode) return;
    lastBracketCompactMode = compact;
    if (state.activeTournamentId) openTournamentPage(state.activeTournamentId);
});
async function openTournamentPage(id) {
    if (!tournamentsEl) return;
    state.activeTournamentId = String(id);
    updateTournamentUrl();
    applyViewMode();
    tournamentsEl.innerHTML = '<div class="ar-loading">加载赛事详情...</div>';
    try {
        const data = await sharedApi(`/tournaments/${id}`);
        tournamentsEl.innerHTML = tournamentDetailPage(data);
        const matchAnchor = location.hash.match(/^#match-row-(\d+)$/);
        if (matchAnchor) requestAnimationFrame(() => focusTournamentMatch(matchAnchor[1]));
    } catch (error) {
        tournamentsEl.innerHTML = `<div class="ar-empty"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p><button onclick="backToTournamentList()">返回赛事列表</button></div>`;
    }
}

// 列表卡片入口：记录列表滚动位置并新增历史记录
function enterTournament(id) {
    state.listScrollY = window.scrollY;
    state.activeTournamentId = String(id);
    updateTournamentUrl(true);
    window.scrollTo(0, 0);
    openTournamentPage(id);
}

function showTournamentList() {
    state.activeTournamentId = '';
    applyViewMode();
    const restore = () => window.scrollTo(0, state.listScrollY || 0);
    // 已加载过列表时直接重绘并恢复滚动位置，避免重新请求后跳回顶部
    if (state.tournaments.length) {
        syncGameSeg();
        renderArchiveList();
        requestAnimationFrame(restore);
    } else loadTournaments().then(restore);
}

function backToTournamentList() {
    // 由列表进入时等同浏览器后退，避免历史记录里叠出重复的列表页
    if (history.state?.fromList) { history.back(); return; }
    state.activeTournamentId = '';
    updateTournamentUrl();
    showTournamentList();
}

window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('tournament') || '';
    if (id === state.activeTournamentId) return; // 仅 hash 变化（阶段/比赛锚点）
    if (id) {
        state.activeTournamentId = id;
        openTournamentPage(id);
    } else showTournamentList();
});

function focusTournamentMatch(matchId) {
    const row = document.getElementById(`match-row-${matchId}`);
    if (!row) return;
    const stage = row.closest('details.tournament-stage-block');
    if (stage) stage.open = true;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('match-row-highlight');
    requestAnimationFrame(() => row.classList.add('match-row-highlight'));
    window.setTimeout(() => row.classList.remove('match-row-highlight'), 1800);
}

// 阶段条吸顶：手动滚动并让出阶段条高度，不写入 hash，避免后退时逐个回退阶段锚点
function openTournamentStage(stageKey, event) {
    event?.preventDefault();
    const stage = document.getElementById(`stage-${stageKey}`);
    if (!stage) return;
    if (stage.tagName === 'DETAILS') stage.open = true;
    const barHeight = document.querySelector('.tournament-stage-map')?.offsetHeight || 0;
    window.scrollTo({ top: stage.getBoundingClientRect().top + window.scrollY - barHeight - 8, behavior: 'smooth' });
}

function closeDetailModal() {
    if (detailModalEl) detailModalEl.hidden = true;
    if (detailModalBodyEl) detailModalBodyEl.innerHTML = '';
    document.body.classList.remove('modal-open');
}

async function showMatchPredictions(matchId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    try {
        const data = await sharedApi(`/matches/${matchId}/predictions`);
        // 渲染结构由 shared.js 统一提供（主页/回看页共用）：英雄区 + 统计条 + 排名列表
        detailModalBodyEl.innerHTML = renderMatchPredictionDetail(data.match, data.predictions);
        detailModalEl.hidden = false;
        document.body.classList.add('modal-open');
    } catch (error) {
        alert(error.message);
    }
}

async function loadTournaments() {
    if (!tournamentsEl) return;
    applyViewMode();
    if (state.activeTournamentId) {
        if (previewSectionEl) previewSectionEl.hidden = true;
        await openTournamentPage(state.activeTournamentId);
        return;
    }
    syncGameSeg();
    tournamentsEl.innerHTML = '<div class="ar-loading">加载赛事中...</div>';
    const status = statusFilterEl?.value || '';
    const params = new URLSearchParams();
    if (state.game) params.set('game_type', state.game);
    if (status) params.set('status', status);
    const data = await sharedApi(`/tournaments${params.toString() ? `?${params}` : ''}`);
    state.tournaments = data.tournaments;
    renderBrandChips();
    renderTierHint();
    renderArchiveList();
    renderPreviews();
}

window.setGame = setGame;
window.setBrand = setBrand;
window.setTier = setTier;
// showMatchHead2Head 由 /js/h2h.js 提供（window 全局）

// ---------- 回到顶部悬浮按钮：下滑超过一屏后出现在右下角 ----------
(function ensureBackToTop() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'back-to-top';
    button.setAttribute('aria-label', '回到顶部');
    button.title = '回到顶部';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l-7 7h4v7h6v-7h4z" fill="currentColor"/></svg>';
    button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.body.appendChild(button);
    const toggle = () => button.classList.toggle('visible', window.scrollY > window.innerHeight * 0.6);
    window.addEventListener('scroll', toggle, { passive: true });
    toggle();
})();
window.setTournamentViewMode = setTournamentViewMode;
window.togglePreviewSection = togglePreviewSection;
window.loadTournaments = loadTournaments;
window.openTournamentPage = openTournamentPage;
window.enterTournament = enterTournament;
window.backToTournamentList = backToTournamentList;
window.showMatchPredictions = showMatchPredictions;
window.focusTournamentMatch = focusTournamentMatch;
window.openTournamentStage = openTournamentStage;
window.closeDetailModal = closeDetailModal;

// 游戏分段按钮：切换后重置厂牌并重新拉取
gameSegEl?.addEventListener('click', event => {
    const button = event.target.closest('button[data-game]');
    if (button) setGame(button.dataset.game);
});
// 搜索：对已加载列表做本地过滤，无需重新请求
searchEl?.addEventListener('input', () => {
    state.search = searchEl.value;
    clearTimeout(searchEl._timer);
    searchEl._timer = setTimeout(renderArchiveList, 140);
});

loadTournaments().catch(error => {
    if (tournamentsEl) tournamentsEl.innerHTML = `<div class="ar-empty"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
    console.error(error);
});
loadPreviews();
