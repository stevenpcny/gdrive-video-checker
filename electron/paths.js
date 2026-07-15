'use strict';

const fs = require('fs');
const path = require('path');

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function createAppPaths(app) {
  const dataDir = path.join(app.getPath('appData'), '视频检查器');
  const libraryDir = path.join(app.getPath('home'), 'Library');
  const cacheDir = path.join(libraryDir, 'Caches', 'local.video-checker');
  const logsDir = path.join(libraryDir, 'Logs', '视频检查器');
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
