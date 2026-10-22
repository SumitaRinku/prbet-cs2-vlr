# 06 · API 参考

Base URL：`/api`。除上传 logo 外均为 JSON 请求/响应。

**鉴权**：`Authorization: Bearer <JWT>`（登录/注册返回，30 天）；机器人接口使用 `Bearer <BOT_FEED_TOKEN>`。

图例：🌐 公开 · 👤 可选登录 · 🔒 登录 · 🛡️ 管理员 · 🤖 机器人 Token

**限流**：`/auth/register`、`/auth/login`、`/auth/password` 共享每 IP 15 分钟 20 次；`/bot/*` 每 IP 1 分钟 300 次；`/bot-account/*` 每 IP 1 分钟 10 次。

**错误格式**：`{ "error": "中文信息", "errorId"?, "statusCode"? }`；状态码 400 / 401 / 403 / 404 / 409 / 413 / 429 / 500。

---

## /api/auth — 认证

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/register` | 🌐 | `{username, password}`；用户名 3–20 位 `[a-zA-Z0-9_]`，密码 ≥6；201 返回 `{user, token}` |
| POST | `/login` | 🌐 | `{username, password}`；成功 `{user, token}`；失败 401 |
| GET | `/me` | 🔒 | `{user}`（id/username/role/total_score/predictions_public/created_at） |
| PUT | `/visibility` | 🔒 | `{predictions_public: 0/1}`；返回更新后的 `{user}` |
| PUT | `/password` | 🔒 | `{old_password, new_password}`；成功后 `token_version + 1`，旧令牌全部失效 |

## /api/matches — 比赛

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 👤 | 通用列表。query：`status`、`game_type`、`tournament_id`；≤200 条，排除 TBD，登录附 `user_prediction` |
| GET | `/upcoming` | 👤 | 首页聚合 `{matches, filters:{status_counts, tournaments, finished_window_days}}`；已结束窗口 1 天；每行附 `display_status` |
| GET | `/:id` | 👤 | `{match}` + `possible_scores` + 登录用户的 `user_prediction` |
| GET | `/:id/predictions` | 🌐 | 已结束比赛的公开预测明细；未结算 400 |
| POST | `/:id/predictions` | 🔒 | `{predicted_winner_id, predicted_team1_score, predicted_team2_score}`；非 TBD、upcoming、betting 开启、未开赛、比分合法且方向一致；写 `prediction_history` |
| DELETE | `/:id/predictions` | 🔒 | 开赛前取消；无预测 404；写历史 |
| GET | `/:id/head2head` | 🌐 | `{match, team1, team2, head_to_head}`；近况/交手按本场开赛前过滤 |

## /api/tournaments — 赛事

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 🌐 | 活跃赛事聚合。query：`game_type`、`status`（finished / ongoing） |
| GET | `/previews` | 🌐 | **未来赛事预告** `{previews:[{id,game_type,external_id,name,begin_at,end_at}], days}`；只读 `tournament_previews`，仅 `is_visible = 1` 且在 `preview_days` 窗口内 |
| GET | `/:id` | 🌐 | 赛事详情 + 全部比赛（赛程图数据源） |
| GET | `/:id/leaderboard` | 🌐 | 赛事榜（排除 admin、弃权局） |
| GET | `/:id/predictions` | 🌐 | 已结束比赛的预测流水 |

## /api/predictions — 我的预测

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/my` | 🔒 | `{predictions, stats}`；stats 与排行榜同口径（活跃赛事、排除弃权） |
| GET | `/history` | 🔒 | `{history}`；query `limit`（≤200，默认 100）；读取 `prediction_history` |

## /api/leaderboard — 排行榜

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 🌐 | 总榜。query：`game_type`、`page`、`page_size`（1–100）；仅活跃赛事、排除 admin 与弃权局 |
| GET | `/export` | 🌐 | CSV（UTF-8 BOM）；query：`game_type`、`tournament_id` |
| GET | `/tournament/:id` | 🌐 | 单赛事榜 |
| GET | `/users/:id/details` | 🌐 | 用户得分明细 `{user, summary, predictions}` |

## /api/images — Logo 代理

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/team-logo?url=...` | 🌐 | 仅代理库内已注册 URL；SSRF 防护（内网拦截、DNS 全记录校验、固定 IP 连接、重定向逐跳校验）；≤2MB / 12s；仅图片；缓存 1 天 + nosniff + CSP |

## /api/qrcode — 二维码

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/?text=<url>&size=<n>` | 🌐 | 仅 http/https URL（≤512 字符）；size 160–640；PNG；缓存 1 天 |

## /api/teams — 队伍

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 🌐 | 队伍列表（排除 TBD）。query：`game_type`、`q`、`limit`（≤100） |
| GET | `/:id` | 🌐 | `{team, stats, tournaments, matches}`；`match_limit` ≤100、`tournament_limit` ≤50 |

## /api/admin — 管理后台（全部 🛡️）

