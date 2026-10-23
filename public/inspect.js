(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Inspect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 所有函数都吃 {data, width, height}（ImageData 形状），纯计算，方便单测。
  const luma = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

  function clampRect(rect, width, height) {
    const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
    const w = Math.max(1, Math.min(width - x, Math.round(rect.w)));
    const h = Math.max(1, Math.min(height - y, Math.round(rect.h)));
    return { x, y, w, h };
  }

  // 帧间差异：均值反映整体抖动，p99 反映局部闪烁（接缝只占画面一小块，均值会被稀释）
  function frameDiffStats(prev, cur) {
    const a = prev.data;
    const b = cur.data;
    const count = Math.min(a.length, b.length) / 4;
    if (!count) return { mean: 0, p99: 0, max: 0 };
    const hist = new Uint32Array(256);
    let total = 0;
    let max = 0;
    for (let i = 0; i < count; i++) {
      const p = i * 4;
      const d = Math.abs(luma(a, p) - luma(b, p));
      const bucket = d > 255 ? 255 : d | 0;
      hist[bucket]++;
      total += d;
      if (d > max) max = d;
    }
    let seen = 0;
    let p99 = 0;
    const cut = count * 0.99;
    for (let value = 0; value < 256; value++) {
      seen += hist[value];
      if (seen >= cut) { p99 = value; break; }
    }
    return { mean: total / count, p99, max };
  }

  // 把差异画成可视图：放大 gain 倍的灰度，超过阈值的染红，接缝闪烁会直接跳出来
  function diffImage(prev, cur, gain, out) {
    const a = prev.data;
    const b = cur.data;
    const count = Math.min(a.length, b.length) / 4;
    for (let i = 0; i < count; i++) {
      const p = i * 4;
      const d = Math.abs(luma(a, p) - luma(b, p)) * gain;
      const v = d > 255 ? 255 : d;
      out[p] = v > 110 ? 255 : v;
      out[p + 1] = v > 110 ? v * 0.45 : v;
      out[p + 2] = v > 110 ? v * 0.35 : v;
      out[p + 3] = 255;
    }
    return out;
  }

  // 拉普拉斯方差：常用的清晰度/锐度指标，越小越糊
  function laplacianVariance(frame, rect) {
    const { data, width, height } = frame;
    const r = clampRect(rect, width, height);
    if (r.w < 3 || r.h < 3) return 0;
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        const i = (y * width + x) * 4;
        const value = 4 * luma(data, i)
          - luma(data, i - 4)
          - luma(data, i + 4)
          - luma(data, i - width * 4)
          - luma(data, i + width * 4);
        sum += value;
        sumSq += value * value;
        n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  // 把选区按 k 倍做盒式下采样再最近邻放回原尺寸。
  // 如果画面本来就是低分辨率放大上来的，这一来一回几乎不损失细节。
  function resampleRoi(frame, rect, k) {
    const r = clampRect(rect, frame.width, frame.height);
    const sw = Math.max(1, Math.floor(r.w / k));
    const sh = Math.max(1, Math.floor(r.h / k));
    const small = new Float64Array(sw * sh * 3);
    const counts = new Uint32Array(sw * sh);
    for (let y = 0; y < r.h; y++) {
      const sy = Math.min(sh - 1, Math.floor(y / k));
      for (let x = 0; x < r.w; x++) {
        const sx = Math.min(sw - 1, Math.floor(x / k));
        const src = ((r.y + y) * frame.width + (r.x + x)) * 4;
        const dst = (sy * sw + sx) * 3;
        small[dst] += frame.data[src];
        small[dst + 1] += frame.data[src + 1];
        small[dst + 2] += frame.data[src + 2];
        counts[sy * sw + sx]++;
      }
    }
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
      const sy = Math.min(sh - 1, Math.floor(y / k));
      for (let x = 0; x < r.w; x++) {
        const sx = Math.min(sw - 1, Math.floor(x / k));
        const cell = sy * sw + sx;
        const n = counts[cell] || 1;
        const dst = (y * r.w + x) * 4;
        out[dst] = small[cell * 3] / n;
        out[dst + 1] = small[cell * 3 + 1] / n;
        out[dst + 2] = small[cell * 3 + 2] / n;
        out[dst + 3] = 255;
      }
    }
    return { data: out, width: r.w, height: r.h };
  }

  // 有效分辨率：找出「降到 1/k 再放大回来也几乎不掉细节」的最大 k。
  // 补丁是 720p 生成后放大到 4K 的话，这里就能把真实尺度量出来。
  function estimateEffectiveScale(frame, rect, keepRatio = 0.8) {
    const r = clampRect(rect, frame.width, frame.height);
    const whole = { x: 0, y: 0, w: r.w, h: r.h };
    const sharp = laplacianVariance(frame, r);
    if (sharp < 0.5) return { scale: 1, sharp, confident: false };
    // 细节保留率对 k 不是单调的：4 倍放大的图在 k=3 会因为采样错位掉下去、k=4 又回到 1。
    // 所以要把所有 k 都量一遍取最大的通过值，不能遇到第一个不过就停。
    let scale = 1;
    for (const k of [2, 3, 4, 6, 8]) {
      if (Math.floor(r.w / k) < 8 || Math.floor(r.h / k) < 8) break;
      const ratio = laplacianVariance(resampleRoi(frame, r, k), whole) / sharp;
      if (ratio >= keepRatio) scale = k;
    }
    return {
      scale,
      sharp,
      confident: true,
      width: Math.round(r.w / scale),
      height: Math.round(r.h / scale)
    };
  }

  function meanColor(frame, rect) {
    const { data, width, height } = frame;
    const r = clampRect(rect, width, height);
    let red = 0;
    let green = 0;
    let blue = 0;
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * width + x) * 4;
        red += data[i];
        green += data[i + 1];
        blue += data[i + 2];
        n++;
      }
    }
    if (!n) return { r: 0, g: 0, b: 0, y: 0 };
    const out = { r: red / n, g: green / n, b: blue / n };
    out.y = 0.299 * out.r + 0.587 * out.g + 0.114 * out.b;
    return out;
  }

  // 沿选区四条边，取边内一条带和边外一条带，比较它们的平均色——接缝色差就在这里
  function seamColorDelta(frame, rect, band = 6) {
    const r = clampRect(rect, frame.width, frame.height);
    const inside = [
      { x: r.x, y: r.y, w: r.w, h: band },
      { x: r.x, y: r.y + r.h - band, w: r.w, h: band },
      { x: r.x, y: r.y, w: band, h: r.h },
      { x: r.x + r.w - band, y: r.y, w: band, h: r.h }
    ];
    const outside = [
      { x: r.x, y: r.y - band, w: r.w, h: band },
      { x: r.x, y: r.y + r.h, w: r.w, h: band },
      { x: r.x - band, y: r.y, w: band, h: r.h },
      { x: r.x + r.w, y: r.y, w: band, h: r.h }
    ];
    const avg = rects => {
      const parts = rects
        .filter(part => part.x >= 0 && part.y >= 0 && part.x + part.w <= frame.width && part.y + part.h <= frame.height)
        .map(part => meanColor(frame, part));
      if (!parts.length) return null;
      const sum = parts.reduce((acc, part) => ({ r: acc.r + part.r, g: acc.g + part.g, b: acc.b + part.b }), { r: 0, g: 0, b: 0 });
      const out = { r: sum.r / parts.length, g: sum.g / parts.length, b: sum.b / parts.length };
      out.y = 0.299 * out.r + 0.587 * out.g + 0.114 * out.b;
      return out;
    };
    const innerAvg = avg(inside);
    const outerAvg = avg(outside);
    if (!innerAvg || !outerAvg) return null;
    return {
      inner: innerAvg,
      outer: outerAvg,
      dr: innerAvg.r - outerAvg.r,
      dg: innerAvg.g - outerAvg.g,
      db: innerAvg.b - outerAvg.b,
      dy: innerAvg.y - outerAvg.y
    };
  }

  // 补丁区 vs 周围一圈：清晰度比值直接回答「有没有提升 / 是不是放大上来的」
  function analyzeSelection(frame, rect) {
    const r = clampRect(rect, frame.width, frame.height);
    const pad = Math.max(12, Math.round(Math.min(r.w, r.h) * 0.35));
    const ring = clampRect({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, frame.width, frame.height);
    const innerSharp = laplacianVariance(frame, r);
    // 外圈用「扩大区域」的整体清晰度近似周围水平；选区占比越小越准
    const ringSharp = laplacianVariance(frame, ring);
    const ratio = ringSharp > 0.0001 ? innerSharp / ringSharp : 0;
    const effective = estimateEffectiveScale(frame, r);
    const seam = seamColorDelta(frame, r);
    const maxDelta = seam ? Math.max(Math.abs(seam.dr), Math.abs(seam.dg), Math.abs(seam.db)) : 0;
    return {
      rect: r,
      width: r.w,
      height: r.h,
      innerSharp,
      ringSharp,
      sharpRatio: ratio,
      sharpVerdict: sharpVerdict(ratio),
      effective,
      effectiveVerdict: effectiveVerdict(effective, r),
      seam,
      seamMaxDelta: maxDelta,
      seamVerdict: seamVerdict(maxDelta, seam)
    };
  }

  function sharpVerdict(ratio) {
    if (!(ratio > 0)) return '清晰度无法判断（选区太小或画面太平）';
    if (ratio < 0.6) return `补丁明显比周围软（${ratio.toFixed(2)}×），像是低分辨率放大上来的`;
    if (ratio < 0.85) return `补丁略软于周围（${ratio.toFixed(2)}×）`;
    if (ratio <= 1.25) return `和周围差不多（${ratio.toFixed(2)}×），没有明显提升`;
    return `补丁比周围更锐（${ratio.toFixed(2)}×），注意别过锐`;
  }

  // 注意：这里量的是「细节尺度」，不是生成时的标称分辨率。
  // 插值越糊（双线性放大等），测出来的尺度会比标称值更小，所以措辞只说细节，不报放大倍数。
  function effectiveVerdict(effective, rect) {
    if (!effective.confident) return '选区太平，量不出细节尺度';
    if (effective.scale <= 1) return `细节与选区像素相当（${rect.w}×${rect.h}），没有放大痕迹`;
    return `细节只相当于约 ${effective.width}×${effective.height}（选区 ${rect.w}×${rect.h}），是放大/插值上来的`;
  }

  function seamVerdict(maxDelta, seam) {
    if (!seam) return '选区贴边，取不到外侧参照';
    const tint = [['R', seam.dr], ['G', seam.dg], ['B', seam.db]]
      .map(([name, value]) => `${name}${value >= 0 ? '+' : ''}${value.toFixed(1)}`)
      .join(' ');
    if (maxDelta >= 8) return `接缝内外色差明显（${tint}）`;
    if (maxDelta >= 4) return `接缝内外有轻微色差（${tint}）`;
    return `接缝内外基本一致（${tint}）`;
  }

  const median = values => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  // 区间扫描结论。三种毛病的指纹不一样：
  //   隔帧闪烁——相邻帧差异比隔一帧的差异还大（抖动来回抵消），实测正常运动 0.56、闪烁 3.0
  //   缺帧硬接——某一帧孤立尖峰，远高于区间常态
  //   持续抖动——连续多帧偏高
  // 闪烁必须靠 lag-2 判，光看「比常态高多少」会漏：每帧都在闪时常态本身就被抬高了。
  function scanVerdict(samples) {
    const values = samples.map(item => item.mean);
    if (values.length < 3) return { kind: 'unknown', text: '帧数太少，看不出规律', base: 0, peak: null, shaky: [] };
    const base = median(values);
    const lag2 = samples.filter(item => Number.isFinite(item.mean2)).map(item => item.mean2);
    const flickerRatio = lag2.length >= 3 && median(lag2) > 0.05 ? base / median(lag2) : 0;
    const floor = Math.max(base, 0.6);
    const scored = samples.map((item, index) => ({ ...item, index, ratio: item.mean / floor }));
    const peak = scored.reduce((best, item) => (item.ratio > best.ratio ? item : best), scored[0]);
    const shaky = scored.filter(item => item.ratio >= 1.8 && item !== peak);
    if (flickerRatio >= 0.9) {
      return {
        kind: 'flicker',
        base,
        peak,
        shaky,
        flickerRatio,
        text: `整段在隔帧闪烁：相邻帧差异是隔一帧的 ${flickerRatio.toFixed(1)} 倍（正常运动约 0.5），开差分视图能看出闪在哪一块`
      };
    }
    if (peak.ratio >= 3 && shaky.length <= Math.max(1, values.length * 0.15)) {
      return {
        kind: 'jump',
        base,
        peak,
        shaky,
        flickerRatio,
        text: `第 ${peak.frame + 1} 帧跳变明显：帧间变化是区间常态的 ${peak.ratio.toFixed(1)} 倍，像是缺帧硬接`
      };
    }
    if (shaky.length >= 3 || (peak.ratio >= 1.8 && shaky.length >= 2)) {
      return {
        kind: 'shake',
        base,
        peak,
        shaky,
        flickerRatio,
        text: `${shaky.length + 1} 帧帧间变化偏高（峰值在第 ${peak.frame + 1} 帧），更像是持续抖动/闪烁`
      };
    }
    if (peak.ratio >= 1.8) {
      return { kind: 'jump', base, peak, shaky, flickerRatio, text: `第 ${peak.frame + 1} 帧略有跳变（${peak.ratio.toFixed(1)} 倍）` };
    }
    return { kind: 'ok', base, peak, shaky, flickerRatio, text: '区间内帧间变化平稳，没有明显跳变或闪烁' };
  }

  return {
    frameDiffStats,
    diffImage,
    laplacianVariance,
    meanColor,
    seamColorDelta,
    analyzeSelection,
    estimateEffectiveScale,
    resampleRoi,
    scanVerdict,
    clampRect
  };
});
