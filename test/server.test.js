'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createVideoCheckerServer, parseMediaInfo, bitDepthOf, snapFps, playableInChromium, sanitizeFlags } = require('../server');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-checker-test-'));
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>test</title>');
  const tool = path.join(root, 'fake-tool');
  fs.writeFileSync(tool, `#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');
const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
const config = configIndex >= 0 ? args[configIndex + 1] : '';
const command = configIndex >= 0 ? args.slice(configIndex + 2) : args;
if (command.includes('-vf')) {
  const input = command[command.indexOf('-i') + 1];
  const output = command[command.length - 1].replace('%05d', '00001');
  const headerIndex = command.indexOf('-headers');
  const headerText = headerIndex >= 0 ? command[headerIndex + 1] : '';
  const token = /X-Video-Checker-Token:\\s*([^\\r\\n]+)/i.exec(headerText)?.[1] || '';
  http.get(input, { headers: { 'X-Video-Checker-Token': token, Range: 'bytes=0-3' } }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      if (response.statusCode !== 206 || Buffer.concat(chunks).toString() !== 'cach') process.exit(2);
      fs.writeFileSync(output, 'fake-jpeg');
    });
  }).on('error', () => process.exit(3));
} else if (command.includes('-hide_banner')) {
  // 只给 -i 的探测：把真实 ffmpeg 的输出格式打到 stderr，并以 1 退出
  process.stderr.write([
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x':",
    '  Duration: 00:00:04.00, start: 0.000000, bitrate: 29550 kb/s',
    '  Stream #0:0[0x1]: Video: hevc (Main 10), yuv420p10le(tv, bt709/bt709/bt709, progressive), 1920x1080, 29550 kb/s, 23.98 fps, 23.98 tbr, 12800 tbn',
    'At least one output file must be specified'
  ].join('\\n'));
  process.exit(1);
} else if (command.includes('listremotes')) {
  const content = config && fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const names = [...content.matchAll(/^\\[([^\\]]+)\\]/gm)].map(m => m[1] + ':');
  process.stdout.write(names.join('\\n'));
} else if (command[0] === 'config' && command[1] === 'dump') {
  const content = config && fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const result = {};
  let section = '';
  for (const line of content.split(/\\r?\\n/)) {
    const heading = /^\\[([^\\]]+)\\]$/.exec(line.trim());
    if (heading) { section = heading[1]; result[section] = {}; continue; }
    const field = /^([^=]+?)\\s*=\\s*(.*)$/.exec(line);
    if (section && field) result[section][field[1].trim()] = field[2];
  }
  process.stdout.write(JSON.stringify(result));
} else if (command[0] === 'lsjson') {
  process.stdout.write(JSON.stringify([{ Name: 'video.mp4', Size: 12, IsDir: false, ModTime: '2026-01-01T00:00:00Z' }]));
} else if (command[0] === 'config' && command[1] === 'create' && command.includes('--non-interactive')) {
  process.stdout.write(JSON.stringify({ State: 'oauth-state', Option: { Name: 'config_is_local', Default: true, Examples: [{ Value: true, Help: 'Yes' }, { Value: false, Help: 'No' }] }, Error: '' }));
} else if (command[0] === 'config' && command[1] === 'update' && command.includes('--continue')) {
  const name = command[2];
  fs.writeFileSync(config, '[' + name + ']\\ntype = drive\\n');
  process.stdout.write(JSON.stringify({ State: '', Option: null, Error: '' }));
} else if (command[0] === 'cat') {
  process.stdout.write('cached-video');
} else process.exit(0);
`, { mode: 0o755 });
  return {
    root,
    options: {
      host: '127.0.0.1',
      port: 0,
      publicDir,
      marksFile: path.join(root, 'data', 'marks.json'),
      settingsFile: path.join(root, 'data', 'settings.json'),
      keysDir: path.join(root, 'data', 'keys'),
      cacheDir: path.join(root, 'cache', 'video'),
      thumbsDir: path.join(root, 'cache', 'thumbs'),
      uploadsDir: path.join(root, 'cache', 'uploads'),
      youtubeDir: path.join(root, 'cache', 'youtube'),
      rclonePath: tool,
      ffmpegPath: tool,
      rcloneConfigPath: path.join(root, 'data', 'rclone', 'rclone.conf'),
      authToken: 'test-token',
      logger() {}
    }
  };
}

