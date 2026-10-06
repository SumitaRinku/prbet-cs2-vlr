const crypto = require('node:crypto');
const { isValidScore } = require('../utils/scoring');
const { recordPredictionHistory } = require('../utils/predictionHistory');

const idPattern = /^[1-9]\d{4,15}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const envIds = name => (process.env[name] || '').split(',').map(x => x.trim()).filter(Boolean);
function policy() { return { groups: envIds('BOT_COMMAND_GROUP_IDS'), admins: envIds('BOT_ADMIN_QQ_IDS') }; }
function problem(text) { const error = new Error(text); error.expected = true; throw error; }

function groupByTournament(rows, formatRow) {
    const groups = new Map();
    for (const row of rows) {
        const key = `${row.game_type}:${row.tournament_id}`;
        if (!groups.has(key)) groups.set(key, { row, lines: [] });
        groups.get(key).lines.push(formatRow(row));
    }
    return [...groups.values()].map(({ row, lines }) => {
        const game = { cs2: 'CS2', valorant: 'Valorant' }[row.game_type] || row.game_type;
        const name = String(row.tournament_name || '').replace(/[\r\n]/g, ' ');
        return [`${game} · ${name}`, ...lines].join('\n');
    }).join('\n\n');
}

function issueCode(db, userId, qq, now = Date.now()) {
    if (!idPattern.test(qq || '')) problem('请输入正确的 QQ 号');
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId)) problem('用户不存在');
    const code = crypto.randomBytes(12).toString('hex').toUpperCase();
    db.transaction(() => {
        db.prepare('DELETE FROM bot_bind_codes WHERE user_id=? OR expires_at<=?').run(userId, now);
        db.prepare('INSERT INTO bot_bind_codes(code_hash,user_id,qq_id,expires_at) VALUES(?,?,?,?)').run(hash(code), userId, qq, now + 600000);
    })();
    return { code, expires_at: now + 600000 };
}

function getMatch(db, id) {
    if (!/^[1-9]\d{0,14}$/.test(String(id))) problem('比赛 ID 无效');
    const m = db.prepare(`SELECT m.*, t.is_active, t.name tournament_name, a.name team1_name, b.name team2_name
        FROM matches m JOIN tournaments t ON t.id=m.tournament_id
        JOIN teams a ON a.id=m.team1_id JOIN teams b ON b.id=m.team2_id WHERE m.id=?`).get(id);
    if (!m || !m.is_active) problem('比赛不存在或赛事未启用');
    return m;
}

