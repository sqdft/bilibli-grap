// 媒体代理：补 Referer 绕过防盗链，透传 Range 支持拖动进度条与断点续传
const axios = require('axios');

const UPSTREAM_TIMEOUT = 10000;

// 仅放行B站自家CDN，防止代理被当作访问任意地址的跳板（SSRF）
const ALLOWED_CDN_SUFFIXES = ['hdslb.com', 'bilivideo.com', 'bilivideo.cn', 'akamaized.net'];

// B站会把视频调度到轮换的PCDN域名（静态列不全），
// 从 playurl 接口的返回里动态学习，1小时过期
const dynamicCdn = new Map();
const DYNAMIC_CDN_TTL = 60 * 60 * 1000;

function learnCdnHosts(urlLike) {
    const list = Array.isArray(urlLike) ? urlLike : urlLike ? [urlLike] : [];
    list.forEach(u => {
        try {
            const host = new URL(u).hostname.toLowerCase();
            dynamicCdn.set(host, Date.now());
        } catch { /* 忽略非法地址 */ }
    });
    for (const [host, ts] of dynamicCdn) {
        if (Date.now() - ts > DYNAMIC_CDN_TTL) dynamicCdn.delete(host);
    }
}

function isAllowedUrl(raw) {
    try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        return dynamicCdn.has(host) ||
            ALLOWED_CDN_SUFFIXES.some(d => host === d || host.endsWith('.' + d));
    } catch {
        return false;
    }
}

async function proxyMedia(req, res) {
    const url = req.query.url;
    if (!url) return res.status(400).send('缺少url参数');
    if (!isAllowedUrl(url)) return res.status(400).send('仅允许代理B站CDN资源');

    try {
        const headers = {
            Referer: 'https://www.bilibili.com',
            'User-Agent': 'Mozilla/5.0'
        };
        if (req.headers.range) headers.Range = req.headers.range;

        const response = await axios.get(url, {
            headers,
            responseType: 'stream',
            timeout: UPSTREAM_TIMEOUT,
            validateStatus: s => s < 500
        });

        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
            if (response.headers[h]) res.setHeader(h, response.headers[h]);
        });
        res.status(response.status);
        response.data.pipe(res);
        response.data.on('error', () => res.destroy());
        req.on('close', () => response.data.destroy()); // 客户端中断时释放上游连接
    } catch (err) {
        if (!res.headersSent) res.status(500).send('代理请求失败');
        else res.end();
    }
}

module.exports = { proxyMedia, learnCdnHosts, isAllowedUrl };
