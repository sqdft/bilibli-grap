// 播放器：播放地址获取缓存 / 分段连播 / 清晰度切换（保留进度）
import { state } from './state.js';
import { api, biliErrorMsg } from './api.js';
import { $, toast } from './util.js';

// 按 bvid_cid_qn 获取并缓存播放地址；同 key 并发请求自动合并
const inflight = new Map();

export async function ensurePlayurlsFor(bvid, cid, qn) {
  const key = `${bvid}_${cid}_${qn}`;
  if (state.playurls.has(key)) return state.playurls.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = api.playurl(bvid, cid, qn, 1)
    .then(d => {
      const data = d.data;
      if (!data || !Array.isArray(data.durl) || !data.durl.length) {
        throw new Error('未取到 MP4 直链（该清晰度可能需要登录权限）');
      }
      state.playurls.set(key, data);
      return data;
    })
    .catch(e => { throw new Error(biliErrorMsg(e)); })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function stopPlayer() {
  const player = $('player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  $('segInfo').textContent = '';
}

export function loadAndPlay(i, seekTo = 0) {
  const data = state.playurls.get(`${state.bvid}_${state.cid}_${state.qn}`);
  if (!data) return;
  const urls = data.durl.map(d => d.url);
  state.currentSegment = i;

  const player = $('player');
  player.src = `/proxy/video?url=${encodeURIComponent(urls[i])}`;
  if (state.cover) player.poster = `/proxy/image?url=${encodeURIComponent(state.cover)}`;
  $('playerSection').classList.remove('hidden');
  if (seekTo > 0) {
    player.addEventListener('loadedmetadata', () => {
      try { player.currentTime = seekTo; } catch { /* 个别流不支持 seek */ }
    }, { once: true });
  }
  player.play().catch(() => { /* 自动播放被拦时用户手动点 */ });

  $('segInfo').textContent = urls.length > 1
    ? `多段视频：正在播放第 ${i + 1}/${urls.length} 段（段间不连续；下载请用「下载」菜单，会逐段保存）`
    : '';
}

export async function play() {
  if (!state.bvid || !state.cid) return;
  const btn = $('btnPlay');
  btn.disabled = true;
  btn.classList.add('loading');
  $('btnPlayText').textContent = '加载中...';
  try {
    const data = await ensurePlayurlsFor(state.bvid, state.cid, state.qn);
    updateQualitySelect(data);
    loadAndPlay(0);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    $('btnPlayText').textContent = '播放';
  }
}

// 清晰度切换：回显实际画质，切过去后保留播放进度
export async function changeQuality(qn) {
  qn = +qn;
  if (!qn || qn === state.qn) return;
  const prevQn = state.qn;
  state.qn = qn;

  const player = $('player');
  const t = player.currentTime || 0;
  const wasActive = !!player.getAttribute('src');
  stopPlayer();
  try {
    const data = await ensurePlayurlsFor(state.bvid, state.cid, qn);
    updateQualitySelect(data);
    if (wasActive) loadAndPlay(0, t);
    const fmt = (data.support_formats || []).find(f => f.quality === data.quality);
    toast(`已切换到 ${fmt?.new_description || data.quality}`, 'success');
  } catch (e) {
    state.qn = prevQn; // 切换失败回退旧清晰度
    updateQualitySelect(await ensurePlayurlsFor(state.bvid, state.cid, prevQn).catch(() => null) || state.playurls.get(`${state.bvid}_${state.cid}_${prevQn}`));
    toast(e.message, 'error');
  }
}

// 用 playurl 返回的 support_formats 刷新清晰度下拉框
export function updateQualitySelect(data) {
  const sel = $('qualitySelect');
  if (!data) { sel.innerHTML = '<option>未知</option>'; return; }
  const formats = data.support_formats || [];
  sel.innerHTML = '';
  if (!formats.length) {
    const o = document.createElement('option');
    o.textContent = `${data.quality || '未知'}`;
    sel.appendChild(o);
    return;
  }
  formats.forEach(f => {
    const o = document.createElement('option');
    o.value = f.quality;
    o.textContent = f.new_description || f.display_desc || f.quality;
    sel.appendChild(o);
  });
  sel.value = String(data.quality);
}

// 播完一段自动接下一段
$('player').addEventListener('ended', () => {
  const data = state.playurls.get(`${state.bvid}_${state.cid}_${state.qn}`);
  if (!data) return;
  const total = data.durl.length;
  if (state.currentSegment < total - 1) loadAndPlay(state.currentSegment + 1);
  else $('segInfo').textContent = '播放结束';
});
