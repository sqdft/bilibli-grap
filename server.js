// Express 后端：B站接口转发 + 媒体代理；npm start 与 Electron 主进程共用
const express = require('express');
const path = require('path');
const bili = require('./lib/bilibili');
const { proxyMedia, learnCdnHosts } = require('./lib/proxy');

const app = express();
app.disable('x-powered-by');

// 只允许本机来源访问：Host 校验防 DNS rebinding，Origin 校验防外部网页调用本机代理（CORS 白名单）
function localHost(h) { return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h || ''); }
app.use((req, res, next) => {
    if (!localHost(req.headers.host)) return res.status(403).send('Forbidden');
    const origin = req.headers.origin;
    if (origin) {
        try {
            if (!localHost(new URL(origin).host)) return res.status(403).send('Forbidden');
        } catch { return res.status(403).send('Forbidden'); }
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

function fail(res, message) { res.json({ code: 1, message }); }
function wrap(handler) {
    return async (req, res) => {
        try { await handler(req, res); }
        catch (err) { fail(res, err.message || '请求失败'); }
    };
}
// B站返回码 → 用户能看懂的话
const BILI_ERR = {
    '-404': '视频不存在或已删除',
    '62002': '稿件不可见（UP主设置了隐私）',
    '-403': '权限不足（可能是隐藏稿件）',
    '-412': '触发B站风控，请稍后再试',
    '-352': '触发B站风控，请稍后再试',
};
function biliData(res, d) {
    if (d && d.code !== 0) return fail(res, BILI_ERR[String(d.code)] || `B站接口错误(${d.code}): ${d.message || ''}`);
    res.json(d);
}

// ---------- 视频 ----------
app.get('/api/video-info', wrap(async (req, res) => {
    const url = req.query.url;
    if (!url) return fail(res, '缺少 url 参数');
    let id;
    try { id = await bili.resolveVideoId(url); }
    catch (err) { return fail(res, err.message); }
    if (!id) return fail(res, '无法识别的B站链接，请粘贴视频页链接、BV号或 av 号');
    biliData(res, await bili.getView(id));
}));

app.get('/api/video-playurl', wrap(async (req, res) => {
    const { bvid, cid } = req.query;
    if (!bvid || !cid) return fail(res, '缺少 bvid 或 cid');
    const qn = parseInt(req.query.qn) || 80;
    const fnval = parseInt(req.query.fnval) || 1;
    const d = await bili.getPlayurl(bvid, cid, qn, fnval);
    if (d && d.code === 0) {
        // 把返回里的 CDN 域名喂给代理白名单（含 DASH 音视频流）
        (d.data?.durl || []).forEach(x => { learnCdnHosts(x.url); learnCdnHosts(x.backup_url); });
        (d.data?.dash?.video || []).forEach(x => learnCdnHosts(x.base_url));
        (d.data?.dash?.audio || []).forEach(x => { learnCdnHosts(x.base_url); learnCdnHosts(x.backup_url); });
    }
    biliData(res, d);
}));

// ---------- 批量导入：收藏夹 / 合集 / 系列 / UP主投稿 ----------
app.get('/api/fav-list', wrap(async (req, res) => {
    const fid = String(req.query.fid || '');
    if (!/^\d+$/.test(fid)) return fail(res, '收藏夹 ID 无效');
    biliData(res, await bili.getFavList(fid, +req.query.pn || 1, Math.min(+req.query.ps || 20, 50)));
}));

app.get('/api/season', wrap(async (req, res) => {
    const { mid, season_id } = req.query;
    if (!/^\d+$/.test(String(mid)) || !/^\d+$/.test(String(season_id))) return fail(res, '合集参数无效');
    biliData(res, await bili.getSeason(mid, season_id, +req.query.pn || 1, 30));
}));

app.get('/api/series', wrap(async (req, res) => {
    const { mid, series_id } = req.query;
    if (!/^\d+$/.test(String(mid)) || !/^\d+$/.test(String(series_id))) return fail(res, '系列参数无效');
    biliData(res, await bili.getSeries(mid, series_id, +req.query.pn || 1, 30));
}));

app.get('/api/space-archives', wrap(async (req, res) => {
    const mid = String(req.query.mid || '');
    if (!/^\d+$/.test(mid)) return fail(res, 'UP主空间参数无效');
    biliData(res, await bili.getSpaceArchives(mid, +req.query.pn || 1, Math.min(+req.query.ps || 25, 50)));
}));

// ---------- 弹幕 / AI 字幕 ----------
app.get('/api/danmaku', wrap(async (req, res) => {
    const cid = String(req.query.cid || '');
    if (!/^\d+$/.test(cid)) return fail(res, '缺少 cid');
    const list = await bili.getDanmaku(cid);
    res.json({ code: 0, data: list });
}));

app.get('/api/subtitle', wrap(async (req, res) => {
    const { bvid, cid } = req.query;
    if (!bvid || !cid) return fail(res, '缺少 bvid 或 cid');
    const subs = await bili.getSubtitles(bvid, cid);
    res.json({ code: 0, data: subs });
}));

// ---------- 媒体代理 ----------
app.get('/proxy/image', proxyMedia);
app.get('/proxy/video', proxyMedia);

// 启动服务：npm start 与 Electron 主进程共用；传 0 则自动分配空闲端口
function startServer(port) {
    return new Promise((resolve) => {
        const server = app.listen(port, '127.0.0.1', () => resolve(server));
    });
}

if (require.main === module) {
    startServer(3049).then(() => console.log('Server running at http://127.0.0.1:3049'));
}

module.exports = { app, startServer };
