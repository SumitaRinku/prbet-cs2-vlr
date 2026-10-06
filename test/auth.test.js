const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const secret = 'isolated-auth-test-secret-with-enough-length';
const password = 'original-password';

function fixture({ legacySchema = false } = {}) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    if (legacySchema) {
        db.exec(`CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
            total_score INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)')
            .run('admin', bcrypt.hashSync(password, 4), 'admin');
    }
    const modules = new Map();
    function load(relative) {
        const filename = path.resolve(__dirname, '..', relative);
        if (modules.has(filename)) return modules.get(filename).exports;
        const module = { exports: {} }, nativeRequire = createRequire(filename);
        modules.set(filename, module);
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            module, __dirname: path.dirname(filename), Buffer, URL, AbortController,
            setTimeout, clearTimeout, setInterval, clearInterval,
            console: { log() {}, warn() {}, error() {} },
            process: { env: { ADMIN_PASSWORD: password, JWT_SECRET: secret } },
            require(name) {
                if (['./database', '../config/database'].includes(name)) return db;
                // Keep tests isolated from the real database and persisted JWT secret.
                if (name === 'fs' && filename.endsWith(`${path.sep}middleware${path.sep}auth.js`)) {
                    return { readFileSync: () => secret };
                }
                if (name.startsWith('.')) return load(nativeRequire.resolve(name));
                return nativeRequire(name);
            }
        }, { filename });
        return module.exports;
    }
    const init = load('server/config/init-db.js');
    init.ensureDatabase();
    db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)')
        .run(2, 'second_admin', bcrypt.hashSync(password, 4), 'admin');
    db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)')
        .run(3, 'alice', bcrypt.hashSync(password, 4), 'user');
    const auth = load('server/middleware/auth.js');
    const token = id => auth.signToken({ id });
    const legacyToken = id => {
        const user = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(id);
        return jwt.sign(user, secret, { algorithm: 'HS256', expiresIn: '30d' });
    };
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('server/routes/auth.js'));
    app.use('/api/admin', load('server/routes/admin.js'));
    app.get('/optional', auth.optionalAuth, (req, res) => res.json({ user: req.user || null }));
    app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
    return { db, init, token, legacyToken, app };
}

async function withServer(context, run) {
    const server = context.app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, { token, method = 'GET', body } = {}) => {
        const response = await fetch(`${base}${route}`, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, body: await response.json() };
    };
    try { await run(request); }
    finally { await new Promise(resolve => server.close(resolve)); context.db.close(); }
}

test('admin demotion and deletion take effect on existing tokens immediately', async () => {
    const context = fixture();
    await withServer(context, async request => {
        const root = context.token(1), old = context.token(2);
        assert.equal((await request('/api/admin/users', { token: old })).status, 200);
        assert.equal((await request('/api/admin/users/2/role', { token: root, method: 'PUT', body: { role: 'user' } })).status, 200);
        assert.equal((await request('/api/admin/users', { token: old })).status, 403);
        const me = await request('/api/auth/me', { token: old });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.role, 'user');
        assert.equal((await request('/api/admin/users/2', { token: root, method: 'DELETE' })).status, 200);
        assert.equal((await request('/api/admin/users', { token: old })).status, 401);
        assert.equal((await request('/api/auth/me', { token: old })).status, 401);
        assert.equal((await request('/optional', { token: old })).body.user, null);
    });
});

test('password change revokes all prior sessions and renews the current session', async () => {
    const context = fixture();
    await withServer(context, async request => {
        const login = await request('/api/auth/login', { method: 'POST', body: { username: 'alice', password } });
        const old = login.body.token, legacy = context.legacyToken(3);
        const failed = await request('/api/auth/password', { token: old, method: 'PUT', body: { old_password: 'wrong', new_password: 'replacement-password' } });
        assert.equal(failed.status, 400);
        assert.equal((await request('/api/auth/me', { token: old })).status, 200);
        const changed = await request('/api/auth/password', { token: old, method: 'PUT', body: { old_password: password, new_password: 'replacement-password' } });
        assert.equal(changed.status, 200);
        assert.equal(jwt.verify(changed.body.token, secret).token_version, 1);
        assert.equal((await request('/api/auth/me', { token: old })).status, 401);
        assert.equal((await request('/api/auth/me', { token: legacy })).status, 401);
        assert.equal((await request('/optional', { token: old })).body.user, null);
        assert.equal((await request('/api/auth/me', { token: changed.body.token })).status, 200);
        assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'alice', password } })).status, 401);
        const newLogin = await request('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'replacement-password' } });
        assert.equal(newLogin.status, 200);
        assert.equal((await request('/api/auth/me', { token: newLogin.body.token })).status, 200);
    });
});

test('admin password reset revokes modern and legacy admin sessions', async () => {
    const context = fixture();
    await withServer(context, async request => {
        const root = context.token(1), old = context.token(2), legacy = context.legacyToken(2);
        const result = await request('/api/admin/users/2/password', { token: root, method: 'PUT', body: { password: 'reset-password' } });
        assert.equal(result.status, 200);
        assert.equal((await request('/api/admin/users', { token: old })).status, 401);
        assert.equal((await request('/api/admin/users', { token: legacy })).status, 401);
        const login = await request('/api/auth/login', { method: 'POST', body: { username: 'second_admin', password: 'reset-password' } });
        assert.equal(login.status, 200);
        assert.equal((await request('/api/admin/users', { token: login.body.token })).status, 200);
    });
});

test('legacy users migrate without logout and repeated migrations preserve revocation', async () => {
    const context = fixture({ legacySchema: true });
    await withServer(context, async request => {
        assert.equal(context.db.prepare('SELECT token_version FROM users WHERE id=1').get().token_version, 0);
        const legacy = context.legacyToken(1);
        assert.equal((await request('/api/admin/users', { token: legacy })).status, 200);
        context.db.prepare('UPDATE users SET token_version=1 WHERE id=1').run();
        context.init.ensureDatabase();
        assert.equal(context.db.prepare('SELECT token_version FROM users WHERE id=1').get().token_version, 1);
        assert.equal((await request('/api/admin/users', { token: legacy })).status, 401);
    });
});

test('registration tokens work and invalid, expired, or mismatched tokens are rejected', async () => {
    const context = fixture();
    await withServer(context, async request => {
        const result = await request('/api/auth/register', { method: 'POST', body: { username: 'new_user', password } });
        assert.equal(result.status, 201);
        assert.equal((await request('/api/auth/me', { token: result.body.token })).status, 200);
        assert.equal((await request('/api/auth/me')).status, 401);
        const invalid = [
            'bad-token',
            jwt.sign({ id: 3 }, 'wrong-secret'),
            jwt.sign({ id: 3 }, secret, { expiresIn: -1 }),
            jwt.sign({ id: 3, token_version: 999 }, secret),
            jwt.sign({ id: 3, token_version: null }, secret),
            jwt.sign({ id: '3' }, secret)
        ];
        for (const token of invalid) {
            assert.equal((await request('/api/auth/me', { token })).status, 401);
            assert.equal((await request('/optional', { token })).body.user, null);
        }
    });
});
