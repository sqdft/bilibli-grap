// Electron 主进程：随机端口起同一个 Express 服务，窗口加载它；接管下载进度/保存目录/完成通知
const { app, BrowserWindow, ipcMain, dialog, Notification, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let downloadDir = null; // 批量下载时用户选择过的目录（仅内存记住，不做持久化）

function sendDownloadEvent(payload) {
    if (win && !win.isDestroyed()) win.webContents.send('download-event', payload);
}

function setupDownloads() {
    session.defaultSession.on('will-download', (event, item) => {
        let token = '', dirMode = false;
        try {
            const u = new URL(item.getURL());
            token = u.searchParams.get('dlToken') || '';
            dirMode = u.searchParams.get('dirMode') === '1';
        } catch { /* 忽略非标准URL */ }

        const filename = item.getFilename();
        if (dirMode && downloadDir) {
            // 批量模式：静默存到用户选过的目录，重名自动加序号
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);
            let p = path.join(downloadDir, filename);
            let i = 1;
            while (fs.existsSync(p)) p = path.join(downloadDir, `${base}(${i++})${ext}`);
            item.setSavePath(p);
        } // 否则走默认保存对话框，用户自己选路径

        item.on('updated', (e, state) => {
            sendDownloadEvent({
                token, type: 'progress',
                received: item.getReceivedBytes(),
                total: item.getTotalBytes(),
                state,
            });
        });
        item.once('done', (e, state) => {
            sendDownloadEvent({ token, type: 'done', state, filename });
            if (state === 'completed' && Notification.isSupported()) {
                try { new Notification({ title: '下载完成', body: filename }).show(); } catch { /* 通知失败不影响下载 */ }
            }
        });
    });
}

ipcMain.handle('choose-download-dir', async () => {
    const r = await dialog.showOpenDialog(win, {
        title: '选择批量下载保存目录',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (!r.canceled && r.filePaths[0]) downloadDir = r.filePaths[0];
    return downloadDir;
});
ipcMain.handle('get-download-dir', () => downloadDir);
ipcMain.handle('clipboard-read', () => clipboard.readText());

async function createWindow() {
    const { startServer } = require('./server');
    const server = await startServer(0); // 随机空闲端口，避免与已开服务冲突
    const port = server.address().port;

    win = new BrowserWindow({
        width: 1100,
        height: 840,
        minWidth: 860,
        minHeight: 600,
        autoHideMenuBar: true,   // 图标留空，窗口自动继承 exe 内嵌图标
        title: 'B站视频下载器',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    win.removeMenu();
    win.loadURL(`http://127.0.0.1:${port}`);
}

app.setAppUserModelId('com.sqdft.biligrabber'); // Windows 通知需要 AppUserModelID

app.whenReady().then(() => {
    setupDownloads();
    createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
