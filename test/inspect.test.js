'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  frameDiffStats, laplacianVariance, seamColorDelta, analyzeSelection, scanVerdict, estimateEffectiveScale
} = require('../public/inspect');

// 造一张图：底噪细节 + 指定区域可以单独换清晰度/颜色
function makeFrame(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const sharpTexture = (x, y) => { const v = ((x + y) % 2) * 160 + 40; return [v, v, v]; };
const softTexture = (x, y) => { const v = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 20 + 110; return [v, v, v]; };

test('帧间差异能分出整体抖动和局部闪烁', () => {
  const base = makeFrame(64, 64, sharpTexture);
  const same = frameDiffStats(base, makeFrame(64, 64, sharpTexture));
  assert.equal(same.mean, 0);
  assert.equal(same.p99, 0);

  // 只有一小块变了：均值很小，但 p99 抓得到
  const patchFlicker = makeFrame(64, 64, (x, y) => (x > 40 && x < 56 && y > 40 && y < 56 ? [255, 255, 255] : sharpTexture(x, y)));
  const local = frameDiffStats(base, patchFlicker);
  assert.ok(local.mean < 15, `局部闪烁的均值应该很小，实际 ${local.mean}`);
  assert.ok(local.max > 90, `局部闪烁的峰值应该很大，实际 ${local.max}`);
});

test('拉普拉斯方差能区分清晰和模糊', () => {
  const sharp = makeFrame(64, 64, sharpTexture);
  const soft = makeFrame(64, 64, softTexture);
  const whole = { x: 0, y: 0, w: 64, h: 64 };
  assert.ok(laplacianVariance(sharp, whole) > laplacianVariance(soft, whole) * 10);
});

test('补丁比周围软时给出「像是放大上来的」结论', () => {
  // 周围锐利，中间 32x32 糊
  const frame = makeFrame(96, 96, (x, y) =>
    (x >= 32 && x < 64 && y >= 32 && y < 64) ? softTexture(x, y) : sharpTexture(x, y));
  const result = analyzeSelection(frame, { x: 32, y: 32, w: 32, h: 32 });
  assert.ok(result.sharpRatio < 0.6, `比值应该明显小于 1，实际 ${result.sharpRatio}`);
  assert.match(result.sharpVerdict, /像是低分辨率放大上来的/);
  assert.equal(result.width, 32);
});

test('补丁和周围一样清晰时，结论是「没有明显提升」', () => {
  const frame = makeFrame(96, 96, sharpTexture);
  const result = analyzeSelection(frame, { x: 32, y: 32, w: 32, h: 32 });
  assert.ok(result.sharpRatio > 0.85 && result.sharpRatio <= 1.25, `实际 ${result.sharpRatio}`);
  assert.match(result.sharpVerdict, /没有明显提升/);
});

test('接缝内外色差能量出来并报方向', () => {
  // 选区内整体偏红 12
  const frame = makeFrame(96, 96, (x, y) => {
    const [r, g, b] = sharpTexture(x, y);
    const inside = x >= 32 && x < 64 && y >= 32 && y < 64;
    return inside ? [r + 12, g, b - 6] : [r, g, b];
  });
  const seam = seamColorDelta(frame, { x: 32, y: 32, w: 32, h: 32 }, 4);
  assert.ok(seam.dr > 8, `红色应明显偏高，实际 ${seam.dr}`);
  assert.ok(seam.db < -3, `蓝色应偏低，实际 ${seam.db}`);
  const result = analyzeSelection(frame, { x: 32, y: 32, w: 32, h: 32 });
  assert.match(result.seamVerdict, /接缝内外色差明显/);

  const flat = makeFrame(96, 96, sharpTexture);
  assert.match(analyzeSelection(flat, { x: 32, y: 32, w: 32, h: 32 }).seamVerdict, /基本一致/);
});

test('扫描结论区分硬接跳变和持续抖动', () => {
  const steady = Array.from({ length: 20 }, (_, i) => ({ frame: 100 + i, mean: 2 + (i % 2) * 0.2 }));
  assert.equal(scanVerdict(steady).kind, 'ok');

  const jump = steady.map(item => ({ ...item }));
  jump[8].mean = 24; // 单帧孤立尖峰 = 缺帧硬接
  const jumpResult = scanVerdict(jump);
  assert.equal(jumpResult.kind, 'jump');
  assert.equal(jumpResult.peak.frame, 108);
  assert.match(jumpResult.text, /缺帧硬接/);

  // 单帧 1.8 倍不算毛病：实测干净素材的峰值就有 1.8 倍，报了就是狼来了
  const mildPeak = steady.map(item => ({ ...item }));
  mildPeak[5].mean = 3.8;
  const mild = scanVerdict(mildPeak);
  assert.equal(mild.kind, 'ok', '1.8 倍上下应判成正常');
  assert.match(mild.text, /正常运动范围/);

  // 隔帧闪烁：每帧都在抖，相邻帧差异反而大于隔一帧（实测正常运动 0.56、闪烁 3.0）
  const flicker = Array.from({ length: 20 }, (_, i) => ({ frame: 200 + i, mean: 4.8, mean2: 1.6 }));
  const flickerResult = scanVerdict(flicker);
  assert.equal(flickerResult.kind, 'flicker');
  assert.match(flickerResult.text, /隔帧闪烁/);

  // 正常运动的 lag-2 比值在 0.5 附近，不能误报成闪烁
  const moving = Array.from({ length: 20 }, (_, i) => ({ frame: 300 + i, mean: 0.9, mean2: 1.6 }));
  assert.equal(scanVerdict(moving).kind, 'ok');

  const shake = steady.map((item, i) => ({ ...item, mean: i >= 6 && i <= 12 ? 5 : item.mean }));
  const shakeResult = scanVerdict(shake);
  assert.equal(shakeResult.kind, 'shake');
  assert.match(shakeResult.text, /抖动|闪烁/);
});

test('能量出补丁被放大过多少倍', () => {
  const size = 96;
  // 先按 1/4 画格子再放大 4 倍：这张图的有效分辨率就是 24x24
  const upscaled = makeFrame(size, size, (x, y) => {
    const v = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) * 150 + 50;
    return [v, v, v];
  });
  const native = makeFrame(size, size, sharpTexture);
  const whole = { x: 0, y: 0, w: size, h: size };

  const up = estimateEffectiveScale(upscaled, whole);
  assert.ok(up.scale >= 3, `放大过的图应测出 >=3 倍，实际 ${up.scale}`);
  assert.ok(up.width <= 32, `有效宽度应该远小于 ${size}，实际 ${up.width}`);

  const real = estimateEffectiveScale(native, whole);
  assert.equal(real.scale, 1, '逐像素都有细节的图不应被判成放大过');
});

