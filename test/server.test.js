'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createVideoCheckerServer } = require('../server');

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
  assert.deepEqual(await health.json(), { ok: true, app: 'video-checker', apiVersion: 10 });

  const settings = await fetch(`${handle.url}/api/settings`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive:', sortMode: 'new', subdir: 'Rejected', ramCacheGb: 4, ramMaxVideoGb: 1, holdSeekRate: 8 })
  });
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { remote: 'drive:', sortMode: 'new', subdir: 'Rejected', ramCacheGb: 4, ramMaxVideoGb: 1, holdSeekRate: 8 });
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')), {
    remote: 'drive:', sortMode: 'new', subdir: 'Rejected', ramCacheGb: 4, ramMaxVideoGb: 1, holdSeekRate: 8
  });

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
    body: JSON.stringify({ key: 'drive:folder/source/video.mp4', status: 'ok' })
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
  assert.equal(movedMarks['drive:archive/source/video.mp4'].status, 'ok');

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
