// 衍生素材：弹幕→ASS / AI字幕→SRT / 仅音频 .m4a（走 DASH 音频流直链，无需 ffmpeg）
import { api } from './api.js';
import { addTask, downloadProxy, saveText } from './downloader.js';
import { toast, safeFilename } from './util.js';

// ---------- ASS 时间/文本 ----------
const assTime = (sec) => {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100) % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

const escAss = (s) => String(s).replace(/[{}]/g, m => (m === '{' ? '（' : '）')).replace(/[\r\n]+/g, ' ');

const colorTag = (c) => {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const h = n => n.toString(16).padStart(2, '0').toUpperCase();
  return `\\c&H20${h(b)}${h(g)}${h(r)}&`;
};

const estWidth = (text, size) => {
  let w = 0;
  for (const ch of String(text)) w += ch.charCodeAt(0) > 0xff ? 1 : 0.55;
  return Math.round(w * size * 1.7);
};

function assHeader(title) {
  return `[Script Info]
Title: ${String(title || 'danmaku').replace(/[\r\n]/g, ' ')}
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: R2L,Microsoft YaHei,43,&H20FFFFFF,&H20FFFFFF,&H20000000,&H20000000,0,0,0,0,100,100,0,0,1,1.6,0,7,0,0,0,1
Style: TOP,Microsoft YaHei,43,&H20FFFFFF,&H20FFFFFF,&H20000000,&H20000000,0,0,0,0,100,100,0,0,1,1.6,0,8,60,60,20,1
Style: BTM,Microsoft YaHei,43,&H20FFFFFF,&H20FFFFFF,&H20000000,&H20000000,0,0,0,0,100,100,0,0,1,1.6,0,2,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

// 简易车道分配：同速滚动不追尾，车道空闲即可复用
export function danmakuToASS(list, title) {
  const dms = list.filter(d => d && d.text && d.mode >= 1 && d.mode <= 5).sort((a, b) => a.t - b.t);
  const W = 1920, SPEED = 240, LANE_H = 52, LANES = 12;
  const scFree = new Array(LANES).fill(-1);
  const stFree = new Array(LANES).fill(-1);
  const sbFree = new Array(LANES).fill(-1);
  const pick = (free, t) => {
    for (let i = 0; i < LANES; i++) if (free[i] <= t) return i;
    return free.indexOf(Math.min(...free));
  };

  const lines = [];
  for (const d of dms) {
    const t = d.t / 1000;
    const size = d.size || 25;
    const fs = Math.round(size * 1.7);
    const text = escAss(d.text);
    const tag = `{\\fs${fs}${colorTag(d.color || 0xffffff)}`;
    if (d.mode <= 3) { // 滚动弹幕
      const w = estWidth(d.text, size);
      const dur = (W + w) / SPEED;
      const lane = pick(scFree, d.t);
      scFree[lane] = d.t + w / SPEED + 0.3;
      const y = 16 + lane * LANE_H;
      lines.push(`Dialogue: 0,${assTime(t)},${assTime(t + dur)},R2L,,0,0,0,,${tag}\\an7\\move(${W + w},${y},${-w},${y})}${text}`);
    } else if (d.mode === 5) { // 顶部固定
      const lane = pick(stFree, d.t);
      stFree[lane] = d.t + 6000;
      const y = 16 + lane * LANE_H;
      lines.push(`Dialogue: 0,${assTime(t)},${assTime(t + 6)},TOP,,0,0,0,,${tag}\\an8\\pos(960,${y})}${text}`);
    } else { // 底部固定 (mode 4)
      const lane = pick(sbFree, d.t);
      sbFree[lane] = d.t + 6000;
      const y = 1080 - 40 - lane * LANE_H;
      lines.push(`Dialogue: 0,${assTime(t)},${assTime(t + 6)},BTM,,0,0,0,,${tag}\\an2\\pos(960,${y})}${text}`);
    }
  }
  return assHeader(title) + lines.join('\n') + '\n';
}

export async function downloadDanmaku(cid, title) {
  if (!cid) throw new Error('请先解析视频');
  toast('正在获取弹幕...', 'info');
  const d = await api.danmaku(cid);
  const list = d.data || [];
  if (!list.length) return toast('该视频没有弹幕', 'warn');
  saveText(danmakuToASS(list, title), safeFilename(title) + '.ass');
  toast(`弹幕已生成（${list.length} 条）`, 'success');
}

// ---------- AI 字幕 → SRT ----------
const srtTime = (sec) => {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000) % 1000;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)},${String(ms).padStart(3, '0')}`;
};

export async function downloadSubtitle(bvid, cid, title) {
  if (!bvid || !cid) throw new Error('请先解析视频');
  toast('正在获取AI字幕...', 'info');
  const d = await api.subtitle(bvid, cid);
  const subs = d.data || [];
  if (!subs.length) return toast('该视频没有可用的AI字幕', 'warn');
  // 优先中文字幕，其次第一个
  const pick = subs.find(s => /zh/i.test(s.lan)) || subs[0];
  const res = await fetch(`/proxy/video?url=${encodeURIComponent(pick.subtitle_url)}`);
  if (!res.ok) throw new Error('字幕内容获取失败');
  const json = await res.json();
  const lines = json.body || [];
  if (!lines.length) return toast('字幕内容为空', 'warn');
  const srt = lines.map((l, i) => `${i + 1}\n${srtTime(l.from)} --> ${srtTime(l.to)}\n${l.content}\n`).join('\n');
  saveText(srt, safeFilename(title) + `_${pick.lan}.srt`);
  toast(`AI字幕已生成（${lines.length} 句，${pick.lan_doc || pick.lan}）`, 'success');
}

// ---------- 仅音频（DASH 音频流直链保存 .m4a，无需 ffmpeg） ----------
export function enqueueAudio(bvid, cid, title) {
  return addTask({
    kind: 'audio',
    name: safeFilename(title) + '.m4a',
    run: async (it) => {
      const d = await api.playurl(bvid, cid, 0, 16); // fnval=16 → DASH
      const audios = ((d.data || {}).dash || {}).audio || [];
      if (!audios.length) throw new Error('该视频没有独立音频流');
      const best = [...audios].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      const url = best.base_url || (best.backup_url && best.backup_url[0]);
      await downloadProxy(url, it.name, it);
    },
  });
}
