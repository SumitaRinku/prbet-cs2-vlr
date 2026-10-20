const crypto = require('crypto');

/**
 * Custom API error class with status codes and context
 */
class ApiError extends Error {
    constructor(message, statusCode = 500, details = {}) {
        super(message);
        this.name = 'ApiError';
        this.statusCode = statusCode;
        this.details = details;
    }
}

/**
 * Generate unique error ID for correlation and debugging
 */
function generateErrorId() {
    return crypto.randomUUID().slice(0, 12).toUpperCase();
}

/**
 * Log error with full context for debugging
 */
function errorLogger(error, req, res, next) {
    const errorId = generateErrorId();
    const context = {
        errorId,
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        ip: req.ip,
        userId: req.user?.id || null,
        userAgent: req.get('user-agent')?.slice(0, 100) || 'unknown'
    };

    // Determine actual status code
    const statusCode = error.statusCode || (error.status ? parseInt(error.status) : 500);

    // Client errors (400-499): log as informational (user's fault)
    if (statusCode >= 400 && statusCode < 500) {
        console.info(`[${errorId}] ${statusCode} ${error.message}`, {
            ...context,
            errorType: 'ClientError'
        });

        return res.status(statusCode).json({
            error: error.message,
            errorId,
            statusCode
        });
    }

    // Server errors (500+): log with full stack trace
    console.error(`[${errorId}] ${statusCode} ${error.message}`, {
        ...context,
        errorType: 'ServerError',
        stack: error.stack,
        details: error.details || {}
    });

    res.status(statusCode).json({
        error: 'Internal server error',
        errorId,
        statusCode
    });
}

/**
 * Request validation error helper
 */
function validationError(message, field = null) {
    const error = new ApiError(message, 400);
    if (field) error.details = { field };
    return error;
}

/**
 * Database error handler
 */
function handleDatabaseError(error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return new ApiError('Resource already exists', 409);
    }
    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return new ApiError('Invalid foreign key reference', 400);
    }
    // Generic database error
    return new ApiError('Database operation failed', 500, { originalCode: error.code });
}

module.exports = {
    ApiError,
    errorLogger,
    generateErrorId,
    validationError,
    handleDatabaseError
};
