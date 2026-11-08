// 解析历史：localStorage 持久化，最近 20 条，去重
const KEY = 'bili_history_v1';

export function getHistory() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; }
  catch { return []; }
}

export function pushHistory(item) {
  const list = getHistory().filter(h => h.bvid !== item.bvid);
  list.unshift({ ...item, ts: Date.now() });
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20))); } catch { /* 存不下就算了 */ }
}

export function clearHistory() {
  try { localStorage.removeItem(KEY); } catch { /* 同上 */ }
}
