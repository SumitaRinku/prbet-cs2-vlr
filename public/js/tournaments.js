const state = {
    game: localStorage.getItem('gameFilter') || 'cs2',
    viewMode: 'detail',
    tournaments: [],
    brand: localStorage.getItem('tournamentBrandFilter') || '',
    tier: localStorage.getItem('tournamentTierFilter') || '',
    activeTournamentId: new URLSearchParams(location.search).get('tournament') || ''
};

const gameFilterEl = document.querySelector('#gameFilter');
const statusFilterEl = document.querySelector('#statusFilter');
const tierFilterEl = document.querySelector('#tierFilter');
const brandFiltersEl = document.querySelector('#brandFilters');
const viewModeToggleEl = document.querySelector('#viewModeToggle');
const tournamentsEl = document.querySelector('#tournaments');
const tournamentCountEl = document.querySelector('#tournamentCount');
const detailModalEl = document.querySelector('#detailModal');
const detailModalBodyEl = document.querySelector('#detailModalBody');

if (gameFilterEl) gameFilterEl.value = state.game;
if (tierFilterEl) tierFilterEl.value = state.tier;
applyViewMode();

function setGame(game) {
    state.game = game;
    state.activeTournamentId = '';
    // 切换游戏后原厂牌大概率不存在于新列表，重置避免空结果
    state.brand = '';
    localStorage.setItem('gameFilter', game);
    localStorage.setItem('tournamentBrandFilter', '');
    updateTournamentUrl();
    renderTierHint();
    loadTournaments();
}

// ---------- 厂牌 / 级别筛选（对已加载数据客户端过滤，切换即时生效） ----------

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
    cs2: '<b>高级</b><i>：Major 级顶级大赛</i>　<b>普通</b><i>：BLAST / IEM / EPL 等常规国际赛事</i>　<b>低级</b><i>：预选赛（Qualifier）</i>',
    valorant: '<b>高级</b><i>：Masters / Champions 国际大赛</i>　<b>普通</b><i>：赛区联赛（EMEA / CN / AMER / Pacific）等常规赛事</i>　<b>低级</b><i>：预选赛（Qualifier）</i>',
    '': '<b>高级</b><i>：CS2 Major、Valorant Masters / Champions</i>　<b>普通</b><i>：其余常规赛事</i>　<b>低级</b><i>：预选赛（Qualifier）</i>'
};

function renderTierHint() {
    const el = document.querySelector('#tierHint');
    if (el) el.innerHTML = TIER_HINTS[state.game] || TIER_HINTS[''];
}

function filteredTournaments() {
    return state.tournaments.filter(t =>
        (!state.brand || (state.brand === '其他' ? !t.brand : t.brand === state.brand)) &&
        (!state.tier || String(t.effective_tier) === state.tier)
    );
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
    const chip = (key, label, count) => `<button type="button" class="brand-filter ${state.brand === key ? 'active' : ''}" onclick="setBrand('${key}')"><span>${escapeHtml(label)}</span><b>${count}</b></button>`;
    brandFiltersEl.innerHTML = chip('', '全部', state.tournaments.length) + keys.map(key => chip(key, key, counts.get(key))).join('');
}

function renderArchiveList() {
    const rows = filteredTournaments();
    if (tournamentCountEl) tournamentCountEl.textContent = `${rows.length} 个赛事`;
    tournamentsEl.innerHTML = rows.map(tournamentCard).join('') || '<div class="empty-state"><h3>暂无赛事</h3><p>请调整筛选条件。</p></div>';
    applyViewMode();
}

function setTournamentViewMode(mode) {
    state.viewMode = mode === 'compact' ? 'compact' : 'detail';
    localStorage.setItem('tournamentViewMode', state.viewMode);
    applyViewMode();
}

