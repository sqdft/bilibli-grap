// 后端接口封装：统一错误处理，B站错误码翻译成人话
async function request(path) {
  const res = await fetch(path);
  let data;
  try { data = await res.json(); }
  catch { throw new Error(`接口响应异常 (HTTP ${res.status})`); }
  if (data.code !== 0) {
    const err = new Error(data.message || '请求失败');
    err.code = data.code;
    throw err;
  }
  return data;
}

const q = (obj) => new URLSearchParams(Object.entries(obj)).toString();

export const api = {
  info: (url) => request(`/api/video-info?${q({ url })}`),
  playurl: (bvid, cid, qn = 80, fnval = 1) => request(`/api/video-playurl?${q({ bvid, cid, qn, fnval })}`),
  danmaku: (cid) => request(`/api/danmaku?${q({ cid })}`),
  subtitle: (bvid, cid) => request(`/api/subtitle?${q({ bvid, cid })}`),
  favList: (fid, pn, ps = 20) => request(`/api/fav-list?${q({ fid, pn, ps })}`),
  season: (mid, season_id, pn) => request(`/api/season?${q({ mid, season_id, pn })}`),
  series: (mid, series_id, pn) => request(`/api/series?${q({ mid, series_id, pn })}`),
  space: (mid, pn) => request(`/api/space-archives?${q({ mid, pn, ps: 25 })}`),
};

export function biliErrorMsg(e) {
  const map = {
    '-404': '视频不存在或已删除',
    '62002': '稿件不可见（UP主设置了隐私）',
    '-403': '权限不足（可能是隐藏稿件）',
    '-412': '触发B站风控，请稍后再试',
    '-352': '触发B站风控，请稍后再试',
  };
  return map[String(e?.code)] || e?.message || '请求失败';
}
