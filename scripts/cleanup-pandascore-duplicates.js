const fs = require('fs');
const path = require('path');
const db = require('../server/config/database');
const { calculatePoints } = require('../server/utils/scoring');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const noBackup = args.has('--no-backup');
const SOURCE = 'pandascore';
const GAME_TYPE = 'cs2';

function tableExists(name) {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function backupDatabase() {
    const dbPath = path.join(__dirname, '../data/database.sqlite');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, `../data/database.sqlite.backup-${stamp}`);
    fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
    return backupPath;
}

function recalculatePredictionsAndScores() {
    const predictions = db.prepare(`
        SELECT p.*, m.status, m.format, m.team1_id, m.team2_id, m.team1_score, m.team2_score
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
    `).all();

    const updatePrediction = db.prepare('UPDATE predictions SET points_earned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const prediction of predictions) {
        updatePrediction.run(calculatePoints(prediction, prediction), prediction.id);
    }

    db.prepare("UPDATE users SET total_score = 0 WHERE role = 'user'").run();
    const scores = db.prepare(`
        SELECT user_id, SUM(COALESCE(points_earned, 0)) total
        FROM predictions
        GROUP BY user_id
    `).all();
    const updateUser = db.prepare('UPDATE users SET total_score = ? WHERE id = ?');
    for (const row of scores) updateUser.run(row.total || 0, row.user_id);
}

function getDuplicatePairs() {
    return db.prepare(`
        SELECT old.id old_id, newer.id new_id
        FROM matches old
        JOIN matches newer
            ON newer.external_source = old.external_source
            AND newer.external_id = ? || ':' || old.external_id
        JOIN tournaments old_tournament ON old_tournament.id = old.tournament_id
        JOIN tournaments new_tournament ON new_tournament.id = newer.tournament_id
        WHERE old.external_source = ?
            AND old.external_id NOT LIKE '%:%'
            AND old_tournament.game_type = ?
            AND new_tournament.game_type = ?
        ORDER BY old.id
    `).all(GAME_TYPE, SOURCE, GAME_TYPE, GAME_TYPE);
}

function getDuplicateTournaments() {
    return db.prepare(`
        SELECT old.id old_id, newer.id new_id
        FROM tournaments old
        JOIN tournaments newer
            ON newer.external_source = old.external_source
            AND newer.external_id = ? || ':' || old.external_id
        WHERE old.external_source = ?
            AND old.external_id NOT LIKE '%:%'
            AND old.game_type = ?
            AND newer.game_type = ?
        ORDER BY old.id
    `).all(GAME_TYPE, SOURCE, GAME_TYPE, GAME_TYPE);
}

function summarize() {
    const pairs = getDuplicatePairs();
    const tournaments = getDuplicateTournaments();
    const oldMatchIds = pairs.map(pair => pair.old_id);
    const oldTournamentIds = tournaments.map(pair => pair.old_id);
    const oldTeams = db.prepare(`
        SELECT COUNT(*) count
        FROM teams team
        WHERE team.external_source = ?
            AND team.external_id NOT LIKE '%:%'
            AND team.game_type = ?
            AND NOT EXISTS (SELECT 1 FROM matches WHERE team1_id = team.id OR team2_id = team.id)
            AND NOT EXISTS (SELECT 1 FROM predictions WHERE predicted_winner_id = team.id)
    `).get(SOURCE, GAME_TYPE).count;

    const predictionStats = oldMatchIds.length
        ? db.prepare(`
            SELECT COUNT(*) total,
                SUM(CASE WHEN points_earned IS NOT NULL THEN 1 ELSE 0 END) settled
            FROM predictions
            WHERE match_id IN (${oldMatchIds.map(() => '?').join(',')})
        `).get(...oldMatchIds)
        : { total: 0, settled: 0 };

    return {
        duplicate_matches: pairs.length,
        duplicate_tournaments: tournaments.length,
        predictions_to_migrate: predictionStats.total || 0,
        settled_predictions_to_migrate: predictionStats.settled || 0,
        unreferenced_legacy_teams: oldTeams || 0,
        old_match_ids: oldMatchIds,
        old_tournament_ids: oldTournamentIds
    };
}

