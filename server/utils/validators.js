/**
 * Centralized validation rules
 * Single source of truth for all input validation
 */

const { validationError } = require('../middleware/errorHandler');

const validators = {
    // User validation
    username: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('Username is required', 'username');
        }
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(v)) {
            throw validationError('Username must be 3-20 alphanumeric characters or underscore', 'username');
        }
        return v.trim();
    },

    password: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('Password is required', 'password');
        }
        if (v.length < 6) {
            throw validationError('Password must be at least 6 characters', 'password');
        }
        return v;
    },

    role: (v) => {
        const role = v || 'user';
        if (!['user', 'admin'].includes(role)) {
            throw validationError('Role must be user or admin', 'role');
        }
        return role;
    },

    // Match validation
    format: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('Format is required', 'format');
        }
        if (!['BO1', 'BO3', 'BO5'].includes(v)) {
            throw validationError('Format must be BO1, BO3, or BO5', 'format');
        }
        return v;
    },

    score: (v, format) => {
        if (!Number.isInteger(v)) {
            throw validationError('Score must be an integer', 'score');
        }
        const maxScore = { BO1: 1, BO3: 2, BO5: 3 }[format] || 0;
        if (v < 0 || v > maxScore) {
            throw validationError(`Score must be 0-${maxScore}`, 'score');
        }
        return v;
    },

    // Prediction validation
    prediction: (obj, format) => {
        if (!obj || typeof obj !== 'object') {
            throw validationError('Prediction object required');
        }

        const { predicted_winner_id, predicted_team1_score, predicted_team2_score } = obj;

        if (!Number.isInteger(predicted_winner_id)) {
            throw validationError('Winner ID must be an integer', 'predicted_winner_id');
        }

        validators.score(predicted_team1_score, format);
        validators.score(predicted_team2_score, format);

        return obj;
    },

    // Integer validation
    integer: (v, fieldName = 'value') => {
        if (!Number.isInteger(Number(v))) {
            throw validationError(`${fieldName} must be an integer`, fieldName);
        }
        return Number(v);
    },

    // Positive integer validation
    positiveInteger: (v, fieldName = 'value') => {
        const num = validators.integer(v, fieldName);
        if (num <= 0) {
            throw validationError(`${fieldName} must be positive`, fieldName);
        }
        return num;
    },

    // Optional string with max length
    optionalString: (v, maxLen = 255, fieldName = 'value') => {
        if (v === undefined || v === null) return null;
        if (typeof v !== 'string') {
            throw validationError(`${fieldName} must be a string`, fieldName);
        }
        if (v.length > maxLen) {
            throw validationError(`${fieldName} must be at most ${maxLen} characters`, fieldName);
        }
        return v.trim();
    },

    // Email validation (simple)
    email: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('Email is required', 'email');
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(v)) {
            throw validationError('Invalid email format', 'email');
        }
        return v.toLowerCase().trim();
    },

    // Boolean validation
    boolean: (v) => {
        if (typeof v === 'boolean') return v;
        if (v === 'true') return true;
        if (v === 'false') return false;
        throw validationError('Value must be boolean', 'value');
    }
};

/**
 * Middleware factory for validating request body
 * Usage: router.post('/endpoint', validate({
 *     username: validators.username,
 *     password: validators.password,
 * }), (req, res, next) => {...})
 */
function validate(schema) {
    return (req, res, next) => {
        try {
            const validated = {};
            for (const [field, validator] of Object.entries(schema)) {
                const value = req.body[field];
                validated[field] = validator(value);
            }
            req.validated = validated;
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = { validators, validate };
