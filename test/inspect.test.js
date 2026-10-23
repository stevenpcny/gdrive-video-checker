'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  frameDiffStats, laplacianVariance, seamColorDelta, analyzeSelection, scanVerdict, estimateEffectiveScale,
  cropFrame, controlRect, createScanSampler, edgeStepProfile, seamStepVerdict, breathingVerdict, temporalResidual
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


// ---------- 补丁区限定扫描 ----------

// 一块区域隔帧闪烁、背景正常运动，可以指定补丁大小
function flickerClip(patch, { amp = 22, grain = 5, frames = 20 } = {}) {
  const W = 480, H = 270;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: frames }, (_, n) => {
    const data = new Uint8ClampedArray(W * H * 4);
    seed = n * 7919 + 13;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const g = grain * (rnd() - 0.5) * 2;
        const inPatch = x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
        const v = inPatch
          ? 120 + (n % 2 ? amp : -amp) + g
          : 110 + 28 * Math.sin((x + n * 1.1) * 0.08) + 18 * Math.sin(y * 0.05) + g;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return { data, width: W, height: H };
  });
}

function scanWith(frames, rect) {
  const control = rect ? controlRect(rect, frames[0].width, frames[0].height) : null;
  const sampler = createScanSampler({ rect, control });
  const samples = [];
  frames.forEach((frame, i) => {
    const sample = sampler.push(i, frame);
    if (sample) samples.push(sample);
  });
  return scanVerdict(samples, rect ? { scope: '补丁区' } : {});
}

test('隔帧闪烁再干净也要报出来（lag-2 趋近 0 不能当成平稳）', () => {
  // 原来拿 median(lag2) > 0.05 当守卫，最强的信号反被判成平稳
  const saturated = Array.from({ length: 20 }, (_, i) => ({ frame: i, mean: 44, mean2: 0 }));
  const result = scanVerdict(saturated);
  assert.equal(result.kind, 'flicker');
  assert.match(result.text, /隔一帧之间几乎没有差异/);
  assert.equal(result.flickerRatio, 99, '比值应该封顶，不能是 Infinity');

  // 整段几乎不动：lag1 也很小，这才是「看不出来」
  const still = Array.from({ length: 20 }, (_, i) => ({ frame: i, mean: 0.01, mean2: 0 }));
  assert.equal(scanVerdict(still).kind, 'ok');
});

test('颗粒噪声的 lag 比值在 1.0 附近，不能误报成闪烁', () => {
  // 独立噪声时 lag1 统计上等于 lag2，比值恒定在 1.0 —— 旧的 0.9 阈值会误报。
  // 实测：运动+颗粒 0.78、运动+强颗粒 0.94、静止+颗粒 0.99，而真闪烁最低 3.95
  for (const [lag1, lag2] of [[4.03, 4.05], [9.36, 9.42], [9.58, 10.23], [4.5, 5.75]]) {
    const samples = Array.from({ length: 20 }, (_, i) => ({ frame: i, mean: lag1, mean2: lag2 }));
    assert.equal(scanVerdict(samples).kind, 'ok', `lag1=${lag1} lag2=${lag2} 不该报闪烁`);
  }
  const real = Array.from({ length: 20 }, (_, i) => ({ frame: i, mean: 16, mean2: 4.05 }));
  assert.equal(scanVerdict(real).kind, 'flicker', '3.95 倍是真闪烁，要报');
});

test('小补丁的闪烁必须限定在补丁区内才判得出来', () => {
  // 全画幅的帧间均值会被面积稀释：同一个闪烁补丁占 1.9% 时判成平稳
  const patch = { x: 100, y: 90, w: 50, h: 50 };
  const frames = flickerClip(patch);
  assert.equal(scanWith(frames, null).kind, 'ok', '全画幅会被稀释（这是为什么要有 --rect）');
  const roi = scanWith(frames, patch);
  assert.equal(roi.kind, 'flicker');
  assert.equal(roi.localized, true, '区外对照区正常，应判成补丁自己的问题');
  assert.match(roi.text, /补丁区/);
  assert.match(roi.text, /区外对照区正常/);
});

test('整幅都在闪时要说明不是补丁单独的问题', () => {
  // 补丁和背景用同一套闪烁 → 对照区也闪
  const whole = { x: 0, y: 0, w: 480, h: 270 };
  const frames = flickerClip(whole);
  const roi = scanWith(frames, { x: 100, y: 90, w: 50, h: 50 });
  assert.equal(roi.kind, 'flicker');
  assert.equal(roi.localized, false);
  assert.match(roi.text, /画面其他地方也一样/);
});

test('对照区取同尺寸的区外区域，贴边时取不到就返回 null', () => {
  assert.deepEqual(controlRect({ x: 100, y: 90, w: 50, h: 50 }, 480, 270), { x: 40, y: 90, w: 50, h: 50 });
  assert.equal(controlRect({ x: 0, y: 0, w: 480, h: 270 }, 480, 270), null, '占满整幅时没有区外');
});

test('cropFrame 裁出来的像素和原图对应位置一致', () => {
  const frame = makeFrame(32, 32, sharpTexture);
  const cut = cropFrame(frame, { x: 8, y: 8, w: 6, h: 6 });
  assert.equal(cut.width, 6);
  assert.equal(cut.height, 6);
  const src = ((8 * 32) + 8) * 4;
  assert.equal(cut.data[0], frame.data[src]);
});

