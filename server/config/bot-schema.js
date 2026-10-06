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
    db.exec(`
        CREATE TABLE IF NOT EXISTS bot_bind_codes (
            code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            qq_id TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bot_bindings (
            qq_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS bot_group_members (
            group_id TEXT NOT NULL, qq_id TEXT NOT NULL REFERENCES bot_bindings(qq_id) ON DELETE CASCADE,
            joined_at INTEGER NOT NULL, PRIMARY KEY(group_id, qq_id)
        );
        CREATE TABLE IF NOT EXISTS bot_command_receipts (
            request_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, qq_id TEXT NOT NULL,
            action TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bot_settlement_state (
            match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
            fingerprint TEXT NOT NULL, predictions TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bot_settlement_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL,
            payload TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bot_receipts_actor_time ON bot_command_receipts(qq_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_bot_receipts_time ON bot_command_receipts(created_at);
    `);
}

module.exports = { ensureBotSchema };
