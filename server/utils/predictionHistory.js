function recordPredictionHistory(db, prediction, action) {
    db.prepare(`
        INSERT INTO prediction_history
            (prediction_id, user_id, match_id, action, predicted_winner_id, predicted_team1_score, predicted_team2_score)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        prediction.id || null,
        prediction.user_id,
        prediction.match_id,
        action,
        prediction.predicted_winner_id,
        prediction.predicted_team1_score,
        prediction.predicted_team2_score
    );
}

module.exports = { recordPredictionHistory };
