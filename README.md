# PRBET · CS2 / Valorant 比赛竞猜

QQ 群每日赛程、昨日赛果与临赛提醒：[NapCat 配置与运行教程](bot/README.md)（Linux 网站 + Windows NapCat）。
账号绑定、群内竞猜、管理员指令与结算推送：[群竞猜启用教程](bot/COMMANDS.md)。

> 基于 Express + SQLite 的电竞赛事预测网站，通过 [PandaScore](https://pandascore.co) REST API 同步 CS2 与 Valorant 赛程及赛果，支持赛前比分预测、积分结算、排行榜、赛事回看、竞猜分享图与 QQ 群机器人。

**实际效果**：<https://prbet.gekichumai.cn>

前端为原生 HTML / CSS / JavaScript（无框架、无构建），后端 Node.js + Express + better-sqlite3 单文件 SQLite，部署简单。比赛同步覆盖过去 48 小时到未来 7 天；远期赛事预告默认覆盖未来 180 天（仅赛事级，不导入远期比赛）。

## 功能特性

### 用户侧

- 注册 / 登录 / JWT 鉴权，登录、注册、改密共享限流防爆破
- 比赛列表：按游戏（CS2 / Valorant）、赛事、状态筛选
- 赛前预测：选择胜者与 BO1 / BO3 / BO5 比分，开赛前可修改 / 取消，保留变更历史
- 比赛详情：公开预测明细、对阵历史（按本场开赛前过滤）
- 竞猜分享图：1080×1080 canvas 合成，主页与个人中心均可用
- 浅色 / 暗色主题；队标暗色变体；暗色模式下黑色赛事 logo 自动反色
- 赛事回看：卡片 / 紧凑视图、完整赛程图（瑞士轮 / 双败 / 单败）
- **未来赛事预告**：赛事回看页展示配置天数内的远期赛事，跟随游戏筛选、可收起
- 队伍中心：队伍近期赛事、阶段名次、比赛结果与胜率
- 排行榜：总榜 / 赛事榜、分页、CSV 导出、用户得分明细
- 个人中心：预测记录筛选、统计、分享、预测公开开关、QQ 绑定、修改密码

### 管理后台 `/admin`

- 概览：用户 / 赛事 / 队伍 / 比赛 / 预测计数、同步状态、待结算提醒
- 用户管理（创建、改角色、重置密码、删除）
- 赛事 / 队伍 / 比赛 CRUD；赛事简称、级别、启用 / 禁用、手动上传 logo
- 预测开关、赛果录入、弃权标记、预测记录管理
- **赛果锁定**：手动录入后同步不再覆盖
- 手动触发比赛同步；**赛事预告前瞻天数设置（7–365 天）** 与立即刷新预告
- 赛事启用 / 禁用：禁用赛事不在前台展示，同步跳过其赛果更新
- 管理界面使用 `ops-` 样式前缀，避免 AdBlock 误判整页为广告

### 积分规则

- 胜者预测错误：**0 分**
- 胜者正确、比分不完全一致：**1 分**
- 胜者与双方比分完全一致：**满分**（BO1 = 1 / BO3 = 2 / BO5 = 3）
- 弃权局：**0 分**，已结算不挂起
- 总分由 `predictions.points_earned` 全量重建，赛果修正后自动自愈，不会增量漂移

## 技术栈

- **运行时**：Node.js ≥ 20
- **后端**：Express 4、better-sqlite3（SQLite）
- **鉴权**：bcryptjs（注册 cost=10，默认管理员 cost=12）、jsonwebtoken（HS256，30 天）
- **前端**：原生 HTML / CSS / JavaScript，无构建
- **群机器人**：NapCat / OneBot + 独立 `bot/` 进程
- **测试**：node:test（6 个文件 / 55 用例）
- **部署**：PM2 + Nginx 反向代理

## 项目结构

```
prg_cs2_bet_new/
├── server/
│   ├── config/      database / init-db / bot-schema
│   ├── middleware/  auth / rateLimit / requestLogger / errorHandler
│   ├── routes/      auth / matches / tournaments / predictions / leaderboard
│   │                images / qrcode / teams / admin / bot / bot-account
│   ├── services/    pandascoreService / settings / tournamentTier
│   │                botCommands / botSettlement
│   ├── utils/       scoring / settlement / validators / matchValidation
│   │                predictionHistory
│   └── index.js
├── public/
│   ├── admin/       管理后台页面
│   ├── css/         style.css / hub.css / admin.css / profile.css
│   ├── js/          theme / tournament-logos / shared / h2h / share / bracket
│   │                app / tournaments / leaderboard-page / profile / teams
│   │                admin / bot-account
│   └── *.html       首页 / 赛事 / 排行榜 / 个人中心 / 队伍
├── bot/             NapCat 群机器人
├── scripts/         cleanup-pandascore-duplicates / backup-db / restore-db
├── test/            node:test
├── data/            SQLite、JWT 密钥、上传 logo、备份
└── package.json
```

## 快速开始

### 前置要求

- Node.js ≥ 20
- PandaScore API Token（[dashboard](https://dashboard.pandascore.co)）

### 本地运行

```bash
npm install
npm run init-db     # 建表 + 迁移 + 默认管理员
npm start
```

访问：

- 首页：http://localhost:3000
- 赛事回看：http://localhost:3000/tournaments.html
- 管理后台：http://localhost:3000/admin/
- 健康检查：http://localhost:3000/api/health

默认管理员：

- 用户名：`admin`（可用 `ADMIN_USERNAME` 自定义）
- 密码：首次初始化随机生成并打印（仅一次），或用 `ADMIN_PASSWORD` 指定
- 登录后可在「个人中心」修改密码

## 环境变量

根目录 `.env`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 默认仅本机 Nginx 反代访问 |
| `TRUST_PROXY` | `1` | 反代层数 |
| `NODE_ENV` | — | `production` / `development` |
| `JWT_SECRET` | 自动生成 | 留空时持久化到 `data/.jwt_secret` |
| `ALLOWED_ORIGINS` | 全开 | CORS 白名单，逗号分隔 |
| `ADMIN_USERNAME` | `admin` | 默认管理员用户名 |
| `ADMIN_PASSWORD` | 随机 | 留空则初始化时打印一次 |
| `ICP_NUMBER` | — | ICP 备案号（footer 注入） |
| `ICP_LINK` | 工信部备案页 | 备案链接 |
| `PANDASCORE_API_TOKEN` | — | PandaScore Token（必填） |
| `PANDASCORE_BASE_URL` | `https://api.pandascore.co` | API 基址 |
| `PANDASCORE_SYNC_ENABLED` | `true` | 关闭比赛与预告定时任务 |
| `PANDASCORE_SYNC_INTERVAL_MS` | `300000` | 比赛同步间隔（≥60000） |
| `PANDASCORE_SYNC_LOOKAHEAD_DAYS` | `7` | 比赛前瞻天数，上限 7 |
| `PANDASCORE_SYNC_RESULTS` | `true` | 是否同步赛果 |
| `PANDASCORE_REQUEST_TIMEOUT_MS` | `20000` | 单请求超时 |
| `PANDASCORE_PREVIEW_DAYS` | `180` | 赛事预告天数默认值；后台设置优先 |
| `PANDASCORE_PREVIEW_INTERVAL_MS` | `21600000` | 预告刷新间隔（6 小时，≥30 分钟） |
| `BOT_FEED_TOKEN` | — | 机器人接口 Token |
| `BOT_COMMAND_GROUP_IDS` | — | 允许群内竞猜的群号 |
| `BOT_ADMIN_QQ_IDS` | — | 允许管理指令的 QQ 号 |
| `ALERT_WEBHOOK_URL` | — | 同步异常告警 webhook |
| `BACKUP_KEEP` | `7` | 备份保留份数 |

`.env` 示例：

```bash
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=1
NODE_ENV=production
JWT_SECRET=请替换为随机长字符串
ALLOWED_ORIGINS=https://your-domain.example
ICP_NUMBER=豫ICP备XXXXXXXX号
PANDASCORE_API_TOKEN=你的PandaScoreToken
PANDASCORE_SYNC_ENABLED=true
PANDASCORE_SYNC_INTERVAL_MS=300000
PANDASCORE_SYNC_LOOKAHEAD_DAYS=7
PANDASCORE_SYNC_RESULTS=true
PANDASCORE_REQUEST_TIMEOUT_MS=20000
PANDASCORE_PREVIEW_DAYS=180
PANDASCORE_PREVIEW_INTERVAL_MS=21600000
```

## PandaScore 同步

- **比赛（近端）**：过去 48 小时 ~ 未来 7 天，默认每 5 分钟；`PANDASCORE_SYNC_LOOKAHEAD_DAYS` 上限 7。
- **赛事预告（远期）**：`/series/upcoming`，默认每 6 小时；天数以管理后台设置为准（默认 180，范围 7–365），只存赛事级信息。
- 手动同步：`npm run sync:pandascore`（比赛）或后台「刷新预告」。
- 未定对阵使用 TBD 占位队；前台列表排除 TBD，完整赛制由赛事详情赛程图展示。

PandaScore 用法：

- 鉴权：`Authorization: Bearer <token>`
- 分页：`page[number]` + `page[size]`
- 时间范围：`range[begin_at]=start,end`

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm start` / `npm run dev` | 启动 |
| `npm run init-db` / `npm run migrate` | 建表/迁移 |
| `npm run sync:pandascore` | 手动同步比赛 |
| `npm run backup` | 在线备份数据库 |
| `npm run restore -- <file>` | 恢复数据库备份 |
| `npm run cleanup:pandascore-duplicates` | 清理历史重复数据（默认 dry-run） |
| `npm test` | 运行测试 |

## 部署（Linux + Nginx + PM2）

```bash
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
cd /home/admin/repo/prg_cs2_bet_new
npm install
npm run init-db
npm run sync:pandascore
npm install -g pm2
pm2 start server/index.js --name prg-cs2-bet-new
pm2 save
pm2 startup
```

只开放 80 / 443；Node 默认只监听 `127.0.0.1`，由 Nginx 反代：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## API 一览

| 路径前缀 | 说明 |
| --- | --- |
| `/api/auth` | 注册、登录、改密、预测公开开关 |
| `/api/matches` | 比赛列表/详情、预测提交、H2H |
| `/api/tournaments` | 赛事、未来赛事预告、赛程、赛事榜 |
| `/api/predictions` | 我的预测、统计、变更历史 |
| `/api/leaderboard` | 排行榜、CSV、用户明细 |
| `/api/teams` | 队伍列表、赛事履历 |
| `/api/images` | 队标安全代理 |
| `/api/qrcode` | 分享图二维码 |
| `/api/admin` | 管理后台（管理员） |
| `/api/bot` | 机器人赛程/指令/结算（Token） |
| `/api/bot-account` | 用户 QQ 绑定 |
| `/api/health` | 健康检查 |

完整接口见 [docs/wiki/06-API参考.md](docs/wiki/06-API参考.md)。

## 安全说明

- 密码 bcrypt 哈希（注册/重置 cost=10，默认管理员 cost=12）
- JWT 密钥优先 `JWT_SECRET`，否则 0600 持久化；改密使旧令牌失效
- 登录/注册/改密限流，依赖 `TRUST_PROXY` 正确识别客户端 IP
- 默认仅监听 `127.0.0.1`，强制反代访问
- 队标代理 SSRF 防护；上传 logo magic bytes 校验；输出统一转义
- HTML 响应禁用缓存，避免部署后复用旧的空白页面

## 文档

完整代码 Wiki：[docs/wiki/README.md](docs/wiki/README.md)。

## License

MIT
