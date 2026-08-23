const state = {
    game: localStorage.getItem('gameFilter') || 'cs2',
    tournaments: [],
    tournament: localStorage.getItem('leaderboardTournamentFilter') || '',
    page: 1
};

const gameFilterEl = document.querySelector('#gameFilter');
const tournamentFilterEl = document.querySelector('#tournamentFilter');
const boardTitleEl = document.querySelector('#boardTitle');
const leaderboardFullEl = document.querySelector('#leaderboardFull');
const detailModalEl = document.querySelector('#detailModal');
const detailModalBodyEl = document.querySelector('#detailModalBody');

if (gameFilterEl) gameFilterEl.value = state.game;

function setGame(game) {
    state.game = game;
    state.page = 1;
    localStorage.setItem('gameFilter', game);
    loadTournamentOptions().then(loadLeaderboard).catch(error => showLeaderboardError(error));
}

function rankIcon(rank) {
    return rank <= 3 ? String(rank) : `#${rank}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function row(user) {
    return `<li class="leaderboard-row clickable" onclick="showUserDetails(${user.id})">
        <span class="rank ${user.rank <= 3 ? `top-${user.rank}` : ''}">${rankIcon(user.rank)}</span>
        <strong>${escapeHtml(user.username)}</strong>
        <span class="lb-score"><b>${user.total_score}</b> 分</span>
        <span class="lb-count">${user.prediction_count} 场已结算</span>
        <span class="lb-rate">${user.success_rate}% 得分率</span>
        <small class="lb-hint">查看明细</small>
    </li>`;
}

async function loadTournamentOptions() {
    if (!tournamentFilterEl) return;
    const params = new URLSearchParams();
    if (state.game) params.set('game_type', state.game);
    const data = await sharedApi(`/tournaments${params.toString() ? `?${params}` : ''}`);
    state.tournaments = data.tournaments;
    const current = state.tournament || tournamentFilterEl.value;
    tournamentFilterEl.innerHTML = '<option value="">总排行榜</option>' + data.tournaments.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    if (data.tournaments.some(t => String(t.id) === String(current))) {
        tournamentFilterEl.value = current;
        state.tournament = current;
    } else {
        tournamentFilterEl.value = '';
        state.tournament = '';
        localStorage.setItem('leaderboardTournamentFilter', '');
    }
}

async function loadLeaderboard() {
    if (!leaderboardFullEl || !tournamentFilterEl) return;
    const tournamentId = tournamentFilterEl.value;
    state.tournament = tournamentId;
    localStorage.setItem('leaderboardTournamentFilter', tournamentId);
    const params = new URLSearchParams();
    if (state.game && !tournamentId) params.set('game_type', state.game);
    params.set('page', state.page);
    params.set('page_size', 20);
    const data = tournamentId
        ? await sharedApi(`/leaderboard/tournament/${tournamentId}?${params}`)
        : await sharedApi(`/leaderboard?${params}`);
    if (boardTitleEl) boardTitleEl.textContent = tournamentId ? `${data.tournament.name} 排行榜` : `${gameName(state.game)} 总排行榜`;
    leaderboardFullEl.innerHTML = data.leaderboard.map(row).join('') || '<li class="empty-state"><h3>暂无排行</h3><p>用户完成预测并结算后会出现在这里。</p></li>';
    renderPagination(data);
}

function renderPagination(data) {
    const el = document.querySelector('#pagination');
    if (!el) return;
    const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.page_size || 20)));
    if (totalPages <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
        <button ${data.page <= 1 ? 'disabled' : ''} onclick="goPage(${data.page - 1})">上一页</button>
        <span>第 ${data.page} / ${totalPages} 页 · 共 ${data.total} 人</span>
        <button ${data.page >= totalPages ? 'disabled' : ''} onclick="goPage(${data.page + 1})">下一页</button>
    `;
}

function goPage(page) {
    state.page = page;
    loadLeaderboard().catch(error => showLeaderboardError(error));
}

function resetLeaderboard() {
    state.page = 1;
    loadLeaderboard().catch(error => showLeaderboardError(error));
}

