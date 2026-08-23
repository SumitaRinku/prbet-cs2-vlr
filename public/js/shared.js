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
    if (!sharedState.user) {
        el.innerHTML = `
            <input id="username" placeholder="用户名">
            <input id="password" placeholder="密码" type="password">
            <button onclick="sharedLogin()">登录</button>
            <button onclick="sharedRegister()">注册</button>
        `;
        return;
    }
    el.innerHTML = `<span>${escapeSharedHtml(sharedState.user.username)} · ${escapeSharedHtml(sharedState.user.role)} · ${sharedState.user.total_score || 0}分</span><button onclick="sharedLogout()">退出</button>${sharedState.user.role === 'admin' ? '<a class="button" href="/admin/">管理后台</a>' : ''}`;
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

window.sharedApi = sharedApi;
window.renderSharedUser = renderSharedUser;
window.sharedLogin = sharedLogin;
window.sharedRegister = sharedRegister;
window.sharedLogout = sharedLogout;
window.gameName = gameName;
window.formatDateTime = formatDateTime;
window.proxiedLogoUrl = proxiedLogoUrl;
window.logoHtml = logoHtml;
renderSharedUser();
