# PRBET Code Wiki

> PRBET（prg-cs2-bet-new）· CS2 / Valorant 电竞赛事预测网站 — 代码知识库

基于 Express + SQLite 的电竞赛事预测站点：PandaScore 同步近端赛程/赛果与远期赛事预告，支持赛前比分预测、积分结算、排行榜、赛事回看、竞猜分享图，以及 QQ 群赛程/提醒/群内竞猜。

- 线上站点：<https://prbet.gekichumai.cn>
- 后端：Node.js ≥ 20 · Express 4 · better-sqlite3（单文件 SQLite）
- 前端：原生 HTML / CSS / JavaScript，无构建步骤
- 部署：PM2 + Nginx 反向代理（Linux）；QQ 机器人由独立 `bot/` 进程 + NapCat 驱动

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [01-项目概览](./01-项目概览.md) | 项目定位、功能特性、技术栈、目录结构、npm scripts |
| [02-系统架构](./02-系统架构.md) | 分层架构、启动流程、模块依赖、外部服务 |
| [03-数据库设计](./03-数据库设计.md) | 全部数据表、索引、外键、启动迁移机制 |
| [04-后端模块详解](./04-后端模块详解.md) | 入口、中间件、路由、服务、工具层关键函数 |
| [05-前端模块详解](./05-前端模块详解.md) | 页面与脚本职责、赛程图、分享图、管理后台 UI |
| [06-API参考](./06-API参考.md) | 全部 REST API：方法、路径、鉴权、参数、响应 |
| [07-核心业务流程](./07-核心业务流程.md) | 比赛同步、赛事预告、预测、结算、TBD / 弃权 / 结果锁定 |
| [08-部署与运维](./08-部署与运维.md) | 本地运行、环境变量、生产部署、备份、安全、排障 |

## 一分钟速览

```
浏览器（原生 HTML + JS 多页）
   │  fetch /api/*
   ▼
Express（server/index.js，默认 127.0.0.1:3000）
   ├── middleware/  requestLogger、auth（JWT）、rateLimit、errorHandler
   ├── routes/      auth / matches / tournaments / predictions / leaderboard
   │                images / qrcode / teams / admin / bot / bot-account
   ├── services/    pandascoreService（近端比赛 + 远期赛事预告）
   │                settings（后台可调配置）、tournamentTier
   │                botCommands / botSettlement（QQ 群指令与推送）
   ├── utils/       scoring、settlement、validators、matchValidation、predictionHistory
   └── config/      database（SQLite 单例）、init-db（建表/迁移）、bot-schema
   ▼
SQLite（data/database.sqlite）
```

积分规则：胜者错 0 分；胜者对比分不精确 1 分；胜者与比分全对得满分（BO1=1 / BO3=2 / BO5=3）；弃权局一律 0 分。总分由 `predictions.points_earned` 全量重建，保证幂等不漂移。
