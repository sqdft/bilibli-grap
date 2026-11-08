// 批量导入：多链接解析 + 收藏夹/合集/系列/UP主空间列表拉取 + 勾选下载
import { api, biliErrorMsg } from './api.js';
import { $, esc, toast, fmtDur } from './util.js';
import { enqueueVideo, ensureBatchDir } from './downloader.js';

let picked = []; // 当前列表 {bvid, cid, title, cover, duration}

export function initBatch() {
  // Tab 切换
  document.querySelectorAll('#batchCard .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#batchCard .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('tab-links').classList.toggle('hidden', tab.dataset.tab !== 'links');
      $('tab-space').classList.toggle('hidden', tab.dataset.tab !== 'space');
    });
  });

  $('btnBatchParse').addEventListener('click', parseBatchLinks);
  $('btnSpaceFetch').addEventListener('click', fetchSpaceList);
  $('pickAll').addEventListener('change', () => {
    document.querySelectorAll('#pickItems input[type=checkbox]').forEach(c => { c.checked = $('pickAll').checked; });
  });
  $('btnPickDownload').addEventListener('click', downloadPicked);
}

// 简易并发池（限速，别把B站接口打爆）
async function pool(tasks, worker, size = 3) {
  let i = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await worker(tasks[idx], idx); }
      catch { results[idx] = null; } // 单个失败不中断整体
    }
  }));
  return results;
}

// ---------- 多链接批量 ----------
async function parseBatchLinks() {
  const raw = $('batchInput').value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!raw.length) return toast('请先粘贴链接，每行一个', 'warn');
  $('btnBatchParse').disabled = true;
  $('batchStat').textContent = `解析中 0/${raw.length}...`;

  const stat = { done: 0 };
  const results = await pool(raw, async (line) => {
    const d = await api.info(line);
    stat.done++;
    $('batchStat').textContent = `解析中 ${stat.done}/${raw.length}...`;
    const v = d.data;
    return { bvid: v.bvid, cid: v.cid, title: v.title, cover: v.pic, duration: v.duration };
  });

  const seen = new Set();
  picked = results.filter(Boolean).filter(x => !seen.has(x.bvid) && seen.add(x.bvid));
  $('btnBatchParse').disabled = false;
  if (!picked.length) {
    $('batchStat').textContent = '';
    return toast('没有解析出有效视频', 'error');
  }
  $('batchStat').textContent = `解析成功 ${picked.length}/${raw.length}`;
  renderPickList();
}

