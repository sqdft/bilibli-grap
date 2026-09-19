const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.static('public'));

// 获取视频信息
app.get('/api/video-info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.json({ code: 1, message: "缺少url参数" });

    const match = url.match(/BV([a-zA-Z0-9]+)/);
    if (!match) return res.json({ code: 1, message: "无效的Bilibili链接" });

    const bvid = 'BV' + match[1];

    try {
        const { data } = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
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
        const { data } = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1`);
        res.json(data);
    } catch (error) {
        res.json({ code: 1, message: error.message });
    }
});

// 图片代理，解决防盗链
app.get('/proxy/image', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('缺少url参数');

    try {
        const response = await axios.get(url, {
            headers: {
                Referer: 'https://www.bilibili.com',
                'User-Agent': 'Mozilla/5.0'
            },
            responseType: 'stream'
        });
        res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('图片代理失败');
    }
});

// 视频代理，解决403和跨域
app.get('/proxy/video', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('缺少url参数');

    try {
        const response = await axios.get(url, {
            headers: {
                Referer: 'https://www.bilibili.com',
                'User-Agent': 'Mozilla/5.0'
            },
            responseType: 'stream'
        });
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('视频代理失败');
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
