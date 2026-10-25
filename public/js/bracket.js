// bracket.js — 赛程图 / stage 模型渲染管线（纯函数）。
// 由 tournaments.js（回看页）与 app.js（主页折叠面板）共用。
// 依赖三个环境全局（各页各自提供）：escapeHtml、logoHtml、focusTournamentMatch。
// 本文件不含任何页面状态 / DOM 副作用；顶层只有函数声明与字面量常量。
const bracketGraphEngine = typeof BracketGraph !== 'undefined' ? BracketGraph : require('./bracket-graph');

function normalizeStageName(name) {
    const raw = String(name || '').trim();
    const lower = raw.toLowerCase();
    const swiss = raw.match(/swiss\s*(?:stage)?\s*(?:round|r)?\s*(\d+)/i) || raw.match(/瑞士轮\s*(\d+)/i);
    if (swiss) return { key: `01-swiss-${swiss[1].padStart(2, '0')}`, label: `瑞士轮 Round ${swiss[1]}` };
    const round = raw.match(/(?:round|r)\s*(\d+)/i);
    if (round && (lower.includes('swiss') || lower.includes('stage'))) return { key: `02-round-${round[1].padStart(2, '0')}`, label: `Round ${round[1]}` };
    if (lower.includes('playoff') || raw.includes('淘汰')) return { key: '70-playoffs', label: '淘汰赛' };
    if (lower.includes('quarter') || raw.includes('四分之一')) return { key: '71-quarterfinals', label: '四分之一决赛' };
    if (lower.includes('semi') || raw.includes('半决赛')) return { key: '72-semifinals', label: '半决赛' };
    if (lower.includes('grand final') || lower.includes('final') || raw.includes('决赛')) return { key: '80-finals', label: '决赛' };
    if (lower.includes('group') || raw.includes('小组')) return { key: '20-groups', label: '小组赛' };
    if (lower.includes('opening') || raw.includes('揭幕')) return { key: '10-opening', label: 'Opening Matches' };
    if (lower.includes('elimination') || raw.includes('淘汰')) return { key: '30-elimination', label: 'Elimination Matches' };
    if (lower.includes('decider') || raw.includes('决胜')) return { key: '40-decider', label: 'Decider Matches' };
    return null;
}

function dateStage(match) {
    const date = match.match_time ? new Date(match.match_time) : null;
    if (!date || Number.isNaN(date.getTime())) return { key: '99-unscheduled', label: '未定时间' };
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return { key: `90-${yyyy}-${mm}-${dd}`, label: `${mm}-${dd}` };
}

