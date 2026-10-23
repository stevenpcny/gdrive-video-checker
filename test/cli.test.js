'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

// 假 ffmpeg：按 CLI 实际发出的参数应答，这样 CI 上没有 ffmpeg 也能跑。
// 画面内容只跟帧号有关：每帧匀速变亮一点(模拟正常运动，lag-2 差异约为 lag-1 的两倍，
// 不会被当成隔帧闪烁)，第 20 帧起整体突亮，于是扫描必须在第 20 帧报跳变。
function fakeFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cli-test-'));
  const tool = path.join(dir, 'fake-ffmpeg');
  fs.writeFileSync(tool, `#!/usr/bin/env node
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (!args.includes('-f')) {
  process.stderr.write([
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x':",
    '  Duration: 00:00:05.00, start: 0.000000, bitrate: 2000 kb/s',
    '  Stream #0:0[0x1]: Video: h264 (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 640x360, 2000 kb/s, 24 fps, 24 tbr, 12288 tbn',
    'At least one output file must be specified'
  ].join('\\n'));
  process.exit(1);
}
const scale = /scale=(\\d+):(\\d+)/.exec(value('-vf') || '');
const w = Number(scale[1]);
const h = Number(scale[2]);
const count = Number(value('-frames:v'));
// CLI 传的是 (N - 0.25)/fps，反推回帧号
const start = Math.round(Number(value('-ss')) * 24 + 0.25);
for (let k = 0; k < count; k++) {
  const frame = start + k;
  const base = frame >= 20 ? 200 : 20;
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    buf[i * 4] = (base + (x % 7) * 3 + Math.min(60, frame)) & 255;
    buf[i * 4 + 1] = buf[i * 4];
    buf[i * 4 + 2] = buf[i * 4];
    buf[i * 4 + 3] = 255;
  }
  process.stdout.write(buf);
}
`, { mode: 0o755 });
  const video = path.join(dir, 'clip.mp4');
  fs.writeFileSync(video, 'not really a video, 假 ffmpeg 不看内容');
  return { dir, tool, video };
}

function runCli(tool, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, VIDEO_CHECKER_FFMPEG: tool },
      maxBuffer: 64 * 1024 * 1024
    }, (error, stdout) => {
      resolve({ code: error ? error.code : 0, json: JSON.parse(stdout) });
    });
  });
}

test('probe 输出分辨率/帧率/色深', async () => {
  const { tool, video } = fakeFfmpeg();
  const { code, json } = await runCli(tool, ['probe', video]);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  assert.equal(json.width, 640);
  assert.equal(json.height, 360);
  assert.equal(json.fps, 24);
  assert.equal(json.bitDepth, 8);
  assert.equal(json.frames, 120);
});

test('scan 认出跳变并报准帧号（0 起）', async () => {
  const { tool, video } = fakeFfmpeg();
  const { json } = await runCli(tool, ['scan', video, '--from', '10', '--to', '31', '--width', '64']);
  assert.equal(json.ok, true);
  assert.equal(json.verdict.kind, 'jump');
  assert.equal(json.verdict.peakFrame, 20, '内容在第 20 帧突变');
  assert.equal(json.verdict.peakFrameDisplay, 21, '界面编号是 +1');
  assert.equal(json.range.from, 10);
  assert.equal(json.samples.length, 20, '[10,31) 共 21 帧，相邻对 20 组');
  assert.equal(json.samples[0].frame, 11);
});

test('roi 给出清晰度/细节尺度/接缝色差三项', async () => {
  const { tool, video } = fakeFfmpeg();
  const { json } = await runCli(tool, ['roi', video, '--frame', '5', '--rect', '100,100,200,160']);
  assert.equal(json.ok, true);
  assert.equal(json.rect.w, 200);
  assert.ok('ratio' in json.sharp && 'verdict' in json.sharp);
  assert.ok('scale' in json.detail && 'verdict' in json.detail);
  assert.ok('maxDelta' in json.seam && 'verdict' in json.seam);
});

test('compare 报两片差异与对齐偏移', async () => {
  const { tool, video } = fakeFfmpeg();
  const { json } = await runCli(tool, ['compare', video, video, '--frame', '30', '--width', '64']);
  assert.equal(json.ok, true);
  assert.equal(json.comparedAt.frameA, 30);
  assert.equal(json.comparedAt.frameB, 30);
  assert.equal(json.mismatch.size, false);
  assert.ok(json.diff.mean < 1, '同一个文件同一帧，差异应接近 0');
});

test('出错时输出 JSON 且退出码为 1', async () => {
  const { tool } = fakeFfmpeg();
  const missing = await runCli(tool, ['probe', '/no/such/file.mp4']);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.ok, false);
  assert.match(missing.json.error, /找不到文件/);

  const bad = await runCli(tool, ['nonsense']);
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /不认识的命令/);
});
