const sharedState = {
    token: localStorage.getItem('token'),
    user: JSON.parse(localStorage.getItem('user') || 'null')
};

async function sharedApi(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (sharedState.token) headers.Authorization = `Bearer ${sharedState.token}`;
    const res = await fetch(`/api${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    // token 过期/失效：清理登录态（登录、注册接口的 401 是凭据错误，不触发登出）
    if (res.status === 401 && sharedState.token && !path.startsWith('/auth/')) {
        sharedLogout();
        throw new Error('登录已过期，请重新登录');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
}

function escapeSharedHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderSharedUser() {
    const el = document.querySelector('#userPanel');
    if (!el) return;
    const toggle = document.getElementById('themeToggle');
    if (!sharedState.user) {
        el.innerHTML = `
            <input id="username" placeholder="用户名">
            <input id="password" placeholder="密码" type="password">
            <button onclick="sharedLogin()">登录</button>
            <button onclick="sharedRegister()">注册</button>
        `;
        if (toggle) el.appendChild(toggle);
        return;
    }
    el.innerHTML = `<span>${escapeSharedHtml(sharedState.user.username)} · ${escapeSharedHtml(sharedState.user.role)} · ${sharedState.user.total_score || 0}分</span><button onclick="sharedLogout()">退出</button>${sharedState.user.role === 'admin' ? '<a class="button" href="/admin/">管理后台</a>' : ''}`;
    if (toggle) el.appendChild(toggle);
}

function notifyAuthChanged() {
    window.dispatchEvent(new CustomEvent('auth-changed'));
}

async function sharedLogin() {
    try {
        const data = await sharedApi('/auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
        sharedState.token = data.token;
        sharedState.user = data.user;
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        renderSharedUser();
        notifyAuthChanged();
    } catch (error) { alert(error.message); }
}

async function sharedRegister() {
    try {
        const data = await sharedApi('/auth/register', { method: 'POST', body: { username: username.value, password: password.value } });
        sharedState.token = data.token;
        sharedState.user = data.user;
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        renderSharedUser();
        notifyAuthChanged();
    } catch (error) { alert(error.message); }
}

function sharedLogout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sharedState.token = null;
    sharedState.user = null;
    renderSharedUser();
    notifyAuthChanged();
}

function gameName(game) {
    return game === 'valorant' ? 'Valorant' : game === 'cs2' ? 'CS2' : '全部游戏';
}

// 赛事名展示：管理端可维护简称（tournaments.short_name）。
// 有简称时，移动端（≤760px）或全名过长（>16 字符）的场景自动改用简称。
function tournamentNameHtml(name, shortName) {
    const full = escapeSharedHtml(name || '');
    const short = String(shortName || '').trim();
    if (!short || short === (name || '')) return `<span class="t-name">${full}</span>`;
    const long = String(name || '').length > 16 ? ' long-name' : '';
    return `<span class="t-name has-short${long}"><span class="tn-full">${full}</span><span class="tn-short">${escapeSharedHtml(short)}</span></span>`;
}

function formatDateTime(value) {
    return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-') : '';
}

function proxiedLogoUrl(url) {
    if (!url) return '';
    // 本地/相对路径（如 TBD 占位盾牌 /images/team-tbd.svg）直接引用，不走外部 logo 代理。
    if (/^\/(?!\/)/.test(url) || url.startsWith('data:')) return url;
    return `/api/images/team-logo?url=${encodeURIComponent(url)}`;
}

function logoHtml(url, darkUrl) {
    // 暗色主题优先 PandaScore 暗色队标（白色版），主题切换由 tournament-logos.js 换源
    const light = proxiedLogoUrl(url);
    const dark = proxiedLogoUrl(darkUrl);
    const useDark = dark && document.documentElement.getAttribute('data-theme') === 'dark';
    const src = useDark ? dark : light;
    if (!src) return '<div class="placeholder">TEAM</div>';
    return `<img src="${src}" data-team-logo data-light="${light || ''}" data-dark="${dark || ''}" data-try="${useDark ? 'dark' : 'light'}" data-variant="${useDark ? 'dark' : 'light'}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="teamLogoError(this)">`;
}

// 赛事厂牌 logo 的匹配与渲染在 /js/tournament-logos.js（公共模块，需先于本文件加载）：
// tournamentLogoUrl / tournamentLogo（上传 logo > 精选映射，远端 URL 不使用）。

// ---------- 比赛预测详情弹窗（主页 app.js 与回看页 tournaments.js 共用） ----------
// 结构：对阵英雄区（队标 + 终场比分）→ 赛事元信息 → 统计条（参与/命中/命中率/最高加分）→ 排名列表。
function matchPredictionDetailRow(prediction, index, match) {
    const points = prediction.points_earned ?? 0;
    const hit = points > 0;
    const rank = index + 1;
    const p1 = Number(prediction.predicted_team1_score);
    const p2 = Number(prediction.predicted_team2_score);
    const winSide = prediction.predicted_winner_name || '';
    return `<li class="pd-row ${hit ? 'hit' : 'miss'}">
        <span class="pd-rank ${rank <= 3 ? `top${rank}` : ''}">${rank}</span>
        <div class="pd-user"><strong>${escapeSharedHtml(prediction.username)}</strong><small>选 ${escapeSharedHtml(winSide)}</small></div>
        <span class="pd-score"><b class="${p1 > p2 ? 'win' : ''}">${p1}</b><em>:</em><b class="${p2 > p1 ? 'win' : ''}">${p2}</b></span>
        <span class="pd-status">${hit ? '命中' : '未中'}</span>
        <b class="pd-points">${hit ? `+${points}` : '0'} 分</b>
    </li>`;
}

function renderMatchPredictionDetail(match, predictions) {
    const list = predictions || [];
    const t1Win = Number(match.team1_score) > Number(match.team2_score);
    const t2Win = Number(match.team2_score) > Number(match.team1_score);
    const hitCount = list.filter(p => (p.points_earned ?? 0) > 0).length;
    const maxPoints = list.reduce((max, p) => Math.max(max, p.points_earned ?? 0), 0);
    const rate = list.length ? Math.round(hitCount / list.length * 100) : 0;
    const teamBlock = (prefix, win) => `<div class="pd-hero-team">
        ${logoHtml(match[`${prefix}_logo_url`], match[`${prefix}_dark_logo_url`])}
        <div><strong class="${win ? 'win' : ''}">${escapeSharedHtml(match[`${prefix}_short_name`] || match[`${prefix}_name`])}</strong><small>${escapeSharedHtml(match[`${prefix}_name`])}</small></div>
    </div>`;
    return `
        <div class="pd-hero">
            ${teamBlock('team1', t1Win)}
            <div class="pd-hero-mid">
                <span class="game-pill ${match.game_type || ''}">${gameName(match.game_type)}</span>
                <div class="pd-final"><b class="${t1Win ? 'win' : ''}">${match.team1_score}</b><em>:</em><b class="${t2Win ? 'win' : ''}">${match.team2_score}</b></div>
                <small>终场比分</small>
            </div>
            ${teamBlock('team2', t2Win)}
        </div>
        <p class="pd-meta">${escapeSharedHtml(match.tournament_name || '')} · ${escapeSharedHtml(match.name || '常规赛程')} · ${formatDateTime(match.match_time)}</p>
        ${match.is_forfeit ? '<p class="pd-forfeit">本场因弃权按 1-0 判定，所有预测均不计入积分。</p>' : ''}
        <div class="pd-stats">
            <span><b>${list.length}</b><small>人参与</small></span>
            <span><b>${hitCount}</b><small>命中</small></span>
            <span><b>${rate}%</b><small>命中率</small></span>
            <span><b>+${maxPoints}</b><small>最高加分</small></span>
        </div>
        <ol class="pd-list">${list.map((p, i) => matchPredictionDetailRow(p, i, match)).join('') || '<li class="empty-state">暂无预测</li>'}</ol>
    `;
}

window.matchPredictionDetailRow = matchPredictionDetailRow;
window.renderMatchPredictionDetail = renderMatchPredictionDetail;

// showMatchHead2Head 在 /js/h2h.js（独立文件，主页/回看页均加载）。

window.sharedApi = sharedApi;
window.renderSharedUser = renderSharedUser;
window.sharedLogin = sharedLogin;
window.sharedRegister = sharedRegister;
window.sharedLogout = sharedLogout;
window.gameName = gameName;
window.tournamentNameHtml = tournamentNameHtml;
window.formatDateTime = formatDateTime;
window.proxiedLogoUrl = proxiedLogoUrl;
window.logoHtml = logoHtml;
renderSharedUser();