function predict(db, userId, matchId, a, b, now = Date.now(), cancel = false) {
    const m = getMatch(db, matchId);
    if (m.status !== 'upcoming' || !(Date.parse(m.match_time) > now)) problem('比赛已开始、结束或时间无效，不能修改竞猜');
    if (!cancel && (!m.betting_enabled || !m.time_confirmed || m.team1_name === 'TBD' || m.team2_name === 'TBD')) problem('比赛暂未开放竞猜或对阵/时间未确定');
    const existing = db.prepare('SELECT * FROM predictions WHERE user_id=? AND match_id=?').get(userId, m.id);
    if (cancel) {
        if (!existing) problem('你尚未对这场比赛竞猜');
        recordPredictionHistory(db, existing, 'deleted');
        db.prepare('DELETE FROM predictions WHERE id=?').run(existing.id);
        return `已取消 #${m.id} 的竞猜`;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || !isValidScore(a, b, m.format)) problem(`比分不符合 ${m.format} 赛制`);
    const winner = a > b ? m.team1_id : m.team2_id;
    let id = existing?.id;
    if (existing) db.prepare(`UPDATE predictions SET predicted_winner_id=?,predicted_team1_score=?,predicted_team2_score=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(winner, a, b, id);
    else id = db.prepare('INSERT INTO predictions(user_id,match_id,predicted_winner_id,predicted_team1_score,predicted_team2_score) VALUES(?,?,?,?,?)').run(userId, m.id, winner, a, b).lastInsertRowid;
    recordPredictionHistory(db, { id, user_id: userId, match_id: m.id, predicted_winner_id: winner, predicted_team1_score: a, predicted_team2_score: b }, existing ? 'updated' : 'created');
    return `竞猜已${existing ? '修改' : '提交'}：#${m.id} ${m.team1_name} ${a}:${b} ${m.team2_name}`;
}

function runCommand(db, input, options = {}) {
    const settings = options.policy || policy();
    const now = options.now ?? Date.now();
    const group = String(input.group_id || ''), qq = String(input.qq_id || '');
    if (!idPattern.test(group) || !idPattern.test(qq) || !settings.groups.includes(group)) problem('本群未启用竞猜功能');
    if (!/^[\w:.-]{1,120}$/.test(input.request_id || '') || typeof input.text !== 'string' || input.text.length > 200) problem('指令格式无效');
    const requestId = `${group}:${qq}:${input.request_id}`;
    return db.transaction(() => {
        const previous = db.prepare('SELECT response FROM bot_command_receipts WHERE request_id=?').get(requestId);
        if (previous) return JSON.parse(previous.response);
        const recent = db.prepare('SELECT COUNT(*) n FROM bot_command_receipts WHERE qq_id=? AND created_at>?').get(qq, now - 60000).n;
        if (recent >= 20) problem('指令过于频繁，请稍后重试');
        const args = input.text.trim().split(/\s+/);
        const action = args.shift();
        let text;
        try {
            // A savepoint rolls back partial mutations even for expected command failures.
            text = db.transaction(() => execute(action, args))();
        } catch (error) {
            if (!error.expected) throw error;
            text = error.message;
        }
        const response = { text };
        db.prepare('INSERT INTO bot_command_receipts VALUES(?,?,?,?,?,?)').run(requestId, group, qq, action || '', JSON.stringify(response), now);
        db.prepare('DELETE FROM bot_command_receipts WHERE created_at<?').run(now - 30 * 86400000);
        return response;
    })();

    function execute(action, args) {
        if (action === '帮助') return 'PRBET 指令：\n/prbet 绑定 绑定码\n/prbet 加入\n/prbet 退出\n/prbet 解绑\n/prbet 赛程\n/prbet 我的\n/prbet 竞猜 比赛ID 2:1（再次提交即修改）\n/prbet 取消 比赛ID\n管理员：开启竞猜/关闭竞猜 比赛ID；结算 比赛ID 2:1；弃权 比赛ID 1或2\n绑定码请在网站个人中心→账号设置生成；比分按赛程队伍顺序填写。加入后本群将展示你的赛后竞猜及积分。';
        if (action === '绑定') {
            const code = String(args[0] || '').toUpperCase();
            const row = db.prepare('SELECT * FROM bot_bind_codes WHERE code_hash=? AND qq_id=? AND expires_at>?').get(hash(code), qq, now);
            if (!row) problem('绑定码无效、已过期或不是为此 QQ 生成');
            const old = db.prepare('SELECT * FROM bot_bindings WHERE qq_id=? OR user_id=?').all(qq, row.user_id);
            if (old.some(x => x.qq_id !== qq || x.user_id !== row.user_id)) problem('QQ 或账号已绑定，请先在网站解除原绑定');
            db.prepare('INSERT OR IGNORE INTO bot_bindings VALUES(?,?)').run(qq, row.user_id);
            db.prepare('DELETE FROM bot_bind_codes WHERE user_id=?').run(row.user_id);
            db.prepare('INSERT OR IGNORE INTO bot_group_members VALUES(?,?,?)').run(group, qq, now);
            return '绑定成功，已加入本群竞猜。赛后将公开你在本群的竞猜结果与得分。';
        }
        const binding = db.prepare('SELECT b.*,u.username FROM bot_bindings b JOIN users u ON u.id=b.user_id WHERE qq_id=?').get(qq);
        if (action === '退出') {
            db.prepare('DELETE FROM bot_group_members WHERE group_id=? AND qq_id=?').run(group, qq);
            return '已退出本群竞猜展示；网站账号与已提交竞猜不变。';
        }
        if (action === '解绑') {
            if (binding) db.prepare('DELETE FROM bot_bind_codes WHERE user_id=?').run(binding.user_id);
            db.prepare('DELETE FROM bot_bindings WHERE qq_id=?').run(qq);
            return '已解除 QQ 绑定及所有群的竞猜展示关联。';
        }
        if (action === '加入') {
            if (!binding) problem('请先在网站生成绑定码，并发送 /prbet 绑定 绑定码');
            db.prepare('INSERT OR IGNORE INTO bot_group_members VALUES(?,?,?)').run(group, qq, now);
            return '已加入本群竞猜，赛后将公开你的竞猜结果与得分。';
        }
        if (action === '赛程') {
            const rows = db.prepare(`SELECT m.id,m.match_time,m.format,m.tournament_id,t.game_type,t.name tournament_name,a.name a,b.name b FROM matches m
                JOIN tournaments t ON t.id=m.tournament_id JOIN teams a ON a.id=m.team1_id JOIN teams b ON b.id=m.team2_id
                WHERE t.is_active=1 AND m.status='upcoming' AND m.betting_enabled=1 AND m.time_confirmed=1
                AND a.name<>'TBD' AND b.name<>'TBD' AND julianday(m.match_time)>julianday(?) ORDER BY julianday(m.match_time) LIMIT 15`).all(new Date(now).toISOString());
            return rows.length ? '可竞猜赛程（北京时间，按以下队伍顺序填写比分）：\n\n'
                + groupByTournament(rows, m => `#${m.id} ${new Date(Date.parse(m.match_time) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ')} ${m.a} vs ${m.b} ${m.format}`) : '暂无开放竞猜的比赛';
        }
        if (['开启竞猜', '关闭竞猜', '结算', '弃权'].includes(action)) {
            if (!settings.admins.includes(qq)) problem('需要配置的管理员 QQ 权限');
            const m = getMatch(db, args[0]);
            if (action.endsWith('竞猜')) {
                if (action === '开启竞猜' && (m.status !== 'upcoming' || !(Date.parse(m.match_time) > now) || !m.time_confirmed || m.team1_name === 'TBD' || m.team2_name === 'TBD')) problem('只能开启尚未开赛且对阵和时间已确认的比赛');
                db.prepare('UPDATE matches SET betting_enabled=? WHERE id=?').run(action === '开启竞猜' ? 1 : 0, m.id);
                return `#${m.id} 已${action}`;
            }
            let a, b;
            if (action === '弃权') {
                if (!['1', '2'].includes(args[1])) problem('弃权格式：弃权 比赛ID 获胜方序号（1或2）');
                a = args[1] === '1' ? 1 : 0; b = 1 - a;
            } else {
                const score = /^(\d):([0-9])$/.exec(args[1] || '');
                if (!score || !isValidScore(Number(score[1]), Number(score[2]), m.format)) problem(`赛果不符合 ${m.format} 赛制`);
                a = Number(score[1]); b = Number(score[2]);
            }
            if (m.team1_name === 'TBD' || m.team2_name === 'TBD') problem('对阵未确定，不能录入赛果');
            db.prepare(`UPDATE matches SET status='finished',team1_score=?,team2_score=?,winner_team_id=?,is_forfeit=?,result_locked=1,betting_enabled=0 WHERE id=?`)
                .run(a, b, a > b ? m.team1_id : m.team2_id, action === '弃权' ? 1 : 0, m.id);
            const settlement = options.settlement || require('../utils/settlement');
            settlement.settleMatch(m.id); settlement.recalculateUserScores();
            return `#${m.id} 已${action}：${m.team1_name} ${a}:${b} ${m.team2_name}${action === '弃权' ? '（弃权不计分）' : ''}`;
        }
        if (!binding || !db.prepare('SELECT 1 FROM bot_group_members WHERE group_id=? AND qq_id=?').get(group, qq)) problem('请先绑定账号并 /prbet 加入 本群竞猜');
        if (action === '我的') {
            const rows = db.prepare(`SELECT p.*,m.tournament_id,t.game_type,t.name tournament_name,a.name a,b.name b FROM predictions p JOIN matches m ON m.id=p.match_id
                JOIN tournaments t ON t.id=m.tournament_id
                JOIN teams a ON a.id=m.team1_id JOIN teams b ON b.id=m.team2_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 10`).all(binding.user_id);
            return `${binding.username} 的最近竞猜：\n\n` + (groupByTournament(rows, p => `#${p.match_id} ${p.a} ${p.predicted_team1_score}:${p.predicted_team2_score} ${p.b} · ${p.points_earned === null ? '待结算' : `本场 ${p.points_earned} 分`}`) || '暂无竞猜');
        }
        if (action === '取消') return predict(db, binding.user_id, args[0], 0, 0, now, true);
        if (['竞猜', '修改'].includes(action)) {
            const score = /^(\d):([0-9])$/.exec(args[1] || '');
            if (!score) problem('格式：/prbet 竞猜 比赛ID 2:1');
            return predict(db, binding.user_id, args[0], Number(score[1]), Number(score[2]), now);
        }
        return '未知指令，请发送 /prbet 帮助';
    }
}

module.exports = { issueCode, runCommand, predict, policy, idPattern };
