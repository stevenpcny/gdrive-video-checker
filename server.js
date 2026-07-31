#!/usr/bin/env node
// 谷歌云盘视频检查器 — 可独立运行，也可嵌入 Electron 主进程
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const GB = 1024 ** 3;
const THUMB_FPS = 10;
const THUMB_PROFILE = '10fps-240w-v2';
const PUBLIC_THUMB_FPS = 2;
const PUBLIC_THUMB_PROFILE = '2fps-240w-v1';
const API_VERSION = 10;
const LIST_CACHE_TTL_MS = 30_000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeFileAtomic(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function writeJsonAtomic(file, value, mode = 0o600) {
  writeFileAtomic(file, JSON.stringify(value, null, 2), mode);
}

function directorySize(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => total + directorySize(path.join(target, name)), 0);
}

function pruneCache(root, maxBytes, maxAgeMs) {
  const now = Date.now();
  const entries = fs.readdirSync(root).map(name => {
    const full = path.join(root, name);
    const stat = fs.statSync(full);
    return { full, mtime: stat.mtimeMs, size: directorySize(full) };
  });
  for (const entry of entries) {
    if (now - entry.mtime > maxAgeMs) fs.rmSync(entry.full, { recursive: true, force: true });
  }
  const remaining = entries.filter(entry => fs.existsSync(entry.full)).sort((a, b) => a.mtime - b.mtime);
  let total = remaining.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of remaining) {
    if (total <= maxBytes) break;
    fs.rmSync(entry.full, { recursive: true, force: true });
    total -= entry.size;
  }
}

function safePath(p) {
  if (typeof p !== 'string') return null;
  const clean = p.replace(/^\/+|\/+$/g, '');
  if (clean.split('/').some(seg => seg === '..' || seg === '')) return clean === '' ? '' : null;
  return clean;
}

function resolveInside(base, rel) {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

const encSegs = p => p.split('/').map(encodeURIComponent).join('/');

function freePort(host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(err => err ? reject(err) : resolve(port));
    });
  });
}

