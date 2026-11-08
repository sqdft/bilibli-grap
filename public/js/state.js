// 全局状态：当前视频 + 播放地址缓存（playurl 结果按 bvid_cid_qn 缓存，避免重复请求）
export const state = {
  info: null,
  bvid: '', aid: '', cid: '',
  title: '', cover: '', owner: '',
  pages: [],          // 多P列表 [{cid, page, part}]
  qn: 80,             // 当前清晰度代号
  currentSegment: 0,  // 当前播放的分段索引
  playurls: new Map(), // `${bvid}_${cid}_${qn}` -> playurl data.data
};

export function resetVideo() {
  state.info = null;
  state.bvid = ''; state.aid = ''; state.cid = '';
  state.title = ''; state.cover = ''; state.owner = '';
  state.pages = [];
  state.qn = 80;
  state.currentSegment = 0;
  state.playurls.clear();
}