test('embedded server authenticates, persists settings, and closes', async t => {
  const { root, options } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handle = await createVideoCheckerServer(options);
  t.after(() => handle.close());

  const denied = await fetch(`${handle.url}/api/health`);
  assert.equal(denied.status, 401);

  const headers = { 'X-Video-Checker-Token': 'test-token' };
  const health = await fetch(`${handle.url}/api/health`, { headers });
  assert.deepEqual(await health.json(), { ok: true, app: 'video-checker', apiVersion: 12 });

  const settings = await fetch(`${handle.url}/api/settings`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive:', sortMode: 'new', ramCacheGb: 4, ramMaxVideoGb: 1, holdSeekRate: 8, playbackRate: 0.5 })
  });
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { remote: 'drive:', sortMode: 'new', ramCacheGb: 4, ramMaxVideoGb: 1, holdSeekRate: 8, playbackRate: 0.5 });
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')), {
    remote: 'drive:', sortMode: 'new', ramCacheGb: 4, ramMaxVideoGb: 1, holdSeekRate: 8, playbackRate: 0.5
  });

  const looped = await fetch(`${handle.url}/api/settings`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ loopVideo: true })
  });
  assert.equal((await looped.json()).loopVideo, true);
  assert.equal(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')).loopVideo, true);

  const imported = await fetch(`${handle.url}/api/remotes/import-config`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ content: '[drive]\\ntype = drive\\n' })
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { ok: true, remotes: ['drive:'] });
  assert.match(fs.readFileSync(options.rcloneConfigPath, 'utf8'), /\[drive\]/);

  const firstList = await fetch(`${handle.url}/api/list?remote=drive&path=folder`, { headers });
  const firstListing = await firstList.json();
  assert.equal(firstListing.cached, false);
  assert.equal(firstListing.entries[0].Name, 'video.mp4');
  const secondList = await fetch(`${handle.url}/api/list?remote=drive&path=folder`, { headers });
  assert.equal((await secondList.json()).cached, true);

  const moved = await fetch(`${handle.url}/api/move`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive', from: 'folder/video.mp4', to: 'folder/Rejected/video.mp4' })
  });
  assert.equal(moved.status, 200);
  const listAfterMove = await fetch(`${handle.url}/api/list?remote=drive&path=folder`, { headers });
  assert.equal((await listAfterMove.json()).cached, false);

  const folderMark = await fetch(`${handle.url}/api/marks`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ key: 'drive:folder/source/video.mp4', flags: [{ frame: 5, t: 0.2 }] })
  });
  assert.equal(folderMark.status, 200);

  const movedFolder = await fetch(`${handle.url}/api/move`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive', from: 'folder/source', to: 'archive/source', isDir: true })
  });
  assert.equal(movedFolder.status, 200);
  const marksAfterFolderMove = await fetch(`${handle.url}/api/marks`, { headers });
  const movedMarks = await marksAfterFolderMove.json();
  assert.equal(movedMarks['drive:folder/source/video.mp4'], undefined);
  assert.deepEqual(movedMarks['drive:archive/source/video.mp4'].flags, [{ frame: 5, t: 0.2 }]);

  const movedIntoSelf = await fetch(`${handle.url}/api/move`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive', from: 'folder/source', to: 'folder/source/child/source', isDir: true })
  });
  assert.equal(movedIntoSelf.status, 400);

  const conflictingFolder = await fetch(`${handle.url}/api/move`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive', from: 'folder/video.mp4', to: 'archive/video.mp4', isDir: true })
  });
  assert.equal(conflictingFolder.status, 409);

  const duplicateImport = await fetch(`${handle.url}/api/remotes/import`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ name: 'drive', json: JSON.stringify({ type: 'service_account', client_email: 'test@example.com' }) })
  });
  assert.equal(duplicateImport.status, 409);
  assert.equal(fs.existsSync(path.join(options.keysDir, 'drive.json')), false);

  const prefetched = await fetch(`${handle.url}/api/prefetch`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive', path: 'folder/video.mp4', size: 12 })
  });
  assert.equal(prefetched.status, 200);
  assert.equal((await prefetched.json()).cached, true);
  assert.equal(fs.readdirSync(options.cacheDir).length, 0, '完整视频不应写入 SSD 缓存');
  assert.equal(fs.readdirSync(options.thumbsDir).length, 0, '预热不应被缩略帧生成阻塞');
  const cacheStatus = await fetch(`${handle.url}/api/cache/status`, { headers });
  assert.deepEqual((await cacheStatus.json()).items, 1);

  const thumbs = await fetch(`${handle.url}/api/thumbs`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive', path: 'folder/video.mp4', size: 12 })
  });
  assert.equal(thumbs.status, 200);
  assert.equal((await thumbs.json()).count, 1);

  const oauthStart = await fetch(`${handle.url}/api/remotes/oauth/start`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ name: 'oauth' })
  });
  const firstStep = await oauthStart.json();
  assert.equal(firstStep.done, false);
  assert.equal(firstStep.option.Name, 'config_is_local');

  const oauthContinue = await fetch(`${handle.url}/api/remotes/oauth/continue`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({
      sessionId: firstStep.sessionId,
      state: firstStep.state,
      result: 'true'
    })
  });
  assert.deepEqual(await oauthContinue.json(), { sessionId: firstStep.sessionId, done: true, remote: 'oauth:' });

  await handle.close();
  await assert.rejects(fetch(`${handle.url}/api/health`, { headers }));
});

