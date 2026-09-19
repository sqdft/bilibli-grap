const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

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

// 从链接提取视频ID；b23.tv 短链需跟随重定向后从最终地址提取
async function resolveVideoId(rawUrl) {
    let url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    let m = url.match(/BV([a-zA-Z0-9]+)/);
    if (m) return { bvid: 'BV' + m[1] };
    m = url.match(/av(\d{4,})/i);
    if (m) return { aid: m[1] };

    if (/b23\.tv\//i.test(url)) {
        try {
            const response = await axios.get(url, { timeout: UPSTREAM_TIMEOUT, maxRedirects: 5 });
            const finalUrl = (response.request && response.request.res && response.request.res.responseUrl) || '';
            m = finalUrl.match(/BV([a-zA-Z0-9]+)/);
            if (m) return { bvid: 'BV' + m[1] };
            m = finalUrl.match(/av(\d{4,})/i);
            if (m) return { aid: m[1] };
        } catch (e) { /* 重定向失败按无效链接处理 */ }
    }
    return null;
}

// 获取视频信息
app.get('/api/video-info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.json({ code: 1, message: "缺少url参数" });

    try {
        const id = await resolveVideoId(url);
        if (!id) return res.json({ code: 1, message: "无效的Bilibili链接" });

        const query = id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`;
        const { data } = await axios.get(`https://api.bilibili.com/x/web-interface/view?${query}`, { timeout: UPSTREAM_TIMEOUT });
        res.json(data);
    } catch (error) {
        res.json({ code: 1, message: error.message });
    }
});

// 获取视频播放地址
app.get('/api/video-playurl', async (req, res) => {
    const { bvid, cid } = req.query;
    if (!bvid || !cid) return res.json({ code: 1, message: "缺少 bvid 或 cid" });

    try {
        const { data } = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1`, { timeout: UPSTREAM_TIMEOUT });
        (data.data?.durl || []).forEach(d => {
            learnCdnHosts(d.url);
            learnCdnHosts(d.backup_url);
        });
        res.json(data);
    } catch (error) {
        res.json({ code: 1, message: error.message });
    }
});

// 媒体代理：补 Referer 解决防盗链，透传 Range 支持拖进度条/断点续传
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
    } catch (err) {
        if (!res.headersSent) res.status(500).send('代理请求失败');
        else res.end();
    }
}

app.get('/proxy/image', proxyMedia);
app.get('/proxy/video', proxyMedia);

// 启动服务：npm start 与 Electron 主进程共用；传 0 则自动分配空闲端口
function startServer(port) {
    return new Promise((resolve) => {
        const server = app.listen(port, '127.0.0.1', () => resolve(server));
    });
}

if (require.main === module) {
    startServer(3000).then(() => console.log('Server running at http://127.0.0.1:3000'));
}

module.exports = { app, startServer };
