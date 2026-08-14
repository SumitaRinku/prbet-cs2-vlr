# PRBET · CS2 / Valorant 比赛竞猜

> 基于 Express + SQLite 的电竞赛事预测网站，通过 [PandaScore](https://pandascore.co) REST API 同步 CS2 与 Valorant 赛程及赛果，支持赛前比分预测、积分结算与排行榜。

中文电竞赛事竞猜站点。前端为原生 HTML / CSS / JavaScript（无框架），后端为 Node.js + Express + better-sqlite3，单文件 SQLite 数据库，部署简单。数据由 PandaScore 定时同步，覆盖过去 1 天到未来 7 天的比赛。

## 功能特性

### 用户侧
- 注册 / 登录 / JWT 鉴权，登录接口限流防爆破
- 比赛列表：按游戏（CS2 / Valorant）、赛事筛选
- 赛前预测：选择胜者与 BO1 / BO3 / BO5 比分
- 赛事回看：赛程图（bracket）展示完整赛制结构
- 排行榜、个人中心（我的预测、修改密码）

### 管理后台 `/admin`
- 统计概览、用户管理
- 赛事 / 队伍 / 比赛管理
- 队伍中心：查看队伍近期赛事、阶段名次、比赛结果与胜率
- 手动触发 PandaScore 同步、查看同步记录
- 预测开关、赛果录入、预测记录管理
- 赛事启用 / 禁用：禁用的赛事不在前台展示，后续同步会跳过其比赛状态与赛果更新，适合过滤无需竞猜的小型赛事

### 积分规则
- 胜者预测错误：**0 分**
- 胜者预测正确、比分不完全一致：**1 分**（基础分）
- 胜者与双方比分完全一致：**满分**（BO1 = 1 / BO3 = 2 / BO5 = 3）
- 结算幂等：赛果修正后重新结算得到正确分数；用户总分由 `predictions.points_earned` 重建，避免增量累加导致的漂移

## 技术栈
- **运行时**：Node.js ≥ 20
- **后端**：Express 4、better-sqlite3（SQLite 单文件数据库）
- **鉴权**：bcryptjs（密码哈希）、jsonwebtoken（JWT，HS256，30 天有效期）
- **其他**：cors、dotenv
- **前端**：原生 HTML / CSS / JavaScript（无构建步骤）
- **部署**：PM2 + Nginx 反向代理（生产）

## 项目结构

```
prg_cs2_bet_new/
├── server/
│   ├── config/
│   │   ├── database.js          # SQLite 连接（启用外键）
│   │   └── init-db.js           # 建表、迁移、创建默认管理员
│   ├── middleware/
│   │   ├── auth.js              # JWT 签发 / 校验，密钥持久化
│   │   └── rateLimit.js         # 内存滑动窗口限流
│   ├── routes/
│   │   ├── auth.js              # 注册 / 登录 / 改密
│   │   ├── matches.js           # 比赛列表 / 详情
│   │   ├── tournaments.js       # 赛事与赛程图
│   │   ├── predictions.js       # 预测提交 / 查询
│   │   ├── leaderboard.js       # 排行榜
│   │   ├── images.js            # 队伍 logo 代理
│   │   └── admin.js             # 管理后台接口
│   ├── services/
│   │   └── pandascoreService.js # PandaScore 同步服务（定时 + 手动）
│   ├── utils/
│   │   ├── scoring.js           # 比分合法性、积分计算
│   │   └── settlement.js        # 比赛结算、总分重建（幂等）
│   └── index.js                 # 应用入口
├── public/                      # 静态前端
│   ├── admin/                   # 管理后台页面
│   ├── css/  images/  js/       # 样式、图片、脚本（含 bracket.js 赛程图）
│   └── *.html                   # 首页 / 赛事 / 排行榜 / 个人中心
├── scripts/
│   └── cleanup-pandascore-duplicates.js
├── data/                        # SQLite 数据库与 JWT 密钥（已 gitignore）
└── package.json
```

## 快速开始

### 前置要求
- Node.js ≥ 20
- PandaScore API Token（在 [dashboard](https://dashboard.pandascore.co) 获取）

### 本地运行

```bash
npm install
npm run init-db     # 建表 + 创建默认管理员
npm start
```

访问：

- 首页：http://localhost:3000
- 管理后台：http://localhost:3000/admin/
- 队伍中心：http://localhost:3000/teams.html
- 健康检查：http://localhost:3000/api/health

默认管理员：

- 用户名：`admin`（可用 `ADMIN_USERNAME` 自定义）
- 密码：首次初始化时随机生成并打印在控制台（仅显示一次），或用 `ADMIN_PASSWORD` 指定
- 登录后可在「个人中心」修改密码

## 环境变量

在项目根目录创建 `.env`（**切勿提交**，已被 `.gitignore` 忽略）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。默认只允许本机 Nginx 反代访问；无反代直连部署才设 `0.0.0.0`，并同时设 `TRUST_PROXY=0` |
| `TRUST_PROXY` | `1` | 信任的反向代理层数。单层 Nginx 为 `1`；直连部署设 `0`；前面还有 CDN 时按层数调大 |
| `NODE_ENV` | — | `production` / `development` |
| `JWT_SECRET` | 自动生成 | JWT 密钥。留空时自动生成并持久化到 `data/.jwt_secret`；生产环境建议显式指定 |
| `ALLOWED_ORIGINS` | 全开 | CORS 白名单，逗号分隔；配置后只允许这些来源 |
| `ADMIN_USERNAME` | `admin` | 默认管理员用户名 |
| `ADMIN_PASSWORD` | 随机 | 留空则初始化时随机生成并打印一次 |
| `ICP_NUMBER` | — | ICP 备案号，公开展示在 footer（服务端注入，生产必填，否则不显示） |
| `ICP_LINK` | `https://beian.miit.gov.cn/` | 备案号链接，默认工信部备案查询页 |
| `PANDASCORE_API_TOKEN` | — | PandaScore API Token（必填，否则无法同步） |
| `PANDASCORE_BASE_URL` | `https://api.pandascore.co` | PandaScore API 基址 |
| `PANDASCORE_SYNC_ENABLED` | `true` | 是否启用定时同步（设 `false` 关闭） |
| `PANDASCORE_SYNC_INTERVAL_MS` | `300000` | 同步间隔，最小 `60000` |
| `PANDASCORE_SYNC_LOOKAHEAD_DAYS` | `7` | 向前查看天数，**上限 7 天** |
| `PANDASCORE_SYNC_RESULTS` | `true` | 是否同步已结束比赛的赛果（设 `false` 关闭） |
| `PANDASCORE_REQUEST_TIMEOUT_MS` | `20000` | 单次 PandaScore HTTP 请求超时 |

### `.env` 示例

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
```

## PandaScore 同步

手动同步：

```bash
npm run sync:pandascore
```

服务启动后若 `PANDASCORE_SYNC_ENABLED=true` 且配置了 Token，会自动定时同步。同步窗口为过去 1 天到未来 7 天；即使配置了更大的 `PANDASCORE_SYNC_LOOKAHEAD_DAYS`，代码也会限制为最多 7 天。

PandaScore REST API 用法遵循官方文档：

- 鉴权：`Authorization: Bearer <token>`
- 分页：`page[number]` + `page[size]`
- 时间范围：`range[begin_at]=start,end`

未定对阵（TBD）使用占位队伍，前台比赛列表会排除含 TBD 的对局，完整赛制结构由赛事详情页的赛程图展示。

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

**端口**：只开放 80 / 443（Nginx）。**不要**对公网开放 3000 —— Node 默认只监听 `127.0.0.1`，由 Nginx 反代访问；公网直连 Node 会绕过反代并可伪造 `X-Forwarded-For` 绕过登录限流。

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# 如果以前开过 3000，删掉：
sudo ufw delete allow 3000/tcp
```

Nginx + HTTPS 反向代理到：

```nginx
proxy_pass http://127.0.0.1:3000;
```

## API 一览

| 路径前缀 | 说明 |
| --- | --- |
| `/api/auth` | 注册、登录、修改密码 |
| `/api/matches` | 比赛列表与详情 |
| `/api/tournaments` | 赛事、赛程图 |
| `/api/predictions` | 提交与查询预测 |
| `/api/leaderboard` | 排行榜 |
| `/api/images` | 队伍 logo 代理 |
| `/api/teams` | 队伍列表、赛事履历与比赛结果 |
| `/api/admin` | 管理后台（需管理员权限） |
| `/api/health` | 健康检查 |

## 安全说明

- 密码使用 bcrypt（cost = 12）哈希存储
- JWT 密钥优先取 `JWT_SECRET`，未配置时持久化到 `data/.jwt_secret`（权限 0600），重启不掉线
- 登录接口限流，依赖 `TRUST_PROXY` 正确识别真实客户端 IP
- 默认仅监听 `127.0.0.1`，强制经反代访问，避免直连绕过限流
- `.env` 与 `data/` 已在 `.gitignore` 中忽略，切勿将密钥提交到仓库

## License

MIT