function apiStageFromMatch(match) {
    if (!match.stage_external_id && !match.stage_slug) return null;
    const raw = match.stage_name || match.stage_slug || '赛事阶段';
    return {
        key: `00-api-${String(match.stage_external_id || match.stage_slug || raw).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        label: raw
    };
}

function stageInfo(match) {
    const apiStage = apiStageFromMatch(match);
    if (apiStage) return apiStage;
    if (match.stage_name) {
        const normalized = normalizeStageName(match.stage_name);
        if (normalized && !/^Round \d+$/i.test(normalized.label)) return normalized;
    }
    return normalizeStageName(match.name) || dateStage(match);
}

function stageMetrics(matches) {
    return {
        total: matches.length,
        finished: matches.filter(match => match.status === 'finished').length,
        predictions: matches.reduce((sum, match) => sum + (match.prediction_count || 0), 0)
    };
}

function stageSubtitle(matches) {
    const metrics = stageMetrics(matches);
    return `${metrics.total} 场比赛 · ${metrics.finished} 场已结算 · ${metrics.predictions} 人次预测`;
}

function stageMatches(item) {
    return item.groups ? item.groups.flatMap(group => group.matches || []) : (item.matches || []);
}
function groupMatches(matches) {
    const map = new Map();
    for (const match of matches) {
        const stage = stageInfo(match);
        if (!map.has(stage.key)) map.set(stage.key, { ...stage, matches: [] });
        map.get(stage.key).matches.push(match);
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).map(group => ({
        ...group,
        matches: group.matches.sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0))
    }));
}

function roundNumber(match) {
    const source = `${match.name || ''} ${match.stage_name || ''}`;
    const round = source.match(/(?:round|r)\s*(\d+)/i);
    return round ? Number(round[1]) : null;
}

function isSwissRoundGroup(group) {
    return /^Round \d+$/i.test(group.label) || /瑞士轮\s*Round\s*\d+/i.test(group.label);
}

// 小组赛里具体分组（Group A/B/C/D）与「Group Stage」这种单一瑞士轮池要区别对待。
function isNamedGroupStage(label) {
    const text = String(label || '');
    return /\bgroup\s+[a-z0-9]+\b/i.test(text) && !/group\s+stage/i.test(text);
}

function stageRoundCounts(matches) {
    const counts = new Map();
    for (const match of matches || []) {
        const round = roundNumber(match);
        if (round === null) continue;
        counts.set(round, (counts.get(round) || 0) + 1);
    }
    return counts;
}

// 是否应渲染为瑞士轮：
// - 明确标注 swiss / Group Stage / Opening Stage；
// - 或轮次 >=3、队伍 >=8，且各轮场数不是全部相等（排除循环赛小组）。
function looksLikeSwissStage(matches, label = '') {
    const list = matches || [];
    const text = String(label || list[0]?.stage_name || '');
    const rounds = stageRoundCounts(list);
    if (isNamedGroupStage(text)) return false;
    if (/swiss/i.test(text) || /瑞士/i.test(text)) return rounds.size >= 2;
    if (/group\s*stage|opening\s*stage|^groups?$/i.test(text.trim())) return rounds.size >= 2;
    if (rounds.size < 3) return false;
    const teams = new Set();
    for (const match of list) {
        if ((match.team1_name || '') !== 'TBD') teams.add(teamRecordKey(match, 1));
        if ((match.team2_name || '') !== 'TBD') teams.add(teamRecordKey(match, 2));
    }
    if (teams.size < 8) return false;
    const counts = [...rounds.values()];
    return counts.some(count => count !== counts[0]);
}

function splitRepeatedSwissStages(groups) {
    const output = [];
    let current = null;
    let lastRound = 0;
    let stageIndex = 0;

    for (const group of groups) {
        const round = isSwissRoundGroup(group) ? Number((group.label.match(/\d+/) || [0])[0]) : null;
        if (!round) {
            current = null;
            lastRound = 0;
            output.push(group);
            continue;
        }
        if (!current || round <= lastRound) {
            stageIndex += 1;
            current = {
                key: `swiss-stage-${String(stageIndex).padStart(2, '0')}`,
                label: `Stage ${stageIndex} Swiss`,
                type: 'swiss-stage',
                groups: []
            };
            output.push(current);
        }
        current.groups.push({ ...group, round });
        lastRound = round;
    }
    return output;
}

function stageItemMetrics(item) {
    return stageMetrics(item.metricsMatches || stageMatches(item));
}

function stageOrderValue(stage) {
    const label = String(stage.label || '').toLowerCase();
    const stageNumber = label.match(/stage\s*(\d+)/i);
    if (stageNumber) return Number(stageNumber[1]);
    if (label.includes('swiss')) return 10;
    if (label.includes('playoff') || label.includes('淘汰')) return 90;
    if (label.includes('final') || label.includes('决赛')) return 91;
    return 50;
}

function sortTournamentStages(stages) {
    return [...stages].sort((a, b) => {
        const order = stageOrderValue(a) - stageOrderValue(b);
        if (order !== 0) return order;
        return String(a.key || '').localeCompare(String(b.key || ''));
    });
}

function teamShortName(match, side) {
    const prefix = side === 1 ? 'team1' : 'team2';
    return match[`${prefix}_short_name`] || match[`${prefix}_name`] || 'TBD';
}

function teamRecordKey(match, side) {
    const prefix = side === 1 ? 'team1' : 'team2';
    // TBD 占位队各处共享同一 id，若直接返回会让连通/战绩算法把所有未定局错误串到一起。
    // 给每个 TBD 侧一个唯一 key，确保它们互不连通、也不参与战绩累计。
    if ((match[`${prefix}_name`] || '') === 'TBD') return `tbd-${match.id}-${side}`;
    return match[`${prefix}_id`] || match[`${prefix}_name`] || match[`${prefix}_short_name`] || `${prefix}-${match.id}`;
}

function swissRecordLabel(record) {
    return `${record.wins || 0}-${record.losses || 0}组`;
}

function swissBucketMeta(record, paired = true) {
    if (!paired) return { tone: 'neutral', outcome: '' };
    const wins = record.wins || 0;
    const losses = record.losses || 0;
    if (wins === 2 && losses === 0) return { tone: 'advance', outcome: '胜者3-0晋级' };
    if (wins === 2 && losses === 1) return { tone: 'advance', outcome: '胜者3-1晋级' };
    if (wins === 2 && losses === 2) return { tone: 'decider', outcome: '胜者3-2晋级 / 败者2-3淘汰' };
    if (wins === 0 && losses === 2) return { tone: 'eliminate', outcome: '败者0-3淘汰' };
    if (wins === 1 && losses === 2) return { tone: 'eliminate', outcome: '败者1-3淘汰' };
    return { tone: 'neutral', outcome: '' };
}

function teamSnapshot(match, side) {
    const prefix = side === 1 ? 'team1' : 'team2';
    return {
        id: match[`${prefix}_id`],
        name: match[`${prefix}_name`] || 'TBD',
        shortName: match[`${prefix}_short_name`] || match[`${prefix}_name`] || 'TBD',
        logo: match[`${prefix}_logo_url`],
        darkLogo: match[`${prefix}_dark_logo_url`]
    };
}

function swissFinalBucketClass(record) {
    if (record.wins >= 3) return 'advance';
    if (record.losses >= 3) return 'eliminate';
    return 'neutral';
}

function swissFinalLabel(record) {
    if (record.wins >= 3) return `${record.wins}-${record.losses}晋级`;
    if (record.losses >= 3) return `${record.wins}-${record.losses}淘汰`;
    return `${record.wins}-${record.losses}`;
}

function swissFinalBuckets(roundGroups, skeleton = false) {
    const records = new Map();
    const allMatches = roundGroups.flatMap(group => group.matches || [])
        .sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0));
    for (const match of allMatches) {
        const team1Key = teamRecordKey(match, 1);
        const team2Key = teamRecordKey(match, 2);
        const team1 = records.get(team1Key) || { wins: 0, losses: 0, team: teamSnapshot(match, 1) };
        const team2 = records.get(team2Key) || { wins: 0, losses: 0, team: teamSnapshot(match, 2) };
        team1.team = team1.team || teamSnapshot(match, 1);
        team2.team = team2.team || teamSnapshot(match, 2);
        if (match.status === 'finished') {
            const winner = bracketGraphEngine.result(match).winner;
            if (winner === 1) {
                team1.wins += 1;
                team2.losses += 1;
            } else if (winner === 2) {
                team2.wins += 1;
                team1.losses += 1;
            }
        }
        records.set(team1Key, team1);
        records.set(team2Key, team2);
    }

    const order = ['3-0晋级', '3-1晋级', '3-2晋级', '0-3淘汰', '1-3淘汰', '2-3淘汰'];
    const buckets = new Map(order.map((label, index) => [label, {
        key: String(index).padStart(2, '0'),
        label,
        tone: label.includes('晋级') ? 'advance' : 'eliminate',
        teams: []
    }]));

    for (const record of records.values()) {
        const label = swissFinalLabel(record);
        if (!buckets.has(label)) continue;
        buckets.get(label).teams.push({
            team: record.team,
            wins: record.wins,
            losses: record.losses,
            tone: swissFinalBucketClass(record)
        });
    }

    const result = [...buckets.values()].map(bucket => ({
        ...bucket,
        teams: bucket.teams.sort((a, b) => a.team.shortName.localeCompare(b.team.shortName))
    }));
    // 骨架模式：6 个晋级/淘汰框始终存在，用「?」占位把每框补足到应有队数。
    if (skeleton) {
        const byLabel = new Map(result.map(bucket => [bucket.label, bucket]));
        return SWISS_16_SKELETON.finals.map(spec => {
            const bucket = byLabel.get(spec.label) || { key: spec.label, label: spec.label, tone: spec.tone, teams: [] };
            const teams = bucket.teams.slice();
            while (teams.length < spec.size) teams.push({ __placeholder: true });
            return { ...bucket, tone: spec.tone, teams };
        });
    }
    return result.filter(bucket => bucket.teams.length);
}

// 未定对局：任一方是 TBD 占位队。
function isTbdMatch(match) {
    return (match.team1_name || '') === 'TBD' || (match.team2_name || '') === 'TBD';
}

// 「?」盾牌：TBD 占位统一用内联 SVG 渲染，绕开需要 http(s)+ 注册的 logo 代理，确保必现。
const TBD_SHIELD = `<svg class="tbd-shield" viewBox="0 0 100 100" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M52.4682 1.14524C60.5852 5.89864 69.5628 11.1553 93.7789 11.1553C94.1861 12.1748 95 17.7612 95 31.9515C95 49.6893 93.2042 75.6699 50.5 99C7.79581 75.6699 6 49.6893 6 31.9515C6 17.7612 6.81386 12.1748 7.22115 11.1553C31.4372 11.1553 40.4148 5.89806 48.5318 1.14524C49.1912 0.759029 49.8442 0.376311 50.5 0C51.1558 0.376311 51.8088 0.759029 52.4682 1.14524Z" fill="#4F657D"/><text fill="#D9E1E9" text-anchor="middle" font-size="50" y="48" x="50" dominant-baseline="central" font-family="Arial, sans-serif" font-weight="bold">?</text></svg>`;

// 标准 16 队 Buchholz 瑞士轮骨架（CS Major Legends 制）：结构确定，去重后共 33 场。
// 每轮固定的战绩桶（进入该轮时的战绩）与对阵数，以及每轮末产生的晋级/淘汰框。
const SWISS_16_SKELETON = {
    rounds: {
        1: [{ wins: 0, losses: 0, count: 8 }],
        2: [{ wins: 1, losses: 0, count: 4 }, { wins: 0, losses: 1, count: 4 }],
        3: [{ wins: 2, losses: 0, count: 2 }, { wins: 1, losses: 1, count: 4 }, { wins: 0, losses: 2, count: 2 }],
        4: [{ wins: 2, losses: 1, count: 3 }, { wins: 1, losses: 2, count: 3 }],
        5: [{ wins: 2, losses: 2, count: 3 }]
    },
    // 晋级/淘汰框：label 与 swissFinalLabel 一致；size=应有队数；afterRound=产生于哪一轮末。
    finals: [
        { label: '3-0晋级', tone: 'advance', size: 2, afterRound: 3 },
        { label: '3-1晋级', tone: 'advance', size: 3, afterRound: 4 },
        { label: '3-2晋级', tone: 'advance', size: 3, afterRound: 5 },
        { label: '0-3淘汰', tone: 'eliminate', size: 2, afterRound: 3 },
        { label: '1-3淘汰', tone: 'eliminate', size: 3, afterRound: 4 },
        { label: '2-3淘汰', tone: 'eliminate', size: 3, afterRound: 5 }
    ]
};

// 判断该赛事是否为标准 16 队瑞士轮：R1..R5 齐全且各轮对阵数匹配 8/8/8/6/3。
function detectSwiss16(roundGroups) {
    const byRound = new Map(roundGroups.map(g => [g.round || Number((String(g.label || '').match(/\d+/) || [0])[0]), g]));
    const expected = { 1: 8, 2: 8, 3: 8, 4: 6, 5: 3 };
    return Object.entries(expected).every(([r, n]) => (byRound.get(Number(r)) || { matches: [] }).matches.length === n);
}

// 合成 TBD 占位对阵，用于骨架中尚未产生的槽位。
function placeholderMatch(round, seq, name) {
    return { __placeholder: true, id: `ph-${round}-${seq}`, name: name || `Round ${round}`, status: 'not_started', team1_name: 'TBD', team2_name: 'TBD' };
}

// 由骨架战绩桶定义派生出与真实桶一致的 key/label/tone（保证能与真实桶合并）。
function skeletonBucketShell(spec) {
    const label = swissRecordLabel(spec);
    const meta = swissBucketMeta(spec, true);
    const key = `${String(spec.wins + spec.losses).padStart(2, '0')}-${String(9 - spec.wins).padStart(2, '0')}-${label}`;
    return { key, label, tone: meta.tone, outcome: meta.outcome, wins: spec.wins, losses: spec.losses, matches: [] };
}

function swissRoundBuckets(roundGroups, skeleton = false) {
    const records = new Map();
    return roundGroups.map(group => {
        const round = group.round || Number((String(group.label || '').match(/\d+/) || [0])[0]);
        const buckets = new Map();
        for (const match of group.matches) {
            const left = records.get(teamRecordKey(match, 1)) || { wins: 0, losses: 0 };
            const right = records.get(teamRecordKey(match, 2)) || { wins: 0, losses: 0 };
            const paired = left.wins === right.wins && left.losses === right.losses;
            const label = paired
                ? swissRecordLabel(left)
                : `${left.wins || 0}-${left.losses || 0} / ${right.wins || 0}-${right.losses || 0}`;
            const meta = swissBucketMeta(left, paired);
            const key = `${String(left.wins + left.losses).padStart(2, '0')}-${String(9 - left.wins).padStart(2, '0')}-${label}`;
            if (!buckets.has(key)) buckets.set(key, { key, label, tone: meta.tone, outcome: meta.outcome, wins: left.wins || 0, losses: left.losses || 0, matches: [] });
            buckets.get(key).matches.push(match);
        }
        for (const match of group.matches) {
            if (match.status !== 'finished') continue;
            const team1Key = teamRecordKey(match, 1);
            const team2Key = teamRecordKey(match, 2);
            const team1 = records.get(team1Key) || { wins: 0, losses: 0 };
            const team2 = records.get(team2Key) || { wins: 0, losses: 0 };
            const winner = bracketGraphEngine.result(match).winner;
            if (winner === 1) {
                team1.wins += 1;
                team2.losses += 1;
            } else if (winner === 2) {
                team2.wins += 1;
                team1.losses += 1;
            }
            records.set(team1Key, team1);
            records.set(team2Key, team2);
        }
        // 骨架模式：按标准结构补齐该轮应有的桶。
        // 未开赛的 TBD 比赛在战绩计算里全部落在 0-0 桶，必须重新分配到骨架桶，
        // 否则每一列都会多出一个 "0:0" 桶，并与占位符重复。
        if (skeleton && SWISS_16_SKELETON.rounds[round]) {
            const specs = SWISS_16_SKELETON.rounds[round];
            const expectedKeys = new Set(specs.map(spec => skeletonBucketShell(spec).key));
            const unmatched = [];
            for (const key of [...buckets.keys()]) {
                if (expectedKeys.has(key)) continue;
                unmatched.push(...buckets.get(key).matches);
                buckets.delete(key);
            }
            let seq = 0;
            for (const spec of specs) {
                const shell = skeletonBucketShell(spec);
                const bucket = buckets.get(shell.key) || shell;
                if (!buckets.has(shell.key)) buckets.set(shell.key, bucket);
                while (bucket.matches.length < spec.count && unmatched.length) bucket.matches.push(unmatched.shift());
                while (bucket.matches.length < spec.count) bucket.matches.push(placeholderMatch(round, `${shell.key}-${seq++}`));
            }
            // 数据异常导致实际对阵多于标准结构时，保留一个兜底桶而不是丢比赛。
            if (unmatched.length) {
                buckets.set('zz-unmatched', {
                    key: 'zz-unmatched',
                    label: '未归类',
                    tone: 'neutral',
                    outcome: '',
                    wins: 0,
                    losses: 0,
                    matches: unmatched
                });
            }
        }
        return {
            ...group,
            round,
            buckets: [...buckets.values()].sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || a.key.localeCompare(b.key)).map(bucket => ({
                ...bucket,
                matches: bucket.matches.sort((a, b) => (a.__placeholder ? 1 : 0) - (b.__placeholder ? 1 : 0) || new Date(a.match_time || 0) - new Date(b.match_time || 0))
            }))
        };
    });
}

function swissGraphLabel(label) {
    return String(label || '').replace(/组/g, '').replace(/-/g, ':').replace(/晋级/g, '').replace(/淘汰/g, '');
}

function swissMatchLogo(match, side) {
    const name = side === 1 ? match.team1_name : match.team2_name;
    const logo = side === 1 ? match.team1_logo_url : match.team2_logo_url;
    const darkLogo = side === 1 ? match.team1_dark_logo_url : match.team2_dark_logo_url;
    const won = bracketGraphEngine.result(match).winner === side;
    // TBD / 骨架占位：直接渲染「?」盾牌，不走 logo 代理。
    const logoNode = (name || '') === 'TBD' || match.__placeholder
        ? `<span class="sw2-logo tbd">${TBD_SHIELD}</span>`
        : `<span class="sw2-logo ${won ? 'winner' : ''}">${logoHtml(logo, darkLogo)}</span>`;
    return `<span class="sw2-side ${won ? 'winner' : ''}">${logoNode}<b>${escapeHtml(teamShortName(match, side))}</b></span>`;
}

function isLiveMatch(match) {
    if (match.__placeholder) return false;
    if (isTbdMatch(match)) return false;
    // 后端确认的进行中状态（running → ongoing）。
    if (match.status === 'ongoing' || match.status === 'live' || match.status === 'running') return true;
    // 前端派生：开赛时间已过、尚未结束/取消，即视为进行中。无需等 5 分钟同步，0 延迟。
    if (match.status === 'finished' || match.status === 'cancelled' || match.status === 'canceled' || match.status === 'postponed') return false;
    return !!match.match_time && new Date(match.match_time).getTime() <= Date.now();
}

// 赛程图卡片上方角标：进行中 → LIVE；未开赛 → 开赛时间（MM-DD HH:mm）。
// 已结束/弃权/TBD/占位不显示。纯函数：时间用本地时区格式化，不依赖页面全局。
function bracketWhenChip(match) {
    if (match.__placeholder || isTbdMatch(match)) return '';
    if (match.status === 'finished' && !bracketGraphEngine.result(match).winner) return '<span class="bracket-chip unknown">赛果待更新</span>';
    if (isLiveMatch(match)) return '<span class="bracket-chip live" aria-label="比赛进行中">LIVE</span>';
    if (match.status !== 'upcoming' || !match.match_time) return '';
    const date = new Date(match.match_time);
    if (Number.isNaN(date.getTime())) return '';
    const pad = value => String(value).padStart(2, '0');
    // 非当年日期补两位年份前缀（如 25-12-31 14:00），当年保持 MM-DD HH:mm
    const yearPrefix = date.getFullYear() === new Date().getFullYear() ? '' : `${String(date.getFullYear() % 100).padStart(2, '0')}-`;
    return `<span class="bracket-chip when">${yearPrefix}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}</span>`;
}

// LIVE 卡片单击跳转的直播间地址（按比赛所属赛事的游戏类型区分）。
const LIVE_STREAM_URLS = {
    cs2: 'https://live.bilibili.com/1883358196',
    valorant: 'https://live.bilibili.com/24160384'
};

// 赛程图卡片点击行为：LIVE 卡片直接新标签页打开对应游戏直播间；
// 其余（未开赛/已结束/未知游戏）保持原有定位逻辑 focusTournamentMatch。
function bracketCardAction(match) {
    if (!match || match.__noLink || !match.id) return '';
    const url = isLiveMatch(match) ? LIVE_STREAM_URLS[String(match.game_type || '').toLowerCase()] || '' : '';
    return url ? `window.open('${url}','_blank','noopener')` : `focusTournamentMatch(${match.id})`;
}

function swissMatchNodeClean(match) {
    // 前端合成骨架槽位、以及没有本地比赛可定位的官方节点不可点击。
    const clickable = !match.__placeholder && !match.__noLink;
    const live = isLiveMatch(match);
    const attrs = clickable
        ? `onclick="${bracketCardAction(match)}"`
        : 'disabled aria-disabled="true"';
    const classes = ['sw2-match', clickable ? '' : 'tbd', live ? 'live' : ''].filter(Boolean).join(' ');
    const badge = live ? '<span class="bracket-chip live" aria-label="比赛进行中">LIVE</span>' : '';
    const outcome = bracketGraphEngine.result(match);
    const scored = outcome.finished && outcome.scores.every(score => score !== null);
    const score = scored ? `${outcome.scores[0]}:${outcome.scores[1]}` : 'vs';
    const button = `<button type="button" class="${classes}" ${attrs} aria-label="${escapeHtml(`${live ? '进行中 · ' : ''}${match.team1_name || 'TBD'} ${score} ${match.team2_name || 'TBD'}`)}" title="${escapeHtml(match.name || 'Swiss match')}">
        ${badge}
        ${swissMatchLogo(match, 1)}
        <span class="sw2-vs${scored ? ' scored' : ''}">${score}</span>
        ${swissMatchLogo(match, 2)}
    </button>`;
    if (badge) return button;
    // 未开赛：开赛时间以文档流小标签放在卡上方（不悬空叠压上一张卡）
    const when = bracketWhenChip(match);
    return when ? `<div class="sw2-slot">${when}${button}</div>` : button;
}

function swissResultTeamClean(entry) {
    // 空槽位（尚未产生的晋级/淘汰队）用「?」盾牌占位。
    if (!entry || entry.__placeholder) return `<span class="sw2-result-team tbd" role="img" aria-label="待定">${TBD_SHIELD}<b>待定</b></span>`;
    return `<span class="sw2-result-team" title="${escapeHtml(entry.team.name)}" role="img" aria-label="${escapeHtml(entry.team.name)}">${logoHtml(entry.team.logo, entry.team.darkLogo)}<b>${escapeHtml(entry.team.shortName || entry.team.name)}</b></span>`;
}

function swissResultBucketsForLabels(finalBuckets, labels) {
    const byLabel = new Map(finalBuckets.map(bucket => [bucket.label, bucket]));
    return labels.map(label => byLabel.get(label)).filter(Boolean);
}

function swissResultBucketClean(bucket) {
    return `<div class="sw2-result-bucket ${escapeHtml(bucket.tone)}">
        <div class="sw2-label">${escapeHtml(swissGraphLabel(bucket.label))} ${bucket.tone === 'advance' ? '晋级' : '淘汰'}</div>
        <div class="sw2-result-teams">${bucket.teams.map(swissResultTeamClean).join('')}</div>
    </div>`;
}

function swissResultZoneClean(buckets, position) {
    if (!buckets.length) return '';
    return `<div class="sw2-result-zone ${position}">
        ${buckets.map(swissResultBucketClean).join('')}
    </div>`;
}

function swissRoundColumnClean(group, finalBuckets) {
    const round = group.round || Number((String(group.label || '').match(/\d+/) || [0])[0]);
    const topResults = round === 4
        ? swissResultBucketsForLabels(finalBuckets, ['3-0晋级'])
        : round === 5
            ? swissResultBucketsForLabels(finalBuckets, ['3-1晋级', '3-2晋级'])
            : [];
    const bottomResults = round === 4
        ? swissResultBucketsForLabels(finalBuckets, ['0-3淘汰'])
        : round === 5
            ? swissResultBucketsForLabels(finalBuckets, ['1-3淘汰', '2-3淘汰'])
            : [];
    return `<section class="sw2-column">
        <div class="sw2-round-title">${escapeHtml(group.label)}</div>
        <div class="sw2-buckets">
            ${swissResultZoneClean(topResults, 'top')}
            <div class="sw2-round-buckets">
                ${group.buckets.map(bucket => `<div class="sw2-bucket ${escapeHtml(bucket.tone)}" style="--sw-diff:${(bucket.wins || 0) - (bucket.losses || 0)}">
                    <div class="sw2-label">${escapeHtml(swissGraphLabel(bucket.label))}</div>
                    <div class="sw2-match-list">${bucket.matches.map(swissMatchNodeClean).join('')}</div>
                </div>`).join('')}
            </div>
            ${swissResultZoneClean(bottomResults, 'bottom')}
        </div>
    </section>`;
}

function swissDiagram(roundGroups) {
    if (!roundGroups.length) return '';
    // 标准 16 队瑞士轮：画完整骨架（HLTV 风格）——未来轮次/未定对阵用「?」盾牌补齐，
    // 右侧晋级/淘汰框始终展示，即使尚无队伍进出线。
    const skeleton = detectSwiss16(roundGroups);
    const groupedRounds = swissRoundBuckets(roundGroups, skeleton);
    const finalBuckets = swissFinalBuckets(roundGroups, skeleton);
    // 非骨架赛事沿用「只显示已有对阵」：整轮无桶且无结果区的列跳过，避免空列。
    const resultLabelsForRound = round => round === 4
        ? ['3-0晋级', '0-3淘汰']
        : round === 5
            ? ['3-1晋级', '3-2晋级', '1-3淘汰', '2-3淘汰']
            : [];
    const visibleRounds = skeleton ? groupedRounds : groupedRounds.filter(group => {
        const round = group.round || Number((String(group.label || '').match(/\d+/) || [0])[0]);
        if (group.buckets.length) return true;
        return swissResultBucketsForLabels(finalBuckets, resultLabelsForRound(round)).length > 0;
    });
    if (!visibleRounds.length) return '';
    return `<div class="swiss-bracket-clean" style="--swiss-round-count:${visibleRounds.length};--swiss-cols:repeat(${visibleRounds.length},minmax(0,1fr))" aria-label="瑞士轮赛程图">
        ${visibleRounds.map(group => swissRoundColumnClean(group, finalBuckets)).join('')}
    </div>`;
}

function playoffRoundLabel(match) {
    const source = String(match.name || match.stage_name || '').toLowerCase();
    if (source.includes('upper bracket') || source.includes('lower bracket') || source.includes('胜者组') || source.includes('败者组')) return null;
    const roundOf = source.match(/\bround\s+of\s+(128|64|32|16|8|4|2)\b/i);
    if (roundOf) {
        const size = Number(roundOf[1]);
        if (size === 8) return { key: '70-quarterfinals', label: '四分之一决赛', order: 70 };
        if (size === 4) return { key: '80-semifinals', label: '半决赛', order: 80 };
        if (size === 2) return { key: '90-final', label: '决赛', order: 90 };
        // Round of N 必须按「N 越大越早」排序，不能与 QF/SF/Final 的 70/80/90 冲突。
        const order = { 128: 10, 64: 20, 32: 30, 16: 40 }[size] || 50;
        return { key: `${String(order).padStart(3, '0')}-round-of-${size}`, label: `Round of ${size}`, order };
    }
    if (source.includes('quarter') || source.includes('四分之一')) return { key: '70-quarterfinals', label: '四分之一决赛', order: 70 };
    if (source.includes('semi') || source.includes('半决赛')) return { key: '80-semifinals', label: '半决赛', order: 80 };
    if (source.includes('grand final') || source.includes('总决赛')) return { key: '90-final', label: '决赛', order: 90 };
    if ((/\bfinals?\b/.test(source) || source.includes('决赛')) && !/bracket/.test(source)) return { key: '90-final', label: '决赛', order: 90 };
    return null;
}

function playoffDisplayLabel(label) {
    if (/round of\s+\d+/i.test(label)) return label.match(/round of\s+\d+/i)[0].replace(/^round/i, 'Round');
    if (label.includes('四分之一') || label.toLowerCase().includes('quarter')) return 'Quarter-finals';
    if (label.includes('半决赛') || label.toLowerCase().includes('semi')) return 'Semi-finals';
    if (label.includes('胜者组') || label.toLowerCase().includes('upper bracket')) return 'Upper bracket final';
    if (label.includes('败者组') || label.toLowerCase().includes('lower bracket')) return 'Lower bracket final';
    if (label.includes('决赛') || label.toLowerCase().includes('grand final')) return 'Grand final';
    return label;
}

function playoffGroupsFromMatches(matches) {
    const sorted = [...matches].sort(bracketMatchCompare);
    const detected = new Map();
    for (const match of sorted) {
        const round = playoffRoundLabel(match);
        if (!round) continue;
        if (!detected.has(round.key)) detected.set(round.key, { ...round, matches: [] });
        detected.get(round.key).matches.push(match);
    }
    const unmatched = sorted.filter(match => !playoffRoundLabel(match));
    const groups = [...detected.values()]
        .sort((a, b) => (a.order || 0) - (b.order || 0) || a.key.localeCompare(b.key))
        .map(group => ({ ...group, matches: group.matches.sort(bracketMatchCompare) }));
    if (unmatched.length) groups.push({ key: '99-other-knockout', label: groups.length ? '其他淘汰赛' : '淘汰赛', order: 99, matches: unmatched });
    return groups;
}

function isPlayoffStage(group) {
    const source = `${group.label || ''} ${stageMatches(group).map(match => match.name || '').join(' ')}`.toLowerCase();
    if (source.includes('group') || source.includes('小组')) return false;
    return source.includes('playoff') || /round\s+of\s+(128|64|32|16|8|4|2)/i.test(source) || source.includes('quarter') || source.includes('semi') || source.includes('upper bracket') || source.includes('lower bracket') || source.includes('胜者组') || source.includes('败者组') || source.includes('淘汰') || source.includes('决赛') || (/\bfinal\b/.test(source) && !/bracket/.test(source));
}

function isCompactBracketViewport() {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
}

// 移动端窄列判定：整轮未定（TBD/占位）或已全部结束的列可隐藏队名缩短列宽。
function isCompactableColumn(matches) {
    return matches.length > 0 && matches.every(match => match.__placeholder || isTbdMatch(match) || match.status === 'finished');
}

// 移动端窄列策略：可压缩列默认收窄；存在活跃列（进行中/未赛）时活跃列本就全宽，
// 其余可压缩列全部收窄；所有列均可压缩（赛事已完结）时保留最右侧一列全宽展示最终结果。
function computeNarrowFlags(matchGroups) {
    const compactable = matchGroups.map(matches => isCompactableColumn(matches));
    const hasActive = compactable.some(flag => !flag);
    const keepIndex = hasActive ? -1 : compactable.lastIndexOf(true);
    return compactable.map((flag, index) => flag && index !== keepIndex);
}

function playoffLayout(groups, narrowFlags = null) {
    const compact = isCompactBracketViewport();
    const cardW = compact ? 150 : 160;
    const narrowW = compact ? 92 : 116;
    const cardH = compact ? 56 : 60;
    const xGap = compact ? 28 : 40;
    // 行间距需容纳未开赛卡片上方的开赛时间角标（约 11px 高），过窄会与上一行卡片贴住
    const yGap = compact ? 18 : 20;
    const startX = compact ? 8 : 20;
    const startY = compact ? 42 : 54;
    const widths = groups.map((_, index) => narrowFlags && narrowFlags[index] ? narrowW : cardW);
    const xs = [];
    let cursor = startX;
    for (const width of widths) {
        xs.push(cursor);
        cursor += width + xGap;
    }
    const ys = [];
    const lines = [];
    for (let roundIndex = 0; roundIndex < groups.length; roundIndex++) {
        const count = groups[roundIndex].matches.length;
        const previous = roundIndex > 0 ? groups[roundIndex - 1].matches.length : 0;
        if (roundIndex > 0 && previous === count * 2) {
            ys.push(Array.from({ length: count }, (_, index) => {
                const a = ys[roundIndex - 1][index * 2];
                const b = ys[roundIndex - 1][index * 2 + 1];
                const targetY = (a + b) / 2;
                const fromRight = xs[roundIndex - 1] + widths[roundIndex - 1];
                const toLeft = xs[roundIndex];
                const joinX = Math.round((fromRight + toLeft) / 2);
                const aCenter = a + cardH / 2;
                const bCenter = b + cardH / 2;
                const targetCenter = targetY + cardH / 2;
                lines.push(`M${fromRight},${aCenter} H${joinX}`, `M${fromRight},${bCenter} H${joinX}`, `M${joinX},${aCenter} V${bCenter}`, `M${joinX},${targetCenter} H${toLeft}`);
                return targetY;
            }));
        } else {
            ys.push(Array.from({ length: count }, (_, index) => startY + index * (cardH + yGap)));
        }
    }
    return {
        w: xs[xs.length - 1] + widths[widths.length - 1] + startX,
        h: Math.max(compact ? 170 : 220, Math.max(...ys.map(round => (round.at(-1) || startY) + cardH + (compact ? 26 : 40)))),
        cardW,
        cardH,
        widths,
        xs,
        ys,
        lines
    };
}

function playoffTeamRowClean(match, side, dropsToLower = false) {
    const outcome = bracketGraphEngine.result(match);
    const score = outcome.scores[side - 1];
    const finished = outcome.finished;
    const won = outcome.winner === side;
    const logo = side === 1 ? match.team1_logo_url : match.team2_logo_url;
    const darkLogo = side === 1 ? match.team1_dark_logo_url : match.team2_dark_logo_url;
    const name = side === 1 ? match.team1_name : match.team2_name;
    const isTbd = (name || '') === 'TBD' || match.__placeholder;
    // 只有已结束的比赛才分胜/负（绿/红条）；未结束（含 TBD）一律中性 pending，不显示红条。
    const tone = won ? 'winner' : outcome.winner ? 'loser' : 'pending';
    return `<div class="pb2-team ${tone}">
        <span class="pb2-bar"></span>
        ${isTbd ? TBD_SHIELD : logoHtml(logo, darkLogo)}
        <b title="${escapeHtml(name || 'TBD')}">${escapeHtml(teamShortName(match, side))}</b>
        <strong>${dropsToLower && tone === 'loser' ? '<i class="bracket-drop" title="落入败者组" aria-label="落入败者组">↓</i>' : ''}${finished ? escapeHtml(score ?? '—') : '—'}</strong>
    </div>`;
}

function playoffCardClean(match, dropsToLower = false) {
    const title = match.name || '淘汰赛';
    const tbd = isTbdMatch(match);
    const live = !match.__placeholder && !tbd && isLiveMatch(match);
    const clickable = !match.__placeholder && !match.__noLink && !!match.id;
    const action = clickable ? bracketCardAction(match) : '';
    const interaction = action
        ? `role="button" tabindex="0" onclick="${action}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${action}}"`
        : '';
    return `<div class="pb2-card ${match.status || ''} ${tbd ? 'tbd' : ''} ${live ? 'live' : ''}" ${interaction} title="${escapeHtml(title)}">
        ${playoffTeamRowClean(match, 1, dropsToLower)}
        ${playoffTeamRowClean(match, 2, dropsToLower)}
    </div>`;
}

function playoffDiagram(matches) {
    // 淘汰赛画完整骨架：即使对阵未定（TBD）也保留卡片与连接线，
    // 用问号盾牌 + TBD 占位，直观展示完整赛制结构。
    const groups = playoffGroupsFromMatches(matches || []);
    if (!groups.length) return '';
    // 保留每轮的队名和比分，通过外层视口横向浏览。
    const narrowFlags = groups.map(() => false);
    const layout = playoffLayout(groups, narrowFlags);
    return `<div class="playoff-bracket-clean" aria-label="淘汰赛赛程图">
        <div class="pb2-layout" style="--pb2-w:${layout.w}px;--pb2-h:${layout.h}px;--pb2-card-w:${layout.cardW}px;--pb2-card-h:${layout.cardH}px">
            <svg class="pb2-lines" viewBox="0 0 ${layout.w} ${layout.h}" aria-hidden="true">
                ${layout.lines.map(path => `<path d="${path}"></path>`).join('')}
            </svg>
            ${groups.map((group, roundIndex) => `<div class="pb2-title" style="left:${layout.xs[roundIndex]}px;top:18px;width:${layout.widths[roundIndex]}px">${escapeHtml(playoffDisplayLabel(group.label))}</div>`).join('')}
            ${groups.map((group, roundIndex) => group.matches.map((match, index) => `<div class="pb2-slot${narrowFlags[roundIndex] ? ' pb2-narrow' : ''}" style="left:${layout.xs[roundIndex]}px;top:${layout.ys[roundIndex][index]}px;width:${layout.widths[roundIndex]}px;height:${layout.cardH}px">${bracketWhenChip(match)}${playoffCardClean(match)}</div>`).join('')).join('')}
        </div>
    </div>`;
}

function bracketTeamState(match, side, flow = null) {
    const outcome = bracketGraphEngine.result(match);
    const finished = outcome.finished;
    const won = outcome.winner === side;
    return {
        finished,
        won,
        tone: won ? 'winner' : outcome.winner ? 'loser' : 'pending',
        marker: flow === 'drop' && outcome.winner && !won ? 'drop' : flow === 'advance' && won ? 'advance' : null
    };
}

function bracketTeamRowClean(match, side, prefix = 'de', flow = null) {
    const score = side === 1 ? match.team1_score : match.team2_score;
    const state = bracketTeamState(match, side, flow);
    const logo = side === 1 ? match.team1_logo_url : match.team2_logo_url;
    const darkLogo = side === 1 ? match.team1_dark_logo_url : match.team2_dark_logo_url;
    // 箭头与比分合并为右对齐整体（"↓0"），不再单独占一列，避免收窄时错位。
    const marker = state.marker === 'drop'
        ? '<i class="de-flow drop" title="掉入败者组" aria-label="掉入败者组">↓</i>'
        : state.marker === 'advance'
            ? '<i class="de-flow advance" title="晋级 Playoffs" aria-label="晋级 Playoffs">→</i>'
            : '';
    return `<div class="${prefix}-team ${state.tone}">
        <span class="${prefix}-bar"></span>
        ${logoHtml(logo, darkLogo)}
        <b>${escapeHtml(teamShortName(match, side))}</b>
        <strong>${marker}${state.finished ? escapeHtml(score ?? '—') : '—'}</strong>
    </div>`;
}

function compactBracketCard(match, prefix = 'de', flow = null) {
    const title = match.name || 'Bracket match';
    const tbd = isTbdMatch(match);
    const live = !match.__placeholder && !tbd && isLiveMatch(match);
    const clickable = !match.__placeholder && !match.__noLink && !!match.id;
    const action = clickable ? bracketCardAction(match) : '';
    const interaction = action
        ? `role="button" tabindex="0" onclick="${action}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${action}}"`
        : '';
    return `<div class="${prefix}-card ${match.status || ''} ${tbd ? 'tbd' : ''} ${live ? 'live' : ''}" ${interaction} title="${escapeHtml(title)}">
        ${bracketTeamRowClean(match, 1, prefix, flow)}
        ${bracketTeamRowClean(match, 2, prefix, flow)}
    </div>`;
}

function bracketKind(match) {
    const name = String(match.name || '').toLowerCase();
    const bracketRound = name.match(/\b(upper|lower)\s+bracket\s+round\s+(\d+)\b/i);
    if (bracketRound) return { side: bracketRound[1], round: Number(bracketRound[2]), label: `Round ${bracketRound[2]}`, kind: `${bracketRound[1]}-round-${bracketRound[2]}` };
    const bracketNamed = name.match(/\b(upper|lower)\s+bracket\s+(quarterfinals?|semifinals?|finals?)\b/i);
    if (bracketNamed) {
        const token = bracketNamed[2].toLowerCase();
        const round = token.startsWith('quarter') ? 70 : token.startsWith('semi') ? 80 : 90;
        const label = token.startsWith('quarter') ? 'Quarter-finals' : token.startsWith('semi') ? 'Semi-finals' : 'Final';
        return { side: bracketNamed[1], round, label, kind: `${bracketNamed[1]}-${round}` };
    }
    if (name.includes('grand final')) return { side: 'grand', round: 100, label: 'Grand final', kind: 'grand-final' };
    if (name.includes('3rd place') || name.includes('third place')) return { side: 'medal', round: 100, label: '3rd Place', kind: 'third-place' };
    const playoff = playoffRoundLabel(match);
    return playoff ? { side: 'single', round: playoff.order, label: playoffDisplayLabel(playoff.label), kind: playoff.key } : null;
}

function matchesByBracketKind(matches) {
    const map = new Map();
    for (const match of [...matches].sort(bracketMatchCompare)) {
        const meta = bracketKind(match);
        if (!meta) continue;
        if (!map.has(meta.kind)) map.set(meta.kind, { ...meta, matches: [] });
        map.get(meta.kind).matches.push(match);
    }
    return map;
}

function bracketMatchPosition(match) {
    const name = String(match.name || '');
    const explicitMatch = name.match(/\bmatch\s*(\d+)\b/i);
    if (explicitMatch) return Number(explicitMatch[1]);
    const namedRound = name.match(/\b(?:quarterfinals?|semifinals?|finals?)\s*(\d+)\b/i);
    if (namedRound) return Number(namedRound[1]);
    return Number.MAX_SAFE_INTEGER;
}

function bracketMatchCompare(a, b) {
    const position = bracketMatchPosition(a) - bracketMatchPosition(b);
    if (position !== 0) return position;
    const time = new Date(a.match_time || 0) - new Date(b.match_time || 0);
    return time || Number(a.id || 0) - Number(b.id || 0);
}

function bracketTeamKeys(match) {
    return [teamRecordKey(match, 1), teamRecordKey(match, 2)].filter(Boolean);
}

function matchTouchesTeamSet(match, teamSet) {
    return bracketTeamKeys(match).some(key => teamSet.has(key));
}

function addMatchTeamsToSet(match, teamSet) {
    for (const key of bracketTeamKeys(match)) teamSet.add(key);
}

function collectConnectedMatches(matches, teamSet) {
    const selected = [];
    let changed = true;
    while (changed) {
        changed = false;
        for (const match of matches || []) {
            if (selected.includes(match) || !matchTouchesTeamSet(match, teamSet)) continue;
            selected.push(match);
            addMatchTeamsToSet(match, teamSet);
            changed = true;
        }
    }
    return selected.sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id);
}