function applyViewMode() {
    if (tournamentsEl) {
        tournamentsEl.classList.toggle('compact-view', state.viewMode === 'compact' && !state.activeTournamentId);
        tournamentsEl.classList.toggle('detail-view', state.viewMode !== 'compact' && !state.activeTournamentId);
        tournamentsEl.classList.toggle('tournament-focus-view', Boolean(state.activeTournamentId));
    }
    if (!viewModeToggleEl) return;
    viewModeToggleEl.hidden = Boolean(state.activeTournamentId);
    viewModeToggleEl.querySelectorAll('button[data-view-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.viewMode === state.viewMode);
    });
}

function updateTournamentUrl() {
    const url = new URL(location.href);
    if (state.activeTournamentId) url.searchParams.set('tournament', state.activeTournamentId);
    else url.searchParams.delete('tournament');
    history.replaceState(null, '', url);
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
    if (match.status !== 'finished') return '<span class="archive-vs">VS</span>';
    const team1Won = match.team1_score > match.team2_score;
    const team2Won = match.team2_score > match.team1_score;
    return `<strong class="archive-scorebox"><span class="${team1Won ? 'winner' : ''}">${match.team1_score}</span><em>:</em><span class="${team2Won ? 'winner' : ''}">${match.team2_score}</span></strong>`;
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
    return `<${tag} class="archive-team team-link ${won ? 'winner' : ''} ${tbd ? 'tbd-team' : ''}"${href}>
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
        ? `<b>查看预测详情</b><button class="link-btn h2h-trigger" onclick="event.stopPropagation(); showMatchHead2Head(${match.id})">对阵历史</button>`
        : tbd
            ? '<b class="muted">等待队伍产生</b>'
            : `<button class="link-btn h2h-trigger" onclick="showMatchHead2Head(${match.id})">对阵历史</button>`;
    return `<article class="archive-match-v2 tournament-match-row ${clickable ? 'clickable' : ''} ${tbd ? 'tbd-match' : ''}" id="match-row-${match.id}" data-match-id="${match.id}" ${clickable ? `onclick="showMatchPredictions(${match.id})"` : ''}>
        <div class="archive-match-main">
            <div class="archive-match-info">
                <span class="archive-status ${match.is_forfeit ? 'forfeit' : tbd ? 'tbd' : match.status}">${tbd ? '对阵待定' : statusText(match)}</span>
                <strong>${escapeHtml(title)}</strong>
                <small>${formatDateTime(match.match_time)}</small>
            </div>
            <div class="archive-matchup-v2">
                ${teamBlock(match, 1)}
                <div class="archive-score-wrap">${matchScore(match)}</div>
                ${teamBlock(match, 2)}
            </div>
        </div>
        <div class="archive-match-meta">
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
        return `<a class="stage-map-node ${done ? 'done' : ''}" href="#stage-${escapeHtml(group.key)}" onclick="openTournamentStage('${escapeHtml(group.key)}')">
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
        <div class="archive-match-list">${rows.map(matchRow).join('')}</div>
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
            <div class="archive-match-list">${(group.matches || []).map(matchRow).join('')}</div>
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

function tournamentCard(tournament) {
    const finished = tournament.finished_count || 0;
    const total = tournament.match_count || 0;
    const predictions = tournament.prediction_count || 0;
    const ongoing = tournament.ongoing_count || 0;
    const upcoming = tournament.upcoming_count || 0;
    const isDone = total > 0 && finished >= total;
    const status = isDone ? '已结束' : '进行中';
    const progress = total ? Math.round((finished / total) * 100) : 0;
    return `<article class="tournament-card archive-tournament panel ${tournament.game_type}" data-id="${tournament.id}" onclick="openTournamentPage(${tournament.id})">
        <div class="tournament-card-head archive-tournament-head">
            <div class="archive-tournament-title">
                <div>${tournamentLogo(tournament.name, tournament.game_type, tournament.logo_url)}<span class="game-pill ${tournament.game_type}">${gameName(tournament.game_type)}</span>${tierBadge(tournament)}<span class="archive-tournament-state ${ongoing ? 'live' : ''}">${ongoing ? `<i class="live-dot"></i>${ongoing} 场进行中` : status}</span></div>
                <h2 title="${escapeHtml(tournament.name)}">${tournamentNameHtml(tournament.name, tournament.short_name)}</h2>
                <p>${formatDateTime(tournament.begin_at)}${tournament.end_at ? ` - ${formatDateTime(tournament.end_at)}` : ''}</p>
            </div>
            <span class="archive-open" aria-hidden="true">›</span>
        </div>
        <div class="tournament-stats archive-tournament-stats">
            <span><b>${total}</b>比赛</span>
            <span><b>${finished}</b>已结束</span>
            <span><b>${upcoming}</b>待开始</span>
            <span><b>${predictions}</b>人次预测</span>
            <span><b>${progress}%</b>完成</span>
        </div>
        <div class="tournament-progress ${isDone ? 'done' : ongoing ? 'live' : ''}"><i style="width:${progress}%"></i></div>
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
    return `<section class="tournament-focus panel">
        <button class="button ghost tournament-back" onclick="backToTournamentList()">返回赛事列表</button>
        <div class="tournament-focus-head ${tournament.game_type}">
            <div>
                ${tournamentLogo(tournament.name, tournament.game_type, tournament.logo_url)}
                <span class="game-pill ${tournament.game_type}">${gameName(tournament.game_type)}</span>${tierBadge(tournament)}
                <h2 title="${escapeHtml(tournament.name)}">${tournamentNameHtml(tournament.name, tournament.short_name)}</h2>
                <p>${formatDateTime(tournament.begin_at)} ${tournament.end_at ? `- ${formatDateTime(tournament.end_at)}` : ''}</p>
            </div>
            <div class="tournament-focus-stats">
                <span><b>${total}</b>比赛</span>
                <span class="stat-done"><b>${finished}</b>已结算</span>
                <span><b>${predictions}</b>预测</span>
            </div>
        </div>
        ${integrityNotice}
        ${stageMap(stages)}
        <div class="tournament-stage-list">${stages.map(stageSection).join('') || '<div class="empty-state"><h3>暂无比赛</h3></div>'}</div>
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
    tournamentsEl.innerHTML = '<div class="loading-text">加载赛事详情...</div>';
    try {
        const data = await sharedApi(`/tournaments/${id}`);
        tournamentsEl.innerHTML = tournamentDetailPage(data);
        const matchAnchor = location.hash.match(/^#match-row-(\d+)$/);
        if (matchAnchor) requestAnimationFrame(() => focusTournamentMatch(matchAnchor[1]));
    } catch (error) {
        tournamentsEl.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p><button onclick="backToTournamentList()">返回赛事列表</button></div>`;
    }
}

