const state = {
    game: localStorage.getItem('gameFilter') || 'cs2',
    viewMode: 'detail',
    tournaments: [],
    activeTournamentId: new URLSearchParams(location.search).get('tournament') || ''
};

const gameFilterEl = document.querySelector('#gameFilter');
const statusFilterEl = document.querySelector('#statusFilter');
const viewModeToggleEl = document.querySelector('#viewModeToggle');
const tournamentsEl = document.querySelector('#tournaments');
const detailModalEl = document.querySelector('#detailModal');
const detailModalBodyEl = document.querySelector('#detailModalBody');

if (gameFilterEl) gameFilterEl.value = state.game;
applyViewMode();

function setGame(game) {
    state.game = game;
    state.activeTournamentId = '';
    localStorage.setItem('gameFilter', game);
    updateTournamentUrl();
    loadTournaments();
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
    const won = match.status === 'finished' && ((side === 1 && match.team1_score > match.team2_score) || (side === 2 && match.team2_score > match.team1_score));
    return `<div class="archive-team ${won ? 'winner' : ''}">
        ${logoHtml(logo)}
        <div><strong>${escapeHtml(shortName)}</strong><small>${escapeHtml(name)}</small></div>
    </div>`;
}


function matchRow(match) {
    const clickable = match.status === 'finished';
    const title = match.name || '常规赛程';
    return `<article class="archive-match-v2 tournament-match-row ${clickable ? 'clickable' : ''}" id="match-row-${match.id}" data-match-id="${match.id}" ${clickable ? `onclick="showMatchPredictions(${match.id})"` : ''}>
        <div class="archive-match-main">
            <div class="archive-match-info">
                <span class="archive-status ${match.status}">${statusText(match)}</span>
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
            ${clickable ? '<b>查看预测详情</b>' : '<b class="muted">未开放详情</b>'}
        </div>
    </article>`;
}

function stageMap(stages) {
    if (!stages.length) return '';
    return `<div class="tournament-stage-map">${stages.map((group, index) => {
        const metrics = stageItemMetrics(group);
        const done = metrics.total > 0 && metrics.finished >= metrics.total;
        return `<a class="stage-map-node ${done ? 'done' : ''}" href="#stage-${escapeHtml(group.key)}">
            <span>${index + 1}</span>
            <strong>${escapeHtml(group.label)}</strong>
            <small>${metrics.finished}/${metrics.total} 已结算</small>
        </a>`;
    }).join('')}</div>`;
}

function roundSection(group) {
    // 「只显示已有对阵」：比赛列表也过滤掉 TBD 未定对局。
    const rows = (group.matches || []).filter(match => !isTbdMatch(match));
    return `<div class="tournament-round-block">
        <div class="tournament-round-head"><h4>${escapeHtml(group.label)}</h4><span>${stageSubtitle(group.matches)}</span></div>
        <div class="archive-match-list">${rows.map(matchRow).join('')}</div>
    </div>`;
}

function stageSection(group) {
    if (group.groups) {
        const metrics = stageItemMetrics(group);
        return `<section class="tournament-stage-block swiss-stage-block" id="stage-${escapeHtml(group.key)}">
            <div class="tournament-stage-head">
                <h3>${escapeHtml(group.label)}</h3>
                <span>${metrics.total} 场比赛 · ${metrics.finished} 场已结算 · ${metrics.predictions} 人次预测</span>
            </div>
            ${stageDiagram(group)}
            <div class="tournament-round-list">${group.groups.map(roundSection).join('')}</div>
        </section>`;
    }
    const roundGroups = roundGroupsFromMatches(group.matches || []);
    if (roundGroups.length >= 1) {
        const metrics = stageItemMetrics(group);
        return `<section class="tournament-stage-block swiss-stage-block" id="stage-${escapeHtml(group.key)}">
            <div class="tournament-stage-head">
                <h3>${escapeHtml(group.label)}</h3>
                <span>${metrics.total} 场比赛 · ${metrics.finished} 场已结算 · ${metrics.predictions} 人次预测</span>
            </div>
            ${stageDiagram(group, roundGroups)}
            <div class="tournament-round-list">${roundGroups.map(roundSection).join('')}</div>
        </section>`;
    }
    return `<section class="tournament-stage-block" id="stage-${escapeHtml(group.key)}">
        <div class="tournament-stage-head">
            <h3>${escapeHtml(group.label)}</h3>
            <span>${stageSubtitle(group.matches)}</span>
        </div>
        ${stageDiagram(group)}
        <div class="archive-match-list">${(group.matches || []).filter(match => !isTbdMatch(match)).map(matchRow).join('')}</div>
    </section>`;
}
function tournamentCard(tournament) {
    const finished = tournament.finished_count || 0;
    const total = tournament.match_count || 0;
    const predictions = tournament.prediction_count || 0;
    const status = total > 0 && finished >= total ? '已结束' : '进行中';
    const progress = total ? Math.round((finished / total) * 100) : 0;
    return `<article class="tournament-card archive-tournament panel" data-id="${tournament.id}">
        <div class="tournament-card-head archive-tournament-head">
            <div class="archive-tournament-title">
                <span class="game-pill ${tournament.game_type}">${gameName(tournament.game_type)}</span>
                <h2 title="${escapeHtml(tournament.name)}">${escapeHtml(tournament.name)}</h2>
                <p>${formatDateTime(tournament.begin_at)} ${tournament.end_at ? `- ${formatDateTime(tournament.end_at)}` : ''}</p>
            </div>
            <div class="archive-tournament-action">
                <span class="archive-tournament-state">${status}</span>
                <button onclick="openTournamentPage(${tournament.id})">进入赛事</button>
            </div>
        </div>
        <div class="tournament-stats archive-tournament-stats">
            <span><b>${total}</b>比赛</span>
            <span><b>${finished}</b>已结算</span>
            <span><b>${predictions}</b>预测</span>
            <span><b>${progress}%</b>完成</span>
        </div>
    </article>`;
}

