# NapCat 赛事提醒：从配置到运行

当前目录是 Windows 端程序。**只需要 Node.js 20 或更新版本，不需要 npm install，也不用复制网站数据库。** Linux 网站需要先部署本次代码，网站和 Windows 使用同一个独立令牌。

默认消息：每日 12:00 发送「昨日简报 + 当日赛程（含次日凌晨）」；若当天 06:00–11:59 有比赛，提前到最早开赛前 10 分钟发送整份日报，中午不重复。窗口无比赛时改成「昨日简报 + 后续赛事预告」。凌晨以 06:00 为分界，统一北京时间。

昨日简报按前一天 06:00 至当天 06:00 的**计划开赛时间**归属，展示最多 12 场已结束比赛的队名、比分，弃权另标；其余数量及链接附后。尚未结束、未同步到比分的比赛标为待更新，不猜比分。早于 06:00 发送日报时，简报仅代表当时已知赛果。

还包括开赛前 30 分钟提醒、周日 20:00 七天预告、已通知比赛的改期/取消/对阵更正。这些功能不会自动 @全体成员。

**新增群聊竞猜、账号绑定、管理员指令和结算推送：** 请看 [群竞猜启用教程](COMMANDS.md)。已有日报用户需要同时更新 Linux 网站与 Windows 程序，并给 NapCat 增加一个本机 HTTP 客户端上报连接。只发日报时仍只需要 HTTP 服务端。

## 消息播报一览

先看这张速览表，下面给出每种情形的完整示例。示例中的队伍、赛事、比赛 ID 和域名均为占位值。

| 情形 | 触发时机 | 消息开头/结果 |
| --- | --- | --- |
| 日报 + 当日赛程 | 默认 12:00；有早场则提前到最早开赛前 10 分钟 | `【赛事日报 · 2026-10-16】` |
| 日报无赛程 | 当天窗口没有已确认比赛 | `今日暂无已确认比赛，为你预告后续赛事：` |
| 临赛提醒（已开放竞猜） | 开赛前默认 30 分钟 | `【即将开赛 · 约 20 分钟后】` |
| 临赛提醒（未开放竞猜） | 同上，但比赛关闭竞猜 | `当前竞猜未开放` |
| 周日七天预告 | 周日默认 20:00 | `【未来七天赛事预告】` |
| 赛程变化 | 已播报比赛改期、取消、延期、下架或对阵变化 | `【赛程更新】` |
| 群内回复/指令 | 合法回复或 `/prbet` 指令 | `QQ 234567：` 后跟处理结果 |
| 赛后结算 | 网站完成比赛结算 | `【比赛结算 · #123】` |
| 数据过期 | 任一订阅游戏同步超过阈值 | 不发群消息，只暂停本轮并写日志 |

### 日报：有赛果和当日赛程

```text
【赛事日报 · 2026-10-16】
时间：北京时间

昨日简报
截至 10/16 12:00

CS2 · BLAST Open
Alpha 2:1 Beta

Valorant · VCT Pacific
Gamma 0:2 Delta
1 场尚未结束或赛果待更新。

今日赛程

CS2 · BLAST Open
10/16 18:00  Alpha vs Beta · BO3
次日 10/17 02:00  Gamma vs Delta · BO1

https://example.com/tournaments.html
```

日报只把有明确比分的已结束比赛放进“昨日简报”；弃权显示为 `Alpha 1:0 Beta（弃权）`。超过 `resultsLimit` 的赛果只提示剩余数量。

### 日报：当天没有已确认赛程

```text
【赛事日报 · 2026-10-16】
时间：北京时间

昨日简报
暂无已确认赛果。

今日赛程
今日暂无已确认比赛，为你预告后续赛事：

CS2 · BLAST Open
10/18 20:00  Alpha vs Beta · BO3
10/19 18:00  Gamma vs Delta · BO1

https://example.com/tournaments.html
```

未来七天也没有已公布赛程时，预告部分显示 `未来七天暂无已公布赛程。`。开赛时间未确认的比赛不会列入正式赛程，末尾会提示待确认数量。

### 临赛提醒：已开放竞猜

启用群竞猜的群会看到可复制的指令；所有满足提醒条件的群都会看到比赛信息和网站链接。

