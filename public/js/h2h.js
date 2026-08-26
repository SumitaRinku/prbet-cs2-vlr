// h2h.js — 对阵历史弹窗（主页 app.js 与回看页 tournaments.js 共用）。
// 两页的全局依赖名不同（index: api/logo；tournaments: sharedApi/logoHtml），
// 这里做运行时适配；弹窗元素约定 #detailModal / #detailModalBody（两页均已存在）。
(function () {
    const h2hApi = (...args) => (typeof sharedApi === 'function' ? sharedApi(...args) : api(...args));
    const h2hLogo = (url, darkUrl) => (typeof logoHtml === 'function' ? logoHtml(url, darkUrl) : logo(url, darkUrl));
    const h2hEscape = value => escapeHtml(value);

    function recentListHtml(items) {
        if (!items.length) return '<div class="h2h-empty">暂无已结算比赛</div>';
        return items.map(item => {
            const isWin = item.result === 'W';
            return `<li class="h2h-form-row">
                <span class="h2h-result ${isWin ? 'win' : 'loss'}">${isWin ? '胜' : '负'}</span>
                <a class="h2h-opp" href="/teams.html?team=${item.opponent_id}">${h2hLogo(item.opponent_logo_url, item.opponent_dark_logo_url)}<span>vs ${h2hEscape(item.opponent)}</span></a>
                <span class="h2h-score">${h2hEscape(item.score)}</span>
                <time class="h2h-date">${formatDateTime(item.match_time)}</time>
            </li>`;
        }).join('');
    }

    async function showMatchHead2Head(matchId) {
        const modalEl = document.getElementById('detailModal');
        const bodyEl = document.getElementById('detailModalBody');
        if (!modalEl || !bodyEl) return;
        try {
            const data = await h2hApi(`/matches/${matchId}/head2head`);
            const m = data.match;
            const formPanel = (team, side) => {
                const teamId = m[`${side}_id`];
                const name = m[`${side}_name`];
                const rate = team.wins + team.losses ? Math.round(team.wins / (team.wins + team.losses) * 100) : 0;
                return `
                <section class="h2h-panel">
                    <header class="h2h-panel-head">
                        <a class="h2h-team-identity" href="/teams.html?team=${teamId}">${h2hLogo(m[`${side}_logo_url`], m[`${side}_dark_logo_url`])}<span><b>${h2hEscape(name)}</b><small>查看队伍详情</small></span></a>
                        <div class="h2h-record"><b>${rate}%</b><span>近况胜率 · ${team.wins}胜 ${team.losses}负</span></div>
                    </header>
                    <ol class="h2h-form">${recentListHtml(team.recent)}</ol>
                </section>`;
            };
            const h2hList = data.head_to_head.length
                ? data.head_to_head.map(h => {
                    const team1Won = h.winner === 'team1';
                    return `<li class="h2h-match-row">
                        <span class="h2h-score-line">
                            <b class="${team1Won ? 'win' : 'loss'}">${h2hEscape(m.team1_name)}</b>
                            <span>${h.team1_score} - ${h.team2_score}</span>
                            <b class="${team1Won ? 'loss' : 'win'}">${h2hEscape(m.team2_name)}</b>
                        </span>
                        <span class="h2h-tournament">${h2hEscape(h.tournament_name || '')}</span>
                        <time class="h2h-match-date">${formatDateTime(h.match_time)}</time>
                    </li>`;
                }).join('')
                : '<div class="h2h-empty">两队暂无交手记录</div>';
            bodyEl.innerHTML = `
                <div class="h2h-hero">
                    <a href="/teams.html?team=${m.team1_id}">${h2hLogo(m.team1_logo_url, m.team1_dark_logo_url)}<strong>${h2hEscape(m.team1_name)}</strong></a>
                    <div><span>HEAD TO HEAD</span><b>VS</b><small>${m.format} · ${formatDateTime(m.match_time)}</small></div>
                    <a href="/teams.html?team=${m.team2_id}">${h2hLogo(m.team2_logo_url, m.team2_dark_logo_url)}<strong>${h2hEscape(m.team2_name)}</strong></a>
                </div>
                <div class="h2h-grid">${formPanel(data.team1, 'team1')}${formPanel(data.team2, 'team2')}</div>
                <section class="h2h-panel h2h-h2h">
                    <header class="h2h-section-head"><div><span>DIRECT MEETINGS</span><h3>交手记录</h3></div><b>${data.head_to_head.length} 场</b></header>
                    <ol class="h2h-matches">${h2hList}</ol>
                </section>
            `;
            modalEl.hidden = false;
            document.body.classList.add('modal-open');
        } catch (error) {
            alert(error.message);
        }
    }

    window.showMatchHead2Head = showMatchHead2Head;
})();
