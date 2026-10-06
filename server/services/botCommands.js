const crypto = require('node:crypto');
const { isValidScore, maxScore } = require('../utils/scoring');
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

const GAME_FILTERS = { cs2: 'cs2', csgo: 'cs2', valorant: 'valorant', val: 'valorant', '无畏契约': 'valorant' };
const QUERY_PAGE_SIZE = { '赛程': 15, '我的': 10 };
const beijingTime = time => new Date(Date.parse(time) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');

function queryFilters(action, args, now) {
    const filter = { game: '', day: '', status: '', page: 1 };
    let hasPage = false;
    for (const arg of args) {
        const key = arg.toLowerCase();
        const game = Object.hasOwn(GAME_FILTERS, key) ? GAME_FILTERS[key] : null;
        if (game && !filter.game) filter.game = game;
        else if (action === '赛程' && ['今天', '明天'].includes(arg) && !filter.day) filter.day = arg;
        else if (action === '我的' && ['待开赛', '待结算', '已结算'].includes(arg) && !filter.status) filter.status = arg;
        else if (/^[1-9]\d{0,3}$/.test(arg) && !hasPage) { filter.page = Number(arg); hasPage = true; }
        else problem(action === '赛程'
            ? '格式：/prbet 赛程 [cs2/valorant] [今天/明天] [页码]，如 /prbet 赛程 cs2 明天 2'
            : '格式：/prbet 我的 [待开赛/待结算/已结算] [cs2/valorant] [页码]，如 /prbet 我的 待开赛 cs2 2');
    }
    filter.args = [filter.status, filter.game, filter.day].filter(Boolean).join(' ');
    filter.size = QUERY_PAGE_SIZE[action];
    if (filter.day) {
        const date = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
        const start = Date.parse(`${date}T00:00:00+08:00`) + (filter.day === '明天' ? 86400000 : 0);
        filter.from = new Date(start).toISOString();
        filter.to = new Date(start + 86400000).toISOString();
    }
    return filter;
}

function queryPage(db, select, from, where, params, order, action, filter) {
    const total = db.prepare(`SELECT COUNT(*) total ${from} WHERE ${where}`).get(...params).total;
    const pages = Math.max(1, Math.ceil(total / filter.size));
    if (total && filter.page > pages) problem(`共 ${pages} 页，请发送 /prbet ${action}${filter.args ? ` ${filter.args}` : ''} ${pages}`);
    const rows = db.prepare(`SELECT ${select} ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, filter.size, (filter.page - 1) * filter.size);
    const next = filter.page < pages ? `\n下一页：/prbet ${action}${filter.args ? ` ${filter.args}` : ''} ${filter.page + 1}` : '';
    return { rows, footer: `\n\n第 ${filter.page}/${pages} 页 · 共 ${total} ${action === '赛程' ? '场' : '条'}${next}` };
}

function predictionState(p, now) {
    if (p.match_status === 'cancelled') return '已取消';
    if (p.match_status === 'postponed') return '已延期';
    if (p.is_forfeit) return '弃权不计分';
    if (p.match_status === 'finished' && p.points_earned !== null) return `本场 ${p.points_earned} 分`;
    if (p.match_status === 'upcoming' && Date.parse(p.match_time) > now) return '待开赛';
    return '待结算';
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
    if (!m || !m.is_active) problem('比赛不存在或赛事未启用；发送 /prbet 赛程 可查看当前可竞猜的比赛及 ID');
    return m;
}

function predict(db, userId, matchId, a, b, now = Date.now(), cancel = false) {
    const m = getMatch(db, matchId);
    if (m.status !== 'upcoming' || !(Date.parse(m.match_time) > now)) problem('比赛已开始或已结束，无法竞猜；发送 /prbet 赛程 可查看尚未开赛的比赛');
    if (!cancel && (!m.betting_enabled || !m.time_confirmed || m.team1_name === 'TBD' || m.team2_name === 'TBD')) problem('比赛暂未开放竞猜或对阵/时间未确定，请稍后再试或联系管理员开启');
    const existing = db.prepare('SELECT * FROM predictions WHERE user_id=? AND match_id=?').get(userId, m.id);
    if (cancel) {
        if (!existing) problem('你尚未对这场比赛竞猜');
        recordPredictionHistory(db, existing, 'deleted');
        db.prepare('DELETE FROM predictions WHERE id=?').run(existing.id);
        return `已取消 #${m.id} 的竞猜`;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || !isValidScore(a, b, m.format)) {
        const max = maxScore(m.format);
        problem(`比分不符合 ${m.format} 赛制（胜方 ${max} 分、败方 0~${Math.max(0, max - 1)} 分，如 ${max}:0、${max}:${Math.max(0, max - 1)}）`);
    }
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
        if (action === '帮助') return [
            'PRBET 群竞猜指令（均以 /prbet 开头，如「/prbet 赛程」）',
            '',
            '▶ 账号',
            '绑定 绑定码 —— 绑定网站账号（码在 个人中心→账号设置 生成，10 分钟有效）',
            '加入 / 退出 —— 控制是否在本群展示你的赛后竞猜',
            '解绑 —— 解除 QQ 与网站账号的绑定',
            '',
            '▶ 竞猜',
            '赛程 [cs2/valorant] [今天/明天] [页码] —— 每页 15 场，如 赛程 cs2 明天 2',
            '竞猜 比赛ID 2:1 —— 提交比分（按赛程队伍顺序填写）',
            '修改 比赛ID 2:1 —— 修改已有竞猜',
            '取消 比赛ID —— 取消竞猜（开赛前有效）',
            '我的 [待开赛/待结算/已结算] [cs2/valorant] [页码] —— 每页 10 条，如 我的 待开赛 cs2',
            '',
            '▶ 管理员',
            '开启竞猜 / 关闭竞猜 比赛ID',
            '结算 比赛ID 2:1 · 弃权 比赛ID 1或2',
            '',
            '赛后本群自动播报结算结果与积分。'
        ].join('\n');
        if (action === '绑定') {
            const code = String(args[0] || '').toUpperCase();
            const row = db.prepare('SELECT * FROM bot_bind_codes WHERE code_hash=? AND qq_id=? AND expires_at>?').get(hash(code), qq, now);
            if (!row) problem('绑定码无效或已过期（10 分钟内有效，且仅限生成时填写的 QQ）；请在网站「个人中心 → 账号设置 → 机器人绑定」重新生成');
            const old = db.prepare('SELECT * FROM bot_bindings WHERE qq_id=? OR user_id=?').all(qq, row.user_id);
            if (old.some(x => x.qq_id !== qq || x.user_id !== row.user_id)) problem('QQ 或账号已绑定，请先在网站「个人中心 → 账号设置」解除原绑定后再试');
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
            const filter = queryFilters(action, args, now);
            const from = `FROM matches m JOIN tournaments t ON t.id=m.tournament_id
                JOIN teams a ON a.id=m.team1_id JOIN teams b ON b.id=m.team2_id`;
            let where = `t.is_active=1 AND m.status='upcoming' AND m.betting_enabled=1 AND m.time_confirmed=1
                AND a.name<>'TBD' AND b.name<>'TBD' AND julianday(m.match_time)>julianday(?)`;
            const params = [new Date(now).toISOString()];
            if (filter.game) { where += ' AND t.game_type=?'; params.push(filter.game); }
            if (filter.day) { where += ' AND julianday(m.match_time)>=julianday(?) AND julianday(m.match_time)<julianday(?)'; params.push(filter.from, filter.to); }
            const { rows, footer } = queryPage(db,
                'm.id,m.match_time,m.format,m.tournament_id,t.game_type,t.name tournament_name,a.name a,b.name b',
                from, where, params, 'julianday(m.match_time),m.id', action, filter);
            return rows.length ? `可竞猜赛程${filter.args ? ` · ${filter.args}` : ''}（北京时间，今天/明天按 00:00–24:00，比分按队伍顺序）：\n\n`
                + groupByTournament(rows, m => `#${m.id} ${beijingTime(m.match_time)} ${m.a} vs ${m.b} ${m.format}`) + footer
                : '当前筛选下暂无开放竞猜的比赛；发送 /prbet 赛程 查看全部';
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
                if (!score || !isValidScore(Number(score[1]), Number(score[2]), m.format)) {
                    const max = maxScore(m.format);
                    problem(`赛果不符合 ${m.format} 赛制（胜方 ${max} 分、败方 0~${Math.max(0, max - 1)} 分）`);
                }
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
            const filter = queryFilters(action, args, now);
            const from = `FROM predictions p JOIN matches m ON m.id=p.match_id JOIN tournaments t ON t.id=m.tournament_id
                JOIN teams a ON a.id=m.team1_id JOIN teams b ON b.id=m.team2_id`;
            let where = 'p.user_id=?';
            const params = [binding.user_id];
            if (filter.game) { where += ' AND t.game_type=?'; params.push(filter.game); }
            if (filter.status === '待开赛') { where += " AND m.status='upcoming' AND julianday(m.match_time)>julianday(?)"; params.push(new Date(now).toISOString()); }
            if (filter.status === '待结算') {
                where += " AND (m.status='ongoing' OR (m.status='upcoming' AND julianday(m.match_time)<=julianday(?)) OR (m.status='finished' AND p.points_earned IS NULL))";
                params.push(new Date(now).toISOString());
            }
            if (filter.status === '已结算') where += " AND m.status='finished' AND p.points_earned IS NOT NULL";
            const { rows, footer } = queryPage(db,
                'p.*,m.tournament_id,m.match_time,m.status match_status,m.is_forfeit,t.game_type,t.name tournament_name,a.name a,b.name b',
                from, where, params, filter.status === '待开赛' ? 'julianday(m.match_time),p.id' : 'p.id DESC', action, filter);
            return `${binding.username} 的竞猜${filter.args ? ` · ${filter.args}` : ''}（北京时间）：\n\n`
                + (rows.length ? groupByTournament(rows, p => `#${p.match_id} ${beijingTime(p.match_time)} ${p.a} ${p.predicted_team1_score}:${p.predicted_team2_score} ${p.b} · ${predictionState(p, now)}`) + footer : '当前筛选下暂无竞猜');
        }
        if (action === '取消') return predict(db, binding.user_id, args[0], 0, 0, now, true);
        if (['竞猜', '修改'].includes(action)) {
            const score = /^(\d):([0-9])$/.exec(args[1] || '');
            if (!score) problem('格式：/prbet 竞猜 比赛ID 2:1');
            return predict(db, binding.user_id, args[0], Number(score[1]), Number(score[2]), now);
        }
        return `未知指令「${action}」，发送 /prbet 帮助 查看全部用法`;
    }
}

module.exports = { issueCode, runCommand, predict, policy, idPattern };