function doubleElimRounds(map, side) {
    return [...map.values()]
        .filter(group => group.side === side)
        .sort((a, b) => a.round - b.round || a.kind.localeCompare(b.kind))
        .map(group => ({ ...group, matches: uniqueMatches(group.matches).sort(bracketMatchCompare) }));
}

function doubleElimRound(label, matches, laneHeight, cardHeight, flow = null, narrow = false, extraClass = '') {
    const countClass = `count-${Math.max(matches.length, 1)}`;
    const slotHeight = matches.length ? laneHeight / matches.length : laneHeight;
    return `<section class="de-round ${countClass}${narrow ? ' de-narrow' : ''} ${extraClass}">
        <div class="de-round-title">${escapeHtml(label)}</div>
        <div class="de-card-list bracket-positioned" style="height:${laneHeight}px">${matches.map((match, index) => {
            const top = Math.round((index + 0.5) * slotHeight - cardHeight / 2);
            // 时间/LIVE 角标挂在 slot 上（卡片自身 overflow:hidden 会裁掉悬挂角标）
            return `<div class="de-card-slot" style="top:${top}px;height:${cardHeight}px">${bracketWhenChip(match)}${compactBracketCard(match, 'de', flow)}</div>`;
        }).join('') || '<div class="de-empty">TBD</div>'}</div>
    </section>`;
}