function migratePrediction(prediction, oldMatch, newMatch) {
    let predictedWinnerId = prediction.predicted_winner_id;
    if (prediction.predicted_winner_id === oldMatch.team1_id) predictedWinnerId = newMatch.team1_id;
    if (prediction.predicted_winner_id === oldMatch.team2_id) predictedWinnerId = newMatch.team2_id;

    const existing = db.prepare('SELECT id FROM predictions WHERE user_id = ? AND match_id = ?')
        .get(prediction.user_id, newMatch.id);

    if (existing) {
        db.prepare(`
            UPDATE predictions
            SET predicted_winner_id = ?, predicted_team1_score = ?, predicted_team2_score = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(predictedWinnerId, prediction.predicted_team1_score, prediction.predicted_team2_score, existing.id);
        db.prepare('DELETE FROM predictions WHERE id = ?').run(prediction.id);
        return { migrated: 0, merged: 1 };
    }

    db.prepare(`
        UPDATE predictions
        SET match_id = ?, predicted_winner_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(newMatch.id, predictedWinnerId, prediction.id);
    return { migrated: 1, merged: 0 };
}

function cleanup() {
    const summary = summarize();
    if (!summary.duplicate_matches && !summary.duplicate_tournaments) {
        return { ...summary, migrated_predictions: 0, merged_predictions: 0, deleted_matches: 0, deleted_tournaments: 0 };
    }

    const result = db.transaction(() => {
        let migratedPredictions = 0;
        let mergedPredictions = 0;
        let deletedMatches = 0;
        let deletedTournaments = 0;
        let deletedTeams = 0;

        for (const pair of getDuplicatePairs()) {
            const oldMatch = db.prepare('SELECT * FROM matches WHERE id = ?').get(pair.old_id);
            const newMatch = db.prepare('SELECT * FROM matches WHERE id = ?').get(pair.new_id);
            if (!oldMatch || !newMatch) continue;

            const predictions = db.prepare('SELECT * FROM predictions WHERE match_id = ?').all(oldMatch.id);
            for (const prediction of predictions) {
                const moved = migratePrediction(prediction, oldMatch, newMatch);
                migratedPredictions += moved.migrated;
                mergedPredictions += moved.merged;
            }

            deletedMatches += db.prepare('DELETE FROM matches WHERE id = ?').run(oldMatch.id).changes;
        }

        for (const pair of getDuplicateTournaments()) {
            const remainingMatches = db.prepare('SELECT COUNT(*) count FROM matches WHERE tournament_id = ?').get(pair.old_id).count;
            if (remainingMatches === 0) {
                deletedTournaments += db.prepare('DELETE FROM tournaments WHERE id = ?').run(pair.old_id).changes;
            }
        }

        deletedTeams += db.prepare(`
            DELETE FROM teams
            WHERE external_source = ?
                AND external_id NOT LIKE '%:%'
                AND game_type = ?
                AND NOT EXISTS (SELECT 1 FROM matches WHERE team1_id = teams.id OR team2_id = teams.id)
                AND NOT EXISTS (SELECT 1 FROM predictions WHERE predicted_winner_id = teams.id)
        `).run(SOURCE, GAME_TYPE).changes;

        recalculatePredictionsAndScores();
        return { migratedPredictions, mergedPredictions, deletedMatches, deletedTournaments, deletedTeams };
    })();

    return {
        ...summary,
        migrated_predictions: result.migratedPredictions,
        merged_predictions: result.mergedPredictions,
        deleted_matches: result.deletedMatches,
        deleted_tournaments: result.deletedTournaments,
        deleted_teams: result.deletedTeams
    };
}

if (!tableExists('matches') || !tableExists('tournaments') || !tableExists('predictions')) {
    console.error('Database schema is incomplete. Expected matches, tournaments and predictions tables.');
    process.exit(1);
}

const before = summarize();
console.log('PandaScore duplicate cleanup');
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', before }, null, 2));

if (!apply) {
    console.log('No changes written. Run `node scripts/cleanup-pandascore-duplicates.js --apply` to clean the database.');
    process.exit(0);
}

const backupPath = noBackup ? null : backupDatabase();
const afterCleanup = cleanup();
const after = summarize();

console.log(JSON.stringify({
    backup: backupPath,
    cleanup: afterCleanup,
    after
}, null, 2));