```text
【即将开赛 · 约 20 分钟后】
CS2 · BLAST Open
#123 Alpha vs Beta · BO3
开赛：10/16 18:00（北京时间）
竞猜截止：10/16 18:00（北京时间）
回复本消息并发送比分即可竞猜（如 2:1）：
竞猜示例（请改成你的预测，比分按上方队伍顺序）：
/prbet 竞猜 123 2:1
https://example.com/tournaments.html?tournament=123#match-row-123
```

已绑定并加入该群竞猜的 QQ，可以直接回复这条提醒并发送 `2:1`、`2-1` 或 `2：1`；也可以发送示例指令。比分顺序按提醒中左队、右队填写。

### 临赛提醒：未开放竞猜

```text
【即将开赛 · 约 20 分钟后】
CS2 · BLAST Open
#123 Alpha vs Beta · BO3
开赛：10/16 18:00（北京时间）
当前竞猜未开放
https://example.com/tournaments.html?tournament=123#match-row-123
```

TBD 对阵、未确认时间、已开始、取消或延期的比赛不会生成临赛提醒。

### 周日未来七天预告

```text
【未来七天赛事预告】
北京时间 · 仅含目前已同步赛程

CS2 · BLAST Open
10/18 20:00  Alpha vs Beta · BO3
10/19 18:00  Gamma vs Delta · BO1
其余 2 场见网站

https://example.com/tournaments.html
```

每个赛事最多列 4 场；关闭 `weeklyEnabled` 后不发送。

### 赛程更新

改期或对阵变化：

```text
【赛程更新】
CS2 · BLAST Open
Alpha vs Beta
原定：10/16 18:00
现为：10/18 20:00  Alpha vs Gamma
https://example.com/tournaments.html
```

取消、延期、下架或时间重新未知时，状态行分别为 `已取消`、`已延期`、`已下架或停止展示`、`开赛时间待确认`。同一变化不会重复刷屏。

### 群内回复、指令和赛后结算

直接回复提醒并提交成功：

```text
QQ 234567：
竞猜已提交：#123 Alpha 2:1 Beta
```

重复提交同一场会变成 `竞猜已修改`。未绑定、未加入当前群、比分不符合 BO1/BO3/BO5 或比赛已开始时，会在同一位置返回对应的简短错误。

赛后结算：

```text
【比赛结算 · #123】
BLAST Open
Alpha 2:1 Beta

本群竞猜结果
alice：2:1 · 比分全中 · 本场 2 分（+2）
bob：2:0 · 猜中胜者 · 本场 1 分（+1）
carol：0:2 · 未猜中 · 本场 0 分（+0）
积分已在网站结算，群消息不会重复加分。
```

赛果修正会把标题改成 `【赛果更正 · #123】`，并显示相对上次结算的得分变化；没有本群成员参与时会显示暂无成员竞猜。多场在短时间内结算时会合并为 `【比赛结算 · 共 N 场】`。

### 长消息、异常和不发送

- 超过约 1,200 字会拆成 `（1/2）`、`（2/2）` 等多条，顺序不变。
- 任一订阅游戏同步过期时，本轮不发日报、预告或提醒，避免把数据缺失说成“暂无比赛”。
- 发送结果不确定时记为 `unknown`，不会盲目重发。
- 群指令每分钟、每个 QQ 受限流保护；重复上报不会重复提交竞猜或结算。

## 第一步：在 Linux 网站服务器更新

将本次项目代码上传/更新到网站目录，保留服务器原有 `.env` 和 `data/`。下面命令在**网站项目根目录**执行：

