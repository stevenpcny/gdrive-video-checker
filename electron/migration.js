'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../server');

function copyFileIfMissing(source, destination, mode) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, mode);
  return true;
}

function migrateLegacyData(paths, options = {}) {
  const legacyRoot = options.legacyRoot || path.join(os.homedir(), '谷歌云盘视频检查器');
  const globalRcloneConfig = options.globalRcloneConfig || path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(paths.migrationFile, 'utf8')); }
    catch { return null; }
  })();
  if (existing?.version >= 1) return existing;

  const copied = [];
  if (copyFileIfMissing(path.join(legacyRoot, 'marks.json'), paths.marksFile, 0o600)) {
    copied.push('marks.json');
  }

  const legacyKeys = path.join(legacyRoot, 'keys');
  if (fs.existsSync(legacyKeys)) {
    for (const name of fs.readdirSync(legacyKeys)) {
      if (!name.endsWith('.json')) continue;
      const source = path.join(legacyKeys, name);
      if (!fs.statSync(source).isFile()) continue;
      if (copyFileIfMissing(source, path.join(paths.keysDir, name), 0o600)) copied.push(`keys/${name}`);
    }
  }

  const result = {
    version: 1,
    completedAt: new Date().toISOString(),
    copied,
    globalRcloneConfigAvailable: fs.existsSync(globalRcloneConfig),
    globalRcloneConfig
  };
  writeJsonAtomic(paths.migrationFile, result);
  return result;
}

module.exports = { migrateLegacyData };
