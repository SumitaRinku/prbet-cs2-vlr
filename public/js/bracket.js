// bracket.js — 赛程图 / stage 模型渲染管线（纯函数）。
// 由 tournaments.js（回看页）与 app.js（主页折叠面板）共用。
// 依赖三个环境全局（各页各自提供）：escapeHtml、logoHtml、focusTournamentMatch。
// 本文件不含任何页面状态 / DOM 副作用；顶层只有函数声明与字面量常量。

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
    return stageMetrics(stageMatches(item));
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
        logo: match[`${prefix}_logo_url`]
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
            if (Number(match.team1_score) > Number(match.team2_score)) {
                team1.wins += 1;
                team2.losses += 1;
            } else if (Number(match.team2_score) > Number(match.team1_score)) {
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
            if (isTbdMatch(match)) continue; // 真实对阵先入桶；TBD 槽位后续由骨架补齐
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
            if (Number(match.team1_score) > Number(match.team2_score)) {
                team1.wins += 1;
                team2.losses += 1;
            } else if (Number(match.team2_score) > Number(match.team1_score)) {
                team2.wins += 1;
                team1.losses += 1;
            }
            records.set(team1Key, team1);
            records.set(team2Key, team2);
        }
        // 骨架模式：按标准结构补齐该轮应有的桶，并把每桶对阵数补足到目标（缺的用 TBD 占位）。
        if (skeleton && SWISS_16_SKELETON.rounds[round]) {
            let seq = 0;
            for (const spec of SWISS_16_SKELETON.rounds[round]) {
                const shell = skeletonBucketShell(spec);
                const bucket = buckets.get(shell.key) || shell;
                if (!buckets.has(shell.key)) buckets.set(shell.key, bucket);
                while (bucket.matches.length < spec.count) bucket.matches.push(placeholderMatch(round, `${shell.key}-${seq++}`));
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
    const won = match.status === 'finished' && (side === 1
        ? Number(match.team1_score) > Number(match.team2_score)
        : Number(match.team2_score) > Number(match.team1_score));
    // TBD / 骨架占位：直接渲染「?」盾牌，不走 logo 代理。
    if ((name || '') === 'TBD' || match.__placeholder) return `<span class="sw2-logo tbd">${TBD_SHIELD}</span>`;
    return `<span class="sw2-logo ${won ? 'winner' : ''}">${logoHtml(logo)}</span>`;
}

function isLiveMatch(match) {
    if (match.__placeholder) return false;
    if (isTbdMatch(match)) return false;
    // 后端确认的进行中状态（PandaScore running → ongoing）。
    if (match.status === 'ongoing' || match.status === 'live' || match.status === 'running') return true;
    // 前端派生：开赛时间已过、尚未结束/取消，即视为进行中。无需等 5 分钟同步，0 延迟。
    if (match.status === 'finished' || match.status === 'cancelled' || match.status === 'canceled' || match.status === 'postponed') return false;
    return !!match.match_time && new Date(match.match_time).getTime() <= Date.now();
}

function swissMatchNodeClean(match) {
    // 骨架占位与 TBD 对阵仅作结构展示，不可点击。
    const clickable = !match.__placeholder && !isTbdMatch(match);
    const live = isLiveMatch(match);
    const attrs = clickable
        ? `onclick="focusTournamentMatch(${match.id})"`
        : 'disabled aria-disabled="true"';
    const classes = ['sw2-match', clickable ? '' : 'tbd', live ? 'live' : ''].filter(Boolean).join(' ');
    const badge = live ? '<span class="sw2-live">LIVE</span>' : '';
    return `<button type="button" class="${classes}" ${attrs} title="${escapeHtml(match.name || 'Swiss match')}">
        ${badge}
        ${swissMatchLogo(match, 1)}
        <span class="sw2-vs">vs</span>
        ${swissMatchLogo(match, 2)}
    </button>`;
}

function swissResultTeamClean(entry) {
    // 空槽位（尚未产生的晋级/淘汰队）用「?」盾牌占位。
    if (!entry || entry.__placeholder) return `<span class="sw2-result-team tbd">${TBD_SHIELD}</span>`;
    return `<span class="sw2-result-team" title="${escapeHtml(entry.team.name)}">${logoHtml(entry.team.logo)}</span>`;
}

function swissResultBucketsForLabels(finalBuckets, labels) {
    const byLabel = new Map(finalBuckets.map(bucket => [bucket.label, bucket]));
    return labels.map(label => byLabel.get(label)).filter(Boolean);
}

function swissResultBucketClean(bucket) {
    return `<div class="sw2-result-bucket ${escapeHtml(bucket.tone)}">
        <div class="sw2-label">${escapeHtml(swissGraphLabel(bucket.label))}</div>
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
    return `<div class="swiss-bracket-clean" style="--swiss-cols:repeat(${visibleRounds.length},minmax(0,1fr))" aria-label="瑞士轮赛程图">
        ${visibleRounds.map(group => swissRoundColumnClean(group, finalBuckets)).join('')}
    </div>`;
}

function playoffRoundLabel(match) {
    const source = `${match.name || ''} ${match.stage_name || ''}`.toLowerCase();
    if (source.includes('quarter') || source.includes('四分之一')) return { key: '1-quarterfinals', label: '四分之一决赛' };
    if (source.includes('semi') || source.includes('半决赛')) return { key: '2-semifinals', label: '半决赛' };
    if (source.includes('upper bracket') || source.includes('胜者组')) return { key: '2-upper-bracket', label: '胜者组决赛' };
    if (source.includes('lower bracket') || source.includes('败者组')) return { key: '2-lower-bracket', label: '败者组决赛' };
    if (source.includes('grand final') || source.includes('决赛')) return { key: '3-final', label: '决赛' };
    if (/\bfinal\b/.test(source) && !/bracket/.test(source)) return { key: '3-final', label: '决赛' };
    return null;
}

function playoffDisplayLabel(label) {
    if (label.includes('四分之一') || label.toLowerCase().includes('quarter')) return 'Quarter-finals';
    if (label.includes('半决赛') || label.toLowerCase().includes('semi')) return 'Semi-finals';
    if (label.includes('胜者组') || label.toLowerCase().includes('upper bracket')) return 'Upper bracket final';
    if (label.includes('败者组') || label.toLowerCase().includes('lower bracket')) return 'Lower bracket final';
    if (label.includes('决赛') || label.toLowerCase().includes('grand final')) return 'Grand final';
    return label;
}

function playoffGroupsFromMatches(matches) {
    const sorted = [...matches].sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0));
    const detected = new Map();
    for (const match of sorted) {
        const round = playoffRoundLabel(match);
        if (!round) continue;
        if (!detected.has(round.key)) detected.set(round.key, { ...round, matches: [] });
        detected.get(round.key).matches.push(match);
    }
    if (detected.size) {
        const groups = [...detected.values()].sort((a, b) => a.key.localeCompare(b.key));
        // 补全骨架：把每个已识别轮次的对局数补到标准淘汰赛槽位数（QF=4、SF=2、决赛=1），
        // 缺失的槽位用 TBD 占位，让「几场1/4、几场半决赛」等结构一目了然。
        // 单败淘汰下，若已知某轮真实场次多于标准（如 Ro16=8），以真实场次为准，不裁剪。
        const expectedByKey = { '1-quarterfinals': 4, '2-semifinals': 2, '2-upper-bracket': 1, '2-lower-bracket': 1, '3-final': 1 };
        for (const group of groups) {
            const expected = expectedByKey[group.key];
            if (!expected) continue;
            const target = Math.max(group.matches.length, expected);
            for (let i = group.matches.length; i < target; i++) {
                group.matches.push(placeholderMatch(group.key, i, playoffDisplayLabel(group.label)));
            }
        }
        return groups;
    }

    const templates = sorted.length >= 7
        ? [
            { key: '1-quarterfinals', label: '四分之一决赛', count: 4 },
            { key: '2-semifinals', label: '半决赛', count: 2 },
            { key: '3-final', label: '决赛', count: 1 }
        ]
        : sorted.length >= 3
            ? [
                { key: '2-semifinals', label: '半决赛', count: 2 },
                { key: '3-final', label: '决赛', count: sorted.length - 2 }
            ]
            : [{ key: '3-final', label: '淘汰赛', count: sorted.length }];
    let offset = 0;
    return templates.map(template => {
        const matchesForRound = sorted.slice(offset, offset + template.count);
        offset += template.count;
        return { key: template.key, label: template.label, matches: matchesForRound };
    }).filter(group => group.matches.length);
}

function isPlayoffStage(group) {
    const source = `${group.label || ''} ${stageMatches(group).map(match => match.name || '').join(' ')}`.toLowerCase();
    if (source.includes('group') || source.includes('小组')) return false;
    return source.includes('playoff') || source.includes('quarter') || source.includes('semi') || source.includes('upper bracket') || source.includes('lower bracket') || source.includes('胜者组') || source.includes('败者组') || source.includes('淘汰') || source.includes('决赛') || (/\bfinal\b/.test(source) && !/bracket/.test(source));
}

function isCompactBracketViewport() {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
}

function playoffLayout(groups) {
    const counts = groups.map(group => group.matches.length).join('-');
    const compact = isCompactBracketViewport();
    if (counts === '4-2-1') {
        const cardW = compact ? 104 : 190;
        const cardH = compact ? 48 : 68;
        const xs = compact ? [6, 122, 238] : [20, 300, 580];
        const ys = compact ? [[34, 88, 142, 196], [61, 169], [115]] : [[54, 134, 214, 294], [94, 254], [174]];
        const w = compact ? 348 : 790;
        const h = compact ? 252 : 390;
        const center = (round, index) => ({ x: xs[round] + cardW, y: ys[round][index] + cardH / 2 });
        const joinPair = (fromRound, aIndex, bIndex, toRound, toIndex) => {
            const a = center(fromRound, aIndex);
            const b = center(fromRound, bIndex);
            const targetY = ys[toRound][toIndex] + cardH / 2;
            const fromRight = xs[fromRound] + cardW;
            const toLeft = xs[toRound];
            const joinX = Math.round((fromRight + toLeft) / 2);
            return [`M${fromRight},${a.y} H${joinX}`, `M${fromRight},${b.y} H${joinX}`, `M${joinX},${a.y} V${b.y}`, `M${joinX},${targetY} H${toLeft}`];
        };
        return {
            w, h, cardW, cardH, xs, ys,
            lines: [
                ...joinPair(0, 0, 1, 1, 0),
                ...joinPair(0, 2, 3, 1, 1),
                ...joinPair(1, 0, 1, 2, 0)
            ]
        };
    }
    if (counts === '2-1') {
        const cardW = compact ? 108 : 190;
        const cardH = compact ? 48 : 68;
        const xs = compact ? [6, 132] : [20, 300];
        const ys = compact ? [[50, 104], [77]] : [[74, 154], [114]];
        const fromRight = xs[0] + cardW;
        const toLeft = xs[1];
        const joinX = Math.round((fromRight + toLeft) / 2);
        const y1 = ys[0][0] + cardH / 2;
        const y2 = ys[0][1] + cardH / 2;
        const targetY = ys[1][0] + cardH / 2;
        return {
            w: compact ? 246 : 510,
            h: compact ? 184 : 260,
            cardW,
            cardH,
            xs,
            ys,
            lines: [`M${fromRight},${y1} H${joinX}`, `M${fromRight},${y2} H${joinX}`, `M${joinX},${y1} V${y2}`, `M${joinX},${targetY} H${toLeft}`]
        };
    }
    const cardW = compact ? 104 : 190;
    const cardH = compact ? 48 : 68;
    const xGap = compact ? 12 : 90;
    const yGap = compact ? 6 : 12;
    const xs = groups.map((_, index) => (compact ? 6 : 20) + index * (cardW + xGap));
    const ys = groups.map(group => group.matches.map((_, index) => (compact ? 34 : 54) + index * (cardH + yGap)));
    return {
        w: xs[xs.length - 1] + cardW + (compact ? 6 : 20),
        h: Math.max(compact ? 170 : 220, Math.max(...ys.map(round => (round.at(-1) || (compact ? 34 : 54)) + cardH + (compact ? 22 : 40)))),
        cardW,
        cardH,
        xs,
        ys,
        lines: []
    };
}

function playoffTeamRowClean(match, side) {
    const score = side === 1 ? match.team1_score : match.team2_score;
    const finished = match.status === 'finished';
    const won = finished && ((side === 1 && Number(match.team1_score) > Number(match.team2_score)) || (side === 2 && Number(match.team2_score) > Number(match.team1_score)));
    const logo = side === 1 ? match.team1_logo_url : match.team2_logo_url;
    const name = side === 1 ? match.team1_name : match.team2_name;
    const isTbd = (name || '') === 'TBD' || match.__placeholder;
    // 只有已结束的比赛才分胜/负（绿/红条）；未结束（含 TBD）一律中性 pending，不显示红条。
    const tone = won ? 'winner' : finished ? 'loser' : 'pending';
    return `<div class="pb2-team ${tone}">
        <span class="pb2-bar"></span>
        ${isTbd ? TBD_SHIELD : logoHtml(logo)}
        <b>${escapeHtml(teamShortName(match, side))}</b>
        <strong>${finished ? escapeHtml(score ?? 0) : '-'}</strong>
    </div>`;
}

function playoffCardClean(match) {
    const title = match.name || '淘汰赛';
    const tbd = isTbdMatch(match);
    // TBD 对局仅作骨架展示，不可点击进入详情。
    const interaction = tbd
        ? ''
        : `role="button" tabindex="0" onclick="focusTournamentMatch(${match.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();focusTournamentMatch(${match.id});}"`;
    return `<div class="pb2-card ${match.status || ''} ${tbd ? 'tbd' : ''}" ${interaction} title="${escapeHtml(title)}">
        ${playoffTeamRowClean(match, 1)}
        ${playoffTeamRowClean(match, 2)}
    </div>`;
}

function playoffDiagram(matches) {
    // 淘汰赛画完整骨架：即使对阵未定（TBD）也保留卡片与连接线，
    // 用 ? 盾牌 + TBD 占位，直观展示赛制结构（PandaScore 早已给出完整 QF/SF/Final 骨架）。
    const groups = playoffGroupsFromMatches(matches || []);
    if (!groups.length) return '';
    const layout = playoffLayout(groups);
    return `<div class="playoff-bracket-clean" aria-label="淘汰赛赛程图">
        <div class="pb2-layout" style="--pb2-w:${layout.w}px;--pb2-h:${layout.h}px;--pb2-card-w:${layout.cardW}px;--pb2-card-h:${layout.cardH}px">
            <svg class="pb2-lines" viewBox="0 0 ${layout.w} ${layout.h}" aria-hidden="true">
                ${layout.lines.map(path => `<path d="${path}"></path>`).join('')}
            </svg>
            ${groups.map((group, roundIndex) => `<div class="pb2-title" style="left:${layout.xs[roundIndex]}px;top:18px;width:${layout.cardW}px">${escapeHtml(playoffDisplayLabel(group.label))}</div>`).join('')}
            ${groups.map((group, roundIndex) => group.matches.map((match, index) => `<div class="pb2-slot" style="left:${layout.xs[roundIndex]}px;top:${layout.ys[roundIndex][index]}px;width:${layout.cardW}px;height:${layout.cardH}px">${playoffCardClean(match)}</div>`).join('')).join('')}
        </div>
    </div>`;
}

function bracketTeamRowClean(match, side, prefix = 'de') {
    const score = side === 1 ? match.team1_score : match.team2_score;
    const won = match.status === 'finished' && ((side === 1 && Number(match.team1_score) > Number(match.team2_score)) || (side === 2 && Number(match.team2_score) > Number(match.team1_score)));
    const logo = side === 1 ? match.team1_logo_url : match.team2_logo_url;
    return `<div class="${prefix}-team ${won ? 'winner' : 'loser'}">
        <span class="${prefix}-bar"></span>
        ${logoHtml(logo)}
        <b>${escapeHtml(teamShortName(match, side))}</b>
        <strong>${match.status === 'finished' ? escapeHtml(score ?? 0) : '-'}</strong>
    </div>`;
}

function compactBracketCard(match, prefix = 'de') {
    const title = match.name || 'Bracket match';
    return `<div class="${prefix}-card ${match.status || ''}" role="button" tabindex="0" onclick="focusTournamentMatch(${match.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();focusTournamentMatch(${match.id});}" title="${escapeHtml(title)}">
        ${bracketTeamRowClean(match, 1, prefix)}
        ${bracketTeamRowClean(match, 2, prefix)}
    </div>`;
}

function bracketKind(match) {
    const name = String(match.name || '').toLowerCase();
    if (name.includes('upper bracket quarterfinal')) return 'upper-qf';
    if (name.includes('upper bracket semifinal')) return 'upper-sf';
    if (name.includes('upper bracket final')) return 'upper-final';
    if (name.includes('lower bracket quarterfinal')) return 'lower-qf';
    if (name.includes('lower bracket semifinal')) return 'lower-sf';
    if (name.includes('lower bracket final')) return 'lower-final';
    if (name.includes('grand final')) return 'grand-final';
    if (name.includes('3rd place') || name.includes('third place')) return 'third-place';
    if (name.includes('quarterfinal')) return 'playoff-qf';
    if (name.includes('semifinal')) return 'playoff-sf';
    if (/\bfinal\b/.test(name)) return 'grand-final';
    return '';
}

function matchesByBracketKind(matches) {
    const map = new Map();
    for (const match of [...matches].sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id)) {
        const kind = bracketKind(match);
        if (!kind) continue;
        if (!map.has(kind)) map.set(kind, []);
        map.get(kind).push(match);
    }
    return map;
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

function buildDoubleElimGroups(map) {
    const upperFinals = map.get('upper-final') || [];
    if (!upperFinals.length) return [];
    return upperFinals.map((upperFinal, index) => {
        const teamSet = new Set(bracketTeamKeys(upperFinal));
        const upperSf = collectConnectedMatches(map.get('upper-sf') || [], teamSet);
        const upperQf = collectConnectedMatches(map.get('upper-qf') || [], teamSet);
        const lowerFinal = collectConnectedMatches(map.get('lower-final') || [], teamSet);
        const lowerSf = collectConnectedMatches(map.get('lower-sf') || [], teamSet);
        const lowerQf = collectConnectedMatches(map.get('lower-qf') || [], teamSet);
        return {
            name: `Group ${String.fromCharCode(65 + index)}`,
            upperQf,
            upperSf,
            upperFinal: [upperFinal],
            lowerQf,
            lowerSf,
            lowerFinal
        };
    });
}

function doubleElimRound(label, matches, extraClass = '') {
    const countClass = `count-${Math.max(matches.length, 1)}`;
    return `<section class="de-round ${countClass} ${extraClass}">
        <div class="de-round-title">${escapeHtml(label)}</div>
        <div class="de-card-list">${matches.map(match => compactBracketCard(match, 'de')).join('') || '<div class="de-empty">TBD</div>'}</div>
    </section>`;
}

function doubleElimLane(label, rounds, tone) {
    return `<div class="de-lane ${tone}">
        <div class="de-lane-label">${escapeHtml(label)}</div>
        <div class="de-lane-rounds">${rounds.join('')}</div>
    </div>`;
}

function doubleElimGroup(group) {
    return `<section class="de-group">
        <h4>${escapeHtml(group.name)}</h4>
        ${doubleElimLane('Upper bracket', [
            doubleElimRound('Quarter-finals', group.upperQf),
            doubleElimRound('Semi-finals', group.upperSf),
            doubleElimRound('Final', group.upperFinal)
        ], 'upper')}
        ${doubleElimLane('Lower bracket', [
            doubleElimRound('Quarter-finals', group.lowerQf),
            doubleElimRound('Semi-finals', group.lowerSf),
            doubleElimRound('Final', group.lowerFinal)
        ], 'lower')}
    </section>`;
}
function finalBracketOverview(map) {
    const matches = uniqueMatches([...(map.get('playoff-qf') || []), ...(map.get('playoff-sf') || []), ...(map.get('grand-final') || [])])
        .sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id);
    if (!matches.length) return '';
    return `<section class="de-finals major-style-playoffs">
        <h4>Playoffs</h4>
        ${playoffDiagram(matches)}
    </section>`;
}

function doubleElimDiagram(matches) {
    // 「只显示已有对阵」：过滤掉 TBD 未定对局。
    const map = matchesByBracketKind((matches || []).filter(match => !isTbdMatch(match)));
    const groups = buildDoubleElimGroups(map);
    const hasDoubleElim = groups.length && (map.get('lower-final') || []).length;
    if (!hasDoubleElim) return '';
    return `<div class="de-bracket-clean" aria-label="赛事赛程图">
        <div class="de-overview-title">Bracket overview</div>
        <div class="de-groups">${groups.map(doubleElimGroup).join('')}</div>
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
    const map = matchesByBracketKind(matches);
    const groups = buildDoubleElimGroups(map);
    const hasDoubleElim = groups.length && (map.get('lower-final') || []).length;
    if (!hasDoubleElim) return null;
    const stages = groups.map((group, index) => ({
        key: `double-elim-group-${index + 1}`,
        label: group.name,
        type: 'double-elim-group',
        matches: uniqueMatches([...group.upperQf, ...group.upperSf, ...group.upperFinal, ...group.lowerQf, ...group.lowerSf, ...group.lowerFinal])
            .sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id)
    }));
    const playoffMatches = uniqueMatches([...(map.get('playoff-qf') || []), ...(map.get('playoff-sf') || []), ...(map.get('grand-final') || [])])
        .sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id);
    if (playoffMatches.length) {
        stages.push({ key: 'double-elim-playoffs', label: 'Playoffs', type: 'double-elim-playoffs', matches: playoffMatches });
    }
    const thirdPlace = (map.get('third-place') || [])
        .sort((a, b) => new Date(a.match_time || 0) - new Date(b.match_time || 0) || a.id - b.id);
    if (thirdPlace.length) {
        stages.push({ key: 'double-elim-third-place', label: '3rd Place', type: 'double-elim-third-place', matches: thirdPlace });
    }
    return stages;
}


