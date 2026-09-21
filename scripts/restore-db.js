const fs = require('fs');
const path = require('path');
const db = require('../server/config/database');

const source = process.argv[2];
if (!source) {
    console.error('用法: node scripts/restore-db.js <backup.sqlite>');
    process.exit(2);
}
const sourcePath = path.resolve(source);
if (!fs.existsSync(sourcePath)) {
    console.error(`备份文件不存在: ${sourcePath}`);
    process.exit(2);
}

db.close();
const target = path.join(__dirname, '..', 'data', 'database.sqlite');
const safety = `${target}.before-restore-${Date.now()}`;
fs.copyFileSync(target, safety);
fs.copyFileSync(sourcePath, target);
console.log(`数据库已恢复: ${sourcePath}`);
console.log(`恢复前数据库备份: ${safety}`);
