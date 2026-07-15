'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
  assert.deepEqual(await health.json(), { ok: true, app: 'video-checker', apiVersion: 2 });

  const settings = await fetch(`${handle.url}/api/settings`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ remote: 'drive:', sortMode: 'new', subdir: 'Rejected', ramCacheGb: 4, ramMaxVideoGb: 1 })
  });
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { remote: 'drive:', sortMode: 'new', subdir: 'Rejected', ramCacheGb: 4, ramMaxVideoGb: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')), {
    remote: 'drive:', sortMode: 'new', subdir: 'Rejected', ramCacheGb: 4, ramMaxVideoGb: 1
  });

  const imported = await fetch(`${handle.url}/api/remotes/import-config`, {
    method: 'POST',
    headers: { ...headers, Origin: handle.url },
    body: JSON.stringify({ content: '[drive]\\ntype = drive\\n' })
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { ok: true, remotes: ['drive:'] });
  assert.match(fs.readFileSync(options.rcloneConfigPath, 'utf8'), /\[drive\]/);

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
