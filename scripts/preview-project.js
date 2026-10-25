const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const db = new Database(path.join(root, 'data/database.sqlite'), { readonly: true, fileMustExist: true });
const databaseModule = require.resolve(path.join(root, 'server/config/database.js'));
require.cache[databaseModule] = { id: databaseModule, filename: databaseModule, loaded: true, exports: db };
const app = express();
// Read-only local preview: no initialization, sync jobs, logins or writes.
app.disable('x-powered-by');
app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
    next();
});
app.use('/api/matches', require(path.join(root, 'server/routes/matches.js')));
app.use('/api/leaderboard', require(path.join(root, 'server/routes/leaderboard.js')));
app.use('/api/tournaments', require(path.join(root, 'server/routes/tournaments.js')));
app.get('/api/images/team-logo', (req, res) => {
    const hash = crypto.createHash('sha1').update(String(req.query.url || '')).digest('hex');
    const file = path.join(root, 'data/logo-cache', hash);
    try {
        const mime = JSON.parse(fs.readFileSync(file + '.meta', 'utf8')).contentType;
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        res.type(mime).send(fs.readFileSync(file));
    } catch { res.sendStatus(404); }
});
app.use('/uploads', express.static(path.join(root, 'data/uploads')));
app.use(express.static(path.join(root, 'public')));
app.use((error, req, res, next) => { console.error(error.message); res.status(500).json({ error: error.message }); });
app.listen(4319, '127.0.0.1', () => console.log('Read-only project preview: http://127.0.0.1:4319/'));