test('standalone mode rejects cross-origin browser writes', async t => {
  const { root, options } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handle = await createVideoCheckerServer({ ...options, authToken: null });
  t.after(() => handle.close());

  const response = await fetch(`${handle.url}/api/settings`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
    body: JSON.stringify({ sortMode: 'old' })
  });
  assert.equal(response.status, 403);
  assert.equal(fs.existsSync(options.settingsFile), false);
});

test('folder sharing reads and updates Google Drive permissions', async t => {
  let linkRole = 'reader';
  const driveApi = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-access-token');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/drive/v3/files/folder12345') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'folder12345', name: 'Review', capabilities: { canShare: true } }));
    }
    if (url.pathname === '/drive/v3/files/folder12345/permissions' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ permissions: [
        { id: 'anyone-link', type: 'anyone', role: linkRole, permissionDetails: [{ inherited: false }] },
        { id: 'owner-user', type: 'user', role: 'owner', emailAddress: 'owner@example.com' }
      ] }));
    }
    if (url.pathname === '/drive/v3/files/folder12345/permissions/anyone-link' && req.method === 'PATCH') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      linkRole = JSON.parse(Buffer.concat(chunks).toString()).role;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'anyone-link', type: 'anyone', role: linkRole }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise(resolve => driveApi.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => driveApi.close(resolve)));

  const { root, options } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const address = driveApi.address();
  fs.mkdirSync(path.dirname(options.rcloneConfigPath), { recursive: true });
  fs.writeFileSync(options.rcloneConfigPath, '[drive]\ntype = drive\n');
  const handle = await createVideoCheckerServer({
    ...options,
    driveApiBaseUrl: `http://127.0.0.1:${address.port}/drive/v3`,
    driveAccessToken: async () => 'test-access-token'
  });
  t.after(() => handle.close());
  const headers = { 'X-Video-Checker-Token': 'test-token' };

  const read = await fetch(`${handle.url}/api/folder-permissions?remote=drive&fileId=folder12345`, { headers });
  const initial = await read.json();
  assert.equal(read.status, 200, JSON.stringify(initial));
  assert.equal(initial.file.capabilities.canShare, true);
  assert.equal(initial.permissions.find(permission => permission.type === 'anyone').role, 'reader');

  const updated = await fetch(`${handle.url}/api/folder-permissions`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive', fileId: 'folder12345', action: 'set-link', role: 'writer' })
  });
  const result = await updated.json();
  assert.equal(updated.status, 200);
  assert.equal(result.permissions.find(permission => permission.type === 'anyone').role, 'writer');
  assert.equal(linkRole, 'writer');
});