function doubleElimLane(label, rounds, tone, bracketNarrowFlags = null) {
    const cardHeight = 48;
    // 行间距需容纳未开赛卡片上方的开赛时间角标（约 11px 高），14px 起才不显局促
    const cardGap = 14;
    const maxMatches = Math.max(1, ...rounds.map(round => round.matches.length));
    // 按精确间距计算：最多对阵数的轮次里相邻卡片的实际间隙 == cardGap
    const laneHeight = maxMatches * (cardHeight + cardGap);
    return `<div class="de-lane ${tone}">
        <div class="de-lane-label">${escapeHtml(label)}</div>
        <div class="de-lane-rounds" style="--de-round-count:${Math.max(rounds.length, 1)}">${rounds.map((round, index) => {
            const flow = tone === 'upper' && index < rounds.length - 1 ? 'drop' : index === rounds.length - 1 ? 'advance' : null;
            // 窄列旗标由 doubleElimDiagram 按整图统一计算（UB/LB 下标对齐），两条泳道列宽保持一致
            const narrow = bracketNarrowFlags ? bracketNarrowFlags[index] === true : false;
            return doubleElimRound(round.label, round.matches, laneHeight, cardHeight, flow, narrow);
        }).join('')}</div>
    </div>`;
}

function finalBracketOverview(map) {
    const matches = uniqueMatches([...map.values()].filter(group => group.side === 'single' || group.side === 'grand').flatMap(group => group.matches))
        .sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id);
    if (!matches.length) return '';
    return `<section class="de-finals major-style-playoffs">
        <h4>Playoffs</h4>
        ${playoffDiagram(matches)}
    </section>`;
}

