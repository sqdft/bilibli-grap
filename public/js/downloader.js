// 下载管理器：统一队列 + 进度渲染；Electron 走 will-download 进度事件，浏览器走 fetch 流式 blob
import { state } from './state.js';
import { ensurePlayurlsFor } from './player.js';
import { api, biliErrorMsg } from './api.js';
import { $, esc, toast, safeFilename } from './util.js';

export const desktop = window.biliDesktop || null;

const items = [];          // 队列条目（新任务插顶部）
const pending = new Map(); // token -> {it, resolve, reject}（Electron 下载事件匹配）
let running = null;
let seq = 0;

if (desktop) desktop.onDownloadEvent(onDesktopEvent);

function onDesktopEvent(p) {
  const entry = pending.get(p.token);
  if (!entry) return;
  const it = entry.it;
  if (p.type === 'progress') {
    it.received = p.received;
    it.total = p.total;
    it.status = p.state === 'interrupted' ? '下载中(中断重连)' : '下载中';
  } else if (p.type === 'done') {
    clearTimeout(it.timer);
    pending.delete(p.token);
    if (p.state === 'completed') {
      it.status = '已完成';
      it.received = it.total || it.received;
      entry.resolve();
    } else {
      it.status = '失败';
      it.error = p.state === 'cancelled' ? '已取消' : '下载中断，可重试';
      entry.reject(new Error(it.error));
    }
  }
  render();
}

async function pump() {
  if (running) return;
  const next = items.find(t => t.status === '等待中');
  if (!next) { render(); return; }
  running = next;
  next.status = '下载中';
  render();
  try {
    await next.run(next);
    if (next.status === '下载中') next.status = '已完成';
  } catch (err) {
    if (next.status === '失败' && next.error) { /* 事件回调已标失败 */ }
    else { next.status = '失败'; next.error = err?.message || '下载失败'; }
  } finally {
    running = null;
    render();
    pump();
  }
}

export function addTask(t) {
  const it = { id: ++seq, kind: 'video', name: '', status: '等待中', received: 0, total: 0, ...t };
  items.unshift(it);
  render();
  pump();
  return it;
}

export function retryTask(id) {
  const it = items.find(x => x.id === id);
  if (!it || it.status !== '失败') return;
  it.status = '等待中';
  it.error = '';
  render();
  pump();
}

export function clearFinished() {
  for (let i = items.length - 1; i >= 0; i--) {
    if (['已完成', '已取消'].includes(items[i].status)) items.splice(i, 1);
  }
  render();
}

// ---------- 渲染 ----------
function render() {
  const list = $('queueList');
  const waiting = items.filter(i => i.status === '等待中').length;
  $('queueTitle').textContent = items.length
    ? `下载队列 (${items.length}${waiting ? ` · 待${waiting}` : ''})`
    : '下载队列';

  list.innerHTML = items.map(it => {
    const cls = { '等待中': 's-wait', '下载中': 's-run', '已完成': 's-done' }[it.status] || 's-fail';
    const pct = it.total ? Math.min(100, Math.round(it.received / it.total * 100)) : (it.status === '已完成' ? 100 : 0);
    const indet = !it.total && (it.status === '下载中' || it.status === '下载中(中断重连)');
    return `
      <div class="q-item">
        <div class="q-info">
          <span class="q-name" title="${esc(it.name)}">${esc(it.name)}</span>
          <span class="q-state ${cls}">${esc(it.status)}${it.error ? ' · ' + esc(it.error) : ''}${pct ? ' ' + pct + '%' : ''}</span>
        </div>
        <div class="q-bar${indet ? ' indet' : ''}"><div class="q-fill" style="width:${pct}%"></div></div>
        ${it.status === '失败' ? `<button class="q-retry" data-id="${it.id}">重试</button>` : ''}
      </div>`;
  }).join('');
}

// ---------- 底层下载 ----------
function proxyUrl(url, token, dirMode) {
  let u = `/proxy/video?url=${encodeURIComponent(url)}`;
  if (token) u += `&dlToken=${token}`;
  if (dirMode) u += `&dirMode=1`;
  return u;
}

async function fetchBlob(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`代理返回 HTTP ${res.status}`);
  const total = +(res.headers.get('content-length') || 0);
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const blob = await res.blob();
    onProgress(blob.size, blob.size);
    return blob;
  }
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  return new Blob(chunks, { type: 'application/octet-stream' });
}

export function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export function saveText(text, filename) {
  saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}

// 经本机代理下载媒体文件：桌面端走 will-download（有原生保存对话框/批量静默目录），
// 浏览器端走 fetch+blob（有进度，超大文件占用内存）
export async function downloadProxy(url, filename, it, dirMode = false) {
  if (desktop) {
    const token = 'dl_' + Date.now().toString(36) + '_' + (++seq).toString(36);
    const pr = new Promise((resolve, reject) => {
      pending.set(token, { it, resolve, reject });
      it.timer = setTimeout(() => {
        if (pending.has(token)) {
          pending.delete(token);
          reject(new Error('下载超时'));
        }
      }, 30 * 60 * 1000);
    });
    const a = document.createElement('a');
    a.href = proxyUrl(url, token, dirMode);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await pr;
  } else {
    const blob = await fetchBlob(`/proxy/video?url=${encodeURIComponent(url)}`,
      (r, t) => { it.received = r; it.total = t; render(); });
    saveBlob(blob, filename);
  }
}

// ---------- 任务构造 ----------
function videoFilename(title, pageNo, segIndex, segTotal, multiPage) {
  let name = safeFilename(title);
  if (multiPage) name += `_P${pageNo}`;
  if (segTotal > 1) name += `_seg${segIndex + 1}`;
  return name + '.mp4';
}

// 下载一个视频（自动解析 cid → playurl → 分段；多段视频默认自动补齐剩余分段任务）
export function enqueueVideo({ bvid, cid, title, pageNo = 1, qn = 80, segIndex = 0, single = false, dirMode = false }) {
  const multiPage = state.bvid === bvid && state.pages.length > 1;
  return addTask({
    kind: 'video',
    name: safeFilename(title) + '.mp4',
    run: async (it) => {
      let realCid = cid;
      if (!realCid) {
        // 批量列表没带 cid 时现查
        const d = await api.info(`https://www.bilibili.com/video/${bvid}`);
        realCid = d.data.cid;
      }
      const data = await ensurePlayurlsFor(bvid, realCid, qn);
      const urls = data.durl.map(d => d.url);
      if (segIndex >= urls.length) throw new Error('分段不存在');
      const name = videoFilename(title, pageNo, segIndex, urls.length, multiPage);
      it.name = name;
      render();
      if (!single && segIndex === 0 && urls.length > 1) {
        for (let i = 1; i < urls.length; i++) {
          enqueueVideo({ bvid, cid: realCid, title, pageNo, qn, segIndex: i, single: true, dirMode });
        }
      }
      await downloadProxy(urls[segIndex], name, it, dirMode);
    },
  });
}

// 批量下载前询问保存目录（桌面端一次选择，之后静默保存）
export async function ensureBatchDir(count) {
  if (!desktop || count <= 1) return false;
  let dir = await desktop.getDownloadDir();
  if (!dir) {
    dir = await desktop.chooseDownloadDir();
    if (dir) toast(`批量下载将保存到：${dir}`, 'success');
  }
  return !!dir;
}
