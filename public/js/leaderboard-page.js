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

function userDetailRow(prediction) {
    if (prediction.is_forfeit) {
        return `<li class="detail-row user-detail forfeit">
            <strong class="detail-title">${escapeHtml(prediction.tournament_name)}</strong>
            <span class="detail-match">${escapeHtml(prediction.team1_name)} ${prediction.team1_score}-${prediction.team2_score} ${escapeHtml(prediction.team2_name)}</span>
            <span class="detail-pick">预测 ${prediction.predicted_team1_score}-${prediction.predicted_team2_score} / ${escapeHtml(prediction.predicted_winner_name)}</span>
            <b class="detail-points">弃权不计分</b>
        </li>`;
    }
    const points = prediction.points_earned ?? 0;
    const cls = points > 0 ? 'correct' : 'wrong';
    return `<li class="detail-row user-detail ${cls}">
        <strong class="detail-title">${escapeHtml(prediction.tournament_name)}</strong>
        <span class="detail-match">${escapeHtml(prediction.team1_name)} ${prediction.team1_score}-${prediction.team2_score} ${escapeHtml(prediction.team2_name)}</span>
        <span class="detail-pick">预测 ${prediction.predicted_team1_score}-${prediction.predicted_team2_score} / ${escapeHtml(prediction.predicted_winner_name)}</span>
        <b class="detail-points">+${points} 分</b>
    </li>`;
}

async function showUserDetails(userId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    const params = new URLSearchParams();
    if (state.game && !state.tournament) params.set('game_type', state.game);
    if (state.tournament) params.set('tournament_id', state.tournament);
    try {
        const data = await sharedApi(`/leaderboard/users/${userId}/details${params.toString() ? `?${params}` : ''}`);
        detailModalBodyEl.innerHTML = `
            <div class="modal-head">
                <h2>${escapeHtml(data.user.username)} 得分详情</h2>
                <p>${data.summary.prediction_count} 场已结算 · ${data.summary.total_score} 分 · ${data.summary.success_rate}% 得分率</p>
            </div>
            <ol class="detail-list">${data.predictions.map(userDetailRow).join('') || '<li class="empty-state">暂无已结算预测</li>'}</ol>
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
window.showUserDetails = showUserDetails;
window.closeDetailModal = closeDetailModal;
loadTournamentOptions().then(loadLeaderboard).catch(error => showLeaderboardError(error));