function backToTournamentList() {
    state.activeTournamentId = '';
    updateTournamentUrl();
    loadTournaments();
}

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

function openTournamentStage(stageKey) {
    const stage = document.getElementById(`stage-${stageKey}`);
    if (stage && stage.tagName === 'DETAILS') stage.open = true;
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
        await openTournamentPage(state.activeTournamentId);
        return;
    }
    tournamentsEl.innerHTML = '<div class="loading-text">加载赛事中...</div>';
    const status = statusFilterEl?.value || '';
    const params = new URLSearchParams();
    if (state.game) params.set('game_type', state.game);
    if (status) params.set('status', status);
    const data = await sharedApi(`/tournaments${params.toString() ? `?${params}` : ''}`);
    state.tournaments = data.tournaments;
    renderBrandChips();
    renderTierHint();
    renderArchiveList();
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
window.loadTournaments = loadTournaments;
window.openTournamentPage = openTournamentPage;
window.backToTournamentList = backToTournamentList;
window.showMatchPredictions = showMatchPredictions;
window.focusTournamentMatch = focusTournamentMatch;
window.openTournamentStage = openTournamentStage;
window.closeDetailModal = closeDetailModal;

loadTournaments().catch(error => {
    if (tournamentsEl) tournamentsEl.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
    console.error(error);
});











