const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();

// 分享图二维码：同源 PNG，供前端 canvas 绘制（避免跨域污染 canvas）。
// text 限制长度与协议白名单，防止将接口当作任意二维码生成器滥用。
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

router.get('/', async (req, res) => {
    const text = String(req.query.text || '').trim();
    const size = Math.min(Math.max(Number(req.query.size) || 320, 160), 640);
    if (!text || text.length > 512) return res.status(400).json({ error: '参数无效' });
    try {
        const parsed = new URL(text);
        if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return res.status(400).json({ error: '仅支持 http/https 链接' });
    } catch {
        return res.status(400).json({ error: '链接格式不正确' });
    }
    try {
        const buffer = await QRCode.toBuffer(text, {
            type: 'png',
            width: size,
            margin: 1,
            color: { dark: '#0d1420ff', light: '#ffffffff' }
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: '二维码生成失败' });
    }
});

module.exports = router;
