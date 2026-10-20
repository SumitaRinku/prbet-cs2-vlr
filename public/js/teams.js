const teamState = {
    game: localStorage.getItem('teamGameFilter') ?? 'cs2',
    sort: localStorage.getItem('teamSort') === 'win_rate' ? 'recent' : (localStorage.getItem('teamSort') || 'recent'),
    activity: localStorage.getItem('teamActivity') || '',
    search: '',
    activeId: new URLSearchParams(location.search).get('team') || '',
    requestId: 0
};
const teamListView = document.querySelector('#teamListView');
const teamDetailView = document.querySelector('#teamDetailView');
const teamsGrid = document.querySelector('#teamsGrid');
const teamGameSeg = document.querySelector('#teamGameSeg');
const teamSort = document.querySelector('#teamSort');
const teamActivity = document.querySelector('#teamActivity');
const teamSearch = document.querySelector('#teamSearch');
const teamCount = document.querySelector('#teamCount');

if (teamSort) teamSort.value = teamState.sort;
if (teamActivity) teamActivity.value = teamState.activity;

function syncGameSeg() {
    if (!teamGameSeg) return;
    teamGameSeg.querySelectorAll('button[data-game]').forEach(button => {
        button.classList.toggle('active', button.dataset.game === teamState.game);
    });
}

function teamEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function teamLogo(url, darkUrl) {
    // 暗色主题优先 PandaScore 暗色队标（白色版），主题切换由 tournament-logos.js 换源
    const resolve = value => (typeof proxiedLogoUrl === 'function' ? proxiedLogoUrl(value) : value);
    const light = resolve(url) || '/images/team-tbd.svg';
    const dark = resolve(darkUrl);
    const useDark = dark && document.documentElement.getAttribute('data-theme') === 'dark';
    const src = useDark ? dark : light;
    return `<img src="${teamEscape(src)}" data-team-logo data-light="${teamEscape(light || '')}" data-dark="${teamEscape(dark || '')}" data-try="${useDark ? 'dark' : 'light'}" data-variant="${useDark ? 'dark' : 'light'}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="teamLogoError(this)">`;
}

function teamGameName(game) { return game === 'valorant' ? 'Valorant' : 'CS2'; }
function teamRecord(row) { return `${row.win_count || 0}胜 ${row.loss_count || 0}负`; }
function winRate(wins, played) { return played ? Math.round((wins / played) * 100) : 0; }

const COUNTRY_CODES = {
    'argentina': 'AR', 'australia': 'AU', 'austria': 'AT', 'belarus': 'BY', 'belgium': 'BE',
    'bosnia and herzegovina': 'BA', 'brazil': 'BR', 'bulgaria': 'BG', 'canada': 'CA',
    'chile': 'CL', 'china': 'CN', 'colombia': 'CO', 'croatia': 'HR', 'czech republic': 'CZ',
    'czechia': 'CZ', 'denmark': 'DK', 'egypt': 'EG', 'estonia': 'EE', 'finland': 'FI',
    'france': 'FR', 'georgia': 'GE', 'germany': 'DE', 'greece': 'GR', 'hong kong': 'HK',
    'hungary': 'HU', 'india': 'IN', 'indonesia': 'ID', 'iran': 'IR', 'ireland': 'IE',
    'israel': 'IL', 'italy': 'IT', 'japan': 'JP', 'kazakhstan': 'KZ', 'kosovo': 'XK',
    'latvia': 'LV', 'lithuania': 'LT', 'malaysia': 'MY', 'mexico': 'MX', 'mongolia': 'MN',
    'morocco': 'MA', 'netherlands': 'NL', 'new zealand': 'NZ', 'north macedonia': 'MK',
    'norway': 'NO', 'pakistan': 'PK', 'peru': 'PE', 'philippines': 'PH', 'poland': 'PL',
    'portugal': 'PT', 'romania': 'RO', 'russia': 'RU', 'saudi arabia': 'SA', 'serbia': 'RS',
    'singapore': 'SG', 'slovakia': 'SK', 'slovenia': 'SI', 'south africa': 'ZA', 'south korea': 'KR',
    'spain': 'ES', 'sweden': 'SE', 'switzerland': 'CH', 'taiwan': 'TW', 'thailand': 'TH',
    'tunisia': 'TN', 'turkey': 'TR', 'ukraine': 'UA', 'united arab emirates': 'AE',
    'united kingdom': 'GB', 'united states': 'US', 'uruguay': 'UY', 'vietnam': 'VN'
};

