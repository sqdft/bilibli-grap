let currentBvid = "";
let currentCid = "";
let currentVideoUrl = "";

async function fetchVideoInfo() {
  const url = document.getElementById("videoUrl").value.trim();
  if (!url) {
    alert("请输入视频链接");
    return;
  }

  try {
    const response = await fetch(`/api/video-info?url=${encodeURIComponent(url)}`);
    const data = await response.json();

    if (data.code !== 0) {
      alert("获取失败：" + data.message);
      return;
    }

    const info = data.data;
    currentBvid = info.bvid;
    currentCid = info.cid;

    // 代理图片防盗链
    document.getElementById("pic").src = `/proxy/image?url=${encodeURIComponent(info.pic)}`;
    document.getElementById("title").textContent = info.title;
    document.getElementById("owner").textContent = info.owner.name;
    document.getElementById("views").textContent = info.stat.view;
    document.getElementById("likes").textContent = info.stat.like;
    document.getElementById("videoLink").href = `https://www.bilibili.com/video/${info.bvid}`;

    document.getElementById("result").style.display = "block";

    // 隐藏视频，清空之前的播放地址
    const player = document.getElementById("player");
    player.style.display = "none";
    player.pause();
    player.src = "";
    currentVideoUrl = "";
  } catch (error) {
    alert("请求出错：" + error);
  }
}

async function playVideo() {
  if (!currentBvid || !currentCid) {
    alert("请先获取视频信息");
    return;
  }

  try {
    const res = await fetch(`/api/video-playurl?bvid=${currentBvid}&cid=${currentCid}`);
    const data = await res.json();

    if (data.code !== 0) {
      alert("获取播放地址失败：" + data.message);
      return;
    }

    currentVideoUrl = data.data.durl[0].url;

    const player = document.getElementById("player");
    // 代理视频地址防止403
    player.src = `/proxy/video?url=${encodeURIComponent(currentVideoUrl)}`;
    player.style.display = "block";
    player.play();
  } catch (err) {
    alert("播放失败：" + err);
  }
}

function downloadVideo() {
    if (!currentVideoUrl) {
      alert("请先播放视频");
      return;
    }
    const a = document.createElement("a");
    a.href = `/proxy/video?url=${encodeURIComponent(currentVideoUrl)}`;
    a.download = "video.mp4"; // 你可以换成想要的文件名
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  