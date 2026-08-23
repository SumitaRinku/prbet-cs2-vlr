# PRBET Code Wiki

> PRBET（prg-cs2-bet-new）· CS2 / Valorant 电竞赛事预测网站 — 代码知识库

基于 Express + SQLite 的电竞赛事预测站点，通过 [PandaScore](https://pandascore.co) REST API 同步 CS2 与 Valorant 赛程及赛果，支持赛前比分预测、积分结算与排行榜。

- 线上站点：<https://prbet.gekichumai.cn>
- 后端：Node.js ≥ 20 · Express 4 · better-sqlite3（单文件 SQLite）
- 前端：原生 HTML / CSS / JavaScript，无构建步骤
- 部署：PM2 + Nginx 反向代理（Linux）

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [01-项目概览](./01-项目概览.md) | 项目定位、功能特性、技术栈、目录结构总览 |
| [02-系统架构](./02-系统架构.md) | 分层架构图、请求处理流程、模块依赖关系 |
| [03-数据库设计](./03-数据库设计.md) | 数据表结构、索引、外键约束、启动时迁移机制 |
| [04-后端模块详解](./04-后端模块详解.md) | 入口、中间件、路由、服务、工具层的关键函数说明 |
| [05-前端模块详解](./05-前端模块详解.md) | 页面与脚本模块职责、赛程图（bracket）渲染管线 |
| [06-API参考](./06-API参考.md) | 全部 REST API 端点：方法、路径、鉴权、参数、响应 |
| [07-核心业务流程](./07-核心业务流程.md) | PandaScore 同步、预测提交、积分结算、TBD / 弃权处理 |
| [08-部署与运维](./08-部署与运维.md) | 本地运行、环境变量、生产部署、安全说明、维护脚本 |

## 阅读建议

- **新上手本仓库**：按 01 → 02 → 03 顺序阅读，建立整体认知。
- **改接口 / 加功能**：直接查 [04-后端模块详解](./04-后端模块详解.md) 与 [06-API参考](./06-API参考.md)。
- **排查积分 / 结算问题**：看 [07-核心业务流程](./07-核心业务流程.md) 中「积分结算」一节。
- **部署上线 / 配置环境变量**：看 [08-部署与运维](./08-部署与运维.md)。

## 一分钟速览

```
浏览器（原生 JS SPA 页面）
   │  fetch /api/*
   ▼
Express（server/index.js，默认监听 127.0.0.1:3000）
   ├── middleware/  auth（JWT）、rateLimit（滑动窗口限流）
   ├── routes/      auth / matches / tournaments / predictions
   │                leaderboard / images / teams / admin
   ├── services/    pandascoreService（定时同步 PandaScore → SQLite）
   ├── utils/       scoring（比分与积分）、settlement（幂等结算）
   └── config/      database（SQLite 连接）、init-db（建表/迁移）
   ▼
SQLite（data/database.sqlite，better-sqlite3 同步驱动）
```

积分规则：胜者错 0 分；胜者对比分不精确 1 分；胜者与比分全对得满分（BO1=1 / BO3=2 / BO5=3）；弃权局一律 0 分。总分由 `predictions.points_earned` 全量重建，保证幂等不漂移。
