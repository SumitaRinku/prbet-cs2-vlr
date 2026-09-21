// Independent, additive migration. Unknown historical source times stay unconfirmed.
function ensureBotSchema(db) {
    const columns = db.prepare('PRAGMA table_info(matches)').all();
    if (!columns.some(column => column.name === 'time_confirmed')) {
        db.exec('ALTER TABLE matches ADD COLUMN time_confirmed INTEGER NOT NULL DEFAULT 0');
        db.exec(`UPDATE matches SET time_confirmed = 1
            WHERE external_source IS NULL AND datetime(match_time) IS NOT NULL`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS bot_sync_state (
        game_type TEXT PRIMARY KEY,
        last_success_at TEXT NOT NULL
    )`);
}

module.exports = { ensureBotSchema };
