// 轻量内存滑动窗口限流，无第三方依赖。
// 适用于单进程部署（pm2 单实例）；多实例需换成共享存储（Redis 等）。

function createRateLimiter({ windowMs, max, message = '请求过于频繁，请稍后再试' }) {
    const hits = new Map(); // key -> { count, resetAt }

    // 周期清理过期条目，避免内存无限增长
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs);
    if (timer.unref) timer.unref();

    return function rateLimit(req, res, next) {
        const key = req.ip || req.socket?.remoteAddress || 'unknown';
        const now = Date.now();
        let entry = hits.get(key);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }

        entry.count += 1;
        if (entry.count > max) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ error: message });
        }
        next();
    };
}

module.exports = { createRateLimiter };
