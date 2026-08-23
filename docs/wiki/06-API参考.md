# 06 · API 参考

Base URL：`/api`。除标注外均为 JSON 请求/响应。

**鉴权方式**：`Authorization: Bearer <JWT>`（登录/注册返回，30 天有效）。

**鉴权级别图例**：
- 🌐 公开 — 无需 token
- 👤 可选 — 带 token 时附加个性化数据（`optionalAuth`）
- 🔒 登录 — 必须 token（`authenticateToken`）
- 🛡️ 管理员 — 必须 admin 角色（`authenticateToken + requireAdmin`）

**限流**：`/api/auth/register`、`/api/auth/login`、`/api/auth/password` 共享每 IP 15 分钟 20 次的限流，超限返回 429 + `Retry-After`。

**通用错误格式**：`{ "error": "中文错误信息" }`，HTTP 状态码语义化（400 参数/校验、401 未登录/过期、403 权限、404 不存在、429 限流、500 服务器错误）。

---

## /api/auth — 认证（routes/auth.js）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/register` | 🌐（限流） | 注册。body `{username, password}`；用户名 3–20 位 `[a-zA-Z0-9_]`，密码 ≥6。成功 201 返回 `{user, token}`；重名 400 |
| POST | `/login` | 🌐（限流） | 登录。body `{username, password}`；成功 `{user, token}`；凭据错误 401 |
| GET | `/me` | 🔒 | 当前用户信息 `{user: {id, username, role, total_score, created_at}}` |
| PUT | `/password` | 🔒（限流） | 改密。body `{old_password, new_password}`；原密码错 400 |

## /api/matches — 比赛（routes/matches.js）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 👤 | 通用比赛列表。query：`status`、`game_type`、`tournament_id`；返回 `{matches}`（≤200 条，含双侧队伍/赛事信息、prediction_count；登录附 `user_prediction`）。只含活跃赛事、排除 TBD |
| GET | `/upcoming` | 👤 | 首页聚合。query：`game_type`、`tournament_id`、`status`（finished/ongoing/upcoming）。返回 `{matches, filters: {status_counts, tournaments, finished_window_days}}`；「已结束」窗口 1 天，每行附 `display_status` |
| GET | `/:id` | 👤 | 比赛详情 `{match}`，附 `possible_scores`（该赛制全部合法比分）；登录附 `user_prediction` |
| GET | `/:id/predictions` | 🌐 | 已结算比赛的预测明细 `{match, predictions[]}`（用户名、预测比分、得分，按得分降序）；未结算 400 |
| POST | `/:id/predictions` | 🔒 | 提交/更新预测。body `{predicted_winner_id, predicted_team1_score, predicted_team2_score}`。校验：非 TBD、status=upcoming、betting_enabled、未开赛、胜者合法、比分合法（`isValidScore`）且与胜者一致。已存在则更新（200），否则 201 |
| DELETE | `/:id/predictions` | 🔒 | 取消预测（仅 upcoming 且未开赛）；无预测 404 |
| GET | `/:id/head2head` | 🌐 | 对阵分析：`{match, team1/team2: {wins, losses, label, recent[]}, head_to_head[]}`（各近 10 场，排除弃权局） |

## /api/tournaments — 赛事（routes/tournaments.js）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 🌐 | 活跃赛事列表。query：`game_type`、`status`（finished=全部结束 / ongoing=有未结束）。返回 `{tournaments}`（含各类计数与 prediction_count） |
| GET | `/:id` | 🌐 | 赛事详情 + 全部比赛 `{tournament, matches}`（赛程图数据源，含 correct_prediction_count） |
| GET | `/:id/leaderboard` | 🌐 | 赛事榜 `{tournament, leaderboard}`（排除 admin、排除弃权局；total_score → success_rate → prediction_count；rank 1–100） |
| GET | `/:id/predictions` | 🌐 | 赛事内已结束比赛的预测流水 `{tournament, predictions}` |

## /api/predictions — 我的预测（routes/predictions.js）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/my` | 🔒 | `{predictions, stats}`：全部预测（JOIN 比赛/队伍/赛事完整字段，按比赛时间倒序）+ stats `{total, settled, points, correct}`（settled 排除弃权局） |

## /api/leaderboard — 排行榜（routes/leaderboard.js）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 🌐 | 总榜。query：`game_type`、`page`（≥1）、`page_size`（1–100 默认 20）。返回 `{leaderboard, total, page, page_size}`；仅活跃赛事、排除 admin、排除弃权局 |
| GET | `/export` | 🌐 | CSV 导出（UTF-8 BOM，Excel 友好）。query：`game_type`、`tournament_id`。列：排名/用户名/总积分/已结算预测数/得分率 |
| GET | `/tournament/:id` | 🌐 | 单赛事榜 `{tournament, leaderboard, total, page, page_size}` |
| GET | `/users/:id/details` | 🌐 | 单用户明细 `{user, summary, predictions[]}`。query：`game_type`、`tournament_id`；summary 含 success_rate |

