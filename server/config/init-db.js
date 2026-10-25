const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./database');
const { settleMatch, recalculateUserScores } = require('../utils/settlement');

function ensureDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
            token_version INTEGER NOT NULL DEFAULT 0,
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

        CREATE TABLE IF NOT EXISTS prediction_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prediction_id INTEGER,
            user_id INTEGER NOT NULL,
            match_id INTEGER NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('created', 'updated', 'deleted')),
            predicted_winner_id INTEGER NOT NULL,
            predicted_team1_score INTEGER NOT NULL,
            predicted_team2_score INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
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

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- 未来赛事预告：只存赛事（PandaScore serie）层级信息，不导入远期比赛。
        -- 与 tournaments 分开，避免远期赛事混入回看列表和积分统计。
        CREATE TABLE IF NOT EXISTS tournament_previews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL,
            external_source TEXT NOT NULL DEFAULT 'pandascore',
            external_id TEXT NOT NULL,
            name TEXT NOT NULL,
            begin_at TEXT,
            end_at TEXT,
            is_visible INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(external_source, external_id)
        );

        -- 赛事阶段（PandaScore tournament 层级）：赛程图分组与官方 bracket 的入口。
        -- external_id 即 PandaScore 的 tournament id；has_bracket 来自其 tournament 对象。
        CREATE TABLE IF NOT EXISTS tournament_stages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL,
            external_source TEXT NOT NULL DEFAULT 'pandascore',
            external_id TEXT NOT NULL,
            name TEXT,
            slug TEXT,
            has_bracket INTEGER NOT NULL DEFAULT 0,
            last_synced_at TEXT,
            bracket_synced_at TEXT,
            bracket_error TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(external_source, external_id),
            FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE
        );

        -- 官方 bracket 节点：保存 PandaScore /tournaments/{id}/brackets 返回的每一场比赛，
        -- 即使该比赛尚未进入近端比赛窗口（例如远期 TBD 场次）也能保留完整骨架。
        CREATE TABLE IF NOT EXISTS bracket_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stage_id INTEGER NOT NULL,
            external_match_id TEXT NOT NULL,
            panda_match_id TEXT,
            name TEXT,
            status TEXT,
            scheduled_at TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            team1_external_id TEXT,
            team1_name TEXT,
            team1_short_name TEXT,
            team1_logo_url TEXT,
            team1_dark_logo_url TEXT,
            team2_external_id TEXT,
            team2_name TEXT,
            team2_short_name TEXT,
            team2_logo_url TEXT,
            team2_dark_logo_url TEXT,
            last_synced_at TEXT,
            UNIQUE(stage_id, external_match_id),
            FOREIGN KEY (stage_id) REFERENCES tournament_stages(id) ON DELETE CASCADE
        );

        -- 官方 bracket 父子关系：source_type 表示本场参赛队来自上一场的胜者或败者。
        CREATE TABLE IF NOT EXISTS bracket_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stage_id INTEGER NOT NULL,
            match_external_id TEXT NOT NULL,
            source_external_match_id TEXT NOT NULL,
            source_type TEXT NOT NULL CHECK(source_type IN ('winner', 'loser')),
            UNIQUE(stage_id, match_external_id, source_external_match_id),
            FOREIGN KEY (stage_id) REFERENCES tournament_stages(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_tournaments_external ON tournaments(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_external ON teams(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_external ON matches(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_matches_time ON matches(match_time);
        CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
        CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_tournament_previews_time ON tournament_previews(game_type, begin_at);
        CREATE INDEX IF NOT EXISTS idx_tournament_stages_tournament ON tournament_stages(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_bracket_nodes_stage ON bracket_nodes(stage_id, position);
        CREATE INDEX IF NOT EXISTS idx_bracket_edges_stage ON bracket_edges(stage_id);
        CREATE INDEX IF NOT EXISTS idx_teams_game ON teams(game_type);
        CREATE INDEX IF NOT EXISTS idx_predictions_user ON predictions(user_id);
        CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions(match_id);
        CREATE INDEX IF NOT EXISTS idx_prediction_history_user ON prediction_history(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_prediction_history_match ON prediction_history(match_id, created_at);
    `);

    // bracket_nodes 在本轮新增时可能已被旧版本创建：幂等补齐队伍 logo 列。
    const bracketNodeColumns = db.prepare('PRAGMA table_info(bracket_nodes)').all().map(column => column.name);
    for (const column of ['team1_logo_url', 'team1_dark_logo_url', 'team2_logo_url', 'team2_dark_logo_url']) {
        if (!bracketNodeColumns.includes(column)) {
            db.exec(`ALTER TABLE bracket_nodes ADD COLUMN ${column} TEXT`);
        }
    }

    const teamColumns = db.prepare('PRAGMA table_info(teams)').all().map(column => column.name);
    if (!teamColumns.includes('game_type')) {
        db.exec("ALTER TABLE teams ADD COLUMN game_type TEXT NOT NULL DEFAULT 'cs2'");
    }

    const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
    if (!userColumns.includes('token_version')) {
        // 改密时递增，使所有旧登录令牌立即失效；存量令牌按版本 0 兼容。
        db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
    }
    if (!userColumns.includes('predictions_public')) {
        // 预测数据是否公开：排行榜默认只展示普通用户，管理员置 1 后可自愿上榜
        db.exec('ALTER TABLE users ADD COLUMN predictions_public INTEGER NOT NULL DEFAULT 0');
    }

    const tournamentColumns = db.prepare('PRAGMA table_info(tournaments)').all().map(column => column.name);
    if (!tournamentColumns.includes('is_active')) {
        db.exec('ALTER TABLE tournaments ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
    }
    if (!tournamentColumns.includes('name_locked')) {
        db.exec('ALTER TABLE tournaments ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0');
        db.prepare("UPDATE tournaments SET name_locked = 1 WHERE external_source = 'pandascore'").run();
    }
    if (!tournamentColumns.includes('logo_url')) {
        // 厂牌 logo（ESL/IEM/BLAST/PGL/VCT 等）：来自 PandaScore league.image_url，
        // 定时同步自动回填，用于前端赛事标识展示。
        db.exec('ALTER TABLE tournaments ADD COLUMN logo_url TEXT');
    }
    if (!tournamentColumns.includes('short_name')) {
        // 手动维护的赛事简称：同步不覆盖，移动端或名称过长时替代全名展示。
        db.exec('ALTER TABLE tournaments ADD COLUMN short_name TEXT');
    }
    if (!tournamentColumns.includes('tier')) {
        // 赛事级别（1=高级 2=普通 3=低级）：NULL 表示未手动设置，查询时按名称关键词自动推断
        // （CS2: Major→高级 / Qualifier→低级；Valorant: Masters/Champions→高级）。
        // 手动设置后 PandaScore 同步不覆盖（同步 UPDATE 字段清单不含 tier）。
        db.exec('ALTER TABLE tournaments ADD COLUMN tier INTEGER');
    }
    if (!teamColumns.includes('dark_logo_url')) {
        // 暗色主题专用队标：来自 PandaScore dark_mode_image_url（白色版），
        // 数据源确认无合适对比度时为 null，前端回退原 logo + 浅色底板。
        db.exec('ALTER TABLE teams ADD COLUMN dark_logo_url TEXT');
    }

    const previewColumns = db.prepare('PRAGMA table_info(tournament_previews)').all().map(column => column.name);
    if (!previewColumns.includes('is_visible')) {
        // 未来赛事预告前台可见性：管理员在后台逐项显示/隐藏，默认全部可见。
        // 预告同步使用 upsert，不会覆盖该字段，管理员的取舍可长期保留。
        db.exec('ALTER TABLE tournament_previews ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1');
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
    if (!matchColumns.includes('is_forfeit')) {
        // 弃权标记：PandaScore 对弃权局返回 canceled + winner_id，按 1-0 记录但不计入积分。
        db.exec('ALTER TABLE matches ADD COLUMN is_forfeit INTEGER NOT NULL DEFAULT 0');
    }
    if (!matchColumns.includes('result_locked')) {
        // 赛果锁定：管理员经 /result、/forfeit 人工录入赛果后置 1，PandaScore 同步不再
        // 覆盖比分/胜者/状态/弃权标记，防止同步窗口内的人工修正被外部数据回滚。
        // 存量回填：已有胜者的已结束比赛视为定局一并锁定（胜者缺失的留给同步补全）。
        db.exec('ALTER TABLE matches ADD COLUMN result_locked INTEGER NOT NULL DEFAULT 0');
        db.prepare("UPDATE matches SET result_locked = 1 WHERE status = 'finished' AND winner_team_id IS NOT NULL").run();
    }

    // 存量阶段回填：为已有比赛补齐 tournament_stages 记录，使新接口在首次同步前
    // 也能按阶段返回结构。has_bracket 先置 0，下一次比赛同步会从 PandaScore 补真实值。
    // 幂等：已存在的阶段（external_source + external_id）不覆盖同步后的元数据。
    db.prepare(`
        INSERT OR IGNORE INTO tournament_stages
            (tournament_id, external_source, external_id, name, slug, has_bracket, last_synced_at)
        SELECT m.tournament_id,
               COALESCE(m.external_source, 'pandascore'),
               m.stage_external_id,
               MAX(m.stage_name),
               MAX(m.stage_slug),
               0,
               MAX(m.last_synced_at)
        FROM matches m
        WHERE m.stage_external_id IS NOT NULL AND m.external_source = 'pandascore'
        GROUP BY m.tournament_id, m.external_source, m.stage_external_id
    `).run();

    require('./bot-schema').ensureBotSchema(db);

    const predictionColumns = db.prepare('PRAGMA table_info(predictions)').all().map(column => column.name);
    if (predictionColumns.includes('streak_bonus')) {
        // 连胜加成机制已整体移除：删掉遗留列并按基础分重建总分（幂等：列不存在则跳过）。
        db.exec('ALTER TABLE predictions DROP COLUMN streak_bonus');
        recalculateUserScores();
        console.log('[init-db] 已移除遗留 streak_bonus 列并按基础分重建总分');
    }

    // 历史弃权局回填：旧逻辑把 PandaScore 的 canceled+winner 弃权局只记成 cancelled、
    // 无比分且不结算，预测一直挂着。这些比赛早已超出同步回看窗口（仅回看 1 天），
    // 常规同步不会再触及，因此在这里一次性修正为「弃权 1-0、status=finished、不计分」。
    // 幂等：修正后 is_forfeit=1，不再命中 WHERE 条件，重复启动无副作用。
    const forfeitCandidates = db.prepare(`
        SELECT id FROM matches
        WHERE is_forfeit = 0 AND status = 'cancelled' AND winner_team_id IS NOT NULL
    `).all();
    if (forfeitCandidates.length) {
        const markForfeit = db.transaction(() => {
            const update = db.prepare(`
                UPDATE matches
                SET is_forfeit = 1, status = 'finished',
                    team1_score = CASE WHEN winner_team_id = team1_id THEN 1 ELSE 0 END,
                    team2_score = CASE WHEN winner_team_id = team2_id THEN 1 ELSE 0 END,
                    betting_enabled = 0
                WHERE id = ?
            `);
            for (const row of forfeitCandidates) {
                update.run(row.id);
                settleMatch(row.id); // calculatePoints 对 is_forfeit 返回 0，预测结算为 0 分
            }
            recalculateUserScores();
        });
        markForfeit();
        console.log(`[init-db] 回填 ${forfeitCandidates.length} 场弃权比赛为弃权 1-0（不计分）`);
    }

    // 历史主客对调修复：预测提交时接口强制校验「预测比分的隐含胜者 = predicted_winner_id」，
    // 因此隐含胜者与预测胜者不一致的存量预测，必然是提交后 team1/team2 顺序被对调所致
    //（同步覆写主客队）。对调回预测比分即可恢复语义；涉及比赛重新结算并重建总分。
    // 幂等：修复后隐含胜者与预测胜者一致，不再命中条件；预测胜者已不在对阵中的
    //（对手被更换）无法推断原顺序，保持原样不自动修。
    const flippedPredictions = db.prepare(`
        SELECT p.id, p.match_id
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        WHERE p.predicted_winner_id IN (m.team1_id, m.team2_id)
            AND (CASE WHEN p.predicted_team1_score > p.predicted_team2_score THEN m.team1_id ELSE m.team2_id END) != p.predicted_winner_id
    `).all();
    if (flippedPredictions.length) {
        const flipScores = db.prepare('UPDATE predictions SET predicted_team1_score = predicted_team2_score, predicted_team2_score = predicted_team1_score, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const repairFlipped = db.transaction(() => {
            const matchIds = new Set();
            for (const row of flippedPredictions) {
                flipScores.run(row.id);
                matchIds.add(row.match_id);
            }
            for (const matchId of matchIds) settleMatch(matchId);
            recalculateUserScores();
            return matchIds;
        });
        const matchIds = repairFlipped();
        console.log(`[init-db] 修复 ${flippedPredictions.length} 条因主客对调而错位的预测比分（涉及 ${matchIds.size} 场比赛，已重新结算）`);
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