function doubleElimDiagram(matches) {
    const map = matchesByBracketKind(matches || []);
    const upperRounds = doubleElimRounds(map, 'upper');
    const lowerRounds = doubleElimRounds(map, 'lower');
    const hasDoubleElim = upperRounds.length && lowerRounds.length;
    if (!hasDoubleElim) return '';
    // 移动端窄列：按「轮次下标」合并上下泳道的比赛统一判定，UB/LB 同列同宽；
    // 全部可压缩时保留最右一列全宽展示最终结果。
    const laneCount = Math.max(upperRounds.length, lowerRounds.length);
    const roundsByIndex = Array.from({ length: laneCount }, (_, index) => [
        ...(upperRounds[index]?.matches || []),
        ...(lowerRounds[index]?.matches || [])
    ]);
    const narrowFlags = isCompactBracketViewport()
        ? computeNarrowFlags(roundsByIndex)
        : roundsByIndex.map(() => false);
    return `<div class="de-bracket-clean" aria-label="赛事赛程图">
        <div class="de-overview-title">Bracket overview</div>
        <section class="de-group de-full-bracket">
            ${doubleElimLane('Upper bracket', upperRounds, 'upper', narrowFlags)}
            ${doubleElimLane('Lower bracket', lowerRounds, 'lower', narrowFlags)}
        </section>
        ${finalBracketOverview(map)}
    </div>`;
}

function tournamentOverviewDiagram(matches) {
    return doubleElimDiagram(matches);
}