test('public Drive stream forwards byte ranges without an account', async t => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/download?id=1AbCdEfGhIjKlMnOp&export=download&authuser=0&confirm=t&resourcekey=0-demo');
    assert.equal(req.headers.range, 'bytes=4-7');
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': '4',
      'Content-Range': 'bytes 4-7/12',
      'Accept-Ranges': 'bytes'
    });
    res.end('5678');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const { root, options } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const address = upstream.address();
  const handle = await createVideoCheckerServer({
    ...options,
    publicDriveBaseUrl: `http://127.0.0.1:${address.port}/download`
  });
  t.after(() => handle.close());

  const response = await fetch(`${handle.url}/public-stream/1AbCdEfGhIjKlMnOp?resourcekey=0-demo`, {
    headers: { 'X-Video-Checker-Token': 'test-token', Range: 'bytes=4-7' }
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-7/12');
  assert.equal(await response.text(), '5678');
});

test('public Drive video preloads into RAM and generates scrub thumbnails', async t => {
  let upstreamRequests = 0;
  const content = Buffer.from('cached-video');
  const upstream = http.createServer((req, res) => {
    upstreamRequests++;
    assert.equal(req.headers.range, undefined);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(content.length),
      'Accept-Ranges': 'bytes'
    });
    res.end(content);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const { root, options } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const address = upstream.address();
  const handle = await createVideoCheckerServer({
    ...options,
    publicDriveBaseUrl: `http://127.0.0.1:${address.port}/download`
  });
  t.after(() => handle.close());
  const headers = { 'X-Video-Checker-Token': 'test-token', Origin: handle.url };
  const body = JSON.stringify({ fileId: '1AbCdEfGhIjKlMnOp', resourceKey: '0-demo' });

  const prefetched = await fetch(`${handle.url}/api/public/prefetch`, { method: 'POST', headers, body });
  assert.deepEqual(await prefetched.json(), { ok: true, cached: true, size: content.length });
  assert.equal(upstreamRequests, 1);

  const cachedRange = await fetch(`${handle.url}/public-stream/1AbCdEfGhIjKlMnOp?resourcekey=0-demo`, {
    headers: { 'X-Video-Checker-Token': 'test-token', Range: 'bytes=0-3' }
  });
  assert.equal(cachedRange.status, 206);
  assert.equal(await cachedRange.text(), 'cach');
  assert.equal(upstreamRequests, 1, 'RAM 命中后不应再请求 Google');

  const thumbs = await fetch(`${handle.url}/api/public/thumbs`, { method: 'POST', headers, body });
  assert.equal(thumbs.status, 200);
  assert.equal((await thumbs.json()).count, 1);
});

