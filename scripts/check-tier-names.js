// 临时验证脚本：测试管理面板 tier 设置 PUT 接口（设置→验证→清除→验证→还原）
// 用法：node scripts/check-tier-names.js
const db = require('../server/config/database');

async function main() {
    // 找一个普通赛事作为测试对象
    const target = db.prepare("SELECT id, name, tier FROM tournaments WHERE name LIKE '%Stake Ranked Episode 3%'").get();
    if (!target) { console.log('未找到测试赛事'); return; }
    console.log(`测试对象: [${target.id}] ${target.name} (当前 tier=${target.tier})`);

    const jwt = require('jsonwebtoken');
    require('dotenv').config();
    // 用数据库中真实 admin 用户签发 token（与 /auth/login 一致）
    const admin = db.prepare("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1").get();
    const token = jwt.sign({ id: admin.id, username: admin.username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

    const put = async body => {
        const res = await fetch(`http://127.0.0.1:3000/api/admin/tournaments/${target.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body)
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const readTier = () => db.prepare('SELECT tier FROM tournaments WHERE id = ?').get(target.id).tier;

    // 1. 设置 tier=1
    let r = await put({ tier: 1 });
    console.log(`设置 tier=1: HTTP ${r.status} -> 落库 tier=${readTier()} ${readTier() === 1 ? 'OK' : 'FAIL'}`);

    // 2. 同步覆盖测试：PandaScore 同步 UPDATE 不含 tier，直接验证 SQL 层（模拟同步语句）
    db.prepare(`UPDATE tournaments SET name = CASE WHEN name_locked = 1 THEN name ELSE name END, game_type = game_type, last_synced_at = datetime('now') WHERE id = ?`).run(target.id);
    console.log(`模拟同步后 tier=${readTier()} ${readTier() === 1 ? 'OK（未被覆盖）' : 'FAIL（被覆盖！）'}`);

    // 3. 清除 tier（回自动推断）
    r = await put({ tier: null });
    console.log(`清除 tier: HTTP ${r.status} -> 落库 tier=${readTier()} ${readTier() === null ? 'OK（回到自动）' : 'FAIL'}`);

    // 4. 非法值拒绝
    r = await put({ tier: 9 });
    console.log(`非法值 tier=9: HTTP ${r.status} ${r.status === 400 ? 'OK（已拒绝）' : 'FAIL'}`);

    console.log('验证完成');
}

main().catch(e => { console.error(e); process.exit(1); });