function uniqueMatches(matches) {
    const seen = new Set();
    return matches.filter(match => {
        const key = match.id || `${match.name || ''}-${match.match_time || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
function doubleElimTournamentStages(matches) {
    const partitions = new Map();
    const bracketMatches = matches.filter(match => {
        const meta = bracketKind(match);
        return meta && ['upper', 'lower', 'single', 'grand', 'medal'].includes(meta.side);
    });
    const externalIds = [...new Set(bracketMatches.map(match => match.stage_external_id).filter(Boolean))];
    const singleExternalBracket = externalIds.length <= 1;
    for (const match of bracketMatches) {
        const meta = bracketKind(match);
        const externalKey = match.stage_external_id || (singleExternalBracket ? 'inferred-playoffs' : match.stage_name || 'inferred-playoffs');
        const key = externalKey ? `api-${externalKey}` : 'inferred-playoffs';
        if (!partitions.has(key)) partitions.set(key, { key, matches: [] });
        partitions.get(key).matches.push(match);
    }
    const stages = [];
    for (const partition of partitions.values()) {
        const map = matchesByBracketKind(partition.matches);
        const upperRounds = doubleElimRounds(map, 'upper');
        const lowerRounds = doubleElimRounds(map, 'lower');
        if (!upperRounds.length || !lowerRounds.length) continue;
        const labelCandidates = partition.matches.map(match => match.stage_name).filter(Boolean);
        const distinctLabels = [...new Set(labelCandidates)];
        const label = labelCandidates.find(name => /play-?in|playoff|knockout/i.test(name))
            || (distinctLabels.length === 1 ? distinctLabels[0] : 'Playoffs');
        stages.push({
            key: `double-elim-${partition.key}`,
            label,
            type: 'double-elim-bracket',
            matches: uniqueMatches(partition.matches).sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id)
        });
    }
    if (!stages.length) return null;
    const consumed = new Set(stages.flatMap(stage => stage.matches).map(match => match.id));
    const leftovers = matches.filter(match => !consumed.has(match.id));
    if (leftovers.length) stages.push(...explicitRoundTournamentStages(leftovers));
    return sortTournamentStages(stages);
}


function matchRoundNumberFromStage(match) {
    const nameRound = String(match.name || '').match(/(?:round|r)[\s-]*(\d+)/i);
    if (nameRound) return Number(nameRound[1]);
    const source = `${match.stage_name || ''} ${match.stage_slug || ''}`;
    const round = source.match(/(?:round|r)[\s-]*(\d+)/i);
    return round ? Number(round[1]) : null;
}

function isPlayoffRoundMatch(match) {
    const source = `${match.stage_name || ''} ${match.stage_slug || ''} ${match.name || ''}`.toLowerCase();
    if (source.includes('upper bracket') || source.includes('lower bracket')) return false;
    if (source.includes('3rd place') || source.includes('third place') || source.includes('decider')) return false;
    return /round\s+of\s+(128|64|32|16|8|4|2)/.test(source) || source.includes('quarterfinal') || source.includes('semi') || source.includes('grand final') || /\bfinal\b/.test(source);
}

function isThirdPlaceMatch(match) {
    const source = `${match.stage_name || ''} ${match.stage_slug || ''} ${match.name || ''}`.toLowerCase();
    return source.includes('3rd place') || source.includes('third place') || source.includes('decider');
}

function swissPlayoffTournamentStages(matches) {
    const roundGroups = new Map();
    const playoffMatches = [];
    const thirdPlaceMatches = [];
    const consumed = new Set();
    for (const match of matches) {
        const round = matchRoundNumberFromStage(match);
        if (round && round >= 1 && round <= 5) {
            const key = `round-${String(round).padStart(2, '0')}`;
            if (!roundGroups.has(key)) roundGroups.set(key, { key, label: `Round ${round}`, round, matches: [] });
            roundGroups.get(key).matches.push(match);
            consumed.add(match.id);
            continue;
        }
        if (isThirdPlaceMatch(match)) {
            thirdPlaceMatches.push(match);
            consumed.add(match.id);
            continue;
        }
        if (isPlayoffRoundMatch(match)) {
            playoffMatches.push(match);
            consumed.add(match.id);
        }
    }
    if (!roundGroups.size || !playoffMatches.length) return null;
    const stages = [{
        key: 'swiss-stage-01',
        label: 'Swiss Stage',
        type: 'swiss-stage',
        groups: [...roundGroups.values()]
            .sort((a, b) => a.round - b.round)
            .map(group => ({
                ...group,
                matches: group.matches.sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id)
            }))
    }];
    stages.push({
        key: 'single-elim-playoffs',
        label: 'Playoffs',
        type: 'single-elim-playoffs',
        matches: uniqueMatches(playoffMatches).sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id)
    });
    if (thirdPlaceMatches.length) {
        stages.push({
            key: 'single-elim-third-place',
            label: '3rd Place',
            type: 'single-elim-third-place',
            matches: uniqueMatches(thirdPlaceMatches).sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id)
        });
    }
    const leftovers = matches.filter(match => !consumed.has(match.id));
    if (leftovers.length) {
        stages.push(...sortTournamentStages(splitRepeatedSwissStages(groupMatches(leftovers))));
    }
    return stages;
}

function explicitRoundTournamentStages(matches) {
    const roundGroups = new Map();
    const leftovers = [];
    for (const match of matches) {
        const source = `${match.stage_name || ''} ${match.name || ''}`.toLowerCase();
        const round = matchRoundNumberFromStage(match);
        if (!round || round > 9 || source.includes('upper bracket') || source.includes('lower bracket') || /round\s+of\s+\d+/.test(source)) {
            leftovers.push(match);
            continue;
        }
        const key = `round-${String(round).padStart(2, '0')}`;
        if (!roundGroups.has(key)) roundGroups.set(key, { key, label: `Round ${round}`, round, matches: [] });
        roundGroups.get(key).matches.push(match);
    }
    const stages = [];
    if (roundGroups.size >= 2) {
        stages.push({
            key: 'explicit-round-stage',
            label: 'Swiss Stage',
            type: 'swiss-stage',
            groups: [...roundGroups.values()].sort((a, b) => a.round - b.round)
        });
    } else {
        leftovers.push(...[...roundGroups.values()].flatMap(group => group.matches));
    }
    if (leftovers.length) stages.push(...sortTournamentStages(splitRepeatedSwissStages(groupMatches(leftovers))));
    return stages;
}

function normalizeTournamentStageMatches(stages) {
    const seen = new Set();
    return (stages || []).map(stage => {
        if (stage.groups) {
            const groups = stage.groups.map(group => ({
                ...group,
                matches: (group.matches || []).filter(match => {
                    if (seen.has(match.id)) return false;
                    seen.add(match.id);
                    return true;
                })
            })).filter(group => group.matches.length);
            return { ...stage, groups };
        }
        const stageMatches = (stage.matches || []).filter(match => {
            if (seen.has(match.id)) return false;
            seen.add(match.id);
            return true;
        });
        return { ...stage, matches: stageMatches };
    }).filter(stage => stage.groups ? stage.groups.length : stage.matches.length);
}

function structureExplicitStages(stages) {
    return (stages || []).map(stage => {
        const matches = stageMatches(stage);
        const rounds = roundGroupsFromMatches(matches);
        // 不再只认 "swiss" 字样：PandaScore 常把 16 队瑞士轮直接命名为 "Group Stage"。
        if (rounds.length >= 2 && looksLikeSwissStage(matches, stage.label)) {
            return { ...stage, type: 'swiss-stage', groups: rounds, matches: undefined };
        }
        return stage;
    });
}

function buildBracketModel(matches) {
    const source = uniqueMatches(matches || []);
    const explicitStages = structureExplicitStages(sortTournamentStages(splitRepeatedSwissStages(groupMatches(source))));
    const inferred = doubleElimTournamentStages(source)
        || (source.some(match => match.stage_external_id) ? explicitStages : swissPlayoffTournamentStages(source))
        || explicitRoundTournamentStages(source);
    const stages = normalizeTournamentStageMatches(inferred);
    const classifiedMatchIds = new Set(stages.flatMap(stage => stageMatches(stage)).map(match => match.id));
    const unclassifiedMatches = source.filter(match => !classifiedMatchIds.has(match.id));
    if (unclassifiedMatches.length) {
        stages.push({ key: '99-unclassified', label: '其他赛程', type: 'unclassified', matches: unclassifiedMatches });
    }
    const renderedIds = stages.flatMap(stage => stageMatches(stage)).map(match => match.id);
    return {
        format: stages.some(stage => stage.type === 'double-elim-bracket') ? 'double-elimination' : stages.some(stage => stage.type === 'swiss-stage') ? 'swiss' : 'staged',
        stages,
        classifiedMatchIds: [...classifiedMatchIds],
        unclassifiedMatches,
        diagnostics: {
            inputCount: source.length,
            renderedCount: renderedIds.length,
            uniqueRenderedCount: new Set(renderedIds).size,
            duplicateInputCount: Math.max(0, (matches || []).length - source.length)
        }
    };
}

function buildTournamentStages(matches) {
    return buildBracketModel(matches).stages;
}
function renderStageDiagram(group, roundGroups = null) {
    // 官方 edges 驱动的阶段即使本地还没有比赛，也要按节点骨架渲染。
    if (group.type === 'official-single') return officialSingleDiagram(group);
    if (group.type === 'official-double') return officialDoubleDiagram(group);
    if (group.type === 'gsl-group') return gslGroupDiagram(group.officialMatches || group.matches || [], group.edges || []);
    const matches = stageMatches(group);
    if (!matches.length) return '';
    const label = (group.label || '').toLowerCase();
    const matchNames = matches.map(match => match.name || '').join(' ').toLowerCase();
    if (group.type === 'double-elim-bracket') return doubleElimDiagram(matches);
    if (group.type === 'group-stage') return groupDiagram(matches);
    if (matchNames.includes('upper bracket') || matchNames.includes('lower bracket')) return '';
    if (group.groups) return swissDiagram(group.groups);
    if (isGslGroupStage(matches)) return gslGroupDiagram(matches, []);
    if (isRoundRobinGroupStage(group, matches)) return groupDiagram(matches);
    if (isPlayoffStage(group)) return playoffDiagram(matches);
    // 季军赛：单独一场（或数场）决胜局，作为独立小卡片展示，回答「是否有季军赛」。
    if (label.includes('3rd') || label.includes('third') || label.includes('季军') || matchNames.includes('3rd place') || matchNames.includes('third place')) {
        return thirdPlaceDiagram(matches);
    }
    const rounds = roundGroups && roundGroups.length ? roundGroups : roundGroupsFromMatches(matches);
    if (rounds.length >= 1 && looksLikeSwissStage(matches, group.label)) return swissDiagram(rounds);
    return '';
}

function stageDiagram(group, roundGroups = null) {
    const diagram = renderStageDiagram(group, roundGroups);
    if (!diagram) return '';
    const diagnostics = group.graphDiagnostics || {};
    const incomplete = group.unlinkedCount || diagnostics.danglingEdges || diagnostics.cyclicNodes || diagnostics.invalidEdges;
    const unpublished = /^official-/.test(group.type || '') && group.officialMatches?.length > 1 && !group.edges?.length;
    const note = incomplete ? '部分晋级关系待确认' : group.bracket_error ? '暂用上次更新的赛程' : unpublished ? '晋级关系待公布' : '';
    const table = diagram.includes('class="group-standings"');
    const swiss = group.type === 'swiss-stage' || !!group.groups;
    const legend = table ? '<span>小组战绩</span>' : swiss ? '<span>按赛前战绩分组</span>'
        : '<span><i class="bracket-key-line"></i>晋级</span><span><i class="bracket-drop" aria-hidden="true">↓</i>落入败者组</span>';
    return `<div class="bracket-view${swiss ? ' bracket-swiss' : ''}" data-bracket-view>
        <div class="bracket-toolbar">
            <div class="bracket-key">${legend}${diagram.includes('bracket-chip live') ? '<span class="bracket-live-key"><i aria-hidden="true"></i>LIVE 进行中</span>' : ''}${note ? `<span class="bracket-note">${note}</span>` : ''}<span class="bracket-overflow-hint">左右滑动查看更多</span></div>
            ${table ? '' : '<div class="bracket-controls"><button type="button" data-bracket-nav="-1" aria-label="查看上一轮">←</button><output class="bracket-round-index" aria-live="polite" aria-atomic="true"></output><button type="button" data-bracket-nav="1" aria-label="查看下一轮">→</button><button type="button" data-bracket-nav="current">定位当前</button></div>'}
        </div>
        <div class="bracket-scroll-shell"><div class="bracket-viewport" tabindex="0" role="region" aria-label="${escapeHtml(group.label || '赛事')}赛程图，可横向滚动">${diagram}</div></div>
    </div>`;
}

// 季军赛骨架：复用 playoff 卡片样式，横排展示决胜局（未定则 TBD 占位）。
function thirdPlaceDiagram(matches) {
    if (!matches || !matches.length) return '';
    const layout = playoffLayout([{ key: '3rd-place', label: '季军赛', matches }]);
    return `<div class="playoff-bracket-clean" aria-label="季军赛赛程图">
        <div class="pb2-layout" style="--pb2-w:${layout.w}px;--pb2-h:${layout.h}px;--pb2-card-w:${layout.cardW}px;--pb2-card-h:${layout.cardH}px">
            <div class="pb2-title" style="left:${layout.xs[0]}px;top:18px;width:${layout.cardW}px">3rd place</div>
            ${matches.map((match, index) => `<div class="pb2-slot" style="left:${layout.xs[0]}px;top:${layout.ys[0][index]}px;width:${layout.cardW}px;height:${layout.cardH}px">${playoffCardClean(match)}</div>`).join('')}
        </div>
    </div>`;
}

function isRoundRobinGroupStage(group, matches) {
    const label = group.label || '';
    if (looksLikeSwissStage(matches, label)) return false;
    return isNamedGroupStage(label) || /group/i.test(label);
}

// 小组循环赛的「图」：用积分榜代替空的 bracket。
function groupStandings(matches) {
    const records = new Map();
    const entry = (match, side) => {
        const key = teamRecordKey(match, side);
        if (!records.has(key)) {
            records.set(key, {
                key,
                team: teamSnapshot(match, side),
                played: 0,
                wins: 0,
                losses: 0,
                mapWins: 0,
                mapLosses: 0
            });
        }
        return records.get(key);
    };
    for (const match of matches || []) {
        if (match.__placeholder || isTbdMatch(match)) continue;
        const left = entry(match, 1);
        const right = entry(match, 2);
        if (match.status !== 'finished') continue;
        left.played += 1;
        right.played += 1;
        const score1 = Number(match.team1_score);
        const score2 = Number(match.team2_score);
        if (Number.isFinite(score1)) {
            left.mapWins += score1;
            right.mapLosses += score1;
        }
        if (Number.isFinite(score2)) {
            right.mapWins += score2;
            left.mapLosses += score2;
        }
        const winningSide = bracketGraphEngine.result(match).winner;
        const winner = winningSide === 1 ? left : winningSide === 2 ? right : null;
        if (winner === left) {
            left.wins += 1;
            right.losses += 1;
        } else if (winner === right) {
            right.wins += 1;
            left.losses += 1;
        }
    }
    return [...records.values()].sort((a, b) =>
        (b.wins - a.wins)
        || ((b.mapWins - b.mapLosses) - (a.mapWins - a.mapLosses))
        || a.team.shortName.localeCompare(b.team.shortName)
    );
}

function groupDiagram(matches) {
    const rows = groupStandings(matches);
    if (!rows.length) return '';
    const body = rows.map((row, index) => `<tr>
        <td class="group-rank">${index + 1}</td>
        <td class="group-team">${logoHtml(row.team.logo, row.team.darkLogo)}<b>${escapeHtml(row.team.shortName)}</b></td>
        <td>${row.played}</td>
        <td>${row.wins}-${row.losses}</td>
        <td>${row.mapWins}-${row.mapLosses}</td>
    </tr>`).join('');
    return `<div class="group-standings" aria-label="小组积分榜">
        <div class="group-standings-title">Group standings</div>
        <table>
            <thead><tr><th>#</th><th>队伍</th><th>场次</th><th>胜-负</th><th>地图分</th></tr></thead>
            <tbody>${body}</tbody>
        </table>
    </div>`;
}

// GSL 组：Opening → Winners/Elimination → Decider。没有官方 edges 时仍按名称渲染三列，
// 避免误判成循环赛积分榜（例如 Thunderpick World Championship 的 Group A/B）。
function isGslGroupStage(matches) {
    return (matches || []).some(match =>
        /\b(winners?'?\s*match|elimination\s*match|decider\s*match)\b/i.test(match.name || ''));
}

function gslRoundDepth(match) {
    const name = String(match.name || '').toLowerCase();
    if (/decider/.test(name)) return 2;
    if (/winners?|elimination/.test(name)) return 1;
    return 0;
}

// 标准 4 队 GSL 布局，对齐 HLTV 样式：
// 上排 Opening round / Winners' match，下排 Elimination match / Decider match。
function gslLayout(nodes, edges, metrics) {
    const opening = nodes.filter(node => node.__round_depth === 0).sort(officialMatchCompare);
    const middle = nodes.filter(node => node.__round_depth === 1).sort((a, b) => {
        const rank = match => (/winners?/i.test(match.name || '') ? 0 : 1);
        return rank(a) - rank(b) || officialMatchCompare(a, b);
    });
    const decider = nodes.filter(node => node.__round_depth === 2).sort(officialMatchCompare);
    if (opening.length !== 2 || middle.length !== 2 || decider.length !== 1) return null;
    const xs = [0, 1, 2].map(index => metrics.startX + index * (metrics.cardW + metrics.xGap));
    const topY = metrics.startY;
    // 两排之间留出 "Elimination match / Decider match" 子标题和未开赛时间角标的空间。
    const bottomY = metrics.startY + metrics.cardH + metrics.yGap + (metrics.compact ? 26 : 32);
    const positions = new Map();
    opening.forEach((match, index) => positions.set(match.__official_id, { x: xs[0], y: index === 0 ? topY : bottomY }));
    middle.forEach((match, index) => positions.set(match.__official_id, { x: xs[1], y: index === 0 ? topY : bottomY }));
    positions.set(decider[0].__official_id, { x: xs[2], y: bottomY });
    const byId = new Map(nodes.map(node => [node.__official_id, node]));
    const lines = [];
    for (const edge of edges) {
        if (!byId.has(edge.match_external_id) || !byId.has(edge.source_external_match_id)) continue;
        const source = positions.get(edge.source_external_match_id);
        const target = positions.get(edge.match_external_id);
        if (!source || !target) continue;
        const fromRight = source.x + metrics.cardW;
        const toLeft = target.x;
        if (fromRight >= toLeft) continue;
        const joinX = Math.round((fromRight + toLeft) / 2);
        lines.push({ ...edge, d: `M${fromRight},${source.y + metrics.cardH / 2} H${joinX} V${target.y + metrics.cardH / 2} H${toLeft}` });
    }
    return {
        xs,
        topY,
        bottomY,
        width: xs[2] + metrics.cardW + metrics.startX,
        height: Math.max(metrics.compact ? 220 : 260, bottomY + metrics.cardH + (metrics.compact ? 26 : 40)),
        columns: [
            { x: xs[0], matches: opening },
            { x: xs[1], matches: middle },
            { x: xs[2], matches: decider }
        ],
        positions,
        lines
    };
}

function gslGroupDiagram(matches, edges = []) {
    if (!matches || !matches.length) return '';
    const nodes = matches.map(match => ({
        ...match,
        __official_id: match.__official_id || match.external_id || `local:${match.id}`,
        __round_depth: gslRoundDepth(match),
        __round_key: 1000 + gslRoundDepth(match)
    }));
    const model = bracketGraphEngine.graph(nodes, edges || [], gslRoundDepth);
    const laneEdges = model.edges;
    const drops = new Set(laneEdges.filter(edge => edge.source_type === 'loser').map(edge => edge.source_external_match_id));
    const metrics = officialCardMetrics();
    const layout = gslLayout(nodes, laneEdges, metrics);
    if (!layout) {
        return `<div class="official-bracket-clean gsl-bracket" aria-label="GSL 小组赛程图">
            ${officialLaneHtml('', nodes, bracketGraphEngine.layout(model, metrics, undefined, officialMatchCompare), metrics)}
        </div>`;
    }
    const subTitleTop = layout.bottomY - (metrics.compact ? 30 : 36);
    const titles = [
        { x: layout.xs[0], y: 0, text: 'Opening round' },
        { x: layout.xs[1], y: 0, text: "Winners' match" },
        { x: layout.xs[1], y: subTitleTop, text: 'Elimination match' },
        { x: layout.xs[2], y: subTitleTop, text: 'Decider match' }
    ].map(item => `<div class="pb2-title" data-bracket-column="${item.x}" style="left:${item.x}px;top:${item.y}px;width:${metrics.cardW}px">${escapeHtml(item.text)}</div>`).join('');
    const cards = nodes.map(match => {
        const position = layout.positions.get(match.__official_id);
        if (!position) return '';
        return `<div class="pb2-slot bracket-match" data-bracket-match="${escapeHtml(match.__official_id)}" style="left:${position.x}px;top:${position.y}px;width:${metrics.cardW}px;height:${metrics.cardH}px">${bracketWhenChip(match)}${playoffCardClean(match, drops.has(match.__official_id))}</div>`;
    }).join('');
    return `<div class="official-bracket-clean gsl-bracket" aria-label="GSL 小组赛程图">
        <section class="official-lane">
            <div class="official-canvas" style="--pb2-w:${layout.width}px;--pb2-h:${layout.height}px;width:${layout.width}px;height:${layout.height}px">
                <svg class="pb2-lines" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">${bracketLinesHtml(layout.lines)}</svg>
                ${titles}
                ${cards}
            </div>
        </section>
    </div>`;
}

// ---------- 官方 bracket（nodes + edges）----------

function officialStatus(status) {
    if (status === 'not_started') return 'upcoming';
    if (status === 'running') return 'ongoing';
    if (status === 'finished') return 'finished';
    if (status === 'canceled' || status === 'cancelled') return 'cancelled';
    if (status === 'postponed') return 'postponed';
    return 'upcoming';
}

function officialNodeToMatch(node, local, stageExternalId, gameType) {
    const teamName = (side) => {
        const localName = local && local[`team${side}_name`];
        if (localName && localName !== 'TBD') return localName;
        return node[`team${side}_name`] || 'TBD';
    };
    const teamValue = (field, side) => {
        const localValue = local && local[`team${side}_${field}`];
        if (localValue !== undefined && localValue !== null) return localValue;
        return node[`team${side}_${field}`] ?? null;
    };
    return {
        id: local ? local.id : null,
        name: node.name || (local && local.name) || null,
        status: local ? local.status : officialStatus(node.status),
        match_time: (local && local.match_time) || node.scheduled_at || null,
        format: (local && local.format) || null,
        is_forfeit: (local && local.is_forfeit) || 0,
        game_type: (local && local.game_type) || gameType || 'cs2',
        team1_id: local ? local.team1_id : null,
        team2_id: local ? local.team2_id : null,
        team1_name: teamName(1),
        team1_short_name: teamValue('short_name', 1) || teamName(1),
        team1_logo_url: teamValue('logo_url', 1),
        team1_dark_logo_url: teamValue('dark_logo_url', 1),
        team2_name: teamName(2),
        team2_short_name: teamValue('short_name', 2) || teamName(2),
        team2_logo_url: teamValue('logo_url', 2),
        team2_dark_logo_url: teamValue('dark_logo_url', 2),
        team1_score: local ? local.team1_score : null,
        team2_score: local ? local.team2_score : null,
        winner_team_id: local ? local.winner_team_id : null,
        prediction_count: (local && local.prediction_count) || 0,
        correct_prediction_count: (local && local.correct_prediction_count) || 0,
        stage_external_id: stageExternalId,
        __official_id: node.external_match_id,
        __noLink: !local
    };
}

function explicitOfficialRoundKey(match) {
    const kind = bracketKind(match);
    if (kind && Number.isFinite(kind.round)) return kind.round;
    const round = String(match.name || '').match(/\bround\s+(\d+)\b/i);
    if (round) return Number(round[1]);
    const label = playoffRoundLabel(match);
    return label && Number.isFinite(label.order) ? label.order : null;
}

function officialRoundKey(match) {
    return match.__round_key !== undefined ? match.__round_key : explicitOfficialRoundKey(match);
}

// GSL 组（Winners / Elimination / Decider）没有轮次名，需要靠 edges 推导列深。
function assignOfficialRoundKeys(matches, edges) {
    const model = bracketGraphEngine.graph(matches, edges || [], explicitOfficialRoundKey);
    for (const match of matches) {
        match.__round_depth = model.depths.get(match.__official_id) || 0;
        match.__round_key = model.ranks.get(match.__official_id) || 0;
    }
    return model;
}

function officialColumnTitle(matches) {
    const labels = [];
    for (const match of matches || []) {
        const kind = bracketKind(match);
        if (kind) labels.push(playoffDisplayLabel(kind.label));
    }
    const unique = [...new Set(labels)];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) return 'Finals';
    const round = String((matches && matches[0] && matches[0].name) || '').match(/\bround\s+(\d+)\b/i);
    if (round) return `Round ${round[1]}`;
    const depth = matches && matches[0] && Number.isFinite(matches[0].__round_depth) ? matches[0].__round_depth : null;
    return depth !== null ? `Round ${depth + 1}` : 'Round';
}

function officialCardMetrics() {
    const compact = isCompactBracketViewport();
    return {
        compact,
        cardW: compact ? 156 : 176,
        cardH: compact ? 56 : 60,
        xGap: compact ? 28 : 36,
        yGap: compact ? 22 : 24,
        startX: 16,
        startY: 48
    };
}

// 赛程图列顺序：优先用轮次语义（Round N / Round of N / QF / SF / Final），
// 这样 Round of 32 → Round of 16 → QF 不会因旧 order 冲突而错位。
function officialMatchCompare(a, b) {
    const position = bracketMatchPosition(a) - bracketMatchPosition(b);
    if (position !== 0) return position;
    const time = new Date(a.match_time || 0) - new Date(b.match_time || 0);
    if (time !== 0) return time;
    return String(a.__official_id || a.id || '').localeCompare(String(b.__official_id || b.id || ''));
}

function bracketLinesHtml(lines) {
    return lines.filter(line => typeof line === 'string' || line.source_type !== 'loser').map(line => typeof line === 'string' ? `<path d="${line}"></path>`
        : `<path d="${line.d}" class="bracket-edge ${line.source_type}" data-from="${escapeHtml(line.source_external_match_id)}" data-to="${escapeHtml(line.match_external_id)}"></path>`).join('');
}

function officialLaneHtml(label, matches, layout, metrics, flowMap = null, titleFor = null, cardLabelFor = null) {
    const drops = new Set(layout.lines.filter(line => line.source_type === 'loser').map(line => line.source_external_match_id));
    if (!matches.length) return '';
    const titles = layout.columns.map(column => {
        const text = titleFor ? titleFor(column) : officialColumnTitle(column.matches);
        return `<div class="pb2-title" data-bracket-column="${column.x}" style="left:${column.x}px;top:0;width:${metrics.cardW}px">${escapeHtml(text)}</div>`;
    }).join('');
    const cards = matches.map(match => {
        const position = layout.positions.get(match.__official_id);
        if (!position) return '';
        const flow = flowMap ? flowMap(match) : null;
        const card = flow ? compactBracketCard(match, 'pb2', flow) : playoffCardClean(match, drops.has(match.__official_id));
        const cardLabel = cardLabelFor ? cardLabelFor(match) : '';
        return `<div class="pb2-slot bracket-match${match.__unlinked ? ' bracket-unlinked' : ''}" data-bracket-match="${escapeHtml(match.__official_id)}" style="left:${position.x}px;top:${position.y}px;width:${metrics.cardW}px;height:${metrics.cardH}px">
            ${cardLabel ? `<span class="official-card-label">${escapeHtml(cardLabel)}</span>` : ''}
            ${bracketWhenChip(match)}${card}
        </div>`;
    }).join('');
    return `<section class="official-lane">
        ${label ? `<div class="official-lane-label">${escapeHtml(label)}</div>` : ''}
        <div class="official-canvas" style="--pb2-w:${layout.width}px;--pb2-h:${layout.height}px;width:${layout.width}px;height:${layout.height}px">
            <svg class="pb2-lines" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">${bracketLinesHtml(layout.lines)}</svg>
            ${titles}
            ${cards}
        </div>
    </section>`;
}

function officialExtrasSection(label, matches, metrics) {
    if (!matches.length) return '';
    return `<section class="official-finals">
        <div class="official-lane-label">${escapeHtml(label)}</div>
        <div class="official-finals-cards">
            ${matches.map(match => `<div class="official-final-card">
                <div class="official-final-slot" style="width:${metrics.cardW}px;height:${metrics.cardH}px">${bracketWhenChip(match)}${playoffCardClean(match)}</div>
            </div>`).join('')}
        </div>
    </section>`;
}

function officialSingleDiagram(stage) {
    const matches = stage.officialMatches || [];
    if (!matches.length) return '';
    const metrics = officialCardMetrics();
    // 季军赛不属于主淘汰树，单独放在下方，避免和 Grand Final 共用 "Finals" 列。
    const main = matches.filter(match => {
        const kind = bracketKind(match);
        return !kind || kind.side !== 'medal';
    });
    const medals = matches.filter(match => {
        const kind = bracketKind(match);
        return kind && kind.side === 'medal';
    });
    const mainIds = new Set(main.map(match => match.__official_id));
    const fullModel = bracketGraphEngine.graph(matches, stage.edges || [], explicitOfficialRoundKey);
    stage.graphDiagnostics = fullModel.diagnostics;
    const mainEdges = fullModel.edges.filter(edge =>
        mainIds.has(edge.match_external_id) && mainIds.has(edge.source_external_match_id));
    let lane = '';
    if (main.length) {
        const model = assignOfficialRoundKeys(main, mainEdges);
        const layout = bracketGraphEngine.layout(model, metrics, undefined, officialMatchCompare);
        lane = officialLaneHtml('', main, layout, metrics);
    }
    const extras = officialExtrasSection('3rd Place', medals, metrics);
    return `<div class="official-bracket-clean" aria-label="赛程图">
        ${lane}
        ${extras}
    </div>`;
}

function officialDoubleDiagram(stage) {
    const matches = stage.officialMatches || [];
    if (!matches.length) return '';
    const medals = matches.filter(match => bracketKind(match)?.side === 'medal');
    const main = matches.filter(match => bracketKind(match)?.side !== 'medal');
    const fullModel = bracketGraphEngine.graph(matches, stage.edges || [], explicitOfficialRoundKey);
    const mainIds = new Set(main.map(match => match.__official_id));
    const model = assignOfficialRoundKeys(main, fullModel.edges.filter(edge => mainIds.has(edge.match_external_id) && mainIds.has(edge.source_external_match_id)));
    stage.graphDiagnostics = fullModel.diagnostics;
    const metrics = officialCardMetrics();
    const lane = match => {
        const side = bracketKind(match)?.side;
        return side === 'grand' ? 'final' : side === 'upper' || side === 'lower' ? side : 'other';
    };
    const layout = bracketGraphEngine.layout(model, metrics, lane, officialMatchCompare);
    const labels = { upper: '胜者组', lower: '败者组', other: '其他轮次' };
    const laneLabels = [...layout.bands].filter(([key]) => key !== 'final').map(([key, band]) =>
        '<span class="bracket-lane-tag ' + key + '" style="top:' + Math.max(0, band.top - 24) + 'px">' + labels[key] + '</span>').join('');
    return '<div class="official-bracket-clean bracket-double" aria-label="双败赛程图">'
        + officialLaneHtml('', main, layout, metrics, null,
            column => column.matches.every(match => bracketKind(match)?.side === 'grand') ? '总决赛' : `第 ${Math.min(...column.matches.map(match => match.__round_key)) + 1} 轮`)
            .replace('<svg class="pb2-lines"', laneLabels + '<svg class="pb2-lines"')
        + officialExtrasSection('3rd Place', medals, metrics) + '</div>';
}

function stageStartTime(stage) {
    const list = stage && stage.groups
        ? stage.groups.flatMap(group => group.matches || [])
        : (stage && stage.matches) || [];
    const times = list.filter(match => match.match_time).map(match => new Date(match.match_time).getTime()).filter(Number.isFinite);
    if (times.length) return Math.min(...times);
    const nodes = (stage && stage.officialMatches) || [];
    const nodeTimes = nodes.filter(match => match.match_time).map(match => new Date(match.match_time).getTime()).filter(Number.isFinite);
    return nodeTimes.length ? Math.min(...nodeTimes) : Number.MAX_SAFE_INTEGER;
}

// 官方阶段优先：有 nodes/edges 时按真实拓扑建阶段；没有官方数据的阶段回退到旧的推断模型。
function buildTournamentStagesWithOfficial(matches, officialStages, options = {}) {
    const source = uniqueMatches(matches || []);
    const official = Array.isArray(officialStages) ? officialStages.filter(stage => stage && stage.external_id) : [];
    if (!official.length) return buildTournamentStages(source);

    const localById = new Map(source.map(match => [String(match.id), match]));
    const localByExternal = new Map();
    const localByStage = new Map();
    for (const match of source) {
        if (match.external_id) localByExternal.set(String(match.external_id), match);
        if (match.stage_external_id) {
            const key = String(match.stage_external_id);
            if (!localByStage.has(key)) localByStage.set(key, []);
            localByStage.get(key).push(match);
        }
    }

    const stages = [];
    const covered = new Set();
    for (const officialStage of official) {
        const externalId = String(officialStage.external_id);
        let localMatches = localByStage.get(externalId) || [];
        if (!localMatches.length && officialStage.name) {
            localMatches = source.filter(match => !match.stage_external_id && match.stage_name === officialStage.name);
        }
        for (const match of localMatches) covered.add(String(match.id));
        const officialMatches = (officialStage.nodes || []).map(node => {
            const local = localById.get(String(node.local_match_id))
                || localByExternal.get(String(node.external_match_id))
                || localByExternal.get(String(node.panda_match_id));
            return officialNodeToMatch(node, local, externalId, options.gameType);
        });
        const matchedIds = new Set(officialMatches.filter(match => match.id != null).map(match => String(match.id)));
        const unlinked = localMatches.filter(match => !matchedIds.has(String(match.id)));
        for (const match of unlinked) officialMatches.push({ ...match, __official_id: match.external_id || `local:${match.id}`, __unlinked: true });
        const edges = officialStage.edges || [];
        const label = officialStage.name || (localMatches[0] && localMatches[0].stage_name) || `Stage ${externalId}`;
        const kinds = officialMatches.map(match => bracketKind(match)).filter(Boolean);
        const hasUpper = kinds.some(kind => kind.side === 'upper');
        const hasLower = kinds.some(kind => kind.side === 'lower');
        const localKinds = localMatches.map(match => bracketKind(match)).filter(Boolean);
        const localHasUpper = localKinds.some(kind => kind.side === 'upper');
        const localHasLower = localKinds.some(kind => kind.side === 'lower');
        const swissSource = localMatches.length ? localMatches : officialMatches;
        const swiss = looksLikeSwissStage(swissSource, label);
        const gsl = isGslGroupStage(officialMatches.length ? officialMatches : localMatches);
        // 瑞士轮优先用官方 nodes 补全未来轮次（例如 PGL 只有 R1-R3 在近端窗口，
        // 但官方 bracket 返回了完整 33 场），再靠骨架把 TBD 对阵放进正确战绩桶。
        const roundSource = officialMatches.length ? officialMatches : swissSource;
        let type;
        if (hasUpper && hasLower) type = 'official-double';
        else if (gsl) type = 'gsl-group';
        else if (swiss) type = 'swiss-stage';
        else if (edges.length && officialMatches.length) type = 'official-single';
        else if (officialMatches.length && officialStage.has_bracket) type = 'official-single';
        else if (localHasUpper && localHasLower) type = 'double-elim-bracket';
        else if (localMatches.length && isPlayoffStage({ label, matches: localMatches })) type = 'playoff-stage';
        else if (localMatches.length || officialMatches.length) type = 'group-stage';
        else continue;
        const roundGroups = roundGroupsFromMatches(roundSource);
        stages.push({
            key: `official-${externalId}`,
            external_id: externalId,
            label,
            type,
            has_bracket: officialStage.has_bracket,
            bracket_synced_at: officialStage.bracket_synced_at,
            bracket_error: officialStage.bracket_error,
            matches: localMatches,
            // 统计只算本地已入库比赛；官方 nodes 可能包含尚未进入同步窗口的未来场次。
            metricsMatches: localMatches,
            officialMatches,
            unlinkedCount: (officialStage.nodes || []).length ? unlinked.length : 0,
            edges,
            graphDiagnostics: bracketGraphEngine.graph(officialMatches, edges, explicitOfficialRoundKey).diagnostics,
            groups: type === 'swiss-stage' && roundGroups.length ? roundGroups : undefined
        });
    }

    const leftovers = source.filter(match => !covered.has(String(match.id)));
    if (leftovers.length) stages.push(...buildBracketModel(leftovers).stages);
    return stages.sort((a, b) => stageStartTime(a) - stageStartTime(b) || String(a.key).localeCompare(String(b.key)));
}

function roundGroupsFromMatches(matches) {
    const map = new Map();
    for (const match of matches) {
        const round = roundNumber(match);
        if (!round) return [];
        const key = `round-${String(round).padStart(2, '0')}`;
        if (!map.has(key)) map.set(key, { key, label: `Round ${round}`, round, matches: [] });
        map.get(key).matches.push(match);
    }
    return [...map.values()].sort((a, b) => a.round - b.round).map(group => ({
        ...group,
        matches: group.matches.sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0))
    }));
}

// 主页折叠面板复用：给定一届赛事的扁平 matches + 官方阶段数据，产出所有 stage 的赛程图 HTML。
// 无副作用；由 app.js 调用。逐 stage 复刻 tournaments.js 里 stageSection 的图渲染分支。
function tournamentBracketSections(matches, officialStages, options = {}) {
    const stages = buildTournamentStagesWithOfficial(matches || [], officialStages, options);
    return stages.map(group => {
        let diagram = '';
        if (group.groups) {
            diagram = stageDiagram(group);
        } else {
            const roundGroups = roundGroupsFromMatches(group.matches || group.officialMatches || []);
            diagram = stageDiagram(group, roundGroups);
        }
        if (!diagram) return '';
        return `<section class="home-bracket-stage">
            <h4 class="home-bracket-stage-title">${escapeHtml(group.label || '')}</h4>
            ${diagram}
        </section>`;
    }).filter(Boolean).join('');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        bracketKind,
        bracketTeamState,
        buildBracketModel,
        buildTournamentStages,
        buildTournamentStagesWithOfficial,
        detectSwiss16,
        doubleElimRounds,
        isGslGroupStage,
        isTbdMatch,
        looksLikeSwissStage,
        matchesByBracketKind,
        playoffGroupsFromMatches,
        playoffRoundLabel,
        roundGroupsFromMatches,
        stageDiagram,
        stageMatches,
        swissRoundBuckets
    };
}