test('本地模式只开放拖入的文件夹，并能读出分辨率/帧率/色深', async () => {
  const { root, options } = fixture();
  const handle = await createVideoCheckerServer(options);
  const headers = { 'X-Video-Checker-Token': 'test-token', Host: new URL(handle.url).host };
  const writeHeaders = { ...headers, Origin: handle.url, 'Content-Type': 'application/json' };
  const dir = path.join(root, 'local-videos');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'shot01.mov'), 'local-video-bytes');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a video');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'must stay unreachable');

  const openResponse = await fetch(`${handle.url}/api/local/open`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ paths: [path.join(dir, 'shot01.mov')] })
  });
  assert.equal(openResponse.status, 200);
  const opened = await openResponse.json();
  assert.equal(opened.dir, fs.realpathSync(dir));
  assert.deepEqual(opened.startNames, ['shot01.mov']);
  assert.ok(opened.entries.some(entry => entry.Name === 'shot01.mov' && entry.Size === 17));

  const listed = await fetch(`${handle.url}/api/list?remote=${encodeURIComponent(opened.remote)}&path=`, { headers });
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).entries.some(entry => entry.Name === 'notes.txt'));

  const ranged = await fetch(`${handle.url}/stream/${encodeURIComponent(opened.remote)}/shot01.mov`, {
    headers: { ...headers, Range: 'bytes=0-4' }
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-4/17');
  assert.equal(await ranged.text(), 'local');

  const escaped = await fetch(`${handle.url}/stream/${encodeURIComponent(opened.remote)}/${encodeURIComponent('../secret.txt')}`, { headers });
  assert.equal(escaped.status, 400);

  const stale = await fetch(`${handle.url}/stream/local-0000000000000000/shot01.mov`, { headers });
  assert.equal(stale.status, 400);

  const probed = await fetch(`${handle.url}/api/probe`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ remote: opened.remote, path: 'shot01.mov' })
  });
  assert.equal(probed.status, 200);
  const info = await probed.json();
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.equal(info.bitDepth, 10);
  assert.equal(info.codec, 'hevc');
  assert.equal(info.playable, null);
  assert.ok(Math.abs(info.fps - 24000 / 1001) < 1e-6, '23.98 应该还原成 24000/1001');

  const moved = await fetch(`${handle.url}/api/move`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ remote: opened.remote, from: 'shot01.mov', to: 'archive/shot01.mov' })
  });
  assert.equal(moved.status, 200);
  assert.ok(fs.existsSync(path.join(dir, 'archive', 'shot01.mov')));

  await handle.close();
});

test('媒体信息解析覆盖真实 ffmpeg 输出的几种写法', () => {
  const prores = parseMediaInfo([
    '  Duration: 00:00:02.00, start: 0.000000, bitrate: 29554 kb/s',
    '  Stream #0:0[0x1]: Video: prores (apch / 0x68637061), yuv422p10le(tv, progressive), 1920x1080, 29550 kb/s, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 12800 tbn (default)'
  ].join('\n'));
  assert.equal(prores.codec, 'prores');
  assert.equal(prores.bitDepth, 10);
  assert.equal(prores.fps, 25);
  assert.equal(prores.width, 1920);
  assert.equal(prores.playable, false);

  const h264 = parseMediaInfo('  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 1475 kb/s, 23.98 fps, 23.98 tbr, 24k tbn (default)');
  assert.equal(h264.codec, 'h264');
  assert.equal(h264.bitDepth, 8);
  assert.equal(h264.playable, null);

  // 色彩描述里带逗号，不能把像素格式切坏
  const hdr = parseMediaInfo('  Stream #0:0: Video: hevc, yuv420p10le(tv, bt709/unknown/unknown, progressive), 3840x2160, SAR 1:1 DAR 16:9, 29.97 fps, 29.97 tbr, 1k tbn');
  assert.equal(hdr.pixFmt, 'yuv420p10le');
  assert.equal(hdr.colorTags, 'tv, bt709/unknown/unknown, progressive');
  assert.equal(hdr.bitDepth, 10);
  assert.ok(Math.abs(hdr.fps - 30000 / 1001) < 1e-6);

  assert.equal(bitDepthOf('p010le'), 10);
  assert.equal(bitDepthOf('yuvj420p'), 8);
  assert.equal(snapFps(59.94), 60000 / 1001);
  assert.equal(snapFps(12.5), 12.5);
  assert.equal(playableInChromium('prores'), false);
  assert.equal(playableInChromium('h264'), null, 'h264/hevc 的可播性交给播放器，不提前猜');
  assert.equal(playableInChromium('hevc'), null);
});

