const { app, BrowserWindow } = require('electron');

let win = null;

async function createWindow() {
  const { startServer } = require('./server');
  const server = await startServer(0); // 随机空闲端口，避免与已开服务冲突
  const port = server.address().port;

  win = new BrowserWindow({
    width: 1100,
    height: 820,
    autoHideMenuBar: true,   // 图标留空，窗口自动继承 exe 内嵌图标
    title: 'B站视频下载器'
  });
  win.removeMenu();
  win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
