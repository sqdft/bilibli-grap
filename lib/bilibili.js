// B站官方接口封装：链接解析 / 视频信息 / 播放地址 / 收藏夹 / 合集 / 系列 / UP主投稿 / 弹幕 / AI字幕 / WBI 签名
const axios = require('axios');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT = 10000;

const http = axios.create({
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
});

// ---------- 链接 → BV/av ----------
async function resolveVideoId(rawUrl) {
    let url = String(rawUrl || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    let m = url.match(/BV([a-zA-Z0-9]{8,})/);
    if (m) return { bvid: 'BV' + m[1] };
    m = url.match(/av(\d+)/i);
    if (m) return { aid: m[1] };

    // b23.tv 短链：跟随重定向后从最终地址提取
    if (/b23\.tv\//i.test(url)) {
        try {
            const response = await http.get(url, { maxRedirects: 5 });
            const finalUrl =
                (response.request && response.request.res && response.request.res.responseUrl) || '';
            m = finalUrl.match(/BV([a-zA-Z0-9]{8,})/);
            if (m) return { bvid: 'BV' + m[1] };
            m = finalUrl.match(/av(\d+)/i);
            if (m) return { aid: m[1] };
            return null;
        } catch (e) {
            // 短链解析失败单独提示，与"链接格式无效"区分开
            const err = new Error('b23.tv 短链解析失败，请检查网络或稍后再试');
            err.shortLink = true;
            throw err;
        }
    }
    return null;
}

// ---------- WBI 签名（收藏夹翻页 / UP主投稿 / AI字幕 等接口需要） ----------
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiCache = null;

async function getMixinKey() {
    if (wbiCache && Date.now() - wbiCache.ts < 3600 * 1000) return wbiCache.key;
    const d = await http.get('https://api.bilibili.com/x/web-interface/nav').then(r => r.data);
    const img = (((d.data || {}).wbi_img || {}).img_url || '').split('/').pop().split('.')[0];
    const sub = (((d.data || {}).wbi_img || {}).sub_url || '').split('/').pop().split('.')[0];
    if (!img || !sub) throw new Error('获取WBI签名参数失败');
    let key = '';
    for (const i of MIXIN_TAB) key += (img + sub)[i] || '';
    wbiCache = { key: key.slice(0, 32), ts: Date.now() };
    return wbiCache.key;
}

function wbiSign(params, mixinKey) {
    const clean = {};
    Object.keys(params).forEach(k => {
        if (params[k] === undefined || params[k] === null) return;
        clean[k] = String(params[k]).replace(/[!'()*]/g, '');
    });
    clean.wts = Math.floor(Date.now() / 1000);
    const query = Object.keys(clean).sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(clean[k])}`).join('&');
    const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
    return { ...clean, w_rid };
}

// ---------- 视频信息 / 播放地址 ----------
async function getView({ bvid, aid }) {
    const params = bvid ? { bvid } : { aid };
    return http.get('https://api.bilibili.com/x/web-interface/view', { params }).then(r => r.data);
}

// qn 清晰度代号，fnval=1 MP4直链（播放/下载用）、fnval=16 DASH（音频提取用）
async function getPlayurl(bvid, cid, qn = 80, fnval = 1) {
    return http.get('https://api.bilibili.com/x/player/playurl', { params: { bvid, cid, qn, fnval } }).then(r => r.data);
}

// ---------- 列表类接口（公开、无需登录） ----------
async function getFavList(fid, pn = 1, ps = 20) {
    return http.get('https://api.bilibili.com/x/v3/fav/resource/list', { params: { media_id: fid, pn, ps, order: 'mtime', platform: 'web' } }).then(r => r.data);
}

async function getSeason(mid, seasonId, pageNum = 1, pageSize = 30) {
    return http.get('https://api.bilibili.com/x/polymer/web-space/seasons_archives_list', { params: { mid, season_id: seasonId, page_num: pageNum, page_size: pageSize } }).then(r => r.data);
}

async function getSeries(mid, seriesId, pn = 1, ps = 30) {
    return http.get('https://api.bilibili.com/x/series/archives', { params: { mid, series_id: seriesId, pn, ps, only_normal: 'true', sort: 'desc' } }).then(r => r.data);
}

async function getSpaceArchives(mid, pn = 1, ps = 30) {
    const key = await getMixinKey();
    const params = wbiSign({ mid, pn, ps, order: 'pubdate' }, key);
    return http.get('https://api.bilibili.com/x/space/wbi/arc/search', { params }).then(r => r.data);
}

// ---------- 弹幕 ----------
// 优先用分段接口取全量弹幕（protobuf 二进制，手工最小解码），失败回退老 XML 接口（仅前几分钟）
function pbVarint(buf, pos) {
    let result = 0n, shift = 0n;
    for (;;) {
        const b = buf[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7n;
    }
    return [result, pos];
}

function pbSkip(buf, pos, wire) {
    if (wire === 0) return pbVarint(buf, pos)[1];
    if (wire === 1) return pos + 8;
    if (wire === 5) return pos + 4;
    if (wire === 2) { const [, p] = pbVarint(buf, pos); const [len, p2] = pbVarint(buf, p); return p2 + Number(len); }
    throw new Error('非法 protobuf wire type: ' + wire);
}

// DmSegMobileReply.elems = 1；DanmakuElem: progress=2, mode=3, fontsize=4, color=5, content=7
function decodeElem(buf) {
    let pos = 0;
    const e = {};
    while (pos < buf.length) {
        let tag;
        [tag, pos] = pbVarint(buf, pos);
        const field = Number(tag >> 3n), wire = Number(tag & 7n);
        if (wire === 0) {
            let v;
            [v, pos] = pbVarint(buf, pos);
            v = Number(v);
            if (field === 2) e.t = v;
            else if (field === 3) e.mode = v;
            else if (field === 4) e.size = v;
            else if (field === 5) e.color = v;
        } else if (wire === 2) {
            let len;
            [len, pos] = pbVarint(buf, pos);
            len = Number(len);
            if (field === 7) e.text = buf.slice(pos, pos + len).toString('utf8');
            pos += len;
        } else {
            pos = pbSkip(buf, pos, wire);
        }
    }
    return e.text ? e : null;
}

function decodeSeg(buf) {
    let pos = 0;
    const elems = [];
    while (pos < buf.length) {
        let tag;
        [tag, pos] = pbVarint(buf, pos);
        const field = Number(tag >> 3n), wire = Number(tag & 7n);
        if (field === 1 && wire === 2) {
            let len;
            [len, pos] = pbVarint(buf, pos);
            len = Number(len);
            const e = decodeElem(buf.slice(pos, pos + len));
            pos += len;
            if (e) elems.push(e);
        } else {
            pos = pbSkip(buf, pos, wire);
        }
    }
    return elems;
}

async function fetchSeg(oid, seg) {
    // 注意：不要传 pid（传错会返回空数据），type=1 为视频弹幕
    const res = await http.get('https://api.bilibili.com/x/v2/dm/web/seg.so',
        { params: { type: 1, oid, segment_index: seg }, responseType: 'arraybuffer' });
    return Buffer.from(res.data);
}

function decodeEntities(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function danmakuFromXml(cid) {
    const res = await http.get('https://api.bilibili.com/x/v1/dm/listinfo.so',
        { params: { oid: cid }, responseType: 'arraybuffer' });
    const xml = Buffer.from(res.data).toString('utf8');
    const out = [];
    const re = /<d p="([^"]+)"[^>]*>([^<]*)<\/d>/g;
    let m;
    while ((m = re.exec(xml))) {
        const p = m[1].split(',');
        out.push({
            t: Math.round(parseFloat(p[0]) * 1000),
            mode: +p[1] || 1,
            size: +p[2] || 25,
            color: +p[3] || 16777215,
            text: decodeEntities(m[2]),
        });
    }
    return out;
}

const MAX_SEG = 120; // 单段约6分钟，120段覆盖12小时，够用

async function getDanmaku(cid) {
    // 分段接口逐段拉取：超过最后一段时B站会返回 404/空数据，视为拉取完成
    const all = [];
    let riskCode = 0;
    for (let seg = 1; seg <= MAX_SEG; seg++) {
        let buf;
        try {
            buf = await fetchSeg(cid, seg);
        } catch (e) {
            if (seg > 1) break;        // 到头了（超范围段返回404）
            riskCode = -1;             // 第一段就失败，接口不可用
            break;
        }
        // B站风控会以 HTTP 200 返回非 protobuf 内容：JSON（{"code":-352}）或 HTML 错误页
        if (buf.length && buf[0] === 0x7b /* '{' */) {
            try { riskCode = JSON.parse(buf.toString('utf8')).code || -1; } catch { riskCode = -1; }
            break;
        }
        let list;
        try {
            list = decodeSeg(buf);
        } catch (e) {
            // 解析失败 = HTML 错误页等非 protobuf 响应
            if (seg > 1) break;
            riskCode = -1;
            break;
        }
        if (!list.length) break;
        all.push(...list);
    }
    if (all.length) return all.sort((a, b) => a.t - b.t);
    if (riskCode === -352 || riskCode === -412) throw new Error('触发B站风控，弹幕暂时取不到，请稍后再试');
    if (riskCode === 0) return []; // 正常拉完但确实没弹幕
    // 分段接口不可用时回退老 XML 接口（已逐步下线，尽力而为）
    try {
        const xml = await danmakuFromXml(cid);
        if (xml.length) return xml.sort((a, b) => a.t - b.t);
    } catch { /* 老接口已404下线 */ }
    throw new Error('未获取到弹幕（视频可能没有弹幕，或接口暂时不可用）');
}

// ---------- AI 字幕列表 ----------
async function getSubtitles(bvid, cid) {
    const key = await getMixinKey();
    const params = wbiSign({ bvid, cid }, key);
    const d = await http.get('https://api.bilibili.com/x/player/wbi/v2', { params }).then(r => r.data);
    const subs = (((d.data || {}).subtitle || {}).subtitles) || [];
    return subs.map(s => ({
        ...s,
        subtitle_url: s.subtitle_url && s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url,
    }));
}

module.exports = {
    resolveVideoId, getView, getPlayurl,
    getFavList, getSeason, getSeries, getSpaceArchives,
    getDanmaku, getSubtitles,
};
