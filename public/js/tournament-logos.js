// 赛事厂牌 logo 公共模块：主页 / 前台各页 / 管理后台共用。
// 必须在 shared.js / app.js / admin.js 之前加载。
// 精选映射按赛事名关键词匹配本地文件（public/images/tournament/），未命中不显示。

const TOURNAMENT_LOGOS = [
    { file: '/images/tournament/blast-bounty.webp', game: 'cs2', keys: ['blast bounty'] },
    { file: '/images/tournament/blast-open.webp', game: 'cs2', keys: ['blast open'] },
    { file: '/images/tournament/blast-rival.webp', game: 'cs2', keys: ['blast rival'] },
    { file: '/images/tournament/epl.png', game: 'cs2', keys: ['esl pro league', 'epl'] },
    { file: '/images/tournament/xpl.png', game: 'cs2', keys: ['xse pro league', 'xpl'] },
    { file: '/images/tournament/ewc.png', game: 'cs2', keys: ['esports world cup', 'ewc'] },
    { file: '/images/tournament/fissure.webp', game: 'cs2', keys: ['fissure'] },
    { file: '/images/tournament/iem.png', game: 'cs2', keys: ['iem'] },
    { file: '/images/tournament/pgl.webp', game: 'cs2', keys: ['pgl'] },
    { file: '/images/tournament/stake-pulse.png', game: 'cs2', keys: ['stake pulse'] },
    { file: '/images/tournament/stake-ranked.png', game: 'cs2', keys: ['stake ranked'] },
    { file: '/images/tournament/starladder.webp', game: 'cs2', keys: ['starladder', 'star ladder'] },
    { file: '/images/tournament/thunderpick.png', game: 'cs2', keys: ['thunderpick'] },
    { file: '/images/tournament/vct-americas.png', game: 'valorant', keys: ['vct americas'] },
    { file: '/images/tournament/vct-champions.png', game: 'valorant', keys: ['vct champions'] },
    { file: '/images/tournament/vct-cn.png', game: 'valorant', keys: ['vct china', 'vct cn'] },
    { file: '/images/tournament/vct-emea.png', game: 'valorant', keys: ['vct emea'] },
    { file: '/images/tournament/vct-masters.png', game: 'valorant', keys: ['vct masters'] },
    { file: '/images/tournament/vct-pacific.png', game: 'valorant', keys: ['vct pacific'] }
];

function tournamentLogoUrl(name, gameType) {
    const lower = String(name || '').toLowerCase();
    if (!lower) return '';
    // Game Changers 无独立 logo，避免误挂对应赛区的标
    if (lower.includes('game changers')) return '';
    for (const item of TOURNAMENT_LOGOS) {
        if (gameType && item.game !== gameType) continue;
        if (item.keys.some(key => lower.includes(key))) return item.file;
    }
    return '';
}

// logo 优先级：管理员手动上传（/uploads/ 本地文件）> 按名称匹配的精选映射；远端 URL 不使用
// 暗色模式专用 logo 约定：精选映射文件的同目录同名 -dark 变体（如 iem.png -> iem-dark.png）。
// 暗色主题下自动优先使用 -dark 变体（白色版），文件不存在时回退原图 + 浅色底板（style.css）。
const darkVariantMissing = new Set();

function darkVariantPath(file) {
    return String(file).replace(/(\.[^.]+)$/, '-dark$1');
}

function tournamentLogoSrc(src) {
    if (document.documentElement.getAttribute('data-theme') !== 'dark') return src;
    if (!src.startsWith('/images/tournament/')) return src;
    const dark = darkVariantPath(src);
    return darkVariantMissing.has(dark) ? src : dark;
}

function tournamentLogo(name, gameType, logoUrl) {
    const src = (logoUrl && logoUrl.startsWith('/uploads/')) ? logoUrl : tournamentLogoUrl(name, gameType);
    if (!src) return '';
    const use = tournamentLogoSrc(src);
    return `<img class="tournament-logo" src="${use}" data-light="${src}" data-try="${use}" data-variant="${use === src ? 'light' : 'dark'}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="tournamentLogoError(this)">`;
}

// -dark 变体 404 时回退原图；原图也失败则移除（与旧行为一致）
function tournamentLogoError(img) {
    img.onerror = null;
    const light = img.dataset.light;
    if (img.dataset.try === light) { img.remove(); return; }
    darkVariantMissing.add(img.dataset.try);
    img.dataset.try = light;
    img.dataset.variant = 'light';
    img.src = light;
}
window.tournamentLogoError = tournamentLogoError;

// 主题切换后（theme.js 派发 theme-changed）给已渲染的赛事 logo 即时换源
function applyTournamentLogoTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('img.tournament-logo[data-light]').forEach(img => {
        const light = img.dataset.light;
        const darkPath = darkVariantPath(light);
        const want = dark && light.startsWith('/images/tournament/') && !darkVariantMissing.has(darkPath) ? darkPath : light;
        if (want === img.dataset.try) return;
        img.onerror = tournamentLogoError;
        img.dataset.try = want;
        img.dataset.variant = want === light ? 'light' : 'dark';
        img.src = want;
    });
    applyTeamLogoTheme(dark);
}
window.addEventListener('theme-changed', applyTournamentLogoTheme);

// ===== 队标暗色变体（PandaScore dark_mode_image_url）=====
// img 由各页面的 logo()/logoHtml() 渲染，带 data-light/data-dark（均为代理 URL）。
// 暗色失败回退亮色，亮色也失败显示占位（与旧行为一致）。
function teamLogoError(img) {
    img.onerror = null;
    if (img.dataset.try === 'dark' && img.dataset.light) {
        img.dataset.try = 'light';
        img.dataset.variant = 'light';
        img.src = img.dataset.light;
        return;
    }
    img.replaceWith(Object.assign(document.createElement('div'), { className: 'placeholder', textContent: 'TEAM' }));
}
window.teamLogoError = teamLogoError;

function applyTeamLogoTheme(dark) {
    document.querySelectorAll('img[data-team-logo][data-dark]').forEach(img => {
        if (!img.dataset.dark) return;
        const next = dark ? img.dataset.dark : (img.dataset.light || img.dataset.dark);
        img.dataset.try = dark ? 'dark' : 'light';
        img.dataset.variant = dark ? 'dark' : 'light';
        img.onerror = teamLogoError;
        img.src = next;
    });
}

window.tournamentLogoUrl = tournamentLogoUrl;
window.tournamentLogo = tournamentLogo;