test('穿帮点的写入、排序、清洗与清空', async () => {
  const { options } = fixture();
  const handle = await createVideoCheckerServer(options);
  const headers = { 'X-Video-Checker-Token': 'test-token', Host: new URL(handle.url).host, Origin: handle.url, 'Content-Type': 'application/json' };
  const post = body => fetch(`${handle.url}/api/marks`, { method: 'POST', headers, body: JSON.stringify(body) });
  const read = async () => (await fetch(`${handle.url}/api/marks`, { headers })).json();

  await post({ key: 'drive:a.mp4', flags: [{ frame: 11, t: 0.48 }, { frame: 3, t: 0.14 }] });
  let marks = await read();
  assert.deepEqual(marks['drive:a.mp4'].flags, [{ frame: 3, t: 0.14 }, { frame: 11, t: 0.48 }], '应按帧号排序');

  // 不传 flags 时保持原样
  await post({ key: 'drive:a.mp4' });
  marks = await read();
  assert.equal(marks['drive:a.mp4'].flags.length, 2, '没传 flags 不该冲掉已记的穿帮点');

  // 覆盖写入
  await post({ key: 'drive:a.mp4', flags: [{ frame: 3, t: 0.14 }] });
  marks = await read();
  assert.equal(marks['drive:a.mp4'].flags.length, 1);

  // 非法输入被清洗掉；去重保留一条
  await post({ key: 'drive:b.mp4', flags: [{ frame: -1 }, { frame: 2.5 }, { frame: 7, t: 'x' }, { frame: 7, t: 1.5 }] });
  marks = await read();
  assert.deepEqual(marks['drive:b.mp4'].flags, [{ frame: 7, t: 1.5 }]);

  // 清空后条目整个消失
  await post({ key: 'drive:b.mp4', flags: [] });
  marks = await read();
  assert.equal(marks['drive:b.mp4'], undefined);

  assert.deepEqual(sanitizeFlags('nope'), []);
  assert.equal(sanitizeFlags(Array.from({ length: 600 }, (_, i) => ({ frame: i, t: i }))).length, 500);

  await handle.close();
});

test('YouTube downloads run yt-dlp, report progress, and open as a local video', async t => {
  const { root, options } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ytdlp = path.join(root, 'fake-yt-dlp');
  fs.writeFileSync(ytdlp, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(root, 'yt-args.json'))}, JSON.stringify(args));