function countryCode(country) {
    const value = String(country || '').trim();
    if (/^[a-z]{2}$/i.test(value)) return value.toUpperCase();
    return COUNTRY_CODES[value.toLowerCase()] || '';
}

function countryFlag(country) {
    const code = countryCode(country);
    if (!code) return '';
    return [...code].map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
}

function countryHtml(country) {
    const value = String(country || '').trim();
    if (!value) return '';
    const flag = countryFlag(value);
    return flag
        ? `<span class="team-country" role="img" aria-label="${teamEscape(value)}" title="${teamEscape(value)}">${flag}</span>`
        : `<span class="team-country team-country-text" title="${teamEscape(value)}">${teamEscape(value)}</span>`;
}

// ---------- 列表卡片：只保留扫读所需信息（队标 / 名称 / 战绩 / 胜率条 / 待赛） ----------

function teamCard(team) {
    const played = team.match_count || 0;
    const wins = team.win_count || 0;
    const rate = winRate(wins, played);
    const shortName = team.short_name || team.name;
    const upcoming = team.upcoming_count || 0;
    return `<a class="th-card ${team.game_type}" href="/teams.html?team=${team.id}" title="${teamEscape(team.name)}">
        <span class="th-card-logo">${teamLogo(team.logo_url, team.dark_logo_url)}</span>
        <span class="th-card-body">
            <span class="th-card-title"><strong>${teamEscape(shortName)}</strong>${countryHtml(team.country)}</span>
            <span class="th-card-sub">${teamEscape(team.name)}</span>
            <span class="th-rate" title="胜率 ${rate}%"><i style="width:${rate}%"></i></span>
            <span class="th-card-foot">
                <span class="th-record"><b>${wins}</b>胜<b class="loss">${played - wins}</b>负</span>
                <span class="th-card-meta">${upcoming ? `<em class="th-upcoming">${upcoming} 场待赛</em>` : '<em>近期无赛程</em>'}</span>
            </span>
        </span>
        <span class="game-pill ${team.game_type}">${teamGameName(team.game_type)}</span>
    </a>`;
}

function stagggerCards() {
    if (!teamsGrid) return;
    teamsGrid.querySelectorAll('.th-card').forEach((card, index) => {
        card.style.animationDelay = `${Math.min(index, 18) * 22}ms`;
    });
}

// ---------- 详情页 ----------

function matchResultLabel(match, teamId) {
    if (match.status !== 'finished') return { label: '待赛', className: 'pending' };
    if (match.is_forfeit) return { label: '弃权', className: 'forfeit' };
    return match.winner_team_id === teamId ? { label: '胜', className: 'win' } : { label: '负', className: 'loss' };
}

function teamMatchRow(match, teamId) {
    const isTeam1 = match.team1_id === teamId;
    const opponent = isTeam1 ? (match.team2_short_name || match.team2_name) : (match.team1_short_name || match.team1_name);
    const own = isTeam1 ? match.team1_score : match.team2_score;
    const other = isTeam1 ? match.team2_score : match.team1_score;
    const result = matchResultLabel(match, teamId);
    const opponentLogo = teamLogo(isTeam1 ? match.team2_logo_url : match.team1_logo_url, isTeam1 ? match.team2_dark_logo_url : match.team1_dark_logo_url);
    return `<article class="th-match">
        <span class="th-tag ${result.className}">${result.label}</span>
        <span class="th-match-opp">${opponentLogo}<span><strong>${teamEscape(opponent)}</strong><small>${teamEscape(match.tournament_name)}${match.stage_name ? ` · ${teamEscape(match.stage_name)}` : ''}</small></span></span>
        <span class="th-score">${match.status === 'finished' ? `<b class="${result.className}">${own}</b><em>:</em><b>${other}</b>` : 'VS'}</span>
        <time>${typeof formatDateTime === 'function' ? formatDateTime(match.match_time) : teamEscape(match.match_time)}</time>
    </article>`;
}

