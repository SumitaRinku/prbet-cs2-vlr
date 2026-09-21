// SQLite 在线备份：better-sqlite3 的 backup API 在同一连接上执行，
// 备份期间读写不受阻塞，产物是一份一致性完整快照。
// 用法：node scripts/backup-db.js
// 建议 crontab 每日一次，例如每天 04:00：
//   0 4 * * * cd /path/to/prg_cs2_bet_new && node scripts/backup-db.js >> data/backup.log 2>&1
// 保留策略：默认保留最近 7 份，可用 BACKUP_KEEP 调整。
const fs = require('fs');
const path = require('path');
const db = require('../server/config/database');

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dest = path.join(BACKUP_DIR, `database-${stamp}.sqlite`);

fs.mkdirSync(BACKUP_DIR, { recursive: true });
db.backup(dest)
    .then(() => {
        const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
        console.log(`[backup] 完成: ${dest} (${size} MB)`);
        // 清理超出保留份数的旧备份（按文件名时间戳排序）
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(name => /^database-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.sqlite$/.test(name))
            .sort();
        for (const name of backups.slice(0, Math.max(backups.length - KEEP, 0))) {
            fs.unlinkSync(path.join(BACKUP_DIR, name));
            console.log(`[backup] 清理旧备份: ${name}`);
        }
        console.log(`[backup] 当前保留 ${Math.min(backups.length, KEEP)} 份`);
    })
    .catch(error => {
        console.error('[backup] 失败:', error.message);
        process.exit(1);
    });