const url = args[args.length - 1];
const id = new URL(url).searchParams.get('v');
if (id === 'privateVid1') { process.stderr.write('ERROR: [youtube] privateVid1: Private video\\n'); process.exit(1); }
const dir = args[args.indexOf('-P') + 1];
process.stdout.write('VCT 测试 视频\\n');
process.stdout.write('VCP 50 100 NA\\n');
setTimeout(() => {
  process.stdout.write('VCP 100 100 NA\\n');
  fs.writeFileSync(path.join(dir, '测试 视频 [' + id + '].mp4'), 'video');
}, 50);
`, { mode: 0o755 });
  const handle = await createVideoCheckerServer({ ...options, ytdlpPath: ytdlp });
  t.after(() => handle.close());
  const headers = { 'X-Video-Checker-Token': 'test-token', Origin: handle.url };
  const post = (route, body) => fetch(`${handle.url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await post('/api/youtube/download', { id: '../../etc/pa' })).status, 400);

  const started = await (await post('/api/youtube/download', { id: 'dQw4w9WgXcQ' })).json();
  assert.equal(started.state, 'running');
  let status;
  for (let i = 0; i < 100; i++) {
    status = await (await fetch(`${handle.url}/api/youtube/status?id=dQw4w9WgXcQ`, { headers })).json();
    if (status.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status.state, 'done');
  assert.equal(status.title, '测试 视频');
  assert.match(status.local.remote, /^local-/);
  assert.deepEqual(status.local.startNames, ['测试 视频 [dQw4w9WgXcQ].mp4']);
  const args = JSON.parse(fs.readFileSync(path.join(root, 'yt-args.json'), 'utf8'));
  assert.equal(args[args.length - 1], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.ok(args.includes('--no-playlist'));
  assert.ok(args.includes('--no-simulate'));

  const stream = await fetch(`${handle.url}/stream/${status.local.remote}/${encodeURIComponent(status.local.startNames[0])}`, { headers });
  assert.equal(await stream.text(), 'video');

  // 已下载过的直接复用，不再启动 yt-dlp
  fs.rmSync(path.join(root, 'yt-args.json'));
  assert.equal((await (await post('/api/youtube/download', { id: 'dQw4w9WgXcQ' })).json()).state, 'done');
  assert.equal(fs.existsSync(path.join(root, 'yt-args.json')), false);

  await post('/api/youtube/download', { id: 'privateVid1' });
  for (let i = 0; i < 100; i++) {
    status = await (await fetch(`${handle.url}/api/youtube/status?id=privateVid1`, { headers })).json();
    if (status.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'privateVid1: Private video');
});

test('review store, sidecar JSON next to a local video, and flag notes', async t => {
  const { root, options } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'local');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'cut.mp4'), 'video');
  fs.writeFileSync(path.join(folder, 'cut.report.json'), '{"configuration":{"patches":[]}}');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'secret');
  const handle = await createVideoCheckerServer(options);
  t.after(() => handle.close());
  const headers = { 'X-Video-Checker-Token': 'test-token', Origin: handle.url };
  const post = (route, body) => fetch(`${handle.url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const opened = await (await post('/api/local/open', { paths: [folder] })).json();
  const side = await fetch(`${handle.url}/api/sidecar?remote=${opened.remote}&path=cut.report.json`, { headers });
  assert.equal((await side.json()).text, '{"configuration":{"patches":[]}}');
  assert.equal((await fetch(`${handle.url}/api/sidecar?remote=${opened.remote}&path=notes.txt`, { headers })).status, 400, '只读 .json');
  assert.equal((await fetch(`${handle.url}/api/sidecar?remote=${opened.remote}&path=../x.json`, { headers })).status, 400);

  const key = `${opened.remote}:cut.mp4`;
  await post('/api/review', { key, plan: { name: 'cut.report.json', text: '{}' }, watched: [[10, 20], [15, 30], [40, 41], [-1, 5], [9, 3]] });
  const saved = await (await post('/api/review', { key, checks: { normal_speed_full_playback: { status: 'pass', note: '全看了' }, bogus: { status: 'maybe' } }, scope: '只修眼睛' })).json();
  assert.deepEqual(saved.watched, [[10, 30], [40, 41]]);
  assert.deepEqual(saved.checks, { normal_speed_full_playback: { status: 'pass', note: '全看了' } });
  assert.equal(saved.plan.name, 'cut.report.json');
  assert.equal(saved.scope, '只修眼睛');
  const read = await (await fetch(`${handle.url}/api/review?key=${encodeURIComponent(key)}`, { headers })).json();
  assert.deepEqual(read.watched, [[10, 30], [40, 41]]);
  await post('/api/review', { key, plan: null });
  assert.equal((await (await fetch(`${handle.url}/api/review?key=${encodeURIComponent(key)}`, { headers })).json()).plan, undefined);

  await post('/api/marks', { key, flags: [{ frame: 5, t: 0.2, note: '  接缝色差明显  ' }, { frame: 6, t: 0.25 }] });
  const marks = await (await fetch(`${handle.url}/api/marks`, { headers })).json();
  assert.deepEqual(marks[key].flags, [{ frame: 5, t: 0.2, note: '接缝色差明显' }, { frame: 6, t: 0.25 }]);
});
