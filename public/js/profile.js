const profileState = { predictions: [], stats: null };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function predictionStatus(prediction) {
    if (prediction.match_is_forfeit) return '<span class="record-status forfeit">弃权不计分</span>';
    if (prediction.match_status !== 'finished') return '<span class="record-status pending">待结算</span>';
    if ((prediction.points_earned || 0) > 0) return '<span class="record-status correct">已得分</span>';
    return '<span class="record-status wrong">未得分</span>';
}

function actualScore(prediction) {
    if (prediction.match_status !== 'finished') return '<span class="muted">未结束</span>';
    return `<strong>${prediction.actual_team1_score} : ${prediction.actual_team2_score}</strong>`;
}

function predictionCard(prediction) {
    const team1 = prediction.team1_short_name || prediction.team1_name;
    const team2 = prediction.team2_short_name || prediction.team2_name;
    return `<article class="prediction-card">
        <div class="prediction-card-head">
            <div>
                <span class="game-pill ${prediction.game_type || ''}">${gameName(prediction.game_type)}</span>
                <span class="match-format">${escapeHtml(prediction.format)}</span>
                <strong>${escapeHtml(prediction.tournament_name)}</strong>
            </div>
            ${predictionStatus(prediction)}
        </div>
        <div class="prediction-matchup">
            <div>${logoHtml(prediction.team1_logo_url)}<strong>${escapeHtml(team1)}</strong></div>
            <div class="prediction-score">
                <span>预测 ${prediction.predicted_team1_score} : ${prediction.predicted_team2_score}</span>
                <b>${actualScore(prediction)}</b>
            </div>
            <div>${logoHtml(prediction.team2_logo_url)}<strong>${escapeHtml(team2)}</strong></div>
        </div>
        <div class="prediction-card-foot">
            <span>${escapeHtml(prediction.match_name || '常规赛程')}</span>
            <span>${formatDateTime(prediction.match_time)}</span>
            <span>预测胜者：${escapeHtml(prediction.predicted_winner_name)}</span>
            <b>${prediction.match_is_forfeit ? '弃权不计分' : prediction.points_earned === null ? '待结算' : `+${prediction.points_earned} 分`}</b>
        </div>
    </article>`;
}

function filteredPredictions() {
    const status = profileStatus.value;
    if (!status) return profileState.predictions;
    if (status === 'finished') return profileState.predictions.filter(p => p.match_status === 'finished');
    if (status === 'pending') return profileState.predictions.filter(p => p.match_status !== 'finished');
    if (status === 'scored') return profileState.predictions.filter(p => (p.points_earned || 0) > 0);
    if (status === 'missed') return profileState.predictions.filter(p => p.match_status === 'finished' && !p.match_is_forfeit && (p.points_earned || 0) === 0);
    if (status === 'forfeit') return profileState.predictions.filter(p => p.match_is_forfeit);
    return profileState.predictions;
}

function renderPredictions() {
    const predictions = filteredPredictions();
    predictionList.innerHTML = predictions.map(predictionCard).join('') || '<div class="empty-state"><h3>暂无预测记录</h3><p>提交预测后会在这里显示。</p></div>';
}

function renderSummary() {
    const stats = profileState.stats || {};
    const total = stats.total || 0;
    const settled = stats.settled || 0;
    const correct = stats.correct || 0;
    profileName.textContent = sharedState.user.username;
    profileRole.textContent = `${sharedState.user.role} · 当前账号积分 ${sharedState.user.total_score || 0}`;
    statTotal.textContent = total;
    statSettled.textContent = settled;
    statPoints.textContent = stats.points || 0;
    statRate.textContent = settled ? `${Math.round((correct / settled) * 100)}%` : '0%';
}

async function loadProfile() {
    if (!sharedState.user) {
        loginRequired.hidden = false;
        profileContent.hidden = true;
        return;
    }
    loginRequired.hidden = true;
    profileContent.hidden = false;
    const data = await sharedApi('/predictions/my');
    profileState.predictions = data.predictions;
    profileState.stats = data.stats;
    renderSummary();
    renderPredictions();
}

async function changePassword() {
    const oldValue = oldPassword.value;
    const newValue = newPassword.value;
    if (!newValue || newValue.length < 6) { alert('新密码至少6位'); return; }
    if (newValue !== newPasswordConfirm.value) { alert('两次输入的新密码不一致'); return; }
    try {
        await sharedApi('/auth/password', { method: 'PUT', body: { old_password: oldValue, new_password: newValue } });
        oldPassword.value = newPassword.value = newPasswordConfirm.value = '';
        alert('密码已修改');
    } catch (error) { alert(error.message); }
}

window.renderPredictions = renderPredictions;
window.changePassword = changePassword;
window.addEventListener('auth-changed', loadProfile);
loadProfile().catch(error => {
    profileContent.hidden = false;
    predictionList.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
});
