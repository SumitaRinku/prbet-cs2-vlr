const express = require('express');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/database');

const router = express.Router();
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12000;

// logo 磁盘缓存：同一 logo 全站只回源一次，后续请求（含其他用户）直接读本地文件。
// logo URL 内容基本不变，缓存不设过期；如需刷新删除 data/logo-cache/ 目录即可。
const LOGO_CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'logo-cache');
let logoCacheDirReady = false;

function logoCachePath(url) {
    return path.join(LOGO_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex'));
}

async function readLogoCache(url) {
    try {
        const [body, meta] = await Promise.all([
            fs.promises.readFile(logoCachePath(url)),
            fs.promises.readFile(`${logoCachePath(url)}.meta`, 'utf8')
        ]);
        return { contentType: JSON.parse(meta).contentType, body };
    } catch (error) {
        return null;
    }
}

async function writeLogoCache(url, image) {
    try {
        if (!logoCacheDirReady) {
            fs.mkdirSync(LOGO_CACHE_DIR, { recursive: true });
            logoCacheDirReady = true;
        }
        const file = logoCachePath(url);
        const temp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(temp, image.body);
        await fs.promises.rename(temp, file);
        await fs.promises.writeFile(`${file}.meta`, JSON.stringify({ contentType: image.contentType }));
    } catch (error) {
        // 缓存写盘失败不影响本次响应
    }
}

// 只代理已注册的 logo URL（队伍表或赛事表里存的），防止代理被滥用为任意图片跳板
function isKnownTeamLogo(url) {
    return !!db.prepare('SELECT id FROM teams WHERE logo_url = ? OR dark_logo_url = ? LIMIT 1').get(url, url)
        || !!db.prepare('SELECT id FROM tournaments WHERE logo_url = ? LIMIT 1').get(url);
}

// 拦截内网/回环/链路本地/元数据地址，防止 SSRF 打到内部服务
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        return false;
    }
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        if (v === '::1' || v === '::') return true;
        if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
        if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)); // IPv4 映射地址
        return false;
    }
    return true; // 解析不出合法 IP，按危险处理
}

// 解析主机名并确认所有 A/AAAA 记录都是公网地址，返回校验过的首条记录。
// 调用方必须用返回的 IP 建立连接（通过自定义 lookup 固定），
// 防止 http.get 二次解析时被 DNS rebinding 换成内网地址。
async function resolvePublicAddress(hostname) {
    if (net.isIP(hostname)) {
        if (isPrivateIp(hostname)) throw new Error('Logo host resolves to a non-public address');
        return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
    }
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) throw new Error('Logo host did not resolve');
    for (const { address } of records) {
        if (isPrivateIp(address)) throw new Error('Logo host resolves to a non-public address');
    }
    return records[0];
}

// 常见图片格式的文件头，用于源站 content-type 缺失/不规范时的兜底识别
function sniffImageType(body) {
    if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
    if (body.length >= 6 && ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('latin1'))) return 'image/gif';
    if (body.length >= 12 && body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

function fetchImage(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            reject(new Error('Unsupported logo URL protocol'));
            return;
        }

        resolvePublicAddress(parsed.hostname).then(({ address, family }) => {
            const client = parsed.protocol === 'https:' ? https : http;
            const options = {
                headers: {
                    'User-Agent': 'PRBET/1.0 team-logo-proxy',
                    Accept: 'image/*'
                },
                timeout: TIMEOUT_MS,
                // 固定连接到刚校验过的公网 IP（TLS SNI/证书校验仍用原主机名）
                lookup: (host, opts, callback) => (opts && opts.all
                    ? callback(null, [{ address, family }])
                    : callback(null, address, family))
            };

            const request = client.get(parsed, options, response => {
                const status = response.statusCode || 0;
                if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < 3) {
                    response.resume();
                    // 每一跳重定向都重新走公网校验，防止重定向绕过
                    fetchImage(new URL(response.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
                    return;
                }

                if (status < 200 || status >= 300) {
                    response.resume();
                    reject(new Error(`Logo source responded ${status}`));
                    return;
                }

                const chunks = [];
                let total = 0;
                response.on('data', chunk => {
                    total += chunk.length;
                    if (total > MAX_BYTES) {
                        request.destroy(new Error('Logo image is too large'));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    const body = Buffer.concat(chunks);
                    // 只允许图片内容通过：源站声明 image/* 直接采信；
                    // 声明缺失或不规范（octet-stream 等）时按文件头识别；识别不出即拒绝，
                    // 防止把 text/html 之类的内容挂在本站域名下形成 XSS。
                    const declared = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                    const contentType = declared.startsWith('image/') ? declared : sniffImageType(body);
                    if (!contentType) {
                        reject(new Error(`Logo source returned non-image content (${declared || 'no content-type'})`));
                        return;
                    }
                    resolve({ contentType, body });
                });
            });

            request.on('timeout', () => request.destroy(new Error('Logo request timed out')));
            request.on('error', reject);
        }, reject);
    });
}

router.get('/team-logo', async (req, res) => {
    const rawUrl = String(req.query.url || '');
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (error) {
        return res.status(400).json({ error: 'Invalid logo URL' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Unsupported logo URL protocol' });
    }
    if (!isKnownTeamLogo(rawUrl)) {
        return res.status(403).json({ error: 'Logo URL is not registered' });
    }

    try {
        let image = await readLogoCache(rawUrl);
        if (!image) {
            image = await fetchImage(rawUrl);
            await writeLogoCache(rawUrl, image);
        }
        res.set({
            'Content-Type': image.contentType,
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'X-Content-Type-Options': 'nosniff',
            // SVG 可内嵌脚本：禁止在直接打开代理 URL 时执行（不影响 <img> 引用）
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
        });
        res.send(image.body);
    } catch (error) {
        console.warn('team-logo proxy failed:', error.message);
        res.status(502).json({ error: '图片获取失败' });
    }
});

module.exports = router;
// 供管理端上传路由复用的图片格式嗅探（按 magic bytes 判定，不信任 Content-Type）
module.exports.sniffImageType = sniffImageType;
