const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./database');

function ensureDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
            total_score INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tournaments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            game_type TEXT NOT NULL DEFAULT 'cs2',
            is_active INTEGER NOT NULL DEFAULT 1,
            name_locked INTEGER NOT NULL DEFAULT 0,
            begin_at TEXT,
            end_at TEXT,
            external_source TEXT,
            external_id TEXT,
            last_synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            game_type TEXT NOT NULL DEFAULT 'cs2',
            short_name TEXT,
            logo_url TEXT,
            country TEXT,
            external_source TEXT,
            external_id TEXT,
            last_synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL,
            team1_id INTEGER NOT NULL,
            team2_id INTEGER NOT NULL,
            name TEXT,
            format TEXT NOT NULL DEFAULT 'BO3' CHECK(format IN ('BO1', 'BO3', 'BO5')),
            match_time TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'ongoing', 'finished', 'cancelled', 'postponed')),
            raw_status TEXT,
            team1_score INTEGER,
            team2_score INTEGER,
            winner_team_id INTEGER,
            betting_enabled INTEGER NOT NULL DEFAULT 1,
            external_source TEXT,
            external_id TEXT,
            last_synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
            FOREIGN KEY (team1_id) REFERENCES teams(id) ON DELETE CASCADE,
            FOREIGN KEY (team2_id) REFERENCES teams(id) ON DELETE CASCADE,
            FOREIGN KEY (winner_team_id) REFERENCES teams(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            match_id INTEGER NOT NULL,
            predicted_winner_id INTEGER NOT NULL,
            predicted_team1_score INTEGER NOT NULL,
            predicted_team2_score INTEGER NOT NULL,
            points_earned INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
            FOREIGN KEY (predicted_winner_id) REFERENCES teams(id) ON DELETE CASCADE,
            UNIQUE(user_id, match_id)
        );

        CREATE TABLE IF NOT EXISTS sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            mode TEXT,
            status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed', 'skipped')),
            message TEXT,
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at TEXT,
            tournaments_upserted INTEGER NOT NULL DEFAULT 0,
            teams_upserted INTEGER NOT NULL DEFAULT 0,
            matches_upserted INTEGER NOT NULL DEFAULT 0,
            matches_finished INTEGER NOT NULL DEFAULT 0
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_tournaments_external ON tournaments(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_external ON teams(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_external ON matches(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_matches_time ON matches(match_time);
        CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
        CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_teams_game ON teams(game_type);
        CREATE INDEX IF NOT EXISTS idx_predictions_user ON predictions(user_id);
        CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions(match_id);
    `);

    const teamColumns = db.prepare('PRAGMA table_info(teams)').all().map(column => column.name);
    if (!teamColumns.includes('game_type')) {
        db.exec("ALTER TABLE teams ADD COLUMN game_type TEXT NOT NULL DEFAULT 'cs2'");
    }

    const tournamentColumns = db.prepare('PRAGMA table_info(tournaments)').all().map(column => column.name);
    if (!tournamentColumns.includes('is_active')) {
        db.exec('ALTER TABLE tournaments ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
    }
    if (!tournamentColumns.includes('name_locked')) {
        db.exec('ALTER TABLE tournaments ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0');
        db.prepare("UPDATE tournaments SET name_locked = 1 WHERE external_source = 'pandascore'").run();
    }


    const matchColumns = db.prepare('PRAGMA table_info(matches)').all().map(column => column.name);
    if (!matchColumns.includes('stage_name')) {
        db.exec('ALTER TABLE matches ADD COLUMN stage_name TEXT');
    }
    if (!matchColumns.includes('stage_slug')) {
        db.exec('ALTER TABLE matches ADD COLUMN stage_slug TEXT');
    }
    if (!matchColumns.includes('stage_external_id')) {
        db.exec('ALTER TABLE matches ADD COLUMN stage_external_id TEXT');
    }
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
    if (!admin) {
        const envPassword = process.env.ADMIN_PASSWORD;
        const password = envPassword || crypto.randomBytes(12).toString('base64url');
        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
            .run(adminUsername, bcrypt.hashSync(password, 12), 'admin');
        if (envPassword) {
            console.log(`Created default admin "${adminUsername}" using ADMIN_PASSWORD from environment`);
        } else {
            console.log(`Created default admin "${adminUsername}" with generated password: ${password}`);
            console.log('请立即登录并修改密码；该密码仅此处显示一次。');
        }
    }
}

module.exports = { ensureDatabase };

if (require.main === module) {
    ensureDatabase();
    console.log('Database ready');
}

