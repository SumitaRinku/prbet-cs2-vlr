require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { ensureDatabase } = require('./config/init-db');
const { startPandascoreSyncService } = require('./services/pandascoreService');
const { errorLogger } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');

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

// Request logging middleware (add early to track all requests)
app.use(requestLogger);

// CORS：配置了 ALLOWED_ORIGINS（逗号分隔）就只允许这些域名，否则全开（兼容旧行为）
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
// 本机地址：生产环境通过域名访问，本地调试则是 localhost/127.0.0.1。
// 浏览器对同源 POST 也会带 Origin 头，若不放行本地地址，登录、同步等写请求会被当成
// 跨域拒绝（旧代码抛普通 Error，最终被兜底成 500 Internal server error）。
const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
if (allowedOrigins.length) {
    app.use(cors({
        origin(origin, callback) {
            // 无 origin（同源请求、curl、服务端调用）放行
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            if (process.env.NODE_ENV !== 'production' && LOCAL_ORIGIN_REGEX.test(origin)) return callback(null, true);
            const error = new Error(`Origin ${origin} 不在 ALLOWED_ORIGINS 白名单内`);
            error.statusCode = 403;
            callback(error);
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
app.use('/api/bot', require('./routes/bot').createBotRouter(require('./config/database')));
app.use('/api/bot-account', require('./routes/botAccount').createBotAccountRouter(require('./config/database'), require('./middleware/auth').authenticateToken));

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
            // HTML 禁止缓存：部署后浏览器若命中 304 会继续复用旧缓存，
            // 一旦曾缓存到空白/半成品页面，页面会一直是纯背景且无报错。
            // 同时忽略条件请求，已缓存过坏页面的浏览器刷新时也能强制拿到新 HTML。
            res.set('Cache-Control', 'no-store');
            delete req.headers['if-none-match'];
            delete req.headers['if-modified-since'];
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

// Global error handler (must be last)
app.use(errorLogger);

app.listen(PORT, HOST, () => {
    console.log(`PRG CS2 Bet running at http://${HOST}:${PORT} (trust proxy: ${TRUST_PROXY})`);
    startPandascoreSyncService();
});

module.exports = app;
module.exports.ApiError = require('./middleware/errorHandler').ApiError;
