// 主控：输入交互（回车/粘贴/自动粘贴）/ 信息卡渲染 / 下载菜单 / 历史 / 主题 / 队列面板
import { state } from './state.js';
import { api, biliErrorMsg } from './api.js';
import { $, esc, toast, fmtNum, store } from './util.js';
import { ensurePlayurlsFor, play, stopPlayer, changeQuality, updateQualitySelect } from './player.js';
import { enqueueVideo, retryTask, clearFinished, desktop } from './downloader.js';
import { enqueueAudio, downloadDanmaku, downloadSubtitle } from './extras.js';
import { initBatch } from './batch.js';
import { pushHistory, getHistory, clearHistory } from './history.js';

// ---------- 主题 ----------
const themeBtn = $('themeBtn');
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  store.set('theme', t);
}
let theme = store.get('theme', 'auto');
applyTheme(theme);
themeBtn.addEventListener('click', () => {
  const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
  theme = theme === 'auto' ? (sysDark ? 'light' : 'dark')
        : theme === 'dark' ? 'light' : 'auto';
  applyTheme(theme);
  toast(`主题：${theme === 'auto' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}`, 'info', 1500);
});

// ---------- 解析历史 ----------
const historyPanel = $('historyPanel');
function renderHistory() {
  const list = getHistory();
  historyPanel.innerHTML = list.length ? `
    <div class="hp-head"><span>最近解析</span><button id="hpClear" class="chip small">清空</button></div>
    <div class="hp-list">${list.map(h => `
      <div class="hp-item" data-bvid="${esc(h.bvid)}">
        <img src="/proxy/image?url=${encodeURIComponent(h.cover || '')}" alt="" loading="lazy" />
        <div class="hp-text">
          <span class="hp-title">${esc(h.title)}</span>
          <span class="hp-sub">${esc(h.owner || '')} · ${esc(h.bvid)}</span>
        </div>
      </div>`).join('')}</div>` : '<div class="hp-empty">暂无历史记录</div>';
}
$('historyBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  renderHistory();
  historyPanel.classList.toggle('hidden');
});
historyPanel.addEventListener('click', (e) => {
  if (e.target.id === 'hpClear') { clearHistory(); renderHistory(); return; }
  const item = e.target.closest('.hp-item');
  if (!item) return;
  $('videoUrl').value = 'https://www.bilibili.com/video/' + item.dataset.bvid;
  historyPanel.classList.add('hidden');
  fetchInfo();
});

// ---------- 剪贴板 / 输入 ----------
let clipOn = store.get('clip_auto', false);
function renderClip() { $('clipToggle').classList.toggle('active', clipOn); }
$('clipToggle').addEventListener('click', () => {
  clipOn = !clipOn;
  store.set('clip_auto', clipOn);
  renderClip();
  toast(clipOn ? '已开启：切回窗口自动填入剪贴板中的B站链接' : '已关闭自动粘贴', 'info', 2000);
});
renderClip();

