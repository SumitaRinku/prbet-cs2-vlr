# NapCat 赛事提醒：从配置到运行

当前目录是 Windows 端程序。**只需要 Node.js 20 或更新版本，不需要 npm install，也不用复制网站数据库。** Linux 网站需要先部署本次代码，网站和 Windows 使用同一个独立令牌。

默认消息：每日 12:00 发送「昨日简报 + 当日赛程（含次日凌晨）」；若当天 06:00–11:59 有比赛，提前到最早开赛前 10 分钟发送整份日报，中午不重复。窗口无比赛时改成「昨日简报 + 后续赛事预告」。凌晨以 06:00 为分界，统一北京时间。

昨日简报按前一天 06:00 至当天 06:00 的**计划开赛时间**归属，展示最多 12 场已结束比赛的队名、比分，弃权另标；其余数量及链接附后。尚未结束、未同步到比分的比赛标为待更新，不猜比分。早于 06:00 发送日报时，简报仅代表当时已知赛果。

还包括开赛前 30 分钟提醒、周日 20:00 七天预告、已通知比赛的改期/取消/对阵更正。这些功能不会自动 @全体成员。

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
