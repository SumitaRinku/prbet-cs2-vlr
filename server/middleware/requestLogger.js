/**
 * Request logging middleware
 * Logs all requests with timing and response codes
 * Helps trace user behavior and identify performance issues
 */

function requestLogger(req, res, next) {
    const start = Date.now();
    const requestId = require('crypto').randomUUID().slice(0, 8).toUpperCase();

    // Attach request ID for error correlation
    req.requestId = requestId;

    // Track response completion
    res.on('finish', () => {
        const duration = Date.now() - start;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

        const log = `[${requestId}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;

        // Log slow requests or errors with more context
        if (level === 'error' || duration > 1000) {
            console[level](log, {
                userId: req.user?.id || null,
                ip: req.ip,
                userAgent: req.get('user-agent')?.slice(0, 60) || 'unknown'
            });
        } else {
            console[level](log);
        }
    });

    next();
}

module.exports = { requestLogger };