### 统计与同步

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/stats` | 计数 + `sync`（含 `preview_days`、`preview_last_run`）。query：`game_type` |
| GET | `/sync/status` | 同步配置与最近运行 `{sync}`；比赛与预告状态分开 |
| PUT | `/sync/settings` | `{preview_days}`；整数 7–365，写入 `app_settings`，返回 `{sync}` |
| POST | `/sync/previews` | 立即刷新远期赛事预告（赛事级，不导入远期比赛） |
| POST | `/sync/pandascore` | 手动同步近端比赛（mode='manual'） |
| GET | `/previews` | 未来赛事预告管理列表（含已隐藏项），query：`game_type` |
| PUT | `/previews/:id/visibility` | `{is_visible: 0|1}`；控制该赛事在前台预告板块是否展示，同步不覆盖 |

### 用户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/users` | 用户列表（含 prediction_count） |
| POST | `/users` | `{username, password, role?}` |
| PUT | `/users/:id/role` | `{role}`；默认 admin 不可降级 |
| PUT | `/users/:id/password` | `{password}` |
| DELETE | `/users/:id` | 默认 admin 拒绝；删后重算总分 |

### 赛事

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/tournaments` | 全部赛事（含禁用） |
| POST | `/tournaments` | `{name, short_name?, game_type?, begin_at?, end_at?, is_active?}`；name_locked=1 |
| PUT | `/tournaments/:id` | 更新；`short_name` 未传保留 / 空串清除；`tier` 可设；is_active 变化联动 betting |
| PUT | `/tournaments/:id/logo` | 二进制图片（image/*，≤2MB，magic bytes 校验）；写 `/uploads/tournament/<id>.<ext>` |
| DELETE | `/tournaments/:id/logo` | 清除上传 logo |
| PUT | `/tournaments/:id/toggle-active` | 启用/禁用切换 |
| DELETE | `/tournaments/:id` | 有比赛时拒绝 |

### 队伍

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/teams` | 列表（≤1000） |
| POST | `/teams` | `{name, game_type?, short_name?, logo_url?, country?}` |
| PUT | `/teams/:id` | 部分更新 |
| DELETE | `/teams/:id` | 有关联比赛拒绝 |

### 比赛

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/matches` | query：`game_type`、`status`、`limit`（≤1000） |
| POST | `/matches` | 创建（`match_time` 必填，写入时 `time_confirmed=1`） |
| PUT | `/matches/:id` | 更新基础字段；置 finished 必须有完整赛果 |
| PUT | `/matches/:id/result` | `{team1_score, team2_score}`；校验 → 推导胜者 → 结算 + 重建总分；写 `result_locked=1` |
| PUT | `/matches/:id/forfeit` | `{winner_team_id}`；1-0、is_forfeit、0 分结算；写 `result_locked=1` |
| PUT | `/matches/:id/betting` | 预测开关 |
| DELETE | `/matches/:id` | 删除并重算总分 |

### 预测

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/predictions` | 近 500 条流水 |
| DELETE | `/predictions/:id` | 删除并重算总分 |

## /api/bot — 机器人（🤖）

`Authorization: Bearer <BOT_FEED_TOKEN>`；未配置 Token 返回 503；`Cache-Control: no-store`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/schedule` | query：`from`、`to`（≤10 天）、`ids`（≤500）；返回 `{version, generated_at, matches, sync, unavailable_ids}`；超过 10000 行返回 413 |
| POST | `/command` | 群内指令 `{request_id, group_id, qq_id, action, args...}`；幂等回执；预期错误 400 |
| GET | `/settlements` | query：`group_id`、`after`（游标）；仅返回群白名单内、且成员入群时间之后的结算事件；游标超前 409 |

## /api/bot-account — 用户 QQ 绑定（🔒）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | `{binding, groups}` |
| POST | `/code` | `{qq_id}`；生成一次性绑定码 |
| DELETE | `/` | 解除绑定并撤销未使用绑定码 |

## /api/health

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 🌐 | `{status:'ok', time}` |

## 非 API 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/`、`/tournaments.html`、`/leaderboard.html`、`/profile.html`、`/teams.html`、`/admin`、`/admin/` | 读取 HTML，注入 ICP 备案号；`Cache-Control: no-store` 且忽略条件请求 |
| GET | `/js/*`、`/css/*`、`/images/*`、`/fonts/*` 等 | `express.static(publicDir)` |
| GET | `/uploads/*` | `express.static(data/uploads)`（管理员上传的赛事 logo，7 天缓存） |
| GET | `*` | 兜底 index.html |

## 响应示例

```jsonc
// GET /api/admin/sync/status（节选）
{
  "sync": {
    "enabled": true, "configured": true, "running": false,
    "interval_ms": 300000, "lookahead_days": 7,
    "preview_days": 180, "preview_interval_ms": 21600000, "preview_running": false,
    "last_run": { "mode": "scheduled", "status": "success", "matches_upserted": 427 },
    "preview_last_run": { "mode": "preview", "status": "success", "tournaments_upserted": 7 }
  }
}
```
