const { createHash } = require('node:crypto');

function captureSettlement(db, matchId, now = Date.now()) {
    const m = db.prepare(`SELECT m.*, t.name tournament_name, t.game_type, t.is_active,
        a.name team1_name, b.name team2_name FROM matches m
        JOIN tournaments t ON t.id=m.tournament_id JOIN teams a ON a.id=m.team1_id
        JOIN teams b ON b.id=m.team2_id WHERE m.id=?`).get(matchId);
    if (!m || !m.is_active || m.status !== 'finished' || m.team1_score === null || m.team2_score === null || !m.winner_team_id) return;
    const predictions = db.prepare(`SELECT p.user_id, u.username, p.predicted_team1_score,
        p.predicted_team2_score, p.predicted_winner_id, p.points_earned
        FROM predictions p JOIN users u ON u.id=p.user_id WHERE p.match_id=? ORDER BY p.user_id`).all(matchId);
    if (predictions.some(p => p.points_earned === null)) return;
    const summary = { id: m.id, tournament_name: m.tournament_name, game_type: m.game_type,
        team1_name: m.team1_name, team2_name: m.team2_name, team1_score: m.team1_score,
        team2_score: m.team2_score, winner_team_id: m.winner_team_id, is_forfeit: m.is_forfeit };
    const fingerprint = createHash('sha256').update(JSON.stringify([summary, predictions])).digest('hex');
    const old = db.prepare('SELECT * FROM bot_settlement_state WHERE match_id=?').get(matchId);
    if (old?.fingerprint === fingerprint) return;
    const prior = new Map(old ? JSON.parse(old.predictions).map(p => [p.user_id, p.points_earned]) : []);
    const payload = { match: summary, correction: !!old, predictions: predictions.map(p => ({ ...p,
        delta: p.points_earned - (prior.get(p.user_id) || 0) })) };
    db.prepare('INSERT INTO bot_settlement_events(match_id,payload,created_at) VALUES(?,?,?)')
        .run(matchId, JSON.stringify(payload), now);
    db.prepare(`INSERT INTO bot_settlement_state(match_id,fingerprint,predictions) VALUES(?,?,?)
        ON CONFLICT(match_id) DO UPDATE SET fingerprint=excluded.fingerprint,predictions=excluded.predictions`)
        .run(matchId, fingerprint, JSON.stringify(predictions));
}

module.exports = { captureSettlement };