// 阶段名次徽章分级配色：冠军金 / 亚军银 / 四强铜 / 八强蓝灰
function placementClass(placement) {
    if (placement === '冠军') return 'place-1';
    if (placement === '亚军') return 'place-2';
    if (placement === '四强') return 'place-3';
    if (placement === '八强') return 'place-4';
    return '';
}

function tournamentHistoryRow(row) {
    const rate = row.win_rate ?? winRate(row.win_count, row.finished_count);
    return `<article class="th-history">
        <span class="th-history-main">
            <strong title="${teamEscape(row.tournament_name)}">${teamEscape(row.tournament_name)}</strong>
            <small>${teamGameName(row.game_type)} · ${row.finished_count || 0}/${row.match_count || 0} 场完成</small>
        </span>
        <span class="th-history-record"><b>${row.win_count || 0}</b> - ${row.loss_count || 0}<small>${rate}%</small></span>
        <b class="th-placement ${placementClass(row.placement)}">${teamEscape(row.placement)}</b>
    </article>`;
}

// 近期状态：最近 5 场已结算比赛的胜负序列
function formStrip(matches, teamId) {
    const recent = matches.filter(match => match.status === 'finished').slice(0, 5);
    if (!recent.length) return '';
    return `<div class="th-form"><span class="th-form-label">近期状态</span>${recent.map(match => {
        const result = matchResultLabel(match, teamId);
        return `<b class="th-form-dot ${result.className}" title="${result.label}">${result.label}</b>`;
    }).join('')}</div>`;
}

function nextMatchBlock(matches, teamId) {
    const next = matches.find(match => match.status === 'upcoming' || match.status === 'ongoing');
    if (!next) return '';
    const isTeam1 = next.team1_id === teamId;
    const opponent = isTeam1 ? (next.team2_short_name || next.team2_name) : (next.team1_short_name || next.team1_name);
    const opponentFull = isTeam1 ? next.team2_name : next.team1_name;
    const opponentId = isTeam1 ? next.team2_id : next.team1_id;
    const logo = teamLogo(isTeam1 ? next.team2_logo_url : next.team1_logo_url, isTeam1 ? next.team2_dark_logo_url : next.team1_dark_logo_url);
    return `<a class="th-next" href="/teams.html?team=${opponentId}" title="查看 ${teamEscape(opponentFull)}">
        <span class="th-next-label"><i class="th-live-dot"></i>${next.status === 'ongoing' ? '正在进行' : '下一场比赛'}</span>
        <span class="th-next-opp">${logo}<span><strong>${teamEscape(opponent)}</strong><small>${teamEscape(next.tournament_name)}${next.stage_name ? ` · ${teamEscape(next.stage_name)}` : ''}</small></span></span>
        <span class="th-next-time"><b>${next.format || 'BO?'}</b>${typeof formatDateTime === 'function' ? formatDateTime(next.match_time) : teamEscape(next.match_time)}</span>
    </a>`;
}

function teamDetail(data) {
    const team = data.team;
    const stats = data.stats || {};
    const matches = data.matches || [];
    const played = stats.match_count || 0;
    const wins = stats.win_count || 0;
    const losses = stats.loss_count ?? Math.max(played - wins, 0);
    const rate = stats.win_rate ?? winRate(wins, played);
    return `<header class="th-hero ${team.game_type}">
        <button class="th-back" onclick="closeTeamDetail()" aria-label="返回队伍列表">‹ 返回</button>
        <div class="th-hero-id">
            <span class="th-hero-logo">${teamLogo(team.logo_url, team.dark_logo_url)}</span>
            <div class="th-hero-text">
                <div class="th-hero-tags"><span class="game-pill ${team.game_type}">${teamGameName(team.game_type)}</span>${countryHtml(team.country)}${team.short_name ? `<span class="th-short">${teamEscape(team.short_name)}</span>` : ''}</div>
                <h2>${teamEscape(team.name)}</h2>
                ${formStrip(matches, team.id)}
            </div>
        </div>
        <dl class="th-hero-stats">
            <div><dt>胜率</dt><dd>${rate}<small>%</small></dd></div>
            <div><dt>已赛</dt><dd>${played}</dd></div>
            <div><dt>胜 / 负</dt><dd>${wins}<span> / ${losses}</span></dd></div>
            <div><dt>待赛</dt><dd>${stats.upcoming_count || 0}</dd></div>
        </dl>
    </header>
    ${nextMatchBlock(matches, team.id)}
    <div class="th-columns">
        <section class="th-panel th-panel-wide">
            <div class="th-panel-head"><h3>比赛记录</h3><span>最近 ${matches.length} 场</span></div>
            <div class="th-match-list">${matches.map(match => teamMatchRow(match, team.id)).join('') || '<div class="th-empty">暂无比赛记录</div>'}</div>
        </section>
        <section class="th-panel">
            <div class="th-panel-head"><h3>赛事履历</h3><span>${data.tournaments?.length || 0} 项赛事</span></div>
            <div class="th-history-list">${data.tournaments?.map(tournamentHistoryRow).join('') || '<div class="th-empty">暂无赛事履历</div>'}</div>
        </section>
    </div>`;
}

