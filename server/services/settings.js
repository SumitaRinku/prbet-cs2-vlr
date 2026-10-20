const db = require('../config/database');

// 管理后台可调设置（app_settings 键值表）。读取时带默认值与环境变量兜底。
const PREVIEW_DAYS = { min: 7, max: 365, default: 180 };

function getSetting(key, fallback = null) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
}

function setSetting(key, value) {
    db.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, String(value));
}

// 赛事预告前瞻天数：管理后台设置 > 环境变量 > 默认 180 天。
function getPreviewDays() {
    const raw = getSetting('preview_days', process.env.PANDASCORE_PREVIEW_DAYS || PREVIEW_DAYS.default);
    const value = Number(raw);
    if (!Number.isFinite(value)) return PREVIEW_DAYS.default;
    return Math.min(Math.max(Math.floor(value), PREVIEW_DAYS.min), PREVIEW_DAYS.max);
}

module.exports = { PREVIEW_DAYS, getSetting, setSetting, getPreviewDays };
