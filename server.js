#!/usr/bin/env node
// 谷歌云盘视频检查器 — 本地服务
// 依赖: 已配置好的 rclone；可选 ffmpeg(进度条帧预览)。无 npm 依赖
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = 5572;            // 本服务(UI + API)
const STREAM_PORT_BASE = 5573; // 每个账号一条 rclone serve 通道，从这里递增
const MARKS_FILE = path.join(__dirname, 'marks.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const THUMBS_DIR = path.join(os.tmpdir(), 'video-checker-thumbs');
const CACHE_DIR = path.join(os.tmpdir(), 'video-checker-cache'); // 预热缓存(文件名用哈希，避开超长文件名)
const CACHE_MAX = 20 * 1024 ** 3;
const KEYS_DIR = path.join(__dirname, 'keys'); // 导入的服务账号密钥
const THUMB_FPS = 5;

fs.rmSync(THUMBS_DIR, { recursive: true, force: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });
fs.rmSync(CACHE_DIR, { recursive: true, force: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- 工具 ----------
function rclone(args) {
  return new Promise((resolve, reject) => {
    execFile('rclone', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

// 路径校验: 相对 remote 的路径，禁止 .. 与空段
function safePath(p) {
  if (typeof p !== 'string') return null;
  const clean = p.replace(/^\/+|\/+$/g, '');
  if (clean.split('/').some(seg => seg === '..' || seg === '')) return clean === '' ? '' : null;
  return clean;
}

const encSegs = p => p.split('/').map(encodeURIComponent).join('/');

// ---------- rclone serve 通道管理: 每账号一条，按需启动 ----------
let knownRemotes = new Set(); // 不含冒号的 remote 名
let nextPort = STREAM_PORT_BASE;
const serves = new Map();     // remoteName -> {port, proc, restarts, ready}

async function refreshRemotes() {
  const out = await rclone(['listremotes']);
  const names = out.trim().split('\n').filter(Boolean).map(r => r.replace(/:$/, ''));
  knownRemotes = new Set(names);
  return names;
}

async function ensureRemote(name) {
  // 支持连接串变体：
  // - "gdrive,shared_with_me"(与我共享视图)
  // - "gdrive,root_folder_id=<驱动器ID>"(把某个"任何人可查看/编辑"的共享文件夹/云端硬盘当根目录浏览——用于"粘贴链接"功能)
  // 校验逗号前的基础账号名
  const base = name.split(',')[0];
  if (!knownRemotes.has(base)) await refreshRemotes();
  if (!knownRemotes.has(base)) throw new Error('未知账号: ' + base);
  if (!/^[A-Za-z0-9_-]+(,shared_with_me|,root_folder_id=[A-Za-z0-9_-]{10,100})?$/.test(name)) throw new Error('非法账号参数: ' + name);
}

function spawnServe(remote, s) {
  s.proc = spawn('rclone', [
    'serve', 'http', remote + ':',
    '--addr', `127.0.0.1:${s.port}`,
    '--read-only',
    // 不用 vfs 磁盘缓存: 它按原文件名落盘，超长文件名(>255字节)会直接打不开
    '--vfs-read-chunk-size', '16M',
    '--vfs-read-chunk-size-limit', '256M',
    '--buffer-size', '32M',
    '--dir-cache-time', '15s',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  s.proc.stderr.on('data', d => process.stderr.write(`[serve ${remote}] ${d}`));
  s.proc.on('exit', code => {
    console.error(`[serve ${remote}] 退出 (code=${code})`);
    s.ready = null;
    const now = Date.now();
    s.restarts = s.restarts.filter(t => now - t < 60000);
    if (s.restarts.length >= 5) {
      console.error(`[serve ${remote}] 一分钟内反复退出，停用该账号通道`);
      serves.delete(remote);
      return;
    }
    s.restarts.push(now);
    setTimeout(() => spawnServe(remote, s), 1000);
  });
}

function waitReady(s) {
  if (s.ready) return s.ready;
  s.ready = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const probe = () => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/' }, r => { r.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - t0 > 10000) reject(new Error('视频流通道启动超时'));
          else setTimeout(probe, 300);
        });
    };
    probe();
  });
  return s.ready;
}

async function getServe(remote) {
  await ensureRemote(remote);
  let s = serves.get(remote);
  if (!s) {
    s = { port: nextPort++, proc: null, restarts: [], ready: null };
    serves.set(remote, s);
    spawnServe(remote, s);
  }
  await waitReady(s);
  return s;
}

process.on('exit', () => { for (const s of serves.values()) s.proc && s.proc.kill(); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// ---------- 标记 ----------
function readMarks() {
  try { return JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8')); } catch { return {}; }
}
function writeMarks(marks) {
  fs.writeFileSync(MARKS_FILE, JSON.stringify(marks, null, 2));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------- 文件夹预热: rclone copyto 下载到本地缓存(哈希文件名) ----------
const prefetchJobs = new Map();
const uploadProgress = new Map(); // uploadId -> 百分比(0-100)，供 /api/upload/progress 轮询

function cacheFile(remote, relPath) {
  const hash = crypto.createHash('md5').update(remote + ':' + relPath).digest('hex');
  return path.join(CACHE_DIR, hash + path.extname(relPath).slice(0, 10));
}

// 删除/改名后作废该文件的本地预热缓存与缩略帧(哈希名与 remote+path 绑定)
function cleanupLocal(remote, relPath) {
  fs.rmSync(cacheFile(remote, relPath), { force: true });
  const thumbHash = crypto.createHash('md5').update(remote + ':' + relPath).digest('hex').slice(0, 16);
  fs.rmSync(path.join(THUMBS_DIR, thumbHash), { recursive: true, force: true });
}

function evictCache(needed) {
  const files = fs.readdirSync(CACHE_DIR).map(f => {
    const full = path.join(CACHE_DIR, f);
    const st = fs.statSync(full);
    return { full, size: st.size, atime: st.atimeMs };
  });
  let total = files.reduce((s, f) => s + f.size, 0);
  files.sort((a, b) => a.atime - b.atime); // 最久未用的先删
  for (const f of files) {
    if (total + needed <= CACHE_MAX) break;
    fs.rmSync(f.full, { force: true });
    total -= f.size;
  }
}

function warmCache(remote, relPath, size) {
  const dst = cacheFile(remote, relPath);
  if (fs.existsSync(dst)) return Promise.resolve();
  if (prefetchJobs.has(dst)) return prefetchJobs.get(dst);
  evictCache(size || 0);
  const job = new Promise((resolve, reject) => {
    const tmp = dst + '.part';
    execFile('rclone', ['copyto', remote + ':' + relPath, tmp], { maxBuffer: 1024 * 1024 }, err => {
      if (err) { fs.rmSync(tmp, { force: true }); return reject(new Error(err.message.slice(0, 200))); }
      fs.renameSync(tmp, dst);
      resolve();
    });
  }).finally(() => prefetchJobs.delete(dst));
  prefetchJobs.set(dst, job);
  return job;
}

// 本地缓存文件按 Range 回源
function serveLocal(req, res, file) {
  const size = fs.statSync(file).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const type = 'video/' + (path.extname(file).slice(1) || 'mp4');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1]) : size - parseInt(m[2]);
    const end = m[1] && m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
    if (start > end || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}

// ---------- 缩略帧生成 ----------
const thumbJobs = new Map(); // hash -> Promise，去重并发请求

async function genThumbs(remote, relPath) {
  const hash = crypto.createHash('md5').update(remote + ':' + relPath).digest('hex').slice(0, 16);
  const dir = path.join(THUMBS_DIR, hash);
  const finish = () => {
    const count = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
    return { base: `/thumbs/${hash}/`, fps: THUMB_FPS, count };
  };
  if (fs.existsSync(path.join(dir, 'done'))) return finish();
  if (thumbJobs.has(hash)) return thumbJobs.get(hash);

  let srcUrl = cacheFile(remote, relPath); // 优先本地缓存
  if (!fs.existsSync(srcUrl)) {
    const s = await getServe(remote);
    srcUrl = `http://127.0.0.1:${s.port}/` + encSegs(relPath);
  }
  fs.mkdirSync(dir, { recursive: true });
  const job = new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', srcUrl,
      '-vf', `fps=${THUMB_FPS},scale=360:-2`,
      '-q:v', '6', path.join(dir, '%05d.jpg'),
    ], { maxBuffer: 16 * 1024 * 1024 }, err => {
      if (err) return reject(new Error('缩略帧生成失败: ' + err.message.slice(0, 200)));
      fs.writeFileSync(path.join(dir, 'done'), '');
      resolve(finish());
    });
  }).finally(() => thumbJobs.delete(hash));
  thumbJobs.set(hash, job);
  return job;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/list' && req.method === 'GET') {
      const remote = url.searchParams.get('remote') || '';
      const p = safePath(url.searchParams.get('path') || '');
      if (p === null) return json(res, 400, { error: '非法路径' });
      await ensureRemote(remote);
      const out = await rclone(['lsjson', remote + ':' + p, '--fast-list']);
      return json(res, 200, { path: p, entries: JSON.parse(out) });
    }

    if (url.pathname === '/api/move' && req.method === 'POST') {
      const body = await readBody(req);
      const from = safePath(body.from), to = safePath(body.to);
      if (!from || !to) return json(res, 400, { error: '非法路径' });
      await ensureRemote(body.remote);
      await rclone(['moveto', body.remote + ':' + from, body.remote + ':' + to]);
      return json(res, 200, { ok: true });
    }

    // 重命名文件或文件夹: moveto 在 Drive 上对二者都是服务端改名(改 name，不搬内容、不换 ID)
    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const body = await readBody(req);
      const from = safePath(body.from), to = safePath(body.to);
      if (!from || !to) return json(res, 400, { error: '非法路径' });
      await ensureRemote(body.remote);
      await rclone(['moveto', body.remote + ':' + from, body.remote + ':' + to]);
      cleanupLocal(body.remote, from); // 旧路径的本地缓存/缩略帧作废
      return json(res, 200, { ok: true });
    }

    // 删除: 文件用 deletefile，文件夹用 purge(连内容一起删)。Drive 默认 use_trash=true，均进回收站可恢复
    if (url.pathname === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const p = safePath(body.path);
      if (!p) return json(res, 400, { error: '非法路径' });
      await ensureRemote(body.remote);
      await rclone([body.isDir ? 'purge' : 'deletefile', body.remote + ':' + p]);
      cleanupLocal(body.remote, p);
      return json(res, 200, { ok: true });
    }

    // 上传进度查询: copyto 到 Drive 的百分比(客户端轮询)
    if (url.pathname === '/api/upload/progress' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      return json(res, 200, { pct: uploadProgress.get(id) ?? 0 });
    }

    // 上传视频: 裸字节流落临时文件 → copyto 到 remote:path(避免引入 multipart 依赖)
    // 用 spawn 流式读 copyto 的 stderr 统计行，解析 % 写入 uploadProgress 供前端轮询
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const remote = url.searchParams.get('remote') || '';
      const p = safePath(url.searchParams.get('path') || '');
      const id = url.searchParams.get('id') || '';
      if (!p) return json(res, 400, { error: '非法路径' });
      await ensureRemote(remote);
      const tmp = path.join(os.tmpdir(), 'vc-upload-' + crypto.randomBytes(8).toString('hex') + path.extname(p).slice(0, 10));
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        req.pipe(ws);
        req.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
      });
      try {
        await new Promise((resolve, reject) => {
          const proc = spawn('rclone', ['copyto', tmp, remote + ':' + p, '--stats', '400ms', '--stats-one-line', '-v']);
          let err = '';
          proc.stderr.on('data', d => {
            const s = d.toString();
            const m = /(\d+)%/.exec(s);
            if (m && id) uploadProgress.set(id, +m[1]);
            err = s; // 留最后一段做出错提示
          });
          proc.on('error', reject);
          proc.on('exit', code => code === 0 ? resolve() : reject(new Error('上传失败: ' + err.slice(-200))));
        });
      } finally {
        fs.rmSync(tmp, { force: true });
        if (id) uploadProgress.delete(id);
      }
      return json(res, 200, { ok: true });
    }

    // 当前文件夹的 Google Drive 网页链接
    if (url.pathname === '/api/link' && req.method === 'GET') {
      const remote = url.searchParams.get('remote') || '';
      const p = safePath(url.searchParams.get('path') || '');
      if (!p) return json(res, 400, { error: '根目录没有单独链接，请进入具体文件夹' });
      await ensureRemote(remote);
      // lsjson --stat 不返回 Drive ID，改从父目录列表里按名字取
      const cut = p.lastIndexOf('/');
      const parent = cut < 0 ? '' : p.slice(0, cut);
      const name = cut < 0 ? p : p.slice(cut + 1);
      const out = await rclone(['lsjson', remote + ':' + parent, '--dirs-only']);
      const entry = JSON.parse(out).find(e => e.Name === name);
      if (!entry || !entry.ID) return json(res, 500, { error: '拿不到文件夹 ID' });
      return json(res, 200, { url: 'https://drive.google.com/drive/folders/' + entry.ID });
    }

    if (url.pathname === '/api/marks' && req.method === 'GET') {
      return json(res, 200, readMarks());
    }

    if (url.pathname === '/api/marks' && req.method === 'POST') {
      const body = await readBody(req); // { key, status } status: 'ok'|'bad'|null(清除)
      const marks = readMarks();
      if (body.status === null) delete marks[body.key];
      else marks[body.key] = { status: body.status, time: new Date().toISOString() };
      writeMarks(marks);
      return json(res, 200, { ok: true });
    }

    // 账号(rclone remote)管理
    if (url.pathname === '/api/remotes' && req.method === 'GET') {
      const names = await refreshRemotes();
      return json(res, 200, { remotes: names.map(n => n + ':') });
    }

    if (url.pathname === '/api/remotes/import' && req.method === 'POST') {
      // { name, json } — 目前支持服务账号密钥；OAuth 客户端凭据需终端授权
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return json(res, 400, { error: '名称只能用字母数字-_（32字内）' });
      let key;
      try { key = JSON.parse(body.json); } catch { return json(res, 400, { error: '不是有效的 JSON 文件' }); }
      if (key.type !== 'service_account') {
        return json(res, 400, {
          error: key.installed || key.web
            ? '这是 OAuth 客户端凭据，需要浏览器授权，请在终端运行: rclone config（新建 drive remote 时填入 client_id/client_secret）'
            : '无法识别的 JSON 类型，需要服务账号密钥(含 "type": "service_account")',
        });
      }
      fs.mkdirSync(KEYS_DIR, { recursive: true });
      const keyFile = path.join(KEYS_DIR, name + '.json');
      fs.writeFileSync(keyFile, body.json, { mode: 0o600 });
      await rclone(['config', 'create', name, 'drive', 'service_account_file', keyFile, 'scope', 'drive']);
      // 验证密钥真的能用，不能用就回滚
      try { await rclone(['lsd', name + ':', '--max-depth', '1']); }
      catch (e) {
        await rclone(['config', 'delete', name]).catch(() => {});
        fs.rmSync(keyFile, { force: true });
        return json(res, 400, { error: '密钥无法访问 Drive（是否有效？）: ' + e.message.slice(0, 200) });
      }
      await refreshRemotes();
      return json(res, 200, { ok: true, remote: name + ':', email: key.client_email });
    }

    // 预热单个文件(客户端按列表顺序逐个调用)
    if (url.pathname === '/api/prefetch' && req.method === 'POST') {
      const body = await readBody(req);
      const p = safePath(body.path);
      if (!p) return json(res, 400, { error: '非法路径' });
      await warmCache(body.remote, p, body.size);
      await genThumbs(body.remote, p).catch(() => {}); // 无 ffmpeg 时预热依然有效
      return json(res, 200, { ok: true });
    }

    // 缩略帧序列: ffmpeg 按 THUMB_FPS 抽帧，供进度条拖动即时预览
    if (url.pathname === '/api/thumbs' && req.method === 'POST') {
      const body = await readBody(req);
      const p = safePath(body.path);
      if (!p) return json(res, 400, { error: '非法路径' });
      const result = await genThumbs(body.remote, p);
      return json(res, 200, result);
    }

    if (url.pathname.startsWith('/thumbs/') && req.method === 'GET') {
      const full = path.join(THUMBS_DIR, decodeURIComponent(url.pathname.slice('/thumbs/'.length)));
      if (full.startsWith(THUMBS_DIR) && fs.existsSync(full)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
        return fs.createReadStream(full).pipe(res);
      }
      return json(res, 404, { error: 'not found' });
    }

    // 视频流: 优先本地预热缓存(哈希名，Range 回源)，没有则代理该账号的 rclone serve
    if (url.pathname.startsWith('/stream/') && req.method === 'GET') {
      const rest = url.pathname.slice('/stream/'.length);
      const slash = rest.indexOf('/');
      if (slash < 1) return json(res, 400, { error: '缺少账号段' });
      const remote = decodeURIComponent(rest.slice(0, slash));
      const local = cacheFile(remote, decodeURIComponent(rest.slice(slash + 1)));
      if (fs.existsSync(local)) return serveLocal(req, res, local);
      const s = await getServe(remote);
      const upstream = http.request({
        host: '127.0.0.1', port: s.port,
        path: rest.slice(slash),
        headers: req.headers.range ? { range: req.headers.range } : {},
      }, up => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: '视频流通道不可用' }); });
      req.on('close', () => upstream.destroy());
      return upstream.end();
    }

    // 静态文件
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(PUBLIC_DIR, file);
      if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        return fs.createReadStream(full).pipe(res);
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`视频检查器: http://127.0.0.1:${PORT}`);
  refreshRemotes().catch(e => console.error('读取 rclone 账号失败:', e.message));
});
