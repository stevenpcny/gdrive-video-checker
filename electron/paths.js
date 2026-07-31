'use strict';

const fs = require('fs');
const path = require('path');

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Windows 只支持只读位，POSIX 权限位在该平台没有意义。
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

function createAppPaths(app) {
  // Windows: %APPDATA%（漫游）存数据，%LOCALAPPDATA%（本机）存缓存与日志，避免缓存被漫游同步。
  const dataDir = path.join(app.getPath('appData'), '视频检查器');
  const localRoot = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || app.getPath('userData'), '视频检查器')
    : path.join(app.getPath('home'), 'Library');
  const cacheDir = process.platform === 'win32'
    ? path.join(localRoot, 'Cache')
    : path.join(localRoot, 'Caches', 'local.video-checker');
  const logsDir = process.platform === 'win32'
    ? path.join(localRoot, 'Logs')
    : path.join(localRoot, 'Logs', '视频检查器');
  const keysDir = path.join(dataDir, 'keys');
  const rcloneDir = path.join(dataDir, 'rclone');
  const videoCacheDir = path.join(cacheDir, 'video');
  const thumbsDir = path.join(cacheDir, 'thumbs');
  const uploadsDir = path.join(cacheDir, 'uploads');

  for (const dir of [dataDir, cacheDir, logsDir, keysDir, rcloneDir, videoCacheDir, thumbsDir, uploadsDir]) {
    ensurePrivateDir(dir);
  }

  return {
    dataDir,
    cacheDir,
    logsDir,
    keysDir,
    rcloneDir,
    videoCacheDir,
    thumbsDir,
    uploadsDir,
    marksFile: path.join(dataDir, 'marks.json'),
    settingsFile: path.join(dataDir, 'settings.json'),
    migrationFile: path.join(dataDir, 'migration.json'),
    rcloneConfigPath: path.join(rcloneDir, 'rclone.conf'),
    mainLog: path.join(logsDir, 'main.log'),
    serverLog: path.join(logsDir, 'server.log')
  };
}

module.exports = { createAppPaths };