test('插值越糊，测出的细节尺度越小（这是细节量，不是标称分辨率）', () => {
  const size = 96;
  // 平滑渐变：几乎没有高频，细节尺度会被判得很小
  const smooth = makeFrame(size, size, (x, y) => { const v = 60 + (x + y) * 0.6; return [v, v, v]; });
  const result = estimateEffectiveScale(smooth, { x: 0, y: 0, w: size, h: size });
  assert.ok(!result.confident || result.scale >= 4, `平滑画面应被判成细节尺度很小，实际 scale=${result.scale} confident=${result.confident}`);
});

test('自动对齐挑出差异最小的偏移，并判断结果可不可信', () => {
  const { pickBestOffset } = require('../public/inspect');
  // -2 帧处明显最小 → 可信
  const clear = [
    { offset: -3, diff: 9.1 }, { offset: -2, diff: 1.2 }, { offset: -1, diff: 7.8 },
    { offset: 0, diff: 8.4 }, { offset: 1, diff: 9.0 }
  ];
  const picked = pickBestOffset(clear);
  assert.equal(picked.offset, -2);
  assert.equal(picked.confident, true);

  // 各偏移差不多 → 不可信，不要瞎对齐
  const flat = [
    { offset: -1, diff: 5.0 }, { offset: 0, diff: 4.9 }, { offset: 1, diff: 5.1 }
  ];
  assert.equal(pickBestOffset(flat).confident, false);

  // 只比次优好一点点也算不可信：中间丢过帧的片子就是这种形状
  const weak = [
    { offset: -1, diff: 3.05 }, { offset: 0, diff: 2.52 }, { offset: 1, diff: 3.4 }
  ];
  const weakPick = pickBestOffset(weak);
  assert.equal(weakPick.offset, 0);
  assert.equal(weakPick.confident, false, '2.52 vs 3.05 只好 17%，不该当成对上了');
  assert.deepEqual(pickBestOffset([]), { offset: 0, confident: false, best: 0, runnerUp: 0 });
});