function updateTeamUrl(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('team', id); else url.searchParams.delete('team');
    history.replaceState(null, '', url);
}

async function loadTeams() {
    if (!teamsGrid) return;
    const requestId = ++teamState.requestId;
    syncGameSeg();
    teamsGrid.classList.remove('th-enter');
    teamsGrid.innerHTML = '<div class="th-loading">加载队伍中...</div>';
    if (teamCount) teamCount.textContent = '';
    const params = new URLSearchParams();
    if (teamState.game) params.set('game_type', teamState.game);
    if (teamState.sort) params.set('sort', teamState.sort);
    if (teamState.activity) params.set('activity', teamState.activity);
    if (teamState.search.trim()) params.set('q', teamState.search.trim());
    try {
        const data = await sharedApi(`/teams?${params}`);
        if (requestId !== teamState.requestId) return;
        const teams = data.teams || [];
        if (teamCount) teamCount.textContent = `${teams.length} 支队伍`;
        teamsGrid.innerHTML = teams.length
            ? teams.map(teamCard).join('')
            : '<div class="th-empty th-empty-lg"><h3>未找到队伍</h3><p>试试调整游戏、范围或搜索关键词。</p></div>';
        stagggerCards();
        requestAnimationFrame(() => {
            if (requestId === teamState.requestId) teamsGrid.classList.add('th-enter');
        });
    } catch (error) {
        if (requestId !== teamState.requestId) return;
        teamsGrid.innerHTML = `<div class="th-empty th-empty-lg"><h3>加载失败</h3><p>${teamEscape(error.message)}</p></div>`;
    }
}

async function openTeamDetail(id) {
    teamState.activeId = String(id);
    updateTeamUrl(teamState.activeId);
    teamListView.hidden = true;
    teamDetailView.hidden = false;
    teamDetailView.innerHTML = '<div class="th-loading">加载队伍详情...</div>';
    try {
        const data = await sharedApi(`/teams/${encodeURIComponent(id)}`);
        if (!data || !data.team) throw new Error('队伍数据暂时不可用，请稍后重试');
        teamDetailView.innerHTML = teamDetail(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
        teamDetailView.innerHTML = `<div class="th-empty th-empty-lg"><h3>加载失败</h3><p>${teamEscape(error.message)}</p><button class="button ghost" onclick="closeTeamDetail()">返回队伍列表</button></div>`;
    }
}

function closeTeamDetail() {
    teamState.activeId = '';
    updateTeamUrl('');
    teamDetailView.hidden = true;
    teamListView.hidden = false;
    loadTeams();
}

teamGameSeg?.addEventListener('click', event => {
    const button = event.target.closest('button[data-game]');
    if (!button) return;
    teamState.game = button.dataset.game;
    localStorage.setItem('teamGameFilter', teamState.game);
    loadTeams();
});
teamSort?.addEventListener('change', () => { teamState.sort = teamSort.value; localStorage.setItem('teamSort', teamState.sort); loadTeams(); });
teamActivity?.addEventListener('change', () => { teamState.activity = teamActivity.value; localStorage.setItem('teamActivity', teamState.activity); loadTeams(); });
teamSearch?.addEventListener('input', () => { teamState.search = teamSearch.value; clearTimeout(teamSearch._timer); teamSearch._timer = setTimeout(loadTeams, 180); });
window.openTeamDetail = openTeamDetail;
window.closeTeamDetail = closeTeamDetail;
if (teamState.activeId) openTeamDetail(teamState.activeId); else loadTeams();
