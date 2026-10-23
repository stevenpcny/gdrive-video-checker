(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Inspect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 所有函数都吃 {data, width, height}（ImageData 形状），纯计算，方便单测。
  const luma = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

  // lag1 中位数低于这个值就认为整段几乎没变化，不做闪烁判断
  const FLICKER_FLOOR = 0.3;
  // lag-2 趋近 0 时比值会炸，封顶后文案改成「隔一帧几乎没差异」
  const FLICKER_CAP = 99;
  // 隔帧闪烁的判线。实测三档（合成样本，补丁区 75x75）：
  //   运动+颗粒 0.78 / 运动+强颗粒 0.94 / 静止+颗粒 0.99  ← 都不该报
  //   闪烁±8 3.95 / 闪烁±22 10.9 / 闪烁无颗粒 ∞          ← 都该报
  // 独立颗粒噪声的比值恒定在 1.0 附近（噪声独立时 lag1 统计上等于 lag2），
  // 原来的 0.9 正好切在假阳性那一堆里，颗粒重的素材会误报成闪烁。
  // 取 2.0：距假阳性上界和真阳性下界各有 2 倍余量。
  const FLICKER_RATIO = 2.0;

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



  // ---------- 残影 / 拖影 ----------
  // 看连续两次帧间残差的相关性：d1 = 当前-前一, d2 = 前一-前两，都先去掉各自均值。
  // 实测/解析三档：
  //   独立颗粒噪声   -0.5  ← d1 和 d2 共享中间帧，噪声项符号相反，这是解析基线
  //   区内部分像素翻转 →-1  ← 一部分在隔帧翻、一部分不动，两次残差的空间图案完全反相
  //   均匀闪烁/普通运动 ~0  ← 整块一起翻时残差没有空间结构，这个度量说不了话
  // 注意它量的是「空间图案的相关性」，不是整体亮度的翻转，所以均匀闪烁看不出来——
  // 判闪烁靠 scanVerdict 的 lag-2 比值，这里只做独立佐证。
  //
  // 残影/拖影：合成样本上 corr 只有 +0.11~0.14，和普通运动的 -0.02 差 0.15，
  // 且对 alpha 不单调（0.3→0.108, 0.5→0.138, 0.7→0.107），区分度不够，
  // 所以不拿它判残影。要判残影得先做块匹配做运动补偿，再看补偿后的拖尾残差。
  function temporalResidual(prev2, prev, cur, rect) {
    const crop = (f) => (rect ? cropFrame(f, rect) : f);
    const a = crop(prev2).data;
    const b = crop(prev).data;
    const c = crop(cur).data;
    const n = Math.min(a.length, b.length, c.length) / 4;
    if (n < 16) return null;
    let s1 = 0, s2 = 0, n1 = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      s1 += luma(c, p) - luma(b, p);
      s2 += luma(b, p) - luma(a, p);
      n1++;
    }
    const m1 = s1 / n1, m2 = s2 / n1;
    let cov = 0, v1 = 0, v2 = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const d1 = (luma(c, p) - luma(b, p)) - m1;
      const d2 = (luma(b, p) - luma(a, p)) - m2;
      cov += d1 * d2; v1 += d1 * d1; v2 += d2 * d2;
    }
    const rms1 = Math.sqrt(v1 / n1), rms2 = Math.sqrt(v2 / n1);
    const corr = rms1 > 0.01 && rms2 > 0.01 ? cov / n1 / (rms1 * rms2) : 0;
    return { corr, rms1, rms2, decay: rms2 > 0.01 ? rms1 / rms2 : 0 };
  }

  // ---------- 接缝梯度剖面：不贴合 / 边界呼吸 / 切断 ----------
  // seamColorDelta 比的是边内外「均值」，只抓得到偏色。
  // 均值相同但有一条硬边（暗描边、补丁把内容切断）它完全看不见，
  // 所以这里量跨边的梯度台阶，并和边外本身的局部梯度做比。
  // 合成缝的决定性特征是：台阶在画面坐标里不动，而内容在动。
  function edgeStepProfile(frame, rect) {
    const { data, width, height } = frame;
    const r = clampRect(rect, width, height);
    const at = (x, y) => luma(data, ((y * width + x) << 2));
    const edges = {
      top:    { along: 'x', from: r.x, to: r.x + r.w, line: r.y,           out: -1 },
      bottom: { along: 'x', from: r.x, to: r.x + r.w, line: r.y + r.h - 1, out: 1 },
      left:   { along: 'y', from: r.y, to: r.y + r.h, line: r.x,           out: -1 },
      right:  { along: 'y', from: r.y, to: r.y + r.h, line: r.x + r.w - 1, out: 1 }
    };
    // 真实合成缝常有 2-3px 粗。只跨 1 像素量，厚缝会同时落在「内」和「外」
    // 两个采样点上 —— 台阶归零，而噪声基准反被抬高，结果比平整的边还低。
    // 所以台阶取 d=1..3 里最大的那个，噪声基准退到 d=4..6（厚缝碰不到的地方）。
    const PROBE = [1, 2, 3];
    const BASE = [4, 5, 6];
    const out = {};
    for (const [name, e] of Object.entries(edges)) {
      const steps = [];
      const noises = [];
      for (let t = e.from; t < e.to; t++) {
        const px = (depth) => (e.along === 'x'
          ? [t, e.line + e.out * depth]
          : [e.line + e.out * depth, t]);
        const inBounds = ([x, y]) => x >= 0 && y >= 0 && x < width && y < height;
        const far = px(BASE[BASE.length - 1]);
        if (!inBounds(far)) continue;
        const inside = px(0);
        let step = 0;
        for (const d of PROBE) {
          const o = px(d);
          step = Math.max(step, Math.abs(at(inside[0], inside[1]) - at(o[0], o[1])));
        }
        const baseVals = BASE.map(d => { const o = px(d); return at(o[0], o[1]); });
        let noise = 0;
        for (let i = 1; i < baseVals.length; i++) noise = Math.max(noise, Math.abs(baseVals[i] - baseVals[i - 1]));
        steps.push(step);
        noises.push(noise);
      }
      if (!steps.length) { out[name] = null; continue; }
      const step = median(steps);
      const noise = Math.max(median(noises), 0.5);
      const ratio = step / noise;
      // 覆盖率：边上有多少比例的位置台阶明显超过本地梯度。
      // 贴满整条边 = 合成缝；只占一段 = 内容在那里被切断了。
      const isHot = steps.map((v, i) => v >= Math.max(noises[i] * 3, 6));
      const hot = isHot.filter(Boolean).length;
      // 「切断」是局部的：亮条只占边长两成，中位数完全不动。
      // 所以另外量最长的一段连续硬边 —— 纹理噪声是零散的点，
      // 内容被切断是连成一段的。贯通的合成缝则是整条边都连着。
      let run = 0;
      let runStart = 0;
      let cur = 0;
      let curStart = 0;
      for (let i = 0; i < isHot.length; i++) {
        if (isHot[i]) {
          if (!cur) curStart = i;
          cur++;
          if (cur > run) { run = cur; runStart = curStart; }
        } else cur = 0;
      }
      const runSteps = steps.slice(runStart, runStart + run);
      out[name] = {
        step,
        noise,
        ratio,
        coverage: hot / steps.length,
        run: run / steps.length,
        runStep: run ? median(runSteps) : 0,
        runRatio: run ? median(runSteps) / noise : 0,
        length: steps.length
      };
    }
    return out;
  }

  function seamStepVerdict(profile) {
    const edges = Object.entries(profile).filter(([, v]) => v);
    if (!edges.length) return { kind: 'unknown', text: '选区贴边了，量不到接缝', worst: null };
    const name = { top: '上', bottom: '下', left: '左', right: '右' };
    // 贯通的合成缝：整条边都连着硬台阶
    const through = edges.filter(([, v]) => v.run >= 0.7 && v.runRatio >= 3);
    if (through.length) {
      const worst = through.reduce((a, b) => (b[1].runRatio > a[1].runRatio ? b : a));
      const [k, m] = worst;
      const many = through.length >= 2 ? `有 ${through.length} 条边贯通硬边，最明显是${name[k]}边：` : `${name[k]}边贯通硬边：`;
      return {
        kind: 'seam',
        worst: { edge: k, ...m },
        text: `${many}台阶是边外本地梯度的 ${m.runRatio.toFixed(1)} 倍、连成 ${(m.run * 100) | 0}% 边长，补丁没和底层贴合`
      };
    }
    // 局部切断：一段连续硬边，但没贯通，而且这一段明显高于该边常态。
    // 最后这个条件用来和「整块偏色」分开：均匀偏色的缝在纹理强的区段会被
    // 淹没、连不成贯通段，但它整条边都在偏，runRatio 和中位 ratio 几乎相等
    // （实测 5.0 vs 4.8）；真正的切断是局部突起（32.8 vs 1.5）。
    // 整块偏色由 seamColorDelta 负责报，不在这里重复。
    const cuts = edges.filter(([, v]) => v.run >= 0.08 && v.runRatio >= 4 && v.runRatio >= v.ratio * 3);
    if (cuts.length) {
      const worst = cuts.reduce((a, b) => (b[1].runRatio > a[1].runRatio ? b : a));
      const [k, m] = worst;
      return {
        kind: 'cut',
        worst: { edge: k, ...m },
        text: `${name[k]}边有一段硬切：连续 ${(m.run * 100) | 0}% 边长上台阶达 ${m.runRatio.toFixed(1)} 倍，像是补丁边界把画面内容切断了`
      };
    }
    const worst = edges.reduce((a, b) => (b[1].runRatio > a[1].runRatio ? b : a));
    const [k, m] = worst;
    return {
      kind: 'ok',
      worst: { edge: k, ...m },
      text: `四条边都没有明显硬边（最大的在${name[k]}边，连续段 ${(m.run * 100) | 0}% 边长、台阶 ${m.runRatio.toFixed(1)} 倍）`
    };
  }

  // 边界呼吸：台阶强度逐帧起伏。合成缝如果每帧都在变，matte 在呼吸。
  // 稳定的台阶是「一条固定的缝」，起伏的台阶是「缝在动」，后者更刺眼。
  function breathingVerdict(series) {
    const values = series.filter(Number.isFinite);
    if (values.length < 4) return { kind: 'unknown', text: '帧数太少，看不出边界呼吸', cv: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean < 1) return { kind: 'ok', text: '接缝台阶一直很弱，没有呼吸', cv: 0, mean };
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length);
    const cv = sd / mean;
    if (cv >= 0.35) {
      return { kind: 'breathing', cv, mean, text: `接缝强度逐帧起伏（变异系数 ${cv.toFixed(2)}，均值 ${mean.toFixed(1)}），边界在呼吸` };
    }
    return { kind: 'ok', cv, mean, text: `接缝强度逐帧稳定（变异系数 ${cv.toFixed(2)}），没有呼吸` };
  }

  // ---------- 补丁区限定扫描 ----------
  // 全画幅 diff 会被面积稀释：同一个隔帧闪烁的补丁，占画幅 17% 时量出 2.7 倍，
  // 4% 时只剩 1.1 倍（刚过阈值），≤2% 就彻底判成平稳。而限定在补丁区内一律 15.6 倍。
  // 眼睛/嘴/手的补丁典型就占 1-3%，所以补丁级的闪烁和硬接必须在区内量。
  function cropFrame(frame, rect) {
    const r = clampRect(rect, frame.width, frame.height);
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const src = ((y + r.y) * frame.width + (x + r.x)) * 4;
        const dst = (y * r.w + x) * 4;
        out[dst] = frame.data[src];
        out[dst + 1] = frame.data[src + 1];
        out[dst + 2] = frame.data[src + 2];
        out[dst + 3] = 255;
      }
    }
    return { data: out, width: r.w, height: r.h };
  }

  // 同尺寸的区外对照区：优先取左右(同一高度，光照和内容最接近)，再试上下。
  // 对照区的作用是归因 —— 同一个毛病是补丁独有，还是整幅都有。
  function controlRect(rect, width, height) {
    const r = clampRect(rect, width, height);
    const gap = Math.max(4, Math.round(Math.min(r.w, r.h) * 0.2));
    const candidates = [
      { x: r.x - r.w - gap, y: r.y },
      { x: r.x + r.w + gap, y: r.y },
      { x: r.x, y: r.y - r.h - gap },
      { x: r.x, y: r.y + r.h + gap }
    ];
    for (const c of candidates) {
      if (c.x >= 0 && c.y >= 0 && c.x + r.w <= width && c.y + r.h <= height) {
        return { x: c.x, y: c.y, w: r.w, h: r.h };
      }
    }
    return null;
  }

  // 扫描时的采样簿记：内部存前一帧和前两帧，push 一帧吐一条样本。
  // CLI 和 GUI 都用它，避免两边各写一遍 prev/prev2 的逻辑。
  function createScanSampler(options = {}) {
    const rect = options.rect || null;
    const control = options.control || null;
    let prev = null;
    let prev2 = null;
    const pick = (frame, r) => (r ? cropFrame(frame, r) : frame);
    return {
      push(index, frame) {
        const cur = { roi: pick(frame, rect), ctrl: control ? cropFrame(frame, control) : null };
        let sample = null;
        if (prev) {
          const stats = frameDiffStats(prev.roi, cur.roi);
          if (prev2) stats.mean2 = frameDiffStats(prev2.roi, cur.roi).mean;
          sample = { frame: index, ...stats };
          if (cur.ctrl && prev.ctrl) {
            const c = frameDiffStats(prev.ctrl, cur.ctrl);
            if (prev2 && prev2.ctrl) c.mean2 = frameDiffStats(prev2.ctrl, cur.ctrl).mean;
            sample.control = { frame: index, ...c };
          }
        }
        prev2 = prev;
        prev = cur;
        return sample;
      }
    };
  }

  function scanVerdict(samples, options = {}) {
    const values = samples.map(item => item.mean);
    if (values.length < 3) return { kind: 'unknown', text: '帧数太少，看不出规律', base: 0, peak: null, shaky: [], localized: null, control: null };
    const base = median(values);
    const lag2 = samples.filter(item => Number.isFinite(item.mean2)).map(item => item.mean2);
    // 隔帧闪烁越干净，lag-2 越接近 0（抖动在隔一帧上完全抵消）。
    // 原来拿 median(lag2) > 0.05 当守卫，结果最强的信号反被判成平稳：
    // 实测静止镜头上 ±22 的隔帧闪烁 lag1=44.0 / lag2=0.000，直接漏掉。
    // 真正该退出的条件是 lag1 也很小 —— 画面根本没动，没得判。
    const lag2Med = lag2.length >= 3 ? median(lag2) : null;
    const flickerSaturated = lag2Med !== null && base > FLICKER_FLOOR && lag2Med <= 0.02;
    const flickerRatio = lag2Med === null || base <= FLICKER_FLOOR ? 0
      : flickerSaturated ? FLICKER_CAP
      : Math.min(base / lag2Med, FLICKER_CAP);
    const floor = Math.max(base, 0.6);
    const scored = samples.map((item, index) => ({ ...item, index, ratio: item.mean / floor }));
    const peak = scored.reduce((best, item) => (item.ratio > best.ratio ? item : best), scored[0]);
    const shaky = scored.filter(item => item.ratio >= 1.8 && item !== peak);
    // 对照区单独跑一遍（不再传 control，避免递归）。它不压报警，只回答
    // 「这毛病是补丁独有的，还是整幅都这样」。
    const ctrlSamples = options.control === undefined
      ? samples.map(item => item.control).filter(Boolean)
      : options.control;
    const ctrl = Array.isArray(ctrlSamples) && ctrlSamples.length >= 3 ? scanVerdict(ctrlSamples, { control: null }) : null;
    const scoped = options.scope || (ctrl ? '补丁区' : null);
    const label = scoped ? scoped : '区间内';
    const sameAsCtrl = kind => {
      if (!ctrl || ctrl.kind !== kind) return false;
      if (kind !== 'jump') return true;
      return !!ctrl.peak && Math.abs(ctrl.peak.frame - peak.frame) <= 1;
    };
    const attribute = kind => (sameAsCtrl(kind)
      ? '；画面其他地方也一样，不是补丁单独的问题'
      : ctrl ? '；区外对照区正常，是这块补丁自己的问题' : '');
    if (flickerRatio >= FLICKER_RATIO) {
      return {
        kind: 'flicker',
        base,
        peak,
        shaky,
        flickerRatio,
        localized: ctrl ? !sameAsCtrl('flicker') : null,
        control: ctrl,
        text: (flickerSaturated
          ? `${label}整段在隔帧闪烁：隔一帧之间几乎没有差异，而相邻帧差异有 ${base.toFixed(1)}（一帧一换的典型指纹）`
          : `${label}整段在隔帧闪烁：相邻帧差异是隔一帧的 ${flickerRatio.toFixed(1)} 倍（正常运动约 0.5）`) + attribute('flicker')
      };
    }
    if (peak.ratio >= 3 && shaky.length <= Math.max(1, values.length * 0.15)) {
      return {
        kind: 'jump',
        base,
        peak,
        shaky,
        flickerRatio,
        localized: ctrl ? !sameAsCtrl('jump') : null,
        control: ctrl,
        text: `${label}第 ${peak.frame + 1} 帧跳变明显：帧间变化是常态的 ${peak.ratio.toFixed(1)} 倍，像是缺帧硬接` + attribute('jump')
      };
    }
    if (shaky.length >= 3 || (peak.ratio >= 1.8 && shaky.length >= 2)) {
      return {
        kind: 'shake',
        base,
        peak,
        shaky,
        flickerRatio,
        localized: ctrl ? !sameAsCtrl('shake') : null,
        control: ctrl,
        text: `${label}有 ${shaky.length + 1} 帧帧间变化偏高（峰值在第 ${peak.frame + 1} 帧），更像是持续抖动/闪烁` + attribute('shake')
      };
    }
    // 1.8 倍这一档不再当成毛病：实测干净素材(人物正常走动)的峰值就能到 1.8 倍，
    // 而真实的缺帧硬接是 3.4 倍以上。报出来会变成狼来了，所以只在文案里带一句。
    if (peak.ratio >= 1.8) {
      return {
        kind: 'ok',
        base,
        peak,
        shaky,
        flickerRatio,
        localized: null,
        control: ctrl,
        text: `${label}没有明显跳变或闪烁（最大的一次在第 ${peak.frame + 1} 帧，${peak.ratio.toFixed(1)} 倍，仍属正常运动范围）`
      };
    }
    return { kind: 'ok', base, peak, shaky, flickerRatio, localized: null, control: ctrl, text: `${label}帧间变化平稳，没有明显跳变或闪烁` };
  }

  // 自动对齐：对每个候选偏移量出一组差异，取「平均差异最小」的那个。
  // 返回片常见少 1 帧或整体偏几帧，对不齐的话 A/B 和差异图全是假象。
  function pickBestOffset(scores) {
    if (!Array.isArray(scores) || !scores.length) return { offset: 0, confident: false, best: 0, runnerUp: 0 };
    const ranked = [...scores].sort((a, b) => a.diff - b.diff);
    const best = ranked[0];
    const others = ranked.filter(item => Math.abs(item.offset - best.offset) > 1);
    const runnerUp = others.length ? others[0].diff : best.diff;
    // 真正对上的偏移，差异会断崖式低于次优；只好 15% 那种多半是画面本身差异不大，
    // 或者整条片子根本没有统一偏移（中间丢过帧），都不该当成可信结果。
    const confident = runnerUp > 0 && best.diff <= runnerUp * 0.7;
    return { offset: best.offset, best: best.diff, runnerUp, confident };
  }

  return {
    pickBestOffset,
    frameDiffStats,
    diffImage,
    laplacianVariance,
    meanColor,
    seamColorDelta,
    analyzeSelection,
    estimateEffectiveScale,
    resampleRoi,
    scanVerdict,
    cropFrame,
    controlRect,
    createScanSampler,
    temporalResidual,
    edgeStepProfile,
    seamStepVerdict,
    breathingVerdict,
    clampRect
  };
});
