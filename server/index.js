require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { ensureDatabase } = require('./config/init-db');
const { startPandascoreSyncService } = require('./services/pandascoreService');

ensureDatabase();

const app = express();
const PORT = process.env.PORT || 3000;
// 默认只监听回环地址：生产环境由 Nginx 反代到 127.0.0.1:3000，
// 不允许公网直连 Node（直连可伪造 X-Forwarded-For 绕过限流）。
// 确需直接对外时显式设 HOST=0.0.0.0，并同时设 TRUST_PROXY=0。
const HOST = process.env.HOST || '127.0.0.1';

// 信任的反向代理层数：默认 1（单层 Nginx）。TRUST_PROXY=0 表示不信任任何代理头，
// req.ip 取 TCP 对端地址；多层代理（如前面还有 CDN）按实际层数调大。
const TRUST_PROXY = Number.isInteger(Number(process.env.TRUST_PROXY)) ? Number(process.env.TRUST_PROXY) : 1;
app.set('trust proxy', TRUST_PROXY);

// CORS：配置了 ALLOWED_ORIGINS（逗号分隔）就只允许这些域名，否则全开（兼容旧行为）
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowedOrigins.length) {
    app.use(cors({
        origin(origin, callback) {
            // 无 origin（同源请求、curl、服务端调用）放行
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            callback(new Error('Not allowed by CORS'));
        }
    }));
} else {
    app.use(cors());
}
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/matches', require('./routes/matches'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/predictions', require('./routes/predictions'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/images', require('./routes/images'));
app.use('/api/qrcode', require('./routes/qrcode'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ICP 备案号：服务端把备案号注入 HTML footer。备案号来自 .env（已 gitignore），
// 仓库中只保留 {{BEIAN}} 占位符，真实值不会进入 git 历史。
const publicDir = path.join(__dirname, '../public');
const escapeHtmlAttr = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function beianHtml() {
    const number = process.env.ICP_NUMBER;
    if (!number) return ''; // 未配置时不输出，避免把占位符暴露给用户
    const link = process.env.ICP_LINK || 'https://beian.miit.gov.cn/';
    return `<a href="${escapeHtmlAttr(link)}" target="_blank" rel="noopener">${escapeHtmlAttr(number)}</a>`;
}

function serveHtml(file) {
    return (req, res) => {
        try {
            const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
            res.send(html.replace('{{BEIAN}}', beianHtml()));
        } catch (error) {
            res.status(404).end();
        }
    };
}

// 显式 HTML 路由放在 express.static 之前，保证注入后的页面优先生效；
// express.static 之后只负责 /js /css /images 等静态资源。
app.get('/', serveHtml('index.html'));
app.get('/tournaments.html', serveHtml('tournaments.html'));
app.get('/leaderboard.html', serveHtml('leaderboard.html'));
app.get('/profile.html', serveHtml('profile.html'));
app.get('/teams.html', serveHtml('teams.html'));
app.get('/admin', serveHtml('admin/index.html'));
app.get('/admin/', serveHtml('admin/index.html'));
app.use(express.static(publicDir));
// 管理员手动上传的赛事 logo（data/uploads，运行时数据，不随代码部署覆盖）
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads'), { maxAge: '7d', fallthrough: true }));
app.get('*', serveHtml('index.html'));

app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
    console.log(`PRG CS2 Bet running at http://${HOST}:${PORT} (trust proxy: ${TRUST_PROXY})`);
    startPandascoreSyncService();
});

module.exports = app;
