const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 优先用环境变量里的固定密钥；没配就用磁盘上持久化的随机密钥。
// 密钥只生成一次并存到 data/.jwt_secret，之后每次启动都复用，
// 既保证没人能伪造 admin token，又不会因重启/更新让用户掉线。
const SECRET_FILE = path.join(__dirname, '../../data/.jwt_secret');

function loadOrCreatePersistedSecret() {
    try {
        const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
        if (existing.length >= 32) return existing;
    } catch (error) {
        // 文件不存在或读取失败，下面生成新的
    }
    const secret = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
        fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    } catch (error) {
        console.warn('无法持久化 JWT 密钥，将使用本进程临时密钥（重启会导致重新登录）:', error.message);
    }
    return secret;
}

const FALLBACK_SECRET = loadOrCreatePersistedSecret();

function getJwtSecret() {
    return process.env.JWT_SECRET || FALLBACK_SECRET;
}

function signToken(user) {
    return jwt.sign({ id: user.id, username: user.username, role: user.role }, getJwtSecret(), { expiresIn: '30d', algorithm: 'HS256' });
}

function authenticateToken(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: '请先登录' });
    }

    try {
        req.user = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
        next();
    } catch (error) {
        res.status(401).json({ error: '登录已过期，请重新登录' });
    }
}

function optionalAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
        return next();
    }

    try {
        req.user = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    } catch (error) {
        req.user = null;
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
}

module.exports = { signToken, authenticateToken, optionalAuth, requireAdmin };
