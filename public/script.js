let currentBvid = "";
let currentCid = "";
let currentTitle = "";
let durls = [];        // 当前视频的分片地址列表（长视频会被B站切成多段）
let currentSegment = 0;

const $ = (id) => document.getElementById(id);
const player = $("player");

// 播完一段自动接下一段
player.addEventListener("ended", () => {
  if (currentSegment < durls.length - 1) loadAndPlay(currentSegment + 1);
});

function setBusy(btnId, busy) {
  const btn = $(btnId);
  if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
  btn.disabled = busy;
  btn.textContent = busy ? "处理中..." : btn.dataset.origText;
}

function stopPlayer() {
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.style.display = "none";
}

function safeFilename(name) {
  return (name || "").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "video";
}

// 切换分P
function selectPage() {
  currentCid = $("pageSelect").value;
  durls = [];
  currentSegment = 0;
  stopPlayer();
}

async function fetchVideoInfo() {
  const url = $("videoUrl").value.trim();
  if (!url) {
    alert("请输入视频链接");
    return;
  }

  setBusy("btnInfo", true);
  try {
    const response = await fetch(`/api/video-info?url=${encodeURIComponent(url)}`);
    const data = await response.json();

    if (data.code !== 0) {
      alert("获取失败：" + data.message);
      return;
    }

    const info = data.data;
    currentBvid = info.bvid;
    currentTitle = info.title;
    currentCid = info.cid;
    durls = [];
    currentSegment = 0;
    stopPlayer();

    // 代理图片防盗链
    $("pic").src = `/proxy/image?url=${encodeURIComponent(info.pic)}`;
    $("title").textContent = info.title;
    $("owner").textContent = info.owner.name;
    $("views").textContent = info.stat.view;
    $("likes").textContent = info.stat.like;
    $("videoLink").href = `https://www.bilibili.com/video/${info.bvid}`;

    // 多P视频显示分P下拉框
    const pages = info.pages || [];
    const select = $("pageSelect");
    select.innerHTML = "";
    if (pages.length > 1) {
      pages.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.cid;
        opt.textContent = `P${p.page} ${p.part}`;
        select.appendChild(opt);
      });
      select.value = currentCid;
      select.style.display = "inline-block";
    } else {
      select.style.display = "none";
    }

    $("result").style.display = "block";
  } catch (error) {
    alert("请求出错：" + error);
  } finally {
    setBusy("btnInfo", false);
  }
}

async function playVideo() {
  if (!currentBvid || !currentCid) {
    alert("请先获取视频信息");
    return;
  }

  setBusy("btnPlay", true);
  try {
    const res = await fetch(`/api/video-playurl?bvid=${currentBvid}&cid=${currentCid}`);
    const data = await res.json();

    if (data.code !== 0) {
      alert("获取播放地址失败：" + data.message);
      return;
    }

    durls = data.data.durl.map((d) => d.url);
    loadAndPlay(0);
  } catch (err) {
    alert("播放失败：" + err);
  } finally {
    setBusy("btnPlay", false);
  }
}

function loadAndPlay(i) {
  currentSegment = i;
  // 代理视频地址防止403
  player.src = `/proxy/video?url=${encodeURIComponent(durls[i])}`;
  player.style.display = "block";
  player.play();
}

function downloadVideo() {
  if (!durls.length) {
    alert("请先播放视频");
    return;
  }
  const suffix = durls.length > 1 ? `_P${currentSegment + 1}` : "";
  const a = document.createElement("a");
  a.href = `/proxy/video?url=${encodeURIComponent(durls[currentSegment])}`;
  a.download = safeFilename(currentTitle) + suffix + ".mp4";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