function matchRoundNumberFromStage(match) {
    const source = `${match.stage_name || ''} ${match.stage_slug || ''} ${match.name || ''}`;
    const round = source.match(/(?:round|r)[\s-]*(\d+)/i);
    return round ? Number(round[1]) : null;
}

function isPlayoffRoundMatch(match) {
    const source = `${match.stage_name || ''} ${match.stage_slug || ''} ${match.name || ''}`.toLowerCase();
    if (source.includes('upper bracket') || source.includes('lower bracket')) return false;
    if (source.includes('3rd place') || source.includes('third place') || source.includes('decider')) return false;
    return source.includes('quarterfinal') || source.includes('semi') || source.includes('grand final') || /\bfinal\b/.test(source);
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
function buildTournamentStages(matches) {
    return doubleElimTournamentStages(matches) || swissPlayoffTournamentStages(matches) || sortTournamentStages(splitRepeatedSwissStages(groupMatches(matches)));
}
function stageDiagram(group, roundGroups = null) {
    const matches = stageMatches(group);
    if (!matches.length) return '';
    const label = (group.label || '').toLowerCase();
    const matchNames = matches.map(match => match.name || '').join(' ').toLowerCase();
    if (label.includes('group') || label.includes('小组')) return '';
    if (matchNames.includes('upper bracket') || matchNames.includes('lower bracket')) return '';
    if (group.groups) return swissDiagram(group.groups);
    if (isPlayoffStage(group)) return playoffDiagram(matches);
    // 季军赛：单独一场（或数场）决胜局，作为独立小卡片展示，回答「是否有季军赛」。
    if (label.includes('3rd') || label.includes('third') || label.includes('季军') || matchNames.includes('3rd place') || matchNames.includes('third place')) {
        return thirdPlaceDiagram(matches);
    }
    if (roundGroups && roundGroups.length >= 1) return swissDiagram(roundGroups);
    return '';
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

// 主页折叠面板复用：给定一届赛事的扁平 matches，产出所有 stage 的赛程图 HTML（含 stage 标题）。
// 无副作用；由 app.js 调用。逐 stage 复刻 tournaments.js 里 stageSection 的图渲染分支。
function tournamentBracketSections(matches) {
    const stages = buildTournamentStages(matches || []);
    return stages.map(group => {
        let diagram = '';
        if (group.groups) {
            diagram = stageDiagram(group);
        } else {
            const roundGroups = roundGroupsFromMatches(group.matches || []);
            diagram = stageDiagram(group, roundGroups);
        }
        if (!diagram) return '';
        return `<section class="home-bracket-stage">
            <h4 class="home-bracket-stage-title">${escapeHtml(group.label || '')}</h4>
            ${diagram}
        </section>`;
    }).filter(Boolean).join('');
}