function exportLeaderboard() {
    const params = new URLSearchParams();
    if (state.game && !state.tournament) params.set('game_type', state.game);
    if (state.tournament) params.set('tournament_id', state.tournament);
    const a = document.createElement('a');
    a.href = `/api/leaderboard/export${params.toString() ? `?${params}` : ''}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function showLeaderboardError(error) {
    if (leaderboardFullEl) leaderboardFullEl.innerHTML = `<li class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></li>`;
}

function closeDetailModal() {
    if (detailModalEl) detailModalEl.hidden = true;
    if (detailModalBodyEl) detailModalBodyEl.innerHTML = '';
    document.body.classList.remove('modal-open');
}

function userDetailStatus(prediction) {
    if (prediction.is_forfeit) return { cls: 'forfeit', label: '弃权', points: '不计分' };
    const points = prediction.points_earned ?? 0;
    return points > 0
        ? { cls: 'correct', label: '得分', points: `+${points} 分` }
        : { cls: 'wrong', label: '未得分', points: '0 分' };
}

function userDetailRow(prediction) {
    const status = userDetailStatus(prediction);
    const team1 = prediction.team1_short_name || prediction.team1_name;
    const team2 = prediction.team2_short_name || prediction.team2_name;
    return `<li class="leaderboard-prediction-card ${status.cls}">
        <div class="lb-prediction-head">
            <div>
                <span class="game-pill ${prediction.game_type || ''}">${gameName(prediction.game_type)}</span>
                <span class="match-format">${escapeHtml(prediction.format || 'BO?')}</span>
                <strong>${escapeHtml(prediction.tournament_name)}</strong>
            </div>
            <span class="lb-result-status ${status.cls}">${status.label}</span>
        </div>
        <div class="lb-prediction-matchup">
            <div class="lb-prediction-team">${logoHtml(prediction.team1_logo_url, prediction.team1_dark_logo_url)}<b>${escapeHtml(team1)}</b></div>
            <div class="lb-score-compare">
                <div><small>赛果</small><strong>${prediction.team1_score} : ${prediction.team2_score}</strong></div>
                <div><small>预测</small><strong>${prediction.predicted_team1_score} : ${prediction.predicted_team2_score}</strong></div>
            </div>
            <div class="lb-prediction-team right">${logoHtml(prediction.team2_logo_url, prediction.team2_dark_logo_url)}<b>${escapeHtml(team2)}</b></div>
        </div>
        <div class="lb-prediction-foot">
            <span>${escapeHtml(prediction.match_name || '常规赛程')}</span>
            <time>${formatDateTime(prediction.match_time)}</time>
            <span>预测胜者：<b>${escapeHtml(prediction.predicted_winner_name)}</b></span>
            <strong>${status.points}</strong>
        </div>
    </li>`;
}

// 明细模态框分页：活跃用户可能有数百条预测，全量渲染会让模态框内列表长达数万像素
const USER_DETAIL_PAGE_SIZE = 20;
let userDetailPredictions = [];
let userDetailVisible = USER_DETAIL_PAGE_SIZE;

function renderUserDetailList(predictions) {
    userDetailPredictions = predictions;
    userDetailVisible = USER_DETAIL_PAGE_SIZE;
    return buildUserDetailListHtml();
}

function buildUserDetailListHtml() {
    if (!userDetailPredictions.length) return '<ol class="detail-list leaderboard-prediction-list"><li class="empty-state">暂无已结算预测</li></ol>';
    const visible = userDetailPredictions.slice(0, userDetailVisible);
    const remaining = userDetailPredictions.length - visible.length;
    return `<ol class="detail-list leaderboard-prediction-list">${visible.map(userDetailRow).join('')}</ol>`
        + (remaining > 0 ? `<button class="ghost load-more-btn" onclick="loadMoreUserDetails()">显示更多（剩余 ${remaining} 条）</button>` : '');
}

function loadMoreUserDetails() {
    userDetailVisible += USER_DETAIL_PAGE_SIZE;
    const list = detailModalBodyEl.querySelector('.leaderboard-prediction-list');
    const btn = detailModalBodyEl.querySelector('.load-more-btn');
    const html = buildUserDetailListHtml();
    // 只替换列表区域，保留头部统计
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const newList = wrapper.querySelector('.leaderboard-prediction-list');
    const newBtn = wrapper.querySelector('.load-more-btn');
    list.replaceWith(newList);
    if (btn) btn.remove();
    if (newBtn) detailModalBodyEl.appendChild(newBtn);
}

async function showUserDetails(userId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    const params = new URLSearchParams();
    if (state.game && !state.tournament) params.set('game_type', state.game);
    if (state.tournament) params.set('tournament_id', state.tournament);
    try {
        const data = await sharedApi(`/leaderboard/users/${userId}/details${params.toString() ? `?${params}` : ''}`);
        const scored = data.predictions.filter(prediction => !prediction.is_forfeit && (prediction.points_earned || 0) > 0).length;
        const missed = data.predictions.filter(prediction => !prediction.is_forfeit && (prediction.points_earned || 0) === 0).length;
        detailModalBodyEl.innerHTML = `
            <div class="modal-head leaderboard-detail-head">
                <div><span class="eyebrow">Prediction history</span><h2>${escapeHtml(data.user.username)}</h2></div>
                <div class="leaderboard-detail-stats">
                    <span><b>${data.summary.total_score}</b>积分</span>
                    <span><b>${data.summary.prediction_count}</b>已结算</span>
                    <span><b>${scored}</b>得分</span>
                    <span><b>${missed}</b>未得分</span>
                    <span><b>${data.summary.success_rate}%</b>得分率</span>
                </div>
            </div>
            ${renderUserDetailList(data.predictions)}
        `;
        detailModalEl.hidden = false;
        document.body.classList.add('modal-open');
    } catch (error) {
        alert(error.message);
    }
}

window.setGame = setGame;
window.loadLeaderboard = loadLeaderboard;
window.goPage = goPage;
window.resetLeaderboard = resetLeaderboard;
window.exportLeaderboard = exportLeaderboard;
window.loadMoreUserDetails = loadMoreUserDetails;
window.showUserDetails = showUserDetails;
window.closeDetailModal = closeDetailModal;
loadTournamentOptions().then(loadLeaderboard).catch(error => showLeaderboardError(error));
