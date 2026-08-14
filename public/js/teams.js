const teamState = {
    game: localStorage.getItem('teamGameFilter') || 'cs2',
    search: '',
    activeId: new URLSearchParams(location.search).get('team') || ''
};
const teamListView = document.querySelector('#teamListView');
const teamDetailView = document.querySelector('#teamDetailView');
const teamsGrid = document.querySelector('#teamsGrid');
const teamGameFilter = document.querySelector('#teamGameFilter');
const teamSearch = document.querySelector('#teamSearch');

if (teamGameFilter) teamGameFilter.value = teamState.game;
if (teamSearch) teamSearch.value = teamState.search;

function teamEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function teamLogo(url) {
    const src = typeof proxiedLogoUrl === 'function' ? proxiedLogoUrl(url) : url || '/images/team-tbd.svg';
    return src ? `<img src="${teamEscape(src)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'placeholder',textContent:'TEAM'}))">` : '<div class="placeholder">TEAM</div>';
}

function teamGameName(game) { return game === 'valorant' ? 'Valorant' : 'CS2'; }
function teamRecord(row) { return `${row.win_count || 0}胜 ${row.loss_count || 0}负`; }

function teamCard(team) {
    return `<a class="team-card" href="/teams.html?team=${team.id}">
        <div class="team-card-logo">${teamLogo(team.logo_url)}</div>
        <div class="team-card-body">
            <div class="team-card-top"><span class="game-pill ${team.game_type}">${teamGameName(team.game_type)}</span><span>${team.match_count || 0} 场已结算</span></div>
            <h3>${teamEscape(team.short_name || team.name)}</h3>
            <p>${teamEscape(team.name)}${team.country ? ` · ${teamEscape(team.country)}` : ''}</p>
            <div class="team-card-foot"><strong>${team.win_count || 0} 胜</strong><span>${team.upcoming_count || 0} 场待赛</span></div>
        </div>
    </a>`;
}

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
    return `<article class="team-match-row">
        <div class="team-match-result ${result.className}">${result.label}</div>
        <div class="team-match-opponent">${teamLogo(isTeam1 ? match.team2_logo_url : match.team1_logo_url)}<div><strong>${teamEscape(opponent)}</strong><small>${teamEscape(match.tournament_name)}${match.stage_name ? ` · ${teamEscape(match.stage_name)}` : ''}</small></div></div>
        <div class="team-match-score">${match.status === 'finished' ? `${own} : ${other}` : 'VS'}</div>
        <time>${typeof formatDateTime === 'function' ? formatDateTime(match.match_time) : teamEscape(match.match_time)}</time>
    </article>`;
}

function tournamentHistoryRow(row) {
    return `<article class="team-history-row">
        <div><span class="game-pill ${row.game_type}">${teamGameName(row.game_type)}</span><strong>${teamEscape(row.tournament_name)}</strong><small>${row.finished_count || 0}/${row.match_count || 0} 场完成</small></div>
        <b class="team-placement">${teamEscape(row.placement)}</b>
        <span>${teamRecord(row)} · ${row.win_rate || 0}% 胜率</span>
    </article>`;
}

function teamDetail(data) {
    const team = data.team;
    const stats = data.stats || {};
    return `<div class="team-detail-head">
        <button class="button ghost team-back" onclick="closeTeamDetail()">返回队伍列表</button>
        <div class="team-identity"><div class="team-detail-logo">${teamLogo(team.logo_url)}</div><div><span class="game-pill ${team.game_type}">${teamGameName(team.game_type)}</span><h2>${teamEscape(team.name)}</h2><p>${teamEscape(team.short_name || '')}${team.country ? ` · ${teamEscape(team.country)}` : ''}</p></div></div>
        <div class="team-stat-grid"><span><b>${stats.match_count || 0}</b>已赛</span><span><b>${stats.win_count || 0}</b>胜场</span><span><b>${stats.win_rate || 0}%</b>胜率</span><span><b>${stats.upcoming_count || 0}</b>待赛</span></div>
    </div>
    <div class="team-detail-grid">
        <section class="panel team-history"><div class="section-head"><h3>赛事履历</h3><span>近期参赛记录与阶段名次</span></div>${data.tournaments?.map(tournamentHistoryRow).join('') || '<div class="empty-state">暂无赛事履历</div>'}</section>
        <section class="panel team-matches"><div class="section-head"><h3>比赛结果</h3><span>最近 30 场比赛</span></div>${data.matches?.map(match => teamMatchRow(match, team.id)).join('') || '<div class="empty-state">暂无比赛记录</div>'}</section>
    </div>`;
}

function updateTeamUrl(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('team', id); else url.searchParams.delete('team');
    history.replaceState(null, '', url);
}

async function loadTeams() {
    if (!teamsGrid) return;
    teamsGrid.innerHTML = '<div class="loading-text">加载队伍中...</div>';
    const params = new URLSearchParams();
    if (teamState.game) params.set('game_type', teamState.game);
    if (teamState.search.trim()) params.set('q', teamState.search.trim());
    try {
        const data = await sharedApi(`/teams?${params}`);
        teamsGrid.innerHTML = data.teams?.map(teamCard).join('') || '<div class="empty-state"><h3>暂无队伍</h3><p>请调整筛选条件。</p></div>';
    } catch (error) { teamsGrid.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${teamEscape(error.message)}</p></div>`; }
}

async function openTeamDetail(id) {
    teamState.activeId = String(id);
    updateTeamUrl(teamState.activeId);
    teamListView.hidden = true;
    teamDetailView.hidden = false;
    teamDetailView.innerHTML = '<div class="loading-text">加载队伍详情...</div>';
    try {
        const data = await sharedApi(`/teams/${encodeURIComponent(id)}`);
        if (!data || !data.team) throw new Error('队伍数据暂时不可用，请稍后重试');
        teamDetailView.innerHTML = teamDetail(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) { teamDetailView.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${teamEscape(error.message)}</p><button onclick="closeTeamDetail()">返回</button></div>`; }
}

function closeTeamDetail() {
    teamState.activeId = '';
    updateTeamUrl('');
    teamDetailView.hidden = true;
    teamListView.hidden = false;
    loadTeams();
}

teamGameFilter?.addEventListener('change', () => { teamState.game = teamGameFilter.value; localStorage.setItem('teamGameFilter', teamState.game); loadTeams(); });
teamSearch?.addEventListener('input', () => { teamState.search = teamSearch.value; clearTimeout(teamSearch._timer); teamSearch._timer = setTimeout(loadTeams, 180); });
window.openTeamDetail = openTeamDetail;
window.closeTeamDetail = closeTeamDetail;
if (teamState.activeId) openTeamDetail(teamState.activeId); else loadTeams();