async function createVideoCheckerServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const requestedPort = Number.isInteger(options.port) ? options.port : 5572;
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, 'public'));
  const marksFile = options.marksFile || path.join(__dirname, 'marks.json');
  const settingsFile = options.settingsFile || path.join(__dirname, 'settings.json');
  const keysDir = options.keysDir || path.join(__dirname, 'keys');
  const cacheDir = options.cacheDir || path.join(os.tmpdir(), 'video-checker-cache');
  const thumbsDir = options.thumbsDir || path.join(os.tmpdir(), 'video-checker-thumbs');
  const uploadsDir = options.uploadsDir || path.join(os.tmpdir(), 'video-checker-uploads');
  const rclonePath = options.rclonePath || 'rclone';
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  const rcloneConfigPath = options.rcloneConfigPath || null;
  const authToken = options.authToken || null;
  const migrationInfo = options.migrationInfo || null;
  const logger = options.logger || (message => console.log(message));
  const openExternal = options.openExternal || null;
  const publicDriveBaseUrl = options.publicDriveBaseUrl || 'https://drive.usercontent.google.com/download';
  const driveApiBaseUrl = options.driveApiBaseUrl || 'https://www.googleapis.com/drive/v3';
  const googleTokenUrl = options.googleTokenUrl || 'https://oauth2.googleapis.com/token';

  for (const dir of [keysDir, cacheDir, thumbsDir, uploadsDir]) ensureDir(dir);
  // 新版完整视频只进 RAM；启动时清理旧版遗留的 SSD 视频缓存。
  for (const name of fs.readdirSync(cacheDir)) fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(uploadsDir)) {
    if (name.endsWith('.part') || name.startsWith('vc-upload-')) {
      fs.rmSync(path.join(uploadsDir, name), { recursive: true, force: true });
    }
  }
  pruneCache(thumbsDir, 5 * 1024 ** 3, 30 * 24 * 60 * 60 * 1000);
  if (rcloneConfigPath) {
    ensureDir(path.dirname(rcloneConfigPath));
    if (!fs.existsSync(rcloneConfigPath)) fs.writeFileSync(rcloneConfigPath, '', { mode: 0o600 });
  }

  let knownRemotes = new Set();
  let actualPort = null;
  let closing = false;
  const serves = new Map();
  const children = new Set();
  const prefetchJobs = new Map();
  const uploadProgress = new Map();
  const thumbJobs = new Map();
  const oauthSessions = new Map();
  const permissionJobs = new Map();
  const listCache = new Map(); // remote/path -> { entries, expiresAt }
  const listJobs = new Map(); // remote/path -> in-flight Drive request
  const ramVideoCache = new Map(); // key -> { buffer, size, atime }
  let ramCacheBytes = 0;
  let expectedOrigin = null;

  function log(message) {
    logger(String(message).replace(/[\r\n]+$/g, ''));
  }

  function trackChild(proc) {
    children.add(proc);
    proc.once('exit', () => children.delete(proc));
    return proc;
  }

  function rcloneArgs(args) {
    return rcloneConfigPath ? ['--config', rcloneConfigPath, ...args] : args;
  }

  function execTool(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const proc = trackChild(execFile(command, args, {
        maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
        ...opts
      }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || '').trim() || err.message));
        else resolve(stdout);
      }));
      proc.on('error', reject);
    });
  }

  function rclone(args, opts) {
    return execTool(rclonePath, rcloneArgs(args), opts);
  }

  function requestJson(target, { method = 'GET', token = '', body = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(target);
      const payload = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const client = url.protocol === 'http:' ? http : https;
      const request = client.request(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': payload.length } : {}),
          ...headers
        }
      }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 5 * 1024 * 1024) request.destroy(new Error('Google API 响应过大'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          let result = {};
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
          catch { return reject(new Error('Google API 返回了无效 JSON')); }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(result.error?.message || `Google API 请求失败 (${response.statusCode})`);
            error.status = response.statusCode;
            return reject(error);
          }
          resolve(result);
        });
      });
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  const base64url = value => Buffer.from(value).toString('base64url');

  async function serviceAccountAccessToken(file) {
    const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!credentials.client_email || !credentials.private_key) throw new Error('服务账号密钥缺少 client_email 或 private_key');
    const now = Math.floor(Date.now() / 1000);
    const tokenUrl = googleTokenUrl;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: tokenUrl,
      iat: now,
      exp: now + 3600
    }));
    const unsigned = `${header}.${claims}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    }).toString();
    const result = await requestJson(tokenUrl, { method: 'POST', body: form });
    if (!result.access_token) throw new Error('服务账号未返回访问令牌');
    return result.access_token;
  }

  async function driveAccessToken(remote) {
    const base = remote.split(',')[0];
    const readConfig = async () => {
      const config = JSON.parse(await rclone(['config', 'dump']));
      const section = config[base];
      if (!section || section.type !== 'drive') throw new Error('当前账号不是 Google Drive');
      return section;
    };
    let section = await readConfig();
    if (section.service_account_file) return serviceAccountAccessToken(section.service_account_file);
    let token;
    try { token = JSON.parse(section.token || '{}'); } catch { token = {}; }
    const expiry = Date.parse(token.expiry || '');
    if (!token.access_token || !Number.isFinite(expiry) || expiry <= Date.now() + 60_000) {
      await rclone(['lsd', base + ':', '--max-depth', '1']);
      section = await readConfig();
      try { token = JSON.parse(section.token || '{}'); } catch { token = {}; }
    }
    if (!token.access_token) throw new Error('当前 Drive 账号没有可用的 OAuth 令牌，请重新授权');
    return token.access_token;
  }

  function driveApiUrl(route, params = {}) {
    const url = new URL(driveApiBaseUrl.replace(/\/$/, '') + route);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  async function folderPermissions(remote, fileId) {
    const token = options.driveAccessToken ? await options.driveAccessToken(remote) : await driveAccessToken(remote);
    const file = await requestJson(driveApiUrl(`/files/${encodeURIComponent(fileId)}`, {
      fields: 'id,name,driveId,capabilities(canShare)',
      supportsAllDrives: 'true'
    }), { token });
    const allPermissions = [];
    let pageToken = '';
    do {
      const result = await requestJson(driveApiUrl(`/files/${encodeURIComponent(fileId)}/permissions`, {
        fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(inherited,inheritedFrom))',
        supportsAllDrives: 'true',
        pageSize: '100',
        ...(pageToken ? { pageToken } : {})
      }), { token });
      allPermissions.push(...(result.permissions || []));
      pageToken = result.nextPageToken || '';
    } while (pageToken);
    const permissions = allPermissions.map(permission => ({
      ...permission,
      inherited: permission.permissionDetails?.length > 0 && permission.permissionDetails.every(detail => detail.inherited)
    }));
    return { token, file, permissions };
  }

  async function serializePermissionChange(fileId, task) {
    const previous = permissionJobs.get(fileId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    permissionJobs.set(fileId, current);
    try { return await current; }
    finally { if (permissionJobs.get(fileId) === current) permissionJobs.delete(fileId); }
  }

  function listCacheKey(remote, relPath) {
    return `${remote}\0${relPath}`;
  }

  function invalidateListCache(remote) {
    const prefix = `${remote}\0`;
    for (const key of listCache.keys()) {
      if (key.startsWith(prefix)) listCache.delete(key);
    }
  }

  async function listDirectory(remote, relPath) {
    const key = listCacheKey(remote, relPath);
    const cached = listCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { entries: cached.entries, cached: true };
    if (cached) listCache.delete(key);

    let job = listJobs.get(key);
    if (!job) {
      job = rclone(['lsjson', remote + ':' + relPath]).then(out => {
        const entries = JSON.parse(out);
        listCache.set(key, { entries, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
        return entries;
      }).finally(() => listJobs.delete(key));
      listJobs.set(key, job);
    }
    return { entries: await job, cached: false };
  }

  function spawnRclone(args, opts = {}) {
    return trackChild(spawn(rclonePath, rcloneArgs(args), opts));
  }

  async function refreshRemotes() {
    const out = await rclone(['listremotes']);
    const names = out.trim().split('\n').filter(Boolean).map(r => r.replace(/:$/, ''));
    knownRemotes = new Set(names);
    return names;
  }

  async function ensureRemote(name) {
    const base = name.split(',')[0];
    if (!knownRemotes.has(base)) await refreshRemotes();
    if (!knownRemotes.has(base)) throw new Error('未知账号: ' + base);
    if (!/^[A-Za-z0-9_-]+(,shared_with_me|,root_folder_id=[A-Za-z0-9_-]{10,100})?$/.test(name)) {
      throw new Error('非法账号参数: ' + name);
    }
  }

  function spawnServe(remote, state) {
    if (closing) return;
    state.proc = spawnRclone([
      'serve', 'http', remote + ':',
      '--addr', `${host}:${state.port}`,
      '--htpasswd', state.htpasswd,
      '--read-only',
      '--vfs-read-chunk-size', '16M',
      '--vfs-read-chunk-size-limit', '256M',
      '--buffer-size', '32M',
      '--dir-cache-time', '15s'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    state.proc.stderr.on('data', d => log(`[serve ${remote}] ${d}`));
    state.proc.on('exit', code => {
      state.ready = null;
      if (closing) return;
      log(`[serve ${remote}] 退出 (code=${code})`);
      const now = Date.now();
      state.restarts = state.restarts.filter(t => now - t < 60000);
      if (state.restarts.length >= 5) {
        log(`[serve ${remote}] 一分钟内反复退出，停用该账号通道`);
        serves.delete(remote);
        return;
      }
      state.restarts.push(now);
      state.restartTimer = setTimeout(() => spawnServe(remote, state), 1000);
    });
  }

  function waitReady(state) {
    if (state.ready) return state.ready;
    state.ready = new Promise((resolve, reject) => {
      const started = Date.now();
      const probe = () => {
        const request = http.get({
          host,
          port: state.port,
          path: '/',
          headers: { Authorization: state.authHeader }
        }, response => {
          response.resume();
          resolve();
        });
        request.on('error', () => {
          if (closing) reject(new Error('应用正在退出'));
          else if (Date.now() - started > 10000) reject(new Error('视频流通道启动超时'));
          else setTimeout(probe, 300);
        });
      };
      probe();
    });
    return state.ready;
  }

  async function getServe(remote) {
    await ensureRemote(remote);
    let state = serves.get(remote);
    if (!state) {
      const user = crypto.randomBytes(12).toString('hex');
      const password = crypto.randomBytes(24).toString('hex');
      const htpasswd = path.join(uploadsDir, `.serve-auth-${crypto.randomBytes(8).toString('hex')}`);
      const passwordHash = crypto.createHash('sha1').update(password).digest('base64');
      fs.writeFileSync(htpasswd, `${user}:{SHA}${passwordHash}\n`, { mode: 0o600 });
      state = {
        port: await freePort(host),
        proc: null,
        restartTimer: null,
        restarts: [],
        ready: null,
        user,
        password,
        htpasswd,
        authHeader: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
      };
      serves.set(remote, state);
      spawnServe(remote, state);
    }
    await waitReady(state);
    return state;
  }

  function readMarks() {
    return readJson(marksFile, {});
  }

  function writeMarks(marks) {
    writeJsonAtomic(marksFile, marks);
  }

  function moveMarksWithFolder(remote, from, to) {
    const marks = readMarks();
    const fromPrefix = `${remote}:${from}/`;
    const toPrefix = `${remote}:${to}/`;
    let changed = false;
    for (const [key, value] of Object.entries(marks)) {
      if (!key.startsWith(fromPrefix)) continue;
      marks[toPrefix + key.slice(fromPrefix.length)] = value;
      delete marks[key];
      changed = true;
    }
    if (changed) writeMarks(marks);
  }

  function readSettings() {
    return readJson(settingsFile, { remote: '', sortMode: 'name', subdir: '不合格', ramCacheGb: 0, ramMaxVideoGb: 0, holdSeekRate: 4 });
  }

  function writeSettings(settings) {
    writeJsonAtomic(settingsFile, settings);
  }

  function ramLimits() {
    const settings = readSettings();
    const totalGb = os.totalmem() / GB;
    const autoCacheGb = Math.min(16, Math.max(2, Math.floor(totalGb * 0.25)));
    const cacheGb = Number(settings.ramCacheGb) > 0 ? Number(settings.ramCacheGb) : autoCacheGb;
    const effectiveCacheGb = Math.min(cacheGb, Math.max(1, totalGb * 0.75));
    const autoVideoGb = Math.min(2, Math.max(0.5, cacheGb / 3));
    const maxVideoGb = Number(settings.ramMaxVideoGb) > 0 ? Number(settings.ramMaxVideoGb) : autoVideoGb;
    return {
      totalGb,
      autoCacheGb,
      autoVideoGb,
      cacheGb: effectiveCacheGb,
      maxVideoGb: Math.min(maxVideoGb, effectiveCacheGb)
    };
  }

  function ramStatus() {
    const limits = ramLimits();
    return {
      totalMemoryGb: +limits.totalGb.toFixed(1),
      autoCacheGb: +limits.autoCacheGb.toFixed(1),
      autoMaxVideoGb: +limits.autoVideoGb.toFixed(1),
      cacheLimitGb: +limits.cacheGb.toFixed(1),
      maxVideoGb: +limits.maxVideoGb.toFixed(1),
      usedGb: +(ramCacheBytes / GB).toFixed(3),
      items: ramVideoCache.size,
      mode: 'ram'
    };
  }

  function parseConfigQuestion(output) {
    const text = output.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) return { State: '', Option: null, Error: text };
    return JSON.parse(text.slice(start, end + 1));
  }

  async function importRcloneConfig(content) {
    if (!rcloneConfigPath) throw new Error('当前运行模式没有私有 rclone 配置');
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 1024 * 1024) {
      throw new Error('rclone.conf 为空或超过 1MB');
    }
    const temp = `${rcloneConfigPath}.import-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(temp, content, { mode: 0o600 });
    try {
      const out = await execTool(rclonePath, ['--config', temp, 'listremotes']);
      const remotes = out.trim().split('\n').filter(Boolean);
      if (!remotes.length) throw new Error('配置中没有 remote');
      if (fs.existsSync(rcloneConfigPath) && fs.statSync(rcloneConfigPath).size) {
        const backupDir = path.join(path.dirname(rcloneConfigPath), 'backups');
        ensureDir(backupDir);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(rcloneConfigPath, path.join(backupDir, `rclone-${stamp}.conf`));
      }
      writeFileAtomic(rcloneConfigPath, content);
      await refreshRemotes();
      return remotes;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  async function oauthStep(session, state, result) {
    const values = ['scope', 'drive'];
    if (session.clientId) values.push('client_id', session.clientId);
    if (session.clientSecret) values.push('client_secret', session.clientSecret);
    const args = state
      ? ['config', 'update', session.name, ...values, '--continue', '--state', state, '--result', String(result ?? ''), '--non-interactive']
      : ['config', 'create', session.name, 'drive', ...values, '--all', '--non-interactive'];
    const question = parseConfigQuestion(await rclone(args));
    if (!question.State) {
      await rclone(['lsd', session.name + ':', '--max-depth', '1']);
      await refreshRemotes();
      oauthSessions.delete(session.id);
      return { done: true, remote: session.name + ':' };
    }
    return { done: false, state: question.State, option: question.Option, error: question.Error || '' };
  }

  function json(res, code, obj) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  }

  function proxyPublicDrive(req, res, fileId, resourceKey, target = null, redirects = 0) {
    if (redirects > 5) return json(res, 502, { error: 'Google Drive 重定向过多' });
    const upstreamUrl = target ? new URL(target) : new URL(publicDriveBaseUrl);
    if (!target) {
      upstreamUrl.searchParams.set('id', fileId);
      upstreamUrl.searchParams.set('export', 'download');
      upstreamUrl.searchParams.set('authuser', '0');
      upstreamUrl.searchParams.set('confirm', 't');
      if (resourceKey) upstreamUrl.searchParams.set('resourcekey', resourceKey);
    }
    const allowed = new Set([
      new URL(publicDriveBaseUrl).hostname,
      'drive.google.com',
      'drive.usercontent.google.com',
      'doc-0k-00-docstext.googleusercontent.com'
    ]);
    if (!allowed.has(upstreamUrl.hostname) && !upstreamUrl.hostname.endsWith('.googleusercontent.com')) {
      return json(res, 502, { error: 'Google Drive 返回了不安全的跳转地址' });
    }
    const client = upstreamUrl.protocol === 'http:' ? http : https;
    const upstream = client.request(upstreamUrl, {
      method: 'GET',
      headers: {
        ...(req.headers.range ? { Range: req.headers.range } : {}),
        'User-Agent': 'Mozilla/5.0 VideoChecker/1.0',
        Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.1'
      }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return proxyPublicDrive(req, res, fileId, resourceKey, new URL(response.headers.location, upstreamUrl).href, redirects + 1);
      }
      const contentType = String(response.headers['content-type'] || '');
      if (contentType.includes('text/html')) {
        log(`[public ${fileId.slice(0, 8)}] Google 返回 HTML，status=${response.statusCode}`);
        response.resume();
        return json(res, 403, { error: '视频不是公开可下载，或 Google 拒绝了该文件的直接播放' });
      }
      if ((response.statusCode || 500) >= 400) {
        log(`[public ${fileId.slice(0, 8)}] Google 返回 status=${response.statusCode}, type=${contentType || '未知'}`);
      }
      const headers = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
        if (response.headers[name] !== undefined) headers[name] = response.headers[name];
      }
      headers['accept-ranges'] = headers['accept-ranges'] || 'bytes';
      res.writeHead(response.statusCode || 502, headers);
      response.pipe(res);
    });
    upstream.on('error', error => {
      log(`[public ${fileId.slice(0, 8)}] 连接失败: ${error.message.slice(0, 160)}`);
      if (!res.headersSent) json(res, 502, { error: '连接 Google Drive 失败: ' + error.message.slice(0, 160) });
      else res.destroy(error);
    });
    req.on('close', () => upstream.destroy());
    upstream.end();
  }

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', data => {
        buf += data;
        if (buf.length > limit) req.destroy(new Error('请求过大'));
      });
      req.on('end', () => {
        try { resolve(buf ? JSON.parse(buf) : {}); }
        catch (error) { reject(error); }
      });
      req.on('error', reject);
    });
  }

  const cacheKey = (remote, relPath) => remote + ':' + relPath;
  const publicCacheKey = (fileId, resourceKey = '') => cacheKey('__public__', fileId + ':' + resourceKey);

  function cleanupLocal(remote, relPath) {
    const key = cacheKey(remote, relPath);
    const cached = ramVideoCache.get(key);
    if (cached) {
      ramCacheBytes -= cached.size;
      ramVideoCache.delete(key);
    }
    const legacyHash = crypto.createHash('md5').update(remote + ':' + relPath).digest('hex').slice(0, 16);
    const hash = crypto.createHash('md5').update(THUMB_PROFILE + ':' + remote + ':' + relPath).digest('hex').slice(0, 16);
    fs.rmSync(path.join(thumbsDir, legacyHash), { recursive: true, force: true });
    fs.rmSync(path.join(thumbsDir, hash), { recursive: true, force: true });
  }

  function evictRamCache(needed = 0) {
    const limit = ramLimits().cacheGb * GB;
    const entries = [...ramVideoCache.entries()].sort((a, b) => a[1].atime - b[1].atime);
    for (const [key, entry] of entries) {
      if (ramCacheBytes + needed <= limit) break;
      ramVideoCache.delete(key);
      ramCacheBytes -= entry.size;
    }
  }

  function warmCache(remote, relPath, size = 0) {
    const key = cacheKey(remote, relPath);
    const cached = ramVideoCache.get(key);
    if (cached) {
      cached.atime = Date.now();
      return Promise.resolve({ cached: true, size: cached.size });
    }
    if (prefetchJobs.has(key)) return prefetchJobs.get(key);
    const limits = ramLimits();
    const declaredSize = Number(size) || 0;
    if (declaredSize > limits.maxVideoGb * GB) {
      return Promise.resolve({ cached: false, reason: '超过单视频 RAM 上限' });
    }
    evictRamCache(declaredSize);
    const job = new Promise((resolve, reject) => {
      const proc = spawnRclone(['cat', remote + ':' + relPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      let bytes = 0;
      let stderr = '';
      const maxBytes = limits.maxVideoGb * GB;
      proc.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          proc.kill('SIGTERM');
          return;
        }
        chunks.push(chunk);
      });
      proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
      proc.on('error', reject);
      proc.on('exit', code => {
        if (bytes > maxBytes) return resolve({ cached: false, reason: '超过单视频 RAM 上限' });
        if (code !== 0) return reject(new Error(stderr || `rclone cat 失败 (${code})`));
        const buffer = Buffer.concat(chunks, bytes);
        evictRamCache(buffer.length);
        if (buffer.length > ramLimits().cacheGb * GB) return resolve({ cached: false, reason: '超过 RAM 总缓存上限' });
        ramVideoCache.set(key, { buffer, size: buffer.length, atime: Date.now() });
        ramCacheBytes += buffer.length;
        resolve({ cached: true, size: buffer.length });
      });
    }).finally(() => prefetchJobs.delete(key));
    prefetchJobs.set(key, job);
    return job;
  }

  function warmPublicCache(fileId, resourceKey = '') {
    const key = publicCacheKey(fileId, resourceKey);
    const cached = ramVideoCache.get(key);
    if (cached) {
      cached.atime = Date.now();
      return Promise.resolve({ cached: true, size: cached.size });
    }
    if (prefetchJobs.has(key)) return prefetchJobs.get(key);
    const limits = ramLimits();
    const maxBytes = limits.maxVideoGb * GB;
    const job = new Promise((resolve, reject) => {
      const suffix = resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : '';
      const request = http.get(`${expectedOrigin}/public-stream/${encodeURIComponent(fileId)}${suffix}`, {
        headers: authToken ? { 'X-Video-Checker-Token': authToken } : {}
      }, response => {
        const declaredSize = Number(response.headers['content-length']) || 0;
        if (response.statusCode >= 400) {
          let message = '';
          response.on('data', chunk => { message = (message + chunk).slice(-500); });
          response.on('end', () => reject(new Error(message || `公开视频下载失败 (${response.statusCode})`)));
          return;
        }
        if (declaredSize > maxBytes) {
          response.resume();
          resolve({ cached: false, reason: '超过单视频 RAM 上限' });
          return;
        }
        const chunks = [];
        let bytes = 0;
        let settled = false;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            settled = true;
            response.destroy();
            resolve({ cached: false, reason: '超过单视频 RAM 上限' });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const buffer = Buffer.concat(chunks, bytes);
          evictRamCache(buffer.length);
          if (buffer.length > ramLimits().cacheGb * GB) return resolve({ cached: false, reason: '超过 RAM 总缓存上限' });
          ramVideoCache.set(key, {
            buffer,
            size: buffer.length,
            atime: Date.now(),
            type: response.headers['content-type'] || 'video/mp4'
          });
          ramCacheBytes += buffer.length;
          resolve({ cached: true, size: buffer.length });
        });
        response.on('error', error => { if (!settled) reject(error); });
      });
      request.on('error', reject);
    }).finally(() => prefetchJobs.delete(key));
    prefetchJobs.set(key, job);
    return job;
  }

  function serveLocal(req, res, entry, relPath) {
    entry.atime = Date.now();
    const size = entry.size;
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const ext = path.extname(relPath).toLowerCase();
    const types = { '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
    const type = entry.type || types[ext] || 'video/' + (ext.slice(1) || 'mp4');
    if (match && (match[1] || match[2])) {
      const start = match[1] ? parseInt(match[1]) : size - parseInt(match[2]);
      const end = match[1] && match[2] ? Math.min(parseInt(match[2]), size - 1) : size - 1;
      if (start > end || start < 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1
      });
      res.end(entry.buffer.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    res.end(entry.buffer);
  }

  async function genThumbs(remote, relPath, size = 0) {
    const hash = crypto.createHash('md5').update(THUMB_PROFILE + ':' + remote + ':' + relPath).digest('hex').slice(0, 16);
    const dir = path.join(thumbsDir, hash);
    const finish = () => ({
      base: `/thumbs/${hash}/`,
      fps: THUMB_FPS,
      count: fs.readdirSync(dir).filter(file => file.endsWith('.jpg')).length
    });
    if (fs.existsSync(path.join(dir, 'done'))) return finish();
    if (thumbJobs.has(hash)) return thumbJobs.get(hash);

    const warmed = await warmCache(remote, relPath, size);
    if (!warmed.cached) throw new Error(warmed.reason || '视频未进入 RAM');
    if (fs.existsSync(path.join(dir, 'done'))) return finish();
    if (thumbJobs.has(hash)) return thumbJobs.get(hash);
    ensureDir(dir);
    const job = new Promise((resolve, reject) => {
      const args = ['-y'];
      if (authToken) args.push('-headers', `X-Video-Checker-Token: ${authToken}\r\n`);
      args.push(
        '-i', `${expectedOrigin}/stream/${encodeURIComponent(remote)}/${encSegs(relPath)}`,
        '-vf', `fps=${THUMB_FPS},scale=240:-2`,
        '-q:v', '6', path.join(dir, '%05d.jpg')
      );
      const proc = trackChild(spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
      let stderr = '';
      proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
      proc.on('exit', code => {
        if (code !== 0) return reject(new Error('缩略帧生成失败: ' + stderr.slice(-300)));
        fs.writeFileSync(path.join(dir, 'done'), '');
        resolve(finish());
      });
      proc.on('error', reject);
    }).finally(() => thumbJobs.delete(hash));
    thumbJobs.set(hash, job);
    return job;
  }

  async function genPublicThumbs(fileId, resourceKey = '') {
    const identity = fileId + ':' + resourceKey;
    const hash = crypto.createHash('md5').update(PUBLIC_THUMB_PROFILE + ':public:' + identity).digest('hex').slice(0, 16);
    const dir = path.join(thumbsDir, hash);
    const finish = () => ({
      base: `/thumbs/${hash}/`,
      fps: PUBLIC_THUMB_FPS,
      count: fs.readdirSync(dir).filter(file => file.endsWith('.jpg')).length
    });
    if (fs.existsSync(path.join(dir, 'done'))) return finish();
    if (thumbJobs.has(hash)) return thumbJobs.get(hash);
    const warmed = await warmPublicCache(fileId, resourceKey);
    if (!warmed.cached) throw new Error(warmed.reason || '视频未进入 RAM');
    if (fs.existsSync(path.join(dir, 'done'))) return finish();
    ensureDir(dir);
    const job = new Promise((resolve, reject) => {
      const suffix = resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : '';
      const args = ['-y'];
      if (authToken) args.push('-headers', `X-Video-Checker-Token: ${authToken}\r\n`);
      args.push(
        '-i', `${expectedOrigin}/public-stream/${encodeURIComponent(fileId)}${suffix}`,
        '-vf', `fps=${PUBLIC_THUMB_FPS},scale=240:-2`,
        '-q:v', '6', path.join(dir, '%05d.jpg')
      );
      const proc = trackChild(spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
      let stderr = '';
      proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
      proc.on('exit', code => {
        if (code !== 0) return reject(new Error('公开视频缩略帧生成失败: ' + stderr.slice(-300)));
        fs.writeFileSync(path.join(dir, 'done'), '');
        resolve(finish());
      });
      proc.on('error', reject);
    }).finally(() => thumbJobs.delete(hash));
    thumbJobs.set(hash, job);
    return job;
  }

  function authorized(req, res) {
    if (req.headers.host !== `${host}:${actualPort}`) {
      json(res, 400, { error: 'invalid host' });
      return false;
    }
    if (authToken && req.headers['x-video-checker-token'] !== authToken) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== expectedOrigin) {
      json(res, 403, { error: 'invalid origin' });
      return false;
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    if (!authorized(req, res)) return;
    const url = new URL(req.url, expectedOrigin || `http://${host}`);
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, app: 'video-checker', apiVersion: API_VERSION });
      }

      if (url.pathname.startsWith('/public-stream/') && req.method === 'GET') {
        const fileId = decodeURIComponent(url.pathname.slice('/public-stream/'.length));
        const resourceKey = url.searchParams.get('resourcekey') || '';
        if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) return json(res, 400, { error: '无效的 Google Drive 文件 ID' });
        if (resourceKey && !/^[A-Za-z0-9_-]{1,200}$/.test(resourceKey)) return json(res, 400, { error: '无效的 resource key' });
        const cached = ramVideoCache.get(publicCacheKey(fileId, resourceKey));
        if (cached) return serveLocal(req, res, cached, fileId + '.mp4');
        return proxyPublicDrive(req, res, fileId, resourceKey);
      }

      if (url.pathname === '/api/public/prefetch' && req.method === 'POST') {
        const body = await readBody(req);
        const fileId = String(body.fileId || '');
        const resourceKey = String(body.resourceKey || '');
        if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) return json(res, 400, { error: '无效的 Google Drive 文件 ID' });
        if (resourceKey && !/^[A-Za-z0-9_-]{1,200}$/.test(resourceKey)) return json(res, 400, { error: '无效的 resource key' });
        return json(res, 200, { ok: true, ...await warmPublicCache(fileId, resourceKey) });
      }

      if (url.pathname === '/api/public/thumbs' && req.method === 'POST') {
        const body = await readBody(req);
        const fileId = String(body.fileId || '');
        const resourceKey = String(body.resourceKey || '');
        if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) return json(res, 400, { error: '无效的 Google Drive 文件 ID' });
        if (resourceKey && !/^[A-Za-z0-9_-]{1,200}$/.test(resourceKey)) return json(res, 400, { error: '无效的 resource key' });
        return json(res, 200, await genPublicThumbs(fileId, resourceKey));
      }

      if (url.pathname === '/api/migration' && req.method === 'GET') {
        return json(res, 200, migrationInfo || { version: 0, copied: [], globalRcloneConfigAvailable: false });
      }

      if (url.pathname === '/api/settings' && req.method === 'GET') {
        return json(res, 200, readSettings());
      }

      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        const current = readSettings();
        const next = { ...current };
        if (typeof body.remote === 'string') next.remote = body.remote;
        if (['name', 'new', 'old'].includes(body.sortMode)) next.sortMode = body.sortMode;
        if (typeof body.subdir === 'string' && body.subdir.trim()) next.subdir = body.subdir.trim();
        if (body.ramCacheGb === 0 || (Number.isFinite(Number(body.ramCacheGb)) && Number(body.ramCacheGb) >= 1)) {
          next.ramCacheGb = Number(body.ramCacheGb);
        }
        if (body.ramMaxVideoGb === 0 || (Number.isFinite(Number(body.ramMaxVideoGb)) && Number(body.ramMaxVideoGb) >= 0.1)) {
          next.ramMaxVideoGb = Number(body.ramMaxVideoGb);
        }
        if ([0.5, 1, 2, 4, 8, 16].includes(Number(body.holdSeekRate))) next.holdSeekRate = Number(body.holdSeekRate);
        writeSettings(next);
        evictRamCache();
        return json(res, 200, next);
      }

      if (url.pathname === '/api/cache/status' && req.method === 'GET') {
        return json(res, 200, ramStatus());
      }

      if (url.pathname === '/api/folder-permissions' && req.method === 'GET') {
        const remote = url.searchParams.get('remote') || '';
        const fileId = url.searchParams.get('fileId') || '';
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) return json(res, 400, { error: '无效的 Drive 文件夹 ID' });
        await ensureRemote(remote);
        const access = await folderPermissions(remote, fileId);
        return json(res, 200, { file: access.file, permissions: access.permissions });
      }

      if (url.pathname === '/api/folder-permissions' && req.method === 'POST') {
        const body = await readBody(req);
        const remote = typeof body.remote === 'string' ? body.remote : '';
        const fileId = typeof body.fileId === 'string' ? body.fileId : '';
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) return json(res, 400, { error: '无效的 Drive 文件夹 ID' });
        await ensureRemote(remote);
        try {
          const result = await serializePermissionChange(fileId, async () => {
            const access = await folderPermissions(remote, fileId);
            if (!access.file.capabilities?.canShare) throw Object.assign(new Error('当前账号无权修改这个文件夹的共享设置'), { status: 403 });
            const permissionUrl = id => driveApiUrl(`/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(id)}`, { supportsAllDrives: 'true' });
            const createUrl = params => driveApiUrl(`/files/${encodeURIComponent(fileId)}/permissions`, { supportsAllDrives: 'true', ...params });
            const modifiable = permission => permission && !permission.inherited && !['owner', 'organizer', 'fileOrganizer'].includes(permission.role);

            if (body.action === 'set-link') {
              if (![null, 'reader', 'writer'].includes(body.role ?? null)) throw Object.assign(new Error('无效的链接权限'), { status: 400 });
              const anyone = access.permissions.find(permission => permission.type === 'anyone');
              if (body.role === null) {
                if (anyone) {
                  if (!modifiable(anyone)) throw Object.assign(new Error('该公开权限继承自父目录，请在权限来源处修改'), { status: 409 });
                  await requestJson(permissionUrl(anyone.id), { method: 'DELETE', token: access.token });
                }
              } else if (anyone && modifiable(anyone)) {
                await requestJson(permissionUrl(anyone.id), { method: 'PATCH', token: access.token, body: { role: body.role } });
              } else {
                await requestJson(createUrl({}), { method: 'POST', token: access.token, body: { type: 'anyone', role: body.role, allowFileDiscovery: false } });
              }
            } else if (body.action === 'add-user') {
              const email = typeof body.email === 'string' ? body.email.trim() : '';
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw Object.assign(new Error('请输入有效的邮箱地址'), { status: 400 });
              if (!['reader', 'commenter', 'writer'].includes(body.role)) throw Object.assign(new Error('无效的用户权限'), { status: 400 });
              await requestJson(createUrl({ sendNotificationEmail: 'true' }), {
                method: 'POST', token: access.token, body: { type: 'user', role: body.role, emailAddress: email }
              });
            } else if (body.action === 'update') {
              const permission = access.permissions.find(item => item.id === body.permissionId);
              if (!modifiable(permission)) throw Object.assign(new Error('该权限是继承权限或管理员权限，不能在此修改'), { status: 409 });
              if (!['reader', 'commenter', 'writer'].includes(body.role)) throw Object.assign(new Error('无效的用户权限'), { status: 400 });
              await requestJson(permissionUrl(permission.id), { method: 'PATCH', token: access.token, body: { role: body.role } });
            } else if (body.action === 'delete') {
              const permission = access.permissions.find(item => item.id === body.permissionId);
              if (!modifiable(permission)) throw Object.assign(new Error('该权限是继承权限或管理员权限，不能在此移除'), { status: 409 });
              await requestJson(permissionUrl(permission.id), { method: 'DELETE', token: access.token });
            } else {
              throw Object.assign(new Error('无效的权限操作'), { status: 400 });
            }
            return folderPermissions(remote, fileId);
          });
          return json(res, 200, result ? { file: result.file, permissions: result.permissions } : { ok: true });
        } catch (error) {
          return json(res, [400, 403, 409].includes(error.status) ? error.status : 502, { error: error.message.slice(0, 400) });
        }
      }

      if (url.pathname === '/api/list' && req.method === 'GET') {
        const remote = url.searchParams.get('remote') || '';
        const relPath = safePath(url.searchParams.get('path') || '');
        if (relPath === null) return json(res, 400, { error: '非法路径' });
        await ensureRemote(remote);
        const startedAt = Date.now();
        const result = await listDirectory(remote, relPath);
        return json(res, 200, { path: relPath, ...result, loadMs: Date.now() - startedAt });
      }

      if (url.pathname === '/api/move' && req.method === 'POST') {
        const body = await readBody(req);
        const from = safePath(body.from), to = safePath(body.to);
        if (!from || !to) return json(res, 400, { error: '非法路径' });
        await ensureRemote(body.remote);
        if (body.isDir) {
          const sourceName = path.posix.basename(from);
          const destinationParent = path.posix.dirname(to) === '.' ? '' : path.posix.dirname(to);
          if (path.posix.basename(to) !== sourceName) return json(res, 400, { error: '移动文件夹时不能改名' });
          if (to === from || to.startsWith(from + '/')) return json(res, 400, { error: '不能移入文件夹自身或它的子目录' });
          const destination = JSON.parse(await rclone(['lsjson', body.remote + ':' + destinationParent]));
          if (destination.some(entry => entry.Name === sourceName)) {
            return json(res, 409, { error: `目标位置已有「${sourceName}」` });
          }
        }
        await rclone(['moveto', body.remote + ':' + from, body.remote + ':' + to]);
        if (body.isDir) moveMarksWithFolder(body.remote, from, to);
        invalidateListCache(body.remote);
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/rename' && req.method === 'POST') {
        const body = await readBody(req);
        const from = safePath(body.from), to = safePath(body.to);
        if (!from || !to) return json(res, 400, { error: '非法路径' });
        await ensureRemote(body.remote);
        await rclone(['moveto', body.remote + ':' + from, body.remote + ':' + to]);
        invalidateListCache(body.remote);
        cleanupLocal(body.remote, from);
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const relPath = safePath(body.path);
        if (!relPath) return json(res, 400, { error: '非法路径' });
        await ensureRemote(body.remote);
        await rclone([body.isDir ? 'purge' : 'deletefile', body.remote + ':' + relPath]);
        invalidateListCache(body.remote);
        cleanupLocal(body.remote, relPath);
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/upload/progress' && req.method === 'GET') {
        return json(res, 200, { pct: uploadProgress.get(url.searchParams.get('id') || '') ?? 0 });
      }

      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const remote = url.searchParams.get('remote') || '';
        const relPath = safePath(url.searchParams.get('path') || '');
        const id = url.searchParams.get('id') || '';
        if (!relPath) return json(res, 400, { error: '非法路径' });
        await ensureRemote(remote);
        const tmp = path.join(uploadsDir, 'vc-upload-' + crypto.randomBytes(8).toString('hex') + path.extname(relPath).slice(0, 10));
        await new Promise((resolve, reject) => {
          const stream = fs.createWriteStream(tmp, { mode: 0o600 });
          req.pipe(stream);
          req.on('error', reject);
          stream.on('error', reject);
          stream.on('finish', resolve);
        });
        try {
          await new Promise((resolve, reject) => {
            const proc = spawnRclone(['copyto', tmp, remote + ':' + relPath, '--stats', '400ms', '--stats-one-line', '-v'], {
              stdio: ['ignore', 'ignore', 'pipe']
            });
            let lastError = '';
            proc.stderr.on('data', data => {
              const text = data.toString();
              const match = /(\d+)%/.exec(text);
              if (match && id) uploadProgress.set(id, +match[1]);
              lastError = text;
            });
            proc.on('error', reject);
            proc.on('exit', code => code === 0 ? resolve() : reject(new Error('上传失败: ' + lastError.slice(-200))));
          });
        } finally {
          fs.rmSync(tmp, { force: true });
          if (id) uploadProgress.delete(id);
        }
        invalidateListCache(remote);
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/link' && req.method === 'GET') {
        const remote = url.searchParams.get('remote') || '';
        const relPath = safePath(url.searchParams.get('path') || '');
        if (!relPath) return json(res, 400, { error: '根目录没有单独链接，请进入具体文件夹' });
        await ensureRemote(remote);
        const cut = relPath.lastIndexOf('/');
        const parent = cut < 0 ? '' : relPath.slice(0, cut);
        const name = cut < 0 ? relPath : relPath.slice(cut + 1);
        const out = await rclone(['lsjson', remote + ':' + parent, '--dirs-only']);
        const entry = JSON.parse(out).find(item => item.Name === name);
        if (!entry || !entry.ID) return json(res, 500, { error: '拿不到文件夹 ID' });
        return json(res, 200, { url: 'https://drive.google.com/drive/folders/' + entry.ID });
      }

      if (url.pathname === '/api/marks' && req.method === 'GET') {
        return json(res, 200, readMarks());
      }

      if (url.pathname === '/api/marks' && req.method === 'POST') {
        const body = await readBody(req);
        const marks = readMarks();
        if (body.status === null) delete marks[body.key];
        else marks[body.key] = { status: body.status, time: new Date().toISOString() };
        writeMarks(marks);
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/remotes' && req.method === 'GET') {
        const names = await refreshRemotes();
        return json(res, 200, { remotes: names.map(name => name + ':') });
      }

      if (url.pathname === '/api/remotes/import-config' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const remotes = await importRcloneConfig(body.content);
          return json(res, 200, { ok: true, remotes });
        } catch (error) {
          return json(res, 400, { error: '导入 rclone.conf 失败: ' + error.message.slice(0, 300) });
        }
      }

      if (url.pathname === '/api/remotes/oauth/start' && req.method === 'POST') {
        const body = await readBody(req);
        const name = (body.name || '').trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return json(res, 400, { error: '名称只能用字母数字-_（32字内）' });
        await refreshRemotes();
        if (knownRemotes.has(name)) return json(res, 409, { error: '该账号名称已存在' });
        const session = {
          id: crypto.randomBytes(16).toString('hex'),
          name,
          clientId: typeof body.clientId === 'string' ? body.clientId.trim() : '',
          clientSecret: typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '',
          state: ''
        };
        oauthSessions.set(session.id, session);
        try {
          const result = await oauthStep(session, '', '');
          if (!result.done) session.state = result.state;
          return json(res, 200, { sessionId: session.id, ...result });
        } catch (error) {
          oauthSessions.delete(session.id);
          await rclone(['config', 'delete', name]).catch(() => {});
          return json(res, 400, { error: 'OAuth 配置失败: ' + error.message.slice(0, 300) });
        }
      }

      if (url.pathname === '/api/remotes/oauth/continue' && req.method === 'POST') {
        const body = await readBody(req);
        const session = oauthSessions.get(body.sessionId);
        if (!session) return json(res, 404, { error: 'OAuth 会话已失效，请重新开始' });
        if (body.state !== session.state) return json(res, 409, { error: 'OAuth 配置状态已变化，请刷新后重试' });
        try {
          const result = await oauthStep(session, body.state, body.result);
          if (!result.done) session.state = result.state;
          return json(res, 200, { sessionId: session.id, ...result });
        } catch (error) {
          oauthSessions.delete(session.id);
          await rclone(['config', 'delete', session.name]).catch(() => {});
          return json(res, 400, { error: 'OAuth 授权失败: ' + error.message.slice(0, 300) });
        }
      }

      if (url.pathname === '/api/remotes/oauth/cancel' && req.method === 'POST') {
        const body = await readBody(req);
        const session = oauthSessions.get(body.sessionId);
        if (session) {
          oauthSessions.delete(session.id);
          await rclone(['config', 'delete', session.name]).catch(() => {});
        }
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/remotes/import' && req.method === 'POST') {
        const body = await readBody(req);
        const name = (body.name || '').trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return json(res, 400, { error: '名称只能用字母数字-_（32字内）' });
        let key;
        try { key = JSON.parse(body.json); }
        catch { return json(res, 400, { error: '不是有效的 JSON 文件' }); }
        if (key.type !== 'service_account') {
          return json(res, 400, {
            error: key.installed || key.web
              ? '这是 OAuth 客户端凭据，请使用“Google OAuth”入口授权'
              : '无法识别的 JSON 类型，需要服务账号密钥'
          });
        }
        await refreshRemotes();
        if (knownRemotes.has(name)) return json(res, 409, { error: '该账号名称已存在' });
        const keyFile = path.join(keysDir, name + '.json');
        try {
          fs.writeFileSync(keyFile, body.json, { mode: 0o600 });
          await rclone(['config', 'create', name, 'drive', 'service_account_file', keyFile, 'scope', 'drive']);
          await rclone(['lsd', name + ':', '--max-depth', '1']);
        } catch (error) {
          await rclone(['config', 'delete', name]).catch(() => {});
          fs.rmSync(keyFile, { force: true });
          return json(res, 400, { error: '密钥无法访问 Drive: ' + error.message.slice(0, 200) });
        }
        if (rcloneConfigPath && fs.existsSync(rcloneConfigPath)) fs.chmodSync(rcloneConfigPath, 0o600);
        await refreshRemotes();
        return json(res, 200, { ok: true, remote: name + ':', email: key.client_email });
      }

      if (url.pathname === '/api/prefetch' && req.method === 'POST') {
        const body = await readBody(req);
        const relPath = safePath(body.path);
        if (!relPath) return json(res, 400, { error: '非法路径' });
        await ensureRemote(body.remote);
        return json(res, 200, { ok: true, ...await warmCache(body.remote, relPath, body.size) });
      }

      if (url.pathname === '/api/thumbs' && req.method === 'POST') {
        const body = await readBody(req);
        const relPath = safePath(body.path);
        if (!relPath) return json(res, 400, { error: '非法路径' });
        await ensureRemote(body.remote);
        return json(res, 200, await genThumbs(body.remote, relPath, body.size));
      }

      if (url.pathname.startsWith('/thumbs/') && req.method === 'GET') {
        const full = resolveInside(thumbsDir, decodeURIComponent(url.pathname.slice('/thumbs/'.length)));
        if (full && fs.existsSync(full) && fs.statSync(full).isFile()) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
          fs.createReadStream(full).pipe(res);
          return;
        }
        return json(res, 404, { error: 'not found' });
      }

      if (url.pathname.startsWith('/stream/') && req.method === 'GET') {
        const rest = url.pathname.slice('/stream/'.length);
        const slash = rest.indexOf('/');
        if (slash < 1) return json(res, 400, { error: '缺少账号段' });
        const remote = decodeURIComponent(rest.slice(0, slash));
        const relPath = decodeURIComponent(rest.slice(slash + 1));
        const local = ramVideoCache.get(cacheKey(remote, relPath));
        if (local) return serveLocal(req, res, local, relPath);
        const serve = await getServe(remote);
        const upstream = http.request({
          host,
          port: serve.port,
          path: rest.slice(slash),
          headers: {
            ...(req.headers.range ? { range: req.headers.range } : {}),
            Authorization: serve.authHeader
          }
        }, response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => {
          if (!res.headersSent) json(res, 502, { error: '视频流通道不可用' });
        });
        req.on('close', () => upstream.destroy());
        upstream.end();
        return;
      }

      if (req.method === 'GET') {
        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const full = resolveInside(publicDir, relative);
        if (full && fs.existsSync(full) && fs.statSync(full).isFile()) {
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          fs.createReadStream(full).pipe(res);
          return;
        }
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      log(error.stack || error.message);
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  actualPort = server.address().port;
  expectedOrigin = `http://${host}:${actualPort}`;
  await refreshRemotes().catch(error => log('读取 rclone 账号失败: ' + error.message));
  log(`视频检查器: ${expectedOrigin}`);

  async function close() {
    if (closing) return;
    closing = true;
    for (const state of serves.values()) {
      if (state.restartTimer) clearTimeout(state.restartTimer);
      if (state.proc && !state.proc.killed) state.proc.kill('SIGTERM');
      if (state.htpasswd) fs.rmSync(state.htpasswd, { force: true });
    }
    for (const proc of children) {
      if (!proc.killed) proc.kill('SIGTERM');
    }
    await new Promise(resolve => server.close(() => resolve()));
  }

  return {
    host,
    port: actualPort,
    url: expectedOrigin,
    close,
    refreshRemotes,
    openExternal
  };
}

async function runStandalone() {
  const handle = await createVideoCheckerServer();
  console.log(`视频检查器: ${handle.url}`);
  const stop = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  runStandalone().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  createVideoCheckerServer,
  safePath,
  resolveInside,
  writeJsonAtomic
};