function extractLink(text) {
  const m = String(text || '').match(
    /((?:https?:\/\/)?(?:www\.)?bilibili\.com\/video\/[^\s"'<>]+|(?:https?:\/\/)?b23\.tv\/[^\s"'<>]+|BV[a-zA-Z0-9]{8,}|av\d+)/i
  );
  return m ? m[1] : '';
}

async function readClipboard() {
  try {
    if (desktop) return (await desktop.readClipboard()) || '';
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch { /* 无权限时静默 */ }
  return '';
}

window.addEventListener('focus', async () => {
  if (!clipOn) return;
  const link = extractLink(await readClipboard());
  if (link && $('videoUrl').value.trim() !== link) {
    $('videoUrl').value = link;
    hintInput();
    fetchInfo();
  }
});

$('btnPaste').addEventListener('click', async () => {
  const link = extractLink(await readClipboard());
  if (!link) return toast('剪贴板中没有B站链接', 'warn');
  $('videoUrl').value = link;
  hintInput();
  fetchInfo();
});

function hintInput() {
  const v = $('videoUrl').value.trim();
  const hint = $('inputHint');
  if (!v) return hint.classList.add('hidden');
  const m = v.match(/BV[a-zA-Z0-9]{8,}|av\d+|b23\.tv/i);
  hint.classList.remove('hidden', 'bad');
  if (m) hint.textContent = `✓ 已识别B站链接：${m[0]}，回车解析`;
  else { hint.textContent = '未识别到 BV / av / b23 链接'; hint.classList.add('bad'); }
}
$('videoUrl').addEventListener('input', hintInput);
$('videoUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });
$('btnInfo').addEventListener('click', () => fetchInfo());

// ---------- 视频信息 ----------
let fetching = false;
async function fetchInfo() {
  const url = $('videoUrl').value.trim();
  if (!url) return toast('请先粘贴B站视频链接', 'warn');
  if (fetching) return;
  fetching = true;

  const btn = $('btnInfo');
  btn.disabled = true;
  btn.textContent = '解析中...';
  $('infoCard').classList.remove('hidden');
  $('infoSkeleton').classList.remove('hidden');
  $('infoBody').classList.add('hidden');
  stopPlayer();
  $('playerSection').classList.add('hidden');

  try {
    const d = await api.info(url);
    const info = d.data;
    Object.assign(state, {
      info,
      bvid: info.bvid,
      aid: info.aid,
      cid: info.cid,
      title: info.title,
      cover: info.pic,
      owner: info.owner.name,
      pages: info.pages || [],
      qn: 80,
      currentSegment: 0,
    });
    state.playurls.clear();
    renderInfo(info);
    pushHistory({ bvid: info.bvid, title: info.title, cover: info.pic, owner: info.owner.name });
    // 预取播放地址：回显画质 + 让下载菜单可用
    ensurePlayurlsFor(info.bvid, info.cid, state.qn).then(updateQualitySelect).catch(() => {});
  } catch (e) {
    $('infoCard').classList.add('hidden');
    toast(biliErrorMsg(e), 'error');
  } finally {
    fetching = false;
    btn.disabled = false;
    btn.textContent = '解析';
  }
}

function renderInfo(info) {
  $('infoSkeleton').classList.add('hidden');
  $('infoBody').classList.remove('hidden');

  $('title').textContent = info.title;
  $('owner').textContent = info.owner.name;
  $('views').textContent = fmtNum(info.stat.view);
  $('likes').textContent = fmtNum(info.stat.like);
  $('videoLink').href = `https://www.bilibili.com/video/${info.bvid}`;

  const pic = $('pic');
  pic.classList.add('loading');
  pic.onload = () => pic.classList.remove('loading');
  pic.onerror = () => pic.classList.remove('loading');
  pic.src = `/proxy/image?url=${encodeURIComponent(info.pic)}`;

  // 多P下拉
  const sel = $('pageSelect');
  sel.innerHTML = '';
  const pages = info.pages || [];
  if (pages.length > 1) {
    pages.forEach(p => {
      const o = document.createElement('option');
      o.value = p.cid;
      o.textContent = `P${p.page} ${p.part}`;
      sel.appendChild(o);
    });
    sel.value = String(info.cid);
    sel.closest('.ctrl-item').classList.remove('hidden');
  } else {
    sel.closest('.ctrl-item').classList.add('hidden');
  }
  $('qualitySelect').innerHTML = '<option>识别中…</option>';
}

$('pageSelect').addEventListener('change', async () => {
  const cid = +$('pageSelect').value;
  if (!cid || cid === state.cid) return;
  state.cid = cid;
  state.currentSegment = 0;
  stopPlayer();
  $('playerSection').classList.add('hidden');
  $('qualitySelect').innerHTML = '<option>识别中…</option>';
  try {
    const data = await ensurePlayurlsFor(state.bvid, cid, state.qn);
    updateQualitySelect(data);
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('qualitySelect').addEventListener('change', () => changeQuality($('qualitySelect').value));
$('btnPlay').addEventListener('click', () => play());

// ---------- 下载菜单 ----------
const ddWrap = $('dlDropdown');
const ddMenu = $('dlMenu');
function pageNo() {
  const i = state.pages.findIndex(p => p.cid === state.cid);
  return i >= 0 ? i + 1 : 1;
}

function buildDlMenu() {
  const data = state.playurls.get(`${state.bvid}_${state.cid}_${state.qn}`);
  const segTotal = data ? data.durl.length : 0;
  const rows = [
    {
      label: '下载视频 MP4',
      sub: segTotal > 1 ? `${segTotal} 个分段将逐个保存` : (state.pages.length > 1 ? '当前分P完整文件' : '完整视频文件'),
      fn: () => enqueueVideo({ bvid: state.bvid, cid: state.cid, title: state.title, pageNo: pageNo(), qn: state.qn, segIndex: 0 }),
    },
  ];
  if (segTotal > 1) {
    rows.push({
      label: `仅当前段（第 ${state.currentSegment + 1} 段）`,
      sub: '只保存正在播放的分段',
      fn: () => enqueueVideo({ bvid: state.bvid, cid: state.cid, title: state.title, pageNo: pageNo(), qn: state.qn, segIndex: state.currentSegment, single: true }),
    });
  }
  rows.push({
    label: '仅音频 .m4a',
    sub: '提取音轨直接保存，无需转码',
    fn: () => enqueueAudio(state.bvid, state.cid, state.title),
  });

  ddMenu.innerHTML = rows.map((r, i) => `
    <div class="menu-item" data-i="${i}">
      <span class="mi-label">${esc(r.label)}</span>
      <span class="mi-sub">${esc(r.sub)}</span>
    </div>`).join('');
  ddMenu._rows = rows;
}

$('btnDownload').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.bvid) return toast('请先解析视频', 'warn');
  buildDlMenu();
  ddMenu.classList.toggle('hidden');
});
ddMenu.addEventListener('click', (e) => {
  const el = e.target.closest('.menu-item');
  if (!el) return;
  const row = ddMenu._rows[+el.dataset.i];
  ddMenu.classList.add('hidden');
  row.fn().catch(err => toast(err?.message || '操作失败', 'error'));
});
document.addEventListener('click', (e) => {
  if (!ddWrap.contains(e.target)) ddMenu.classList.add('hidden');
  if (!historyPanel.contains(e.target) && e.target !== $('historyBtn')) historyPanel.classList.add('hidden');
});

// ---------- 衍生素材 ----------
$('btnDanmaku').addEventListener('click', () => {
  if (!state.bvid) return toast('请先解析视频', 'warn');
  downloadDanmaku(state.cid, state.title).catch(e => toast(e.message, 'error'));
});
$('btnSubtitle').addEventListener('click', () => {
  if (!state.bvid) return toast('请先解析视频', 'warn');
  downloadSubtitle(state.bvid, state.cid, state.title).catch(e => toast(e.message, 'error'));
});

// ---------- 队列面板 ----------
$('queueToggle').addEventListener('click', () => $('queuePanel').classList.toggle('collapsed'));
$('queueClear').addEventListener('click', clearFinished);
$('queueList').addEventListener('click', (e) => {
  const b = e.target.closest('.q-retry');
  if (b) retryTask(+b.dataset.id);
});

// ---------- 启动 ----------
initBatch();
