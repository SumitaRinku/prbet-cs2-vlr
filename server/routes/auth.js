const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { signToken, authenticateToken } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;

// 登录/注册限流：每 IP 15 分钟内最多 20 次，挡暴力破解和批量注册
const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: '尝试次数过多，请 15 分钟后再试' });

router.post('/register', authLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!usernameRegex.test(username || '')) return res.status(400).json({ error: '用户名需为3-20位数字、字母或下划线' });
    if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    try {
        const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, bcrypt.hashSync(password, 10));
        const user = { id: result.lastInsertRowid, username, role: 'user', total_score: 0 };
        res.status(201).json({ user, token: signToken(user) });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: '用户名已存在' });
        res.status(500).json({ error: '注册失败' });
    }
});

router.post('/login', authLimiter, (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT id, username, password_hash, role, total_score FROM users WHERE username = ?').get(username || '');
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: '用户名或密码错误' });

    const safeUser = { id: user.id, username: user.username, role: user.role, total_score: user.total_score };
    res.json({ user: safeUser, token: signToken(safeUser) });
});

router.get('/me', authenticateToken, (req, res) => {
    const user = db.prepare('SELECT id, username, role, total_score, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json({ user });
});

// 自助修改密码：需验证原密码。走 authLimiter，防止拿到 token 后暴力试原密码。
router.put('/password', authLimiter, authenticateToken, (req, res) => {
    const { old_password, new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: '新密码至少6位' });
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (!bcrypt.compareSync(old_password || '', user.password_hash)) return res.status(400).json({ error: '原密码错误' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
    res.json({ message: '密码已修改' });
});

module.exports = router;
