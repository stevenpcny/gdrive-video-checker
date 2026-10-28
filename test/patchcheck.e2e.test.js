'use strict';

// 端到端：用真实 ffmpeg 造原片和带缺陷的成片，跑 `cli.js patchcheck`，
// 验证干净成片零报警、每种注入缺陷都被抓到。机器上没有 ffmpeg 就跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const FFMPEG = process.env.VIDEO_CHECKER_FFMPEG || 'ffmpeg';
let hasFfmpeg = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { stdio: 'pipe' }).toString().includes('libx264') && (hasFfmpeg = true); } catch { /* 没装 */ }

const CLI = path.join(__dirname, '..', 'cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-patchcheck-'));
const box = 'x=150:y=50:w=40:h=40';
const enc = ['-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '24'];
const make = (name, args) => execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...args, ...enc, path.join(dir, name)]);

function run(file, extra = []) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, 'patchcheck', path.join(dir, file), '--plan', path.join(dir, 'merge.json'), '--quiet', ...extra],
      { env: { ...process.env, VIDEO_CHECKER_FFMPEG: FFMPEG }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch { reject(error || new Error(stdout)); }
      });
  });
}

const checks = result => new Set(result.findings.filter(f => f.severity === 'fail').map(f => f.check));

test('patchcheck end to end on synthetic footage', { skip: !hasFfmpeg && '没有带 libx264 的 ffmpeg' }, async t => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  make('source.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3']);
  const src = path.join(dir, 'source.mp4');
  make('clean.mp4', ['-i', src]);
  make('flicker.mp4', ['-i', src, '-vf', `drawbox=${box}:color=white@0.35:t=fill:enable='between(n,24,59)*eq(mod(n,2),0)'`]);
  make('tint.mp4', ['-i', src, '-vf', `drawbox=${box}:color=red@0.25:t=fill:enable='between(n,24,59)'`]);
  make('outside.mp4', ['-i', src, '-vf', 'drawbox=x=20:y=130:w=60:h=40:color=blue@0.3:t=fill']);
  fs.writeFileSync(path.join(dir, 'merge.json'), JSON.stringify({
    schema_version: 1, source: 'source.mp4', source_size: [320, 180], fps: 24,
    patches: [{ name: 'person-a', target: [24, 60], crop: [130, 30, 80, 80], work_size: [160, 160],
      matte: { region: [40, 40, 80, 80], shape: 'rect', feather: 0, protect: [] }, blend: 'alpha' }]
  }));
  const withSource = ['--source', src];

  const clean = await run('clean.mp4', withSource);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.findings, [], JSON.stringify(clean.findings, null, 1));

  const flicker = await run('flicker.mp4', withSource);
  assert.equal(flicker.patches[0].scan.kind, 'flicker');
  assert.ok(checks(flicker).has('matte_core_protection_and_flicker'));

  const tint = await run('tint.mp4', [...withSource, '--review', path.join(dir, 'review.json'), '--sheet', path.join(dir, 'sheet.png'), '--evidence', path.join(dir, 'ev')]);
  const tintChecks = checks(tint);
  assert.ok(tintChecks.has('face_neck_hand_color_and_texture'), 'LAB 接缝色差');
  assert.ok(tintChecks.has('native_and_magnified_edges'), '贯通硬边');
  assert.ok(tintChecks.has('cut_boundaries_and_occlusions'), '补丁起止跳变');
  assert.equal(tint.junctions.find(j => j.frame === 24).kind, 'fail');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8'));
  assert.equal(review.status, 'pending_visual_review', '自动检查不替人判通过');
  assert.equal(review.checks.face_neck_hand_color_and_texture.status, 'not_run');
  assert.equal(review.checks.face_neck_hand_color_and_texture.auto_suggestion, 'fail');
  assert.ok(fs.statSync(path.join(dir, 'sheet.png')).size > 1000);
  assert.equal(tint.outputs.sheetFrames.count, 36);
  assert.ok(tint.outputs.evidence.length >= 3);

  const outside = await run('outside.mp4', withSource);
  assert.deepEqual([...checks(outside)], ['unchanged_outside_matte']);

  // 没有原片时，受画面内容影响的判据只给提示，不判失败；隔帧闪烁仍然判失败
  const blind = await run('clean.mp4');
  assert.ok(blind.findings.every(f => f.severity === 'warn'), JSON.stringify(blind.findings, null, 1));
  const blindFlicker = await run('flicker.mp4');
  assert.ok(checks(blindFlicker).has('matte_core_protection_and_flicker'));
});
