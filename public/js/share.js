// 竞猜分享卡：1080x1080 正方形扁平风分享图（canvas 合成）。
// 跨平台一致：用 FontFace API 加载 MiSans woff2 子集（Regular + Bold，~6MB）。
//
// 设计原则：英雄式布局——对阵区占画面 37%，比分为最大文字(110px)，其余按权重递减。
// 垂直分区（各段高度按视觉重要性分配）：
//   0-75      头部（logo + PRBET + 分割线）
//   75-240    赛事信息（赛事名 44 / 副标题 32 / 时间 28）
//   240-650   英雄对阵区 410px（logo 140 + 比分 110 + 队名 48）
//   650-780   结果区 130px（实际比分 60 + 徽章 32）
//   780-870   预测人 90px（用户名 40 + 积分 32 + 连胜）
//   870-1080  底部 210px（二维码 160 + 引导文案）
(function () {
    const CARD_W = 1080;
    const CARD_H = 1080;
    const PAD = 60; // 两侧统一边距

    // 双色板：根据当前主题选择，确保浅色模式下所有元素颜色适配白底
    const C_DARK = {
        bg: '#0f1620',
        border: '#2a3a50',
        text: '#e2e8f0',
        textDim: '#7b8da4',
        textFaint: '#4a5b73',
        gold: '#f0b429',
        goldDark: '#2a2008',
        blue: '#3b82f6',
        green: '#34d399',
        red: '#f87171',
        amber: '#fbbf24',
        qrBg: '#f8fafc',
        accentBar: '#3b82f6'
    };

    const C_LIGHT = {
        bg: '#f7f9fb',
        border: '#c0cad6',
        text: '#1c2733',
        textDim: '#4a5b73',
        textFaint: '#7b8da4',
        gold: '#c79435',
        goldDark: '#ffffff',
        blue: '#2f6fa7',
        green: '#2f7d4f',
        red: '#c84f4f',
        amber: '#b45309',
        qrBg: '#1c2733',
        accentBar: '#2f6fa7'
    };

    let C = C_DARK;

    function detectTheme() {
        const theme = document.documentElement.getAttribute('data-theme');
        C = theme === 'light' ? C_LIGHT : C_DARK;
    }

    const FONT_FAMILY = 'MiSans, system-ui, sans-serif';

    let fontsReady = false;
    let currentMatch = null;

    // ---------- 字体加载 ----------

    // 将设计字重映射到实际加载的字重（500 或 700）
    // 原 Regular(400) 偏细，改用 Medium(500) 作为正文字重
    function mapWeight(w) { return w >= 600 ? 700 : 500; }

    async function loadFonts() {
        if (fontsReady) return;
        const faces = [
            { file: 'MiSans-Medium.woff2', weight: '500' },
            { file: 'MiSans-Bold.woff2', weight: '700' }
        ];
        await Promise.all(faces.map(async ({ file, weight }) => {
            try {
                const face = new FontFace('MiSans', `url(/fonts/${file})`, { weight });
                await face.load();
                document.fonts.add(face);
            } catch (e) { /* 回退 system-ui */ }
        }));
        fontsReady = true;
    }

    // ---------- 基础工具 ----------

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function loadImage(src) {
        return new Promise(resolve => {
            if (!src) return resolve(null);
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function font(weight, size) {
        return `${mapWeight(weight)} ${size}px ${FONT_FAMILY}`;
    }

    function text(ctx, str, x, y, weight, size, color, align = 'center') {
        ctx.font = font(weight, size);
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';
        ctx.fillText(String(str ?? ''), x, y);
    }

    function textEllipsis(ctx, str, x, y, weight, size, color, maxWidth, align = 'center') {
        ctx.font = font(weight, size);
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';
        let s = String(str ?? '');
        if (ctx.measureText(s).width <= maxWidth) { ctx.fillText(s, x, y); return; }
        while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
        ctx.fillText(s + '…', x, y);
    }

    function divider(ctx, y) {
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, y);
        ctx.lineTo(CARD_W - PAD, y);
        ctx.stroke();
    }

    // ---------- 头部 ----------

    function drawHeader(ctx, brandImg) {
        if (brandImg) {
            const h = 52;
            const w = brandImg.width * (h / brandImg.height);
            ctx.drawImage(brandImg, PAD, 18, w, h);
        }
        text(ctx, 'PRBET', CARD_W - PAD, 44, 600, 32, C.textDim, 'right');
        divider(ctx, 80);
    }

    // ---------- 赛事信息 ----------

    function drawTournamentInfo(ctx, match) {
        const cx = CARD_W / 2;
        // 赛事名（大字）
        textEllipsis(ctx, match.tournament_name || '', cx, 128, 700, 52, C.textDim, CARD_W - PAD * 2);
        // 比赛副标题
        if (match.name) {
            textEllipsis(ctx, match.name, cx, 182, 400, 38, C.textFaint, CARD_W - PAD * 2);
        }
        // 开赛时间
        const date = new Date(match.match_time);
        const padDate = n => String(n).padStart(2, '0');
        // 非当年日期补两位年份前缀（如 25-12-31 14:00），与站内 formatDateTime 口径一致
        const yearPrefix = date.getFullYear() === new Date().getFullYear() ? '' : `${String(date.getFullYear() % 100).padStart(2, '0')}-`;
        const dateText = `${yearPrefix}${padDate(date.getMonth() + 1)}-${padDate(date.getDate())} ${padDate(date.getHours())}:${padDate(date.getMinutes())}`;
        text(ctx, `${dateText} 开赛`, cx, match.name ? 228 : 206, 400, 34, C.textFaint);
        divider(ctx, 260);
    }

    // ---------- 英雄对阵区（画面核心） ----------

    function drawMatchup(ctx, match, logo1, logo2) {
        const p = match.user_prediction;
        const team1Pick = p?.predicted_winner_id === match.team1_id;
        const team2Pick = p?.predicted_winner_id === match.team2_id;

        const cy = 410;         // 队标与比分的中线
        const logoSize = 140;
        const logoX1 = CARD_W / 2 - 310;
        const logoX2 = CARD_W / 2 + 310;

        // 队标（无背景板，直接绘制）
        drawTeamLogo(ctx, logo1, logoX1, cy, logoSize);
        drawTeamLogo(ctx, logo2, logoX2, cy, logoSize);

        // 队名简称（队标正下方，大字）
        const name1 = match.team1_short_name || match.team1_name;
        const name2 = match.team2_short_name || match.team2_name;
        const nameY = cy + logoSize / 2 + 38;
        textEllipsis(ctx, name1, logoX1, nameY, 700, 48, team1Pick ? C.gold : C.text, 460);
        textEllipsis(ctx, name2, logoX2, nameY, 700, 48, team2Pick ? C.gold : C.text, 460);

        // 队名全称（简称下方，细体）
        if (match.team1_name && match.team1_name !== name1) {
            textEllipsis(ctx, match.team1_name, logoX1, nameY + 42, 400, 30, C.textFaint, 460);
        }
        if (match.team2_name && match.team2_name !== name2) {
            textEllipsis(ctx, match.team2_name, logoX2, nameY + 42, 400, 30, C.textFaint, 460);
        }

        // 中央比分（视觉锚点）
        if (p && p.predicted_team1_score !== null && p.predicted_team1_score !== undefined) {
            const cx = CARD_W / 2;
            text(ctx, p.predicted_team1_score, cx - 24, cy, 800, 88, team1Pick ? C.gold : C.text, 'right');
            text(ctx, ':', cx, cy, 600, 56, C.textFaint, 'center');
            text(ctx, p.predicted_team2_score, cx + 24, cy, 800, 88, team2Pick ? C.gold : C.text, 'left');
            text(ctx, '我的预测', cx, cy + 84, 500, 34, C.textFaint);
        }
        divider(ctx, 640);
    }

    function drawTeamLogo(ctx, logoImg, cx, cy, size) {
        if (logoImg) {
            const ratio = Math.min(size / logoImg.width, size / logoImg.height);
            const w = logoImg.width * ratio;
            const h = logoImg.height * ratio;
            ctx.drawImage(logoImg, cx - w / 2, cy - h / 2, w, h);
        } else {
            text(ctx, 'TBD', cx, cy, 600, 32, C.textFaint);
        }
    }

    // ---------- 结果区 ----------

    function drawResult(ctx, match) {
        const p = match.user_prediction;
        const settled = p.points_earned !== null && p.points_earned !== undefined;
        const forfeit = match.is_forfeit;

        let label, bg, border, fg;
        if (forfeit) {
            label = '弃权 · 不计分'; bg = 'rgba(251,191,36,0.15)'; border = 'rgba(251,191,36,0.4)'; fg = C.amber;
        } else if (!settled) {
            label = '待结算'; bg = 'rgba(59,130,246,0.15)'; border = 'rgba(59,130,246,0.4)'; fg = '#60a5fa';
        } else if (p.points_earned > 0) {
            label = `命中 +${p.points_earned}分`; bg = 'rgba(52,211,153,0.15)'; border = 'rgba(52,211,153,0.4)'; fg = C.green;
        } else {
            label = '未命中'; bg = 'rgba(248,113,113,0.15)'; border = 'rgba(248,113,113,0.4)'; fg = C.red;
        }

        const cy = 700;

        // 已结算：左侧实际比分
        if (settled && !forfeit) {
            const t1Win = match.team1_score > match.team2_score;
            const t2Win = match.team2_score > match.team1_score;
            text(ctx, '实际比分', PAD, cy - 34, 500, 24, C.textFaint, 'left');
            text(ctx, match.team1_score, PAD, cy + 16, 800, 60, t1Win ? C.gold : C.text, 'left');
            text(ctx, ':', PAD + 50, cy + 18, 600, 40, C.textFaint, 'left');
            text(ctx, match.team2_score, PAD + 88, cy + 16, 800, 60, t2Win ? C.gold : C.text, 'left');
            // 分隔线
            ctx.strokeStyle = C.border;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(CARD_W / 2 + 40, cy - 42);
            ctx.lineTo(CARD_W / 2 + 40, cy + 42);
            ctx.stroke();
        }

        // 结果徽章
        ctx.font = font(600, 32);
        const tw = ctx.measureText(label).width;
        const bw = tw + 52;
        const bh = 60;
        const bx = settled && !forfeit ? CARD_W - PAD - bw : CARD_W / 2 - bw / 2;
        const by = cy - bh / 2;
        roundRect(ctx, bx, by, bw, bh, 8);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.stroke();
        text(ctx, label, bx + bw / 2, by + bh / 2 + 1, 600, 32, fg);
    }

    // ---------- 预测人 ----------

    function drawUserLine(ctx, user) {
        const cy = 800;
        const name = user.username;
        const score = `${user.total_score || 0} 分`;
        ctx.font = font(700, 40);
        const nw = ctx.measureText(name).width;
        ctx.font = font(400, 32);
        const sw = ctx.measureText(score).width;

        const gap = 20;
        const total = nw + gap + sw;
        let x = CARD_W / 2 - total / 2;

        text(ctx, name, x, cy, 700, 40, C.text, 'left');
        text(ctx, score, x + nw + gap, cy, 400, 32, C.textDim, 'left');
    }

    // ---------- 底部：二维码 + 引导 ----------

    function drawQrPlaceholder(ctx, x, y, size) {
        ctx.fillStyle = C.qrBg;
        ctx.fillRect(x, y, size, size);
        ctx.fillStyle = C.border;
        ctx.fillRect(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7);
        // 占位文字颜色与 qrBg 反色
        const placeholderText = C === C_DARK ? C.text : '#f8fafc';
        text(ctx, 'PRBET', x + size / 2, y + size / 2, 600, 18, placeholderText);
    }

    function drawFooter(ctx, qrImg) {
        const qrSize = 150;
        // 底部区域 850~1080，y 轴居中 = 965
        const qy = 965 - qrSize / 2;  // = 890
        const qrCenterY = qy + qrSize / 2;  // = 965

        // 先测量文字宽度，计算整体居中起始 x
        ctx.font = font(700, 42);
        const w1 = ctx.measureText('扫码加入 PRBET').width;
        ctx.font = font(400, 32);
        const w2 = ctx.measureText('免费竞猜 CS2 · Valorant').width;
        const textGap = 30;
        const blockWidth = qrSize + textGap + Math.max(w1, w2);
        const startX = (CARD_W - blockWidth) / 2;

        const qx = startX;
        // 二维码底板：暗色模式画深色外框增强对比，浅色模式无需外框
        if (C === C_DARK) {
            ctx.fillStyle = C.qrBg;
            ctx.fillRect(qx - 8, qy - 8, qrSize + 16, qrSize + 16);
        }
        if (qrImg) {
            ctx.drawImage(qrImg, qx, qy, qrSize, qrSize);
        } else {
            drawQrPlaceholder(ctx, qx, qy, qrSize);
        }
        // 说明文字左对齐，垂直居中于二维码中轴
        const textX = qx + qrSize + textGap;
        text(ctx, '扫码加入 PRBET', textX, qrCenterY - 26, 700, 42, C.text, 'left');
        text(ctx, '免费竞猜 CS2 · Valorant', textX, qrCenterY + 28, 400, 32, C.textDim, 'left');
    }

    // ---------- 组装 ----------

    function proxiedLogo(url) {
        if (!url) return '';
        if (/^\/(?!\/)/.test(url) || url.startsWith('data:')) return url;
        return typeof window.proxiedLogoUrl === 'function' ? window.proxiedLogoUrl(url) : url;
    }

    async function renderShareCard(match, user) {
        await loadFonts();
        detectTheme();
        const canvas = document.createElement('canvas');
        canvas.width = CARD_W;
        canvas.height = CARD_H;
        const ctx = canvas.getContext('2d');

        // 浅色模式用原版彩色 logo，暗色模式优先用 dark 版
        const isDark = C === C_DARK;
        const [logo1, logo2, brand, qr] = await Promise.all([
            loadImage(proxiedLogo(isDark ? (match.team1_dark_logo_url || match.team1_logo_url) : match.team1_logo_url)),
            loadImage(proxiedLogo(isDark ? (match.team2_dark_logo_url || match.team2_logo_url) : match.team2_logo_url)),
            loadImage('/images/prbetlogo.png'),
            new URLSearchParams(location.search).has('sharetest') ? Promise.resolve(null) : loadImage(`/api/qrcode?text=${encodeURIComponent('https://prbet.gekichumai.cn')}&size=300`)
        ]);

        drawBackground(ctx);
        drawHeader(ctx, brand);
        drawTournamentInfo(ctx, match);
        drawMatchup(ctx, match, logo1, logo2);
        drawResult(ctx, match);
        drawUserLine(ctx, user);
        drawFooter(ctx, qr);
        return canvas.toDataURL('image/png');
    }

    function drawBackground(ctx) {
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, CARD_W, CARD_H);
        ctx.fillStyle = C.accentBar;
        ctx.fillRect(0, 0, CARD_W, 5);
    }

    // ---------- 弹窗 ----------

    function ensureModal() {
        let modal = document.getElementById('shareModal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'shareModal';
        modal.className = 'modal';
        modal.setAttribute('hidden', '');
        modal.innerHTML = `
            <div class="modal-backdrop" onclick="closeShareModal()"></div>
            <section class="modal-panel share-panel">
                <div class="modal-head">
                    <h2>分享我的竞猜</h2>
                    <button class="modal-close" type="button" onclick="closeShareModal()" aria-label="关闭">×</button>
                </div>
                <div class="share-body">
                    <div class="share-canvas-wrap"><img id="shareImage" alt="竞猜分享图"></div>
                    <div class="share-actions"><button type="button" class="button" id="shareDownload">保存图片</button></div>
                    <p class="share-hint">移动端可长按图片保存，或点击按钮下载后分享到社交平台</p>
                </div>
            </section>`;
        document.body.appendChild(modal);
        modal.querySelector('#shareDownload').addEventListener('click', () => {
            const img = modal.querySelector('#shareImage');
            if (!img.src) return;
            const a = document.createElement('a');
            a.href = img.src;
            a.download = `prbet-${currentMatch ? currentMatch.id : 'share'}.png`;
            a.click();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeShareModal();
        });
        return modal;
    }

    async function sharePrediction(matchId) {
        const finder = typeof window.getMatchForShare === 'function' ? window.getMatchForShare : null;
        const context = typeof window.getShareContext === 'function' ? window.getShareContext() : {};
        const match = finder ? finder(matchId) : null;
        if (!match || !match.user_prediction) return;
        const user = context.user;
        if (!user) return;
        const modal = ensureModal();
        const img = modal.querySelector('#shareImage');
        img.removeAttribute('src');
        modal.querySelector('.share-canvas-wrap').classList.add('loading');
        modal.removeAttribute('hidden');
        document.body.classList.add('modal-open');
        try {
            currentMatch = match;
            img.src = await renderShareCard(match, user);
        } catch (error) {
            alert('分享图生成失败：' + (error.message || '请稍后重试'));
            closeShareModal();
        } finally {
            modal.querySelector('.share-canvas-wrap').classList.remove('loading');
        }
    }

    function closeShareModal() {
        const modal = document.getElementById('shareModal');
        if (modal) modal.setAttribute('hidden', '');
        document.body.classList.remove('modal-open');
    }

    window.sharePrediction = sharePrediction;
    window.closeShareModal = closeShareModal;
})();
