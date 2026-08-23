// 连胜机制前端：规则说明弹窗 + 徽标辅助渲染（主页与个人中心共用）
function streakBadgeHtml(streak) {
    return streak >= 2 ? `<b class="streak-badge" title="当前赛事连胜 ${streak} 轮">连胜 ${streak}</b>` : '';
}

function streakRulesModalHtml() {
    return `
        <div class="modal-head">
            <h2>连胜规则说明</h2>
            <button class="modal-close" type="button" onclick="closeStreakRules()" aria-label="关闭">×</button>
        </div>
        <div class="streak-rules-body">
            <h3>连胜范围</h3>
            <p>连胜在每个赛事内独立计算（赛事本身属于单一游戏，不会跨游戏、跨赛事累加）。在一个赛事里猜错后，其他赛事的连胜不受影响。</p>

            <h3>一轮的判定（同时开赛的处理）</h3>
            <p>同一开赛时间的多场比赛视为一轮：<strong>一轮内你的全部预测都正确，连胜 +1</strong>；只要有任意一场猜错，连胜清零。</p>
            <p>这样同时开赛的几场比赛会被合并判定，不会因为结算先后顺序而产生歧义。</p>

            <h3>特殊情形</h3>
            <p>· 一轮中还有未结算的比赛时，该轮暂不计入连胜，等全部结算后一起判定；</p>
            <p>· 弃权比赛不参与判定，既不清零也不累加连胜；</p>
            <p>· 没有预测的比赛不影响连胜。</p>

            <h3>连胜加成</h3>
            <p>连胜达到档位后，该轮内每场预测在基础得分之外额外加分：</p>
            <table>
                <tr><th>当前连胜</th><th>每场额外加分</th></tr>
                <tr><td>3 - 4 轮</td><td>+1 分</td></tr>
                <tr><td>5 - 7 轮</td><td>+2 分</td></tr>
                <tr><td>8 轮及以上</td><td>+3 分</td></tr>
            </table>
            <p>加成分数与基础得分分开记录，均计入总积分。</p>
        </div>
    `;
}

function showStreakRules() {
    let modal = document.getElementById('streakRulesModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'streakRulesModal';
        modal.className = 'modal';
        modal.setAttribute('hidden', '');
        modal.innerHTML = `<div class="modal-backdrop" onclick="closeStreakRules()"></div><section class="modal-panel">${streakRulesModalHtml()}</section>`;
        document.body.appendChild(modal);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeStreakRules();
        });
    }
    modal.removeAttribute('hidden');
}

function closeStreakRules() {
    const modal = document.getElementById('streakRulesModal');
    if (modal) modal.setAttribute('hidden', '');
}