// ---------- 接缝台阶：硬边 / 切断 / 呼吸 ----------

function seamFrame(paint) {
  const W = 200, H = 200;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let v = 100 + 30 * Math.sin(x * 0.09) + 22 * Math.sin(y * 0.07) + 5 * (rnd() - 0.5) * 2;
      v = paint(x, y, v);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}
const SEAM_RECT = { x: 60, y: 60, w: 80, h: 80 };
const inSeamRect = (x, y) => x >= 60 && x < 140 && y >= 60 && y < 140;
const seamKind = paint => seamStepVerdict(edgeStepProfile(seamFrame(paint), SEAM_RECT)).kind;

test('贴合良好和只是发糊的补丁，不该报硬边', () => {
  assert.equal(seamKind((x, y, v) => v), 'ok');
  // 发糊但亮度一致：清晰度判据的活，不该在接缝这里报
  assert.equal(seamKind((x, y, v) => (inSeamRect(x, y)
    ? 100 + 30 * Math.sin(Math.round(x / 6) * 6 * 0.09) + 22 * Math.sin(Math.round(y / 6) * 6 * 0.07)
    : v)), 'ok');
});

test('贯通的硬边要报 seam，1px 和 3px 粗的缝都要抓到', () => {
  // 厚缝是关键：只跨 1 像素量的话，缝会同时落在内外两个采样点上，
  // 台阶归零、噪声基准反被抬高，结果比平整的边还低
  assert.equal(seamKind((x, y, v) => (x === 60 && y >= 60 && y < 140 ? 25 : v)), 'seam');
  assert.equal(seamKind((x, y, v) => (x >= 59 && x <= 61 && y >= 60 && y < 140 ? 25 : v)), 'seam');
});

test('内容被切断要报 cut，而整块偏色不在这里重复报', () => {
  // 一根亮条斜穿上边界：补丁外有，补丁里被抹平
  const cut = seamKind((x, y, v) => (Math.abs((x - 90) - (y - 40) * 0.3) < 9 && y < 60 ? 235 : v));
  assert.equal(cut, 'cut');

  // 整块偏亮：均匀偏色在纹理强处会被淹没、连不成贯通段，
  // 但它整条边都在偏（runRatio ≈ 中位 ratio），不是局部突起 → 交给 seamColorDelta 报
  const shifted = seamFrame((x, y, v) => (inSeamRect(x, y) ? v + 18 : v));
  assert.equal(seamStepVerdict(edgeStepProfile(shifted, SEAM_RECT)).kind, 'ok');
  assert.match(analyzeSelection(shifted, SEAM_RECT).seamVerdict, /色差明显/);
});

test('接缝台阶逐帧起伏判成边界呼吸，稳定的缝不算', () => {
  assert.equal(breathingVerdict([3, 12, 4, 13, 2, 14, 3, 11, 4, 12]).kind, 'breathing');
  assert.equal(breathingVerdict([8, 8.1, 7.9, 8.2, 8, 7.8, 8.1, 8]).kind, 'ok');
  assert.equal(breathingVerdict([0.4, 0.3, 0.5, 0.4, 0.3, 0.4]).kind, 'ok', '台阶本来就很弱，不算呼吸');
  assert.equal(breathingVerdict([1, 2]).kind, 'unknown');
});

test('帧间残差的相关性：独立噪声 -0.5，部分像素翻转接近 -1', () => {
  const W = 40, H = 40;
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const make = (n, paint) => {
    const data = new Uint8ClampedArray(W * H * 4);
    seed = n * 7919 + 3;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = paint(x, y, n, 8 * (rnd() - 0.5) * 2);
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return { data, width: W, height: H };
  };

  // d1 和 d2 共享中间帧，独立噪声下相关系数的解析值恰好是 -0.5。
  // 这条是实现的正确性检查，数值对不上就是算错了。
  const noise = (x, y, n, g) => 120 + g;
  const pure = temporalResidual(make(0, noise), make(1, noise), make(2, noise), null);
  assert.ok(Math.abs(pure.corr + 0.5) < 0.15, `独立噪声应在 -0.5 附近，实际 ${pure.corr.toFixed(3)}`);

  // 左半边隔帧翻转、右半边不动：两次残差的空间图案完全反相
  const halfFlip = (x, y, n, g) => (x < W / 2 ? 120 + (n % 2 ? 20 : -20) + g : 120 + g);
  const partial = temporalResidual(make(0, halfFlip), make(1, halfFlip), make(2, halfFlip), null);
  assert.ok(partial.corr < -0.9, `部分像素翻转应强负相关，实际 ${partial.corr.toFixed(3)}`);

  // 整块一起翻：mean-removed 之后没有空间结构，这个度量看不出来
  const allFlip = (x, y, n) => 120 + (n % 2 ? 20 : -20);
  const uniform = temporalResidual(make(0, allFlip), make(1, allFlip), make(2, allFlip), null);
  assert.ok(Math.abs(uniform.corr) < 0.1, '均匀闪烁没有空间图案，corr 应接近 0（判闪烁靠 lag-2 比值）');
});
