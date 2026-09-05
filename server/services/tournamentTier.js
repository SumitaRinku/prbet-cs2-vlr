// 赛事级别（tier）规则：1=高级 2=普通 3=低级。
// tournaments.tier 为手动设置值（管理面板），NULL 表示未设置。
// 未设置时按名称关键词自动推断（中英文同义词，PandaScore 名为英文、
// 手动改名后的赛事可能为中文）：
//   低级（两游戏）: Qualifier / 预选赛 —— 优先判定，"Major Qualifier" 属预选赛
//   CS2 高级:      Major
//   Valorant 高级: Masters / Champions / 大师赛 / 冠军赛
//   其余→普通。
// 关键词推断仅在查询时计算（effective_tier），不落库，PandaScore 同步永远不覆盖手动设置。
// SQLite LIKE 对 ASCII 默认不区分大小写，可命中 qualifier/QUALIFIER 等变体。
const TIER_SQL = `
    CASE
        WHEN t.tier IS NOT NULL THEN t.tier
        WHEN t.name LIKE '%Qualifier%' OR t.name LIKE '%预选赛%' THEN 3
        WHEN t.game_type = 'cs2' AND t.name LIKE '%Major%' THEN 1
        WHEN t.game_type = 'valorant' AND (t.name LIKE '%Masters%' OR t.name LIKE '%Champions%' OR t.name LIKE '%大师赛%' OR t.name LIKE '%冠军赛%') THEN 1
        ELSE 2
    END`;

module.exports = { TIER_SQL };