// ---------- 收藏夹 / 合集 / 系列 / UP主空间 ----------
function parseSpaceLink(text) {
  text = String(text || '').trim();
  let m;
  if ((m = text.match(/space\.bilibili\.com\/(\d+)\/favlist/))) {
    const fid = text.match(/[?&]fid=(\d+)/);
    if (fid) return { type: 'fav', fid: fid[1] };
  }
  if (/favlist/.test(text) && (m = text.match(/[?&]fid=(\d+)/))) return { type: 'fav', fid: m[1] };
  if ((m = text.match(/[?&]season_id=(\d+)/))) {
    const mid = (text.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
    const bv = (text.match(/BV[a-zA-Z0-9]{8,}/) || [])[0] || '';
    return { type: 'season', season_id: m[1], mid, bv };
  }
  if (/collectiondetail/.test(text) && (m = text.match(/[?&]sid=(\d+)/))) {
    const mid = (text.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
    return { type: 'season', season_id: m[1], mid };
  }
  if ((m = text.match(/[?&]series_id=(\d+)/))) {
    const mid = (text.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
    return { type: 'series', series_id: m[1], mid };
  }
  if ((m = text.match(/space\.bilibili\.com\/(\d+)/))) return { type: 'space', mid: m[1] };
  return null;
}

async function fetchSpaceList() {
  const text = $('spaceInput').value.trim();
  const target = parseSpaceLink(text);
  if (!target) {
    return toast('无法识别链接类型：支持收藏夹(fid)、合集/系列(season_id/series_id)、UP主空间链接', 'error');
  }
  const btn = $('btnSpaceFetch');
  btn.disabled = true;
  $('spaceStat').textContent = '获取列表中...';

  try {
    let list = [];
    let name = '';

    if (target.type === 'fav') {
      const first = await api.favList(target.fid, 1, 20);
      const info = first.data?.info || {};
      name = info.title || '收藏夹';
      const total = Math.min(+info.media_count || 0, 200);
      list = norm(first.data?.medias || [], x => ({ bvid: x.bvid, cid: x.cid, title: x.title, cover: x.cover, duration: x.duration }));
      for (let pn = 2; list.length < total; pn++) {
        const d = await api.favList(target.fid, pn, 20);
        const batch = norm(d.data?.medias || [], x => ({ bvid: x.bvid, cid: x.cid, title: x.title, cover: x.cover, duration: x.duration }));
        if (!batch.length) break;
        list.push(...batch);
        $('spaceStat').textContent = `获取列表中 ${list.length}/${total}...`;
      }
    } else if (target.type === 'season') {
      let mid = target.mid;
      if (!mid && target.bv) {
        const d = await api.info(`https://www.bilibili.com/video/${target.bv}`);
        mid = d.data?.owner?.mid;
      }
      if (!mid) throw new Error('合集链接缺少UP主信息，请粘贴包含 space.bilibili.com 或视频链接的完整地址');
      for (let pn = 1; pn <= 20; pn++) {
        const d = await api.season(mid, target.season_id, pn);
        const archives = d.data?.archives || [];
        if (pn === 1) name = d.data?.meta?.name || '合集';
        if (!archives.length) break;
        list.push(...norm(archives, x => ({ bvid: x.bvid, cid: x.cid, title: x.title, cover: x.pic, duration: x.duration })));
        $('spaceStat').textContent = `获取列表中 ${list.length}...`;
        if (list.length >= +d.data?.meta?.total) break;
      }
    } else if (target.type === 'series') {
      let mid = target.mid;
      if (!mid) throw new Error('系列链接缺少UP主信息，请粘贴包含 space.bilibili.com 的完整地址');
      for (let pn = 1; pn <= 20; pn++) {
        const d = await api.series(mid, target.series_id, pn);
        if (pn === 1) name = d.data?.meta?.name || '系列';
        const archives = d.data?.archives || [];
        if (!archives.length) break;
        list.push(...norm(archives, x => ({ bvid: x.bvid, cid: x.cid, title: x.title, cover: x.pic, duration: x.duration })));
        if (list.length >= +d.data?.total) break;
      }
    } else { // space：最新投稿，上限 100 个
      const first = await api.space(target.mid, 1);
      name = first.data?.list?.vlist?.[0]?.author || 'UP主投稿';
      const total = Math.min(+first.data?.page?.count || 0, 100);
      list = norm(first.data?.list?.vlist || [], x => ({ bvid: x.bvid, cid: x.cid, title: x.title, cover: x.pic, duration: x.length }));
      for (let pn = 2; list.length < total; pn++) {
        const d = await api.space(target.mid, pn);
        const batch = norm(d.data?.list?.vlist || [], x => ({ bvid: x.bvid, cid: x.cid, title: x.title, cover: x.pic, duration: x.length }));
        if (!batch.length) break;
        list.push(...batch);
        $('spaceStat').textContent = `获取列表中 ${list.length}/${total}...`;
      }
    }

    const seen = new Set();
    picked = list.filter(x => x.bvid && !seen.has(x.bvid) && seen.add(x.bvid));
    $('spaceStat').textContent = `${name}：共 ${picked.length} 个视频`;
    if (!picked.length) return toast('该列表下没有取到视频', 'warn');
    renderPickList();
  } catch (e) {
    $('spaceStat').textContent = '';
    toast(biliErrorMsg(e), 'error');
  } finally {
    btn.disabled = false;
  }
}

const norm = (arr, map) => (arr || []).map(map).filter(x => x.bvid);

// ---------- 勾选列表渲染与下载 ----------
function renderPickList() {
  $('pickList').classList.remove('hidden');
  $('pickAll').checked = true;
  $('pickItems').innerHTML = picked.map((p, i) => `
    <label class="pick-item">
      <input type="checkbox" checked data-i="${i}" />
      <img src="/proxy/image?url=${encodeURIComponent(p.cover || '')}" alt="" loading="lazy" />
      <span class="pick-title" title="${esc(p.title)}">${esc(p.title)}</span>
      <span class="pick-dur">${p.duration ? fmtDur(p.duration) : ''}</span>
    </label>`).join('');
}

async function downloadPicked() {
  const sel = [...document.querySelectorAll('#pickItems input[type=checkbox]')]
    .filter(c => c.checked).map(c => picked[+c.dataset.i]).filter(Boolean);
  if (!sel.length) return toast('请先勾选要下载的视频', 'warn');

  const dirMode = await ensureBatchDir(sel.length);
  let ok = 0;
  for (const p of sel) {
    try {
      enqueueVideo({ bvid: p.bvid, cid: p.cid, title: p.title, qn: 80, segIndex: 0, dirMode });
      ok++;
    } catch (e) {
      toast(`${p.title}: ${biliErrorMsg(e)}`, 'error');
    }
  }
  if (ok) toast(`已加入下载队列 ${ok} 个视频`, 'success');
}