```bash
npm install
npm run backup
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

最后一条会生成一个随机令牌。把它保存到网站根目录 `.env`，不要添加到前端代码：

```dotenv
BOT_FEED_TOKEN=刚生成的令牌
PANDASCORE_SYNC_ENABLED=true
PANDASCORE_SYNC_RESULTS=true
```

保留原有 `PANDASCORE_API_TOKEN` 等配置，再执行：

```bash
npm run init-db
npm run sync:pandascore
pm2 restart prg-cs2-bet-new --update-env
```

`prg-cs2-bet-new` 替换为 `pm2 list` 中实际网站进程名；若网站不用 PM2，则按现有方式重启。迁移会添加 `matches.time_confirmed` 和 `bot_sync_state`，不会清空数据。同步回看范围由 1 天扩为 2 天，以便补齐昨日赛果。

Nginx 需要将 `/api/bot/` 和其他 `/api/` 一样转发给网站 Node 服务。如果当前 `/` 已经反代到网站，一般无需另外修改。公网用 HTTPS，接口响应不应被 CDN 缓存。**不需要在网站服务器安装 NapCat。**

在网站后台启用希望推送的赛事。新同步进来的赛事默认禁用，未启用的不会出现在消息中。旧的 PandaScore 比赛会在重新同步确认真实时间后参与定时提醒。

## 第二步：在 Windows 服务器配置 NapCat

1. 确认 NapCat 已登录，机器人 QQ 已加入目标群且有发言权限。
2. 在 NapCat 的网络配置里新增或开启 **HTTP 服务端（OneBot HTTP Server）**，不是 HTTP 客户端，也不是 WebSocket。
3. 主机/监听地址设 `127.0.0.1`，端口可设 `3001`（若占用则换一个），设置 Access Token，保存并按界面提示启用配置。不同版本页面名称可能稍有不同。
4. 记录实际 HTTP 端口和 Access Token。该令牌与网站令牌可以、也建议分别生成。

只由 Windows 本机调用 NapCat，所以不需要在云防火墙开放 3001 或 NapCat WebUI 端口。

## 第三步：填写 Windows 程序配置

将整个 `bot` 文件夹复制到 Windows，例如 `C:\prbet-bot`。不要只复制 `run.js`，它还需要 `core.js`。先安装 Node.js 20+，重新打开 PowerShell，确认：

```powershell
node --version
Set-Location C:\prbet-bot
Copy-Item config.example.json config.json
notepad config.json
```

至少修改以下 5 项：

| 配置 | 填写内容 |
| --- | --- |
| `siteUrl` | 网站的 HTTPS 域名，例如 `https://prbet.gekichumai.cn`，末尾不带 `/api` |
| `feedToken` | Linux `.env` 中的 `BOT_FEED_TOKEN` |
| `napcatUrl` | NapCat HTTP 服务端地址，例如 `http://127.0.0.1:3001`，不是 WebUI 地址 |
| `napcatToken` | NapCat HTTP 服务端的 Access Token |
| `groupIds` | 目标QQ群号，必须保留引号，例如 `["123456789"]`；多个群用逗号分隔 |

先填一个专门的测试群。不要将带令牌的 `config.json` 上传公开仓库。JSON 不允许注释或最后一项后多余的逗号。

## 第四步：先预览，再测试发消息

在 Windows PowerShell 中执行：

```powershell
Set-Location C:\prbet-bot
node run.js --preview
```

这会真实读取网站赛程并打印日报，**不会发到QQ群，也不会写入发送记录**。如果提示同步过期，应先处理 Linux 的 PandaScore 同步；当前工作区旧库不能直接当成生产实时赛程。

预览没有问题后，将 `config.json` 中 `"dryRun": true` 改成 `"dryRun": false`，保存，再执行：

```powershell
node run.js --test
```

**这条命令会立即向配置中的每一个群发送一条“赛事提醒连接测试”。** 输出 `sent` 且群内收到消息代表链路通畅；失败时看状态和下面的排查表。每次运行 `--test` 都是新的测试消息，不受日报去重限制。

测试通过后可换成正式群号，启动：

```powershell
node run.js
```

程序持续运行，每分钟检查一次。必须保持运行；关掉这个终端就停止。不会因为启动就立即补发当天所有消息：日报只在计划时间起两小时内补发，临赛提醒只发仍未开始的比赛。需要马上看日报时用 `--preview`，不要删除发送记录。

## 第五步：设置 Windows 开机自动运行

用 Windows「任务计划程序」→「创建任务」：