## /api/images — Logo 代理（routes/images.js）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/team-logo?url=...` | 🌐 | 队伍/赛事 logo 安全代理。仅接受 teams/tournaments 表中已注册的 URL；SSRF 防护（内网 IP 拦截、DNS 全记录校验、固定 IP 连接防 rebinding、重定向逐跳校验）；≤2MB、12s 超时、仅放行图片内容（content-type + 文件头嗅探）。成功返回图片字节（缓存 1 天 + nosniff + CSP）；失败 400/403/502 |

## /api/teams — 队伍（routes/teams.js）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 🌐 | 队伍列表（排除 TBD）。query：`game_type`、`q`（名称/短名 LIKE）、`limit`（≤100 默认 60）。含 match_count/win_count/upcoming_count/last_match_time |
| GET | `/:id` | 🌐 | 队伍详情 `{team, stats, tournaments, matches}`。query：`match_limit`（≤100 默认 30）、`tournament_limit`（≤50 默认 20）。tournaments 含 placement 名次（冠军/亚军/四强/八强/已参赛/进行中）与胜率 |

## /api/admin — 管理后台（routes/admin.js，全部 🛡️）

### 统计与同步

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/stats` | 计数概览 `{users, tournaments, teams, matches, predictions, sync}`。query：`game_type` |
| GET | `/sync/status` | 同步配置与最近运行 `{sync}` |
| POST | `/sync/pandascore` | 手动触发同步（mode='manual'），返回同步统计；失败 500 |

### 用户管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/users` | 用户列表（含 prediction_count） |
| POST | `/users` | 创建用户。body `{username, password, role?}` |
| PUT | `/users/:id/role` | 改角色。body `{role}`；默认 admin 不能降级 |
| PUT | `/users/:id/password` | 重置密码。body `{password}` |
| DELETE | `/users/:id` | 删除用户（默认 admin 拒绝；删后重算总分） |

### 赛事管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/tournaments` | 全部赛事（含禁用，含 match_count）。query：`game_type` |
| POST | `/tournaments` | 创建。body `{name, game_type?, begin_at?, end_at?, is_active?}`（name_locked=1） |
| PUT | `/tournaments/:id` | 更新（传 name 即锁定；is_active 变化联动该赛事 betting） |
| PUT | `/tournaments/:id/toggle-active` | 启用/禁用切换，返回 `{is_active}` |
| DELETE | `/tournaments/:id` | 删除（有比赛拒绝 400） |

### 队伍管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/teams` | 列表（≤1000）。query：`game_type` |
| POST | `/teams` | 创建。body `{name, game_type?, short_name?, logo_url?, country?}` |
| PUT | `/teams/:id` | 更新（COALESCE 部分更新） |
| DELETE | `/teams/:id` | 删除（有关联比赛拒绝 400） |

### 比赛管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/matches` | 列表。query：`game_type`、`status`、`limit`（≤1000 默认 300） |
| POST | `/matches` | 创建。body `{tournament_id, team1_id, team2_id, name?, format?, match_time, betting_enabled?}` |
| PUT | `/matches/:id` | 更新基础字段。**置 status=finished 必须已有完整赛果**（引导走 /result）；状态跳变为 finished 时自动结算+重建总分 |
| PUT | `/matches/:id/result` | **录赛果**。body `{team1_score, team2_score}`；校验 `isValidScore` → 推导胜者 → 事务：更新+settleMatch+recalculateUserScores。返回 `{predictions_processed}` |
| PUT | `/matches/:id/forfeit` | **弃权标记**。body `{winner_team_id}`；按 1-0 记录、is_forfeit=1、0 分结算 |
| PUT | `/matches/:id/betting` | 预测开关切换，返回 `{betting_enabled}` |
| DELETE | `/matches/:id` | 删除（级联删预测，重算总分） |

### 预测管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/predictions` | 预测流水（近 500 条全字段） |
| DELETE | `/predictions/:id` | 删除单条预测（重算总分） |

## /api/health — 健康检查

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 🌐 | `{status: 'ok', time: ISO时间}` |

## 非 API 路由（server/index.js）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/`、`/tournaments.html`、`/leaderboard.html`、`/profile.html`、`/teams.html`、`/admin`、`/admin/` | 读对应 HTML 并注入 ICP 备案号后返回 |
| GET | `/js/*`、`/css/*`、`/images/*` 等 | `express.static(publicDir)` |
| GET | `*`（兜底） | 返回注入后的 index.html |

## 响应示例

```jsonc
// GET /api/matches/upcoming（节选）
{
  "matches": [
    {
      "id": 42, "tournament_id": 7, "format": "BO3",
      "match_time": "2026-08-21T14:00:00.000Z", "status": "upcoming",
      "display_status": "upcoming", "betting_enabled": 1,
      "team1_name": "Team Spirit", "team1_short_name": "TS", "team1_logo_url": "https://...",
      "team2_name": "NAVI", "team2_short_name": "NAVI", "team2_logo_url": "https://...",
      "tournament_name": "IEM Cologne 2026", "tournament_logo_url": null,
      "prediction_count": 128,
      "user_prediction": null   // 登录且未预测时
    }
  ],
  "filters": {
    "status_counts": { "finished": 12, "ongoing": 1, "upcoming": 34, "all": 47 },
    "tournaments": [ /* 含各相位计数与 next_match_time */ ],
    "finished_window_days": 1
  }
}
```
