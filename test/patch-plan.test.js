'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PatchPlan = require('../public/patch-plan');

const merge = {
  schema_version: 1,
  source: 'source.mp4',
  source_size: [1280, 720],
  fps: '24000/1001',
  patches: [
    {
      name: 'person-a-segment-a',
      target: [24, 72],
      crop: [{ frame: 24, value: [800, 40, 360, 640] }, { frame: 72, value: [848, 40, 360, 640] }],
      work_size: [180, 320],
      matte: { region: [45, 40, 90, 60], shape: 'rect', feather: 6, protect: [[30, 110, 120, 50]] },
      blend: 'alpha'
    },
    {
      name: 'person-a-segment-b',
      target: [72, 100],
      crop: [848, 40, 360, 640],
      work_size: [180, 320],
      matte: { region: [45, 40, 90, 60], feather: 6 }
    }
  ]
};

test('parses merge config and maps work-canvas matte into source pixels', () => {
  const plan = PatchPlan.parse(JSON.stringify(merge));
  assert.equal(plan.kind, 'merge');
  assert.ok(Math.abs(plan.fps - 23.976) < 0.001);
  const g = PatchPlan.geometryAt(plan.patches[0], 24);
  // crop 360x640 对 work 180x320：每个工作像素 = 2 个源像素
  assert.deepEqual(g.matte, { x: 890, y: 120, w: 180, h: 120 });
  assert.deepEqual(g.protect[0], { x: 860, y: 260, w: 240, h: 100 });
  assert.deepEqual(g.core, { x: 902, y: 132, w: 156, h: 96 });
  assert.equal(PatchPlan.geometryAt(plan.patches[0], 72), null, 'target 右开');
  assert.equal(PatchPlan.geometryAt(plan.patches[0], 23), null);
});

test('keyframes interpolate linearly like np.interp and round half to even', () => {
  const plan = PatchPlan.parse(merge);
  // 48 帧在 24→72 正中间：x = 800 + 24 = 824
  assert.equal(PatchPlan.geometryAt(plan.patches[0], 48).crop.x, 824);
  assert.deepEqual(PatchPlan.rectAt([{ frame: 0, value: [0, 0, 10, 10] }, { frame: 2, value: [5, 3, 10, 10] }], 1), { x: 2, y: 2, w: 10, h: 10 });
  assert.deepEqual(PatchPlan.curve([{ frame: 10, value: [1] }, { frame: 20, value: [3] }], 0), [1]);
  assert.deepEqual(PatchPlan.curve([{ frame: 10, value: [1] }, { frame: 20, value: [3] }], 99), [3]);
});

test('reads the configuration embedded in a merge report and lists junctions', () => {
  const report = { mode: 'merge', decode_pass: true, output: { size: [1280, 720], frames: 240, fps: '24000/1001', audio: true }, configuration: merge, audio_payload_sha256: 'abc' };
  const plan = PatchPlan.parse(report);
  assert.equal(plan.kind, 'report');
  assert.equal(plan.frames, 240);
  assert.equal(plan.decodePass, true);
  assert.deepEqual(PatchPlan.junctions(plan).map(j => [j.frame, j.segment]), [[24, false], [72, true], [100, false]]);
  assert.equal(PatchPlan.patchedFrames(plan).length, 76);
  assert.deepEqual(PatchPlan.checkMedia(plan, { width: 1280, height: 720, fps: 23.976, frames: 240 }), []);
  assert.equal(PatchPlan.checkMedia(plan, { width: 640, height: 360, fps: 25, frames: 50 }).length, 4);
  const half = PatchPlan.scaleFor(plan, 640, 360);
  assert.deepEqual(PatchPlan.geometryAt(plan.patches[1], 80, half).matte, { x: 469, y: 60, w: 90, h: 60 });
});

test('rejects prepare configs and broken input with a readable reason', () => {
  assert.throws(() => PatchPlan.parse('{"prepare":{}}'), /prepare/);
  assert.throws(() => PatchPlan.parse('not json'), /JSON/);
  assert.throws(() => PatchPlan.parse({ patches: [{ target: [5, 5] }] }), /target/);
});
