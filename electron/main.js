'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell
} = require('electron');
const { createAppPaths } = require('./paths');
const { migrateLegacyData } = require('./migration');
const { createVideoCheckerServer } = require('../server');

let mainWindow = null;
let serverHandle = null;
let isQuitting = false;

function appendLog(file, message) {
  fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}

function runtimeBinary(name) {
  const archDir = process.arch === 'arm64' ? 'darwin-arm64'
    : process.arch === 'x64' ? 'darwin-x64'
      : null;
  if (!archDir) throw new Error(`不支持的 CPU 架构: ${process.arch}`);
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'vendor');
  const file = path.join(base, app.isPackaged ? 'bin' : 'bin', archDir, name);
  if (!fs.existsSync(file)) throw new Error(`应用安装不完整，缺少 ${name}`);
  return file;
}

function registerWindowIpc() {
  ipcMain.handle('window:set-bounds', (event, requested) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const values = [requested.width, requested.height, requested.x, requested.y];
    if (!values.every(Number.isInteger) || requested.width <= 0 || requested.height <= 0) {
      throw new Error('非法窗口尺寸');
    }
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
    const width = Math.max(720, Math.min(requested.width, workArea.width));
    const height = Math.max(600, Math.min(requested.height, workArea.height));
    const x = Math.max(workArea.x, Math.min(requested.x, workArea.x + workArea.width - width));
    const y = Math.max(workArea.y, Math.min(requested.y, workArea.y + workArea.height - height));
    win.setBounds({ x, y, width, height }, true);
  });
}

async function createWindow() {
  const paths = createAppPaths(app);
  const migrationInfo = migrateLegacyData(paths);
  appendLog(paths.mainLog, `启动 ${app.getVersion()} ${process.arch}`);

  const authToken = crypto.randomBytes(32).toString('hex');
  serverHandle = await createVideoCheckerServer({
    host: '127.0.0.1',
    port: 0,
    publicDir: path.join(app.getAppPath(), 'public'),
    marksFile: paths.marksFile,
    settingsFile: paths.settingsFile,
    keysDir: paths.keysDir,
    cacheDir: paths.videoCacheDir,
    thumbsDir: paths.thumbsDir,
    uploadsDir: paths.uploadsDir,
    rclonePath: runtimeBinary('rclone'),
    ffmpegPath: runtimeBinary('ffmpeg'),
    rcloneConfigPath: paths.rcloneConfigPath,
    authToken,
    migrationInfo,
    logger: message => appendLog(paths.serverLog, message),
    openExternal: url => shell.openExternal(url)
  });

  const origin = serverHandle.url;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    show: false,
    title: '视频检查器',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      details.requestHeaders['X-Video-Checker-Token'] = authToken;
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  await mainWindow.loadURL(`${origin}/?electron=1`);
}

async function shutdown() {
  if (serverHandle) {
    const handle = serverHandle;
    serverHandle = null;
    await handle.close();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerWindowIpc();
    return createWindow();
  }).catch(error => {
    dialog.showErrorBox('视频检查器启动失败', error.stack || error.message);
    app.quit();
  });

  app.on('before-quit', event => {
    if (isQuitting || !serverHandle) return;
    event.preventDefault();
    isQuitting = true;
    shutdown().finally(() => app.quit());
  });
}
