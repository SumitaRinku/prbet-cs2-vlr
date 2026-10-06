(() => {
    const feedback = document.getElementById('botBindingFeedback');
    document.getElementById('botBindingForm').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const qq = document.getElementById('botBindingQQ').value.trim();
            const result = await sharedApi('/bot-account/code', { method: 'POST', body: { qq_id: qq } });
            feedback.textContent = `请用 QQ ${qq} 在启用功能的群内发送：/prbet 绑定 ${result.code}（10 分钟有效，仅限此 QQ 使用）`;
        } catch (error) { feedback.textContent = error.message; }
    });
    document.getElementById('botUnbind').addEventListener('click', async () => {
        try {
            const result = await sharedApi('/bot-account', { method: 'DELETE' });
            feedback.textContent = result.message;
        } catch (error) { feedback.textContent = error.message; }
    });
    function refresh() {
        if (!sharedState.token) { feedback.textContent = ''; return; }
        sharedApi('/bot-account').then(result => {
            feedback.textContent = result.binding ? `已绑定 QQ ${result.binding.qq_id}；已加入 ${result.groups.length} 个群的竞猜展示。` : '尚未绑定 QQ';
        }).catch(() => {});
    }
    window.addEventListener('auth-changed', refresh);
    refresh();
})();
