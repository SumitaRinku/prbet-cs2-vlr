const express = require('express');
const { issueCode } = require('../services/botCommands');
const { createRateLimiter } = require('../middleware/rateLimit');

function createBotAccountRouter(db, authenticate) {
    const router = express.Router();
    router.use(authenticate);
    router.use(createRateLimiter({ windowMs: 60000, max: 10 }));
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.get('/', (req, res) => {
        const binding = db.prepare('SELECT qq_id FROM bot_bindings WHERE user_id=?').get(req.user.id);
        const groups = binding ? db.prepare('SELECT group_id FROM bot_group_members WHERE qq_id=?').all(binding.qq_id) : [];
        res.json({ binding: binding || null, groups });
    });
    router.post('/code', (req, res, next) => {
        try { res.json(issueCode(db, req.user.id, req.body.qq_id)); }
        catch (error) { if (error.expected) res.status(400).json({ error: error.message }); else next(error); }
    });
    router.delete('/', (req, res) => {
        db.transaction(() => {
            db.prepare('DELETE FROM bot_bind_codes WHERE user_id=?').run(req.user.id);
            db.prepare('DELETE FROM bot_bindings WHERE user_id=?').run(req.user.id);
        })();
        res.json({ message: '已解除绑定并撤销待使用的绑定码' });
    });
    return router;
}
module.exports = { createBotAccountRouter };
