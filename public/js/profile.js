const profileState = { predictions: [], stats: null, streaks: [], streakMap: {}, visibleCount: 20 };
const PREDICTION_PAGE_SIZE = 20;

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
    if (!predictions.length) {
        predictionList.innerHTML = '<div class="empty-state"><h3>暂无预测记录</h3><p>提交预测后会在这里显示。</p></div>';
        return;
    }
    // 分页渲染：全量渲染上百张卡片会拖慢长列表（移动端尤甚）
    const visible = predictions.slice(0, profileState.visibleCount);
    const remaining = predictions.length - visible.length;
    predictionList.innerHTML = visible.map(predictionCard).join('')
        + (remaining > 0 ? `<button class="ghost load-more-btn" onclick="loadMorePredictions()">显示更多（剩余 ${remaining} 条）</button>` : '');
}

function loadMorePredictions() {
    profileState.visibleCount += PREDICTION_PAGE_SIZE;
    renderPredictions();
}

// 连胜列表：仅显示有连胜记录的赛事，按当前连胜降序、最长连胜次之
function renderStreaks() {
    const streaks = (profileState.streaks || []).filter(item => item.current > 0 || item.best > 0)
        .sort((a, b) => (b.current - a.current) || (b.best - a.best));
    if (!streaks.length) {
        streakList.innerHTML = '<div class="empty-state"><h3>暂无连胜记录</h3><p>在赛事中连续猜对即可累积连胜并获得额外加分。</p></div>';
        return;
    }
    streakList.innerHTML = streaks.map(item => `<div class="streak-item">
        <span class="streak-name"><b>${escapeHtml(item.tournament_name)}</b><small>${gameName(item.game_type)}</small></span>
        <span class="streak-val">${streakBadgeHtml(item.current)}<span>最长 ${item.best} 轮</span></span>
    </div>`).join('');
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
    if (statStreakBonus) statStreakBonus.textContent = `+${stats.streak_bonus || 0}`;
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
    profileState.streaks = data.streaks || [];
    // 连胜映射：tournament_id -> 当前连胜（分享卡用，与 app.js 的 myStreaks 结构一致）
    profileState.streakMap = Object.fromEntries(profileState.streaks.map(item => [String(item.tournament_id), item.current]));
    renderSummary();
    renderStreaks();
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

// 筛选切换时回到第一页再渲染（不能直接覆盖 renderPredictions，会形成无限递归）
function resetAndRenderPredictions() {
    profileState.visibleCount = PREDICTION_PAGE_SIZE;
    renderPredictions();
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

window.getShareContext = () => ({ user: sharedState.user, streaks: profileState.streakMap });

function sharePredictionFromProfile(matchId) {
    if (typeof window.sharePrediction === 'function') window.sharePrediction(matchId);
}
window.sharePredictionFromProfile = sharePredictionFromProfile;
window.resetAndRenderPredictions = resetAndRenderPredictions;
window.loadMorePredictions = loadMorePredictions;
window.changePassword = changePassword;
window.addEventListener('auth-changed', loadProfile);
loadProfile().catch(error => {
    profileContent.hidden = false;
    predictionList.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
});
