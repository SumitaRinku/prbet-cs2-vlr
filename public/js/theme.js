// 主题切换：localStorage 持久化，未设置时跟随系统偏好。
// 通过 html[data-theme] 驱动 style.css 中的 CSS 变量切换。
(function initTheme() {
    const root = document.documentElement;
    const stored = localStorage.getItem('theme');
    const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = stored === 'dark' || stored === 'light' ? stored : (preferDark ? 'dark' : 'light');
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;

    // 按钮图标：显示当前主题（太阳=浅色 / 月亮=深色），点击切换到另一主题
    const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/></svg>';
    const MOON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.6 14.2A8.6 8.6 0 0 1 9.8 3.4a.9.9 0 0 0-1.2-1.1 9.9 9.9 0 1 0 13.1 13.1.9.9 0 0 0-1.1-1.2z"/></svg>';

    function icon(next) {
        return next === 'dark' ? MOON : SUN;
    }

    function label(next) {
        return next === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    }

    function addToggle() {
        const nav = document.querySelector('.hero nav');
        if (!nav || document.getElementById('themeToggle')) return;
        const btn = document.createElement('button');
        btn.id = 'themeToggle';
        btn.type = 'button';
        btn.className = 'theme-toggle';
        btn.innerHTML = icon(theme);
        btn.setAttribute('aria-label', label(theme));
        btn.title = label(theme);
        btn.addEventListener('click', () => {
            const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            root.setAttribute('data-theme', next);
            root.style.colorScheme = next;
            localStorage.setItem('theme', next);
            btn.innerHTML = icon(next);
            btn.setAttribute('aria-label', label(next));
            btn.title = label(next);
            // 通知 tournament-logos.js 等模块即时响应主题切换（赛事 -dark 变体 / 队标暗色版换源）
            window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: next } }));
        });
        nav.appendChild(btn);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addToggle);
    else addToggle();
})();