function tournamentDetailPage(data) {
    const tournament = data.tournament;
    const matches = data.matches || [];
    const finished = tournament.finished_count || matches.filter(match => match.status === 'finished').length;
    const total = tournament.match_count || matches.length;
    const predictions = tournament.prediction_count || matches.reduce((sum, match) => sum + (match.prediction_count || 0), 0);
    const stages = buildTournamentStages(matches);
    return `<section class="tournament-focus panel">
        <button class="button ghost tournament-back" onclick="backToTournamentList()">返回赛事列表</button>
        <div class="tournament-focus-head">
            <div>
                <span class="game-pill ${tournament.game_type}">${gameName(tournament.game_type)}</span>
                <h2>${escapeHtml(tournament.name)}</h2>
                <p>${formatDateTime(tournament.begin_at)} ${tournament.end_at ? `- ${formatDateTime(tournament.end_at)}` : ''}</p>
            </div>
            <div class="tournament-focus-stats">
                <span><b>${total}</b>比赛</span>
                <span><b>${finished}</b>已结算</span>
                <span><b>${predictions}</b>预测</span>
            </div>
        </div>
        ${stageMap(stages)}
        ${tournamentOverviewDiagram(matches)}
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
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('match-row-highlight');
    requestAnimationFrame(() => row.classList.add('match-row-highlight'));
    window.setTimeout(() => row.classList.remove('match-row-highlight'), 1800);
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

function closeDetailModal() {
    if (detailModalEl) detailModalEl.hidden = true;
    if (detailModalBodyEl) detailModalBodyEl.innerHTML = '';
    document.body.classList.remove('modal-open');
}

async function showMatchPredictions(matchId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    try {
        const data = await sharedApi(`/matches/${matchId}/predictions`);
        const match = data.match;
        detailModalBodyEl.innerHTML = `
            <div class="modal-head">
                <span class="game-pill ${match.game_type || ''}">${match.game_type === 'valorant' ? 'Valorant' : 'CS2'}</span>
                <h2>${escapeHtml(match.team1_name)} ${match.team1_score}-${match.team2_score} ${escapeHtml(match.team2_name)}</h2>
                <p>${escapeHtml(match.tournament_name)} · ${escapeHtml(match.name || '常规赛程')} · ${formatDateTime(match.match_time)}</p>
            </div>
            <ol class="detail-list">${data.predictions.map(predictionDetailRow).join('') || '<li class="empty-state">暂无预测</li>'}</ol>
        `;
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
    tournamentsEl.innerHTML = data.tournaments.map(tournamentCard).join('') || '<div class="empty-state"><h3>暂无赛事</h3><p>请等待同步或切换筛选条件。</p></div>';
    applyViewMode();
}

window.setGame = setGame;
window.setTournamentViewMode = setTournamentViewMode;
window.loadTournaments = loadTournaments;
window.openTournamentPage = openTournamentPage;
window.backToTournamentList = backToTournamentList;
window.showMatchPredictions = showMatchPredictions;
window.focusTournamentMatch = focusTournamentMatch;
window.closeDetailModal = closeDetailModal;

loadTournaments().catch(error => {
    if (tournamentsEl) tournamentsEl.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
    console.error(error);
});




