1. 常规：名称 `PRBET QQ Reminders`，选择安装 Node.js、可读取 `C:\prbet-bot` 的账号，选择“不管用户是否登录都要运行”。保存时由 Windows 提示输入该账号密码。
2. 触发器：系统启动时，可延迟 1 分钟。
3. 操作：启动程序 `powershell.exe`；参数填 `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\prbet-bot\start.ps1"`；“起始于”填 `C:\prbet-bot`。
4. 设置：勾选失败后每 1 分钟重新启动；取消“任务运行超过指定时间则停止”；如果任务已运行，选择“不启动新实例”。
5. 先停止手动运行的 `node run.js`（Ctrl+C），然后右键任务→运行。

NapCat 自身也需要按它原有的方式保持运行和登录。程序只负责调用已运行的 NapCat，不代替 QQ 登录。

程序额外占用本机 `39173` 端口防止同一台机器同时启动两个实例，该端口无需对外开放。通过更改 `lockPort` 绕过锁并同时运行多个实例可能导致重复消息，不要这样使用。

通过任务启动时，日志保存在 `C:\prbet-bot\data\worker-启动日期.log`。可查看：

```powershell
Get-Content (Get-ChildItem C:\prbet-bot\data\worker-*.log | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Tail 50
node C:\prbet-bot\run.js --status
```

## 可调整的规则

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `games` | `["cs2", "valorant"]` | 可只保留一个游戏 |
| `dailyTime` | `"12:00"` | 无早场时的日报时间 |
| `dayStart` | `"06:00"` | 每日赛程及昨日简报的分界 |
| `earlyMinutes` | `10` | 上午最早比赛前多少分钟发日报 |
| `reminderMinutes` | `30` | 独立临赛提醒；设 `0` 关闭 |
| `weeklyEnabled` | `true` | 是否发送周日预告 |
| `weeklyTime` | `"20:00"` | 周日发送时间 |
| `resultsLimit` | `12` | 日报最多展示多少条昨日赛果 |
| `freshnessMinutes` | `20` | 数据超过多久未成功同步便暂停发送 |
| `pollSeconds` | `60` | 检查间隔；因此通常在目标时刻后约一分钟内发送 |

修改配置后重启 Windows 任务。所有群使用同一套筛选与时间配置。网站未启用的赛事不推送。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 找不到 `node` | 安装 Node.js 20+，重开终端；计划任务账号也需要可找到 Node |
| 网站 HTTP 401 | 两台服务器的 feedToken / BOT_FEED_TOKEN 不一致 |
| 网站 HTTP 503 | Linux 未配置 BOT_FEED_TOKEN，或修改后未重启网站 |
| 网站接口格式不匹配 / 返回 HTML | 网站没更新，或 Nginx 没有代理 `/api/bot/` |
| 提示同步过期 | 在 Linux 执行 `npm run sync:pandascore`，查看错误；确认订阅游戏成功同步，服务端时钟正确 |
| 赛程中缺少赛事 | 在网站后台启用赛事；确认比赛时间已知、数据在未来七天内 |
| NapCat HTTP 401/403 | 检查 NapCat Access Token |
| NapCat HTTP 404 | 检查使用的是 OneBot HTTP 服务端口，而非 WebUI 端口 |
| `failed` | 明确被拒绝；核对群号、QQ登录状态和群发言权限。常规任务最多重试 3 次 |
| `unknown` | 超时或回执不完整，可能已发出。核对群消息和 NapCat 日志；程序不会盲目重发 |
| 端口 39173 被占用 | 先停止旧进程/旧计划任务，避免同时运行两份 |
| `dryRun` 仍为 true | 程序只预览一次并退出，不会进入正式推送循环 |

发送记录在 `data/delivery.json`，由程序以临时文件落盘后原子替换保存。更新程序时保留 `config.json` 与整个 `data` 文件夹；只替换代码。**不要为了重发而删除整个记录文件**，否则会丢失去重状态。OneBot 不提供业务幂等键，发生“已发送但没来得及保存回执”的情况无法保证恰好一次，程序会按 unknown 保守处理。

当前一次完整赛程接口最多返回 10,000 场，超过会报错而非悄悄截断。消息约 1,200 字拆分，间隔 3 秒发送；同步异常时暂停正式推送，避免把缺失数据说成“没有比赛”。赛程更正每次轮询检查，不做额外的五分钟合并。简报按数据库已保存的比分生成，不是实时比分直播。
