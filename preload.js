// 渲染进程桥：向页面暴露下载进度事件、保存目录选择、剪贴板读取（contextIsolation 安全暴露）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('biliDesktop', {
    isDesktop: true,
    onDownloadEvent: (cb) => ipcRenderer.on('download-event', (_e, payload) => cb(payload)),
    getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
    chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
    readClipboard: () => ipcRenderer.invoke('clipboard-read'),
});
