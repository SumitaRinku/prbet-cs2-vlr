# QQ 群赛事提醒：实现设计

本文记录已实现的架构和关键约束。配置、操作和消息示例见 [bot/README.md](../bot/README.md) 与 [bot/COMMANDS.md](../bot/COMMANDS.md)。

## 架构

```text
Linux：PandaScore → 同步服务 → SQLite → /api/bot/*（BOT_FEED_TOKEN 鉴权）
                                          ↑ Windows 每 60 秒拉取
Windows：bot/run.js + 本地 JSON 状态 → 本机 NapCat HTTP 服务端 → QQ 群
NapCat HTTP 客户端 → 127.0.0.1:3002/onebot（HMAC 签名）→ bot/interactions.js → /api/bot/command
```

Windows 主动访问网站，Linux 不连接 Windows，NapCat 不对公网开放。SQLite 不在两台机器间共享。bot 为零依赖 Node.js 20+ 程序。

## 网站接口（`server/routes/bot.js`）

所有接口要求 `Authorization: Bearer <BOT_FEED_TOKEN>`，未配置令牌时返回 503。

| 接口 | 说明 |
| --- | --- |
| `GET /schedule?from&to&ids` | 窗口内已启用赛事的比赛（窗口最大 10 天），以及按 `ids` 补查已播报但移出窗口的比赛（最多 500 个）。返回 `generated_at`、`sync`（每游戏 `last_success_at`）、`matches`、`unavailable_ids`。超过 10,000 场返回 413，不截断 |
| `POST /command` | 执行群指令（`server/services/botCommands.js`），按指令回执幂等 |
| `GET /settlements?group_id&after` | 结算事件游标读取；不带 `after` 返回当前最新游标；游标超界返回 409 |

账号绑定码由已登录用户通过 `/api/bot-account`（`server/routes/botAccount.js`）生成和解绑。

## 数据

`server/config/bot-schema.js` 建立以下表，由 `init-db` 幂等迁移：

| 表 | 用途 |
| --- | --- |
| `bot_sync_state` | 每游戏最近一次完整同步成功时间，用于新鲜度判断 |
| `bot_bind_codes` / `bot_bindings` | 一次性绑定码、QQ 与账号一对一绑定 |
| `bot_group_members` | 各群的竞猜展示关联 |
| `bot_command_receipts` | 指令去重与审计，保留 30 天 |
| `bot_settlement_events` / `bot_settlement_state` | 结算事件流 |

`matches.time_confirmed` 标记开赛时间是否可信：PandaScore 缺失时间时为 0，这类比赛不进入正式赛程和提醒。

## 关键规则

- 时间：接口输出 ISO UTC；bot 按 `Asia/Shanghai` 计算，`dayStart`（默认 06:00）为日报日期分界。
- 日报：日期 D 覆盖 `[D 06:00, D+1 06:00)`。D 当天 06:00–12:00 有比赛则在最早一场前 `earlyMinutes` 分钟发送，否则 `dailyTime`。每个日期只发一份，无比赛时同一份改为近期赛程。
- 提醒对象：`upcoming`、时间已确认、开赛在未来、赛事已启用、双方非 TBD。竞猜开关只影响提醒中的竞猜提示。
- 新鲜度：任一订阅游戏超过 `freshnessMinutes` 未成功同步，暂停本轮所有推送，避免把缺失数据当成“无比赛”。
- 赛程更正：只对已播报的比赛，按快照比对时间、对阵、状态；同一变化只发一次。

## 发送与去重

状态保存在 `bot/data/delivery.json`（推送）和 `bot/data/interactions.json`（指令、结算游标、发送记录），临时文件写入后原子替换。

- 去重键：日报 `daily:日期`、周报 `weekly:日期`、提醒 `reminder:比赛ID:开赛时间`（改期后可重新提醒）、更正 `change:比赛ID:内容哈希`。长消息分段先整体落盘，重试沿用原分段。
- 发送成功需同时满足 HTTP 成功、OneBot `status`/`retcode` 正常并返回 `message_id`。
- 明确失败才有限重试；超时或“已发未记账”记为 `unknown`，不自动重发。OneBot 无幂等键，无法保证恰好一次。
- 停机恢复：日报/周报仅在计划时刻后 2 小时内补发；提醒只发仍在窗口内的。
- 单实例：本机 `lockPort` 端口锁。
