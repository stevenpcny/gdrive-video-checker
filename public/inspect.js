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

  // ---------- 接缝颜色：CIELAB ΔE ----------
  // flow-video-patch 的验收要求「沿贴回边缘取内侧(生成)和外侧(原片)几十像素宽的
  // 同类区域比 LAB，并写明颜色转换、取样区域和 ΔE 算法」。这里统一用：
  //   解码后的 8 位 RGB 按 sRGB(BT.709 原色, D65) 线性化 → XYZ → CIELAB，ΔE = CIE76。
  // 这不是 OpenCV 的 8 位 LAB 编码距离，也不是 ΔE2000；数值只辅助定位，不是通用阈值。
  const LINEAR = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const labF = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

  function rgbToLab(r, g, b) {
    const R = LINEAR[r | 0];
    const G = LINEAR[g | 0];
    const B = LINEAR[b | 0];
    const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
    const y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
    const z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
    const fx = labF(x);
    const fy = labF(y);
    const fz = labF(z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  // 逐像素转 LAB 再平均（先平均 RGB 再转会被高光/暗部拉偏）
  function meanLab(frame, rect) {
    const { data, width, height } = frame;
    const x0 = Math.max(0, Math.round(rect.x));
    const y0 = Math.max(0, Math.round(rect.y));
    const x1 = Math.min(width, Math.round(rect.x + rect.w));
    const y1 = Math.min(height, Math.round(rect.y + rect.h));
    let L = 0;
    let A = 0;
    let B = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
        L += lab.L;
        A += lab.a;
        B += lab.b;
        n++;
      }
    }
    return n ? { L: L / n, a: A / n, b: B / n, n } : null;
  }

  const deltaE76 = (p, q) => Math.sqrt((p.L - q.L) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2);

  // 逐条边比内外：上边常是发际/额头，下边常是下巴/脖子，不能混在一起平均。
  // 内带要越过羽化带（那里只被改了一半，会低估差异），取 feather+near … feather+far；
  // 外带取边外 near … far。near/far 按 4K 下 16/70 像素随画面高度缩放。
  // ellipse 的贴回区只在包围盒四边中点贴边，所以只取每条边中间 40%。
  function seamLab(frame, rect, options = {}) {
    const { width, height } = frame;
    const scale = Math.max(0.25, (options.frameHeight || height) / 2160);
    const feather = Math.max(0, options.feather || 0);
    const near = Math.max(2, Math.round(16 * scale));
    let far = Math.max(near + 4, Math.round(70 * scale));
    const maxInset = Math.floor(Math.min(rect.w, rect.h) / 2) - 1;
    const innerStart = Math.min(maxInset - 2, Math.round(feather) + near);
    const innerEnd = Math.min(maxInset, Math.round(feather) + far);
    if (innerEnd - innerStart < 2) return { edges: {}, worst: null, near, far, unit: 'CIE76' };
    far = Math.max(far, near + 2);
    const along = options.shape === 'ellipse' ? 0.4 : 1;
    const span = (start, len) => ({ s: start + len * (1 - along) / 2, l: len * along });
    const hs = span(rect.x, rect.w);
    const vs = span(rect.y, rect.h);
    const bands = {
      top: {
        inner: { x: hs.s, y: rect.y + innerStart, w: hs.l, h: innerEnd - innerStart },
        outer: { x: hs.s, y: rect.y - far, w: hs.l, h: far - near }
      },
      bottom: {
        inner: { x: hs.s, y: rect.y + rect.h - innerEnd, w: hs.l, h: innerEnd - innerStart },
        outer: { x: hs.s, y: rect.y + rect.h + near, w: hs.l, h: far - near }
      },
      left: {
        inner: { x: rect.x + innerStart, y: vs.s, w: innerEnd - innerStart, h: vs.l },
        outer: { x: rect.x - far, y: vs.s, w: far - near, h: vs.l }
      },
      right: {
        inner: { x: rect.x + rect.w - innerEnd, y: vs.s, w: innerEnd - innerStart, h: vs.l },
        outer: { x: rect.x + rect.w + near, y: vs.s, w: far - near, h: vs.l }
      }
    };
    const inside = r => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height && r.w >= 1 && r.h >= 1;
    const edges = {};
    let worst = null;
    for (const [name, band] of Object.entries(bands)) {
      if (!inside(band.inner) || !inside(band.outer)) { edges[name] = null; continue; }
      const a = meanLab(frame, band.inner);
      const b = meanLab(frame, band.outer);
      if (!a || !b) { edges[name] = null; continue; }
      const item = { dE: deltaE76(a, b), dL: a.L - b.L, da: a.a - b.a, db: a.b - b.b, inner: a, outer: b };
      edges[name] = item;
      if (!worst || item.dE > worst.dE) worst = { edge: name, ...item };
    }
    return { edges, worst, near, far, unit: 'CIE76', innerOffset: [innerStart, innerEnd] };
  }

  // 有原片时只算补丁「新引入」的接缝色差：成片的(内-外) 减去 原片同位置的(内-外)。
  // 原片里边内外本来就不同（脸和头发、皮肤和衣领）是内容，不是补丁的问题。
  function seamLabRelative(finished, source, rect, options = {}) {
    const f = seamLab(finished, rect, options);
    const s = seamLab(source, rect, options);
    const edges = {};
    let worst = null;
    for (const name of ['top', 'bottom', 'left', 'right']) {
      const a = f.edges[name];
      const b = s.edges[name];
      if (!a || !b) { edges[name] = null; continue; }
      const dL = a.dL - b.dL;
      const da = a.da - b.da;
      const db = a.db - b.db;
      const item = { dE: Math.sqrt(dL * dL + da * da + db * db), dL, da, db, raw: a.dE, original: b.dE };
      edges[name] = item;
      if (!worst || item.dE > worst.dE) worst = { edge: name, ...item };
    }
    return { edges, worst, near: f.near, far: f.far, unit: 'CIE76', relative: true, innerOffset: f.innerOffset };
  }

  // 接缝色差随时间：既看最大值，也看相邻采样之间有没有跳（颜色跳 = 时间不稳定）。
  // 4 / 8 只是提示档（ΔE76≈2.3 是一般可察觉差），最终以画面为准。
  function seamColorVerdict(series) {
    const values = series.filter(item => item && item.worst);
    if (!values.length) return { kind: 'unknown', text: '贴边或区域太小，量不到接缝颜色', max: null };
    const max = values.reduce((a, b) => (b.worst.dE > a.worst.dE ? b : a));
    let jump = null;
    for (let i = 1; i < values.length; i++) {
      for (const edge of ['top', 'bottom', 'left', 'right']) {
        const p = values[i - 1].edges && values[i - 1].edges[edge];
        const q = values[i].edges && values[i].edges[edge];
        if (!p || !q) continue;
        const d = Math.abs(q.dE - p.dE);
        if (!jump || d > jump.d) jump = { d, edge, from: values[i - 1].frame, to: values[i].frame };
      }
    }
    const name = { top: '上', bottom: '下', left: '左', right: '右' };
    const w = max.worst;
    const tint = `ΔL ${w.dL >= 0 ? '+' : ''}${w.dL.toFixed(1)} Δa ${w.da >= 0 ? '+' : ''}${w.da.toFixed(1)} Δb ${w.db >= 0 ? '+' : ''}${w.db.toFixed(1)}`;
    const rel = values[0].relative;
    const head = `${name[w.edge]}边${rel ? '补丁引入的' : ''}内外色差最大 ΔE76 ${w.dE.toFixed(1)}（第 ${max.frame + 1} 帧，${tint}${rel ? `；原片同位置本来差 ${w.original.toFixed(1)}` : ''}）`;
    const jumpText = jump && jump.d >= 3 ? `；${name[jump.edge]}边色差在第 ${jump.from + 1}→${jump.to + 1} 帧之间跳了 ${jump.d.toFixed(1)}，颜色随时间不稳` : '';
    const kind = w.dE >= 8 || (jump && jump.d >= 5) ? 'fail' : w.dE >= 4 || (jump && jump.d >= 3) ? 'warn' : 'ok';
    const lead = kind === 'fail' ? '接缝色差明显：' : kind === 'warn' ? '接缝有轻微色差：' : '接缝颜色基本一致：';
    return { kind, max: { frame: max.frame, ...w }, jump, text: lead + head + jumpText };
  }

  // ---------- 成片 vs 原片：遮罩外有没有被改动 ----------
  // 未修区应只剩编码噪声。分块比 RGB 平均绝对差，先用全体分块的中位数当噪声基线，
  // 再找明显高出基线的块——衣服被调色波及、旧轮廓、整幅偏色都会在这里冒出来。
  // exclude 里的矩形（贴回区及其羽化外扩）不参与。两帧必须同尺寸、已对齐。
  function regionChange(a, b, options = {}) {
    if (a.width !== b.width || a.height !== b.height) throw new Error('两帧尺寸不同，没法逐像素比');
    const { width, height } = a;
    const block = options.block || Math.max(8, Math.round(Math.min(width, height) / 24));
    const exclude = options.exclude || [];
    const only = options.only || null;
    const hits = (x, y, w, h, r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y;
    const blocks = [];
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let total = 0;
    for (let by = 0; by < height; by += block) {
      for (let bx = 0; bx < width; bx += block) {
        const bw = Math.min(block, width - bx);
        const bh = Math.min(block, height - by);
        if (only && !only.some(r => hits(bx, by, bw, bh, r))) continue;
        if (exclude.some(r => hits(bx, by, bw, bh, r))) continue;
        let d = 0;
        let dr = 0;
        let dg = 0;
        let db = 0;
        let n = 0;
        for (let y = by; y < by + bh; y++) {
          for (let x = bx; x < bx + bw; x++) {
            if (only && !only.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue;
            const i = (y * width + x) * 4;
            const r = a.data[i] - b.data[i];
            const g = a.data[i + 1] - b.data[i + 1];
            const bl = a.data[i + 2] - b.data[i + 2];
            d += (Math.abs(r) + Math.abs(g) + Math.abs(bl)) / 3;
            dr += r;
            dg += g;
            db += bl;
            n++;
          }
        }
        if (!n) continue;
        sumR += dr;
        sumG += dg;
        sumB += db;
        total += n;
        blocks.push({ x: bx, y: by, w: bw, h: bh, mean: d / n, shift: { r: dr / n, g: dg / n, b: db / n } });
      }
    }
    if (!blocks.length) return { blocks: 0, base: 0, worst: null, hot: [], shift: null };
    const base = median(blocks.map(item => item.mean));
    const limit = Math.max(options.minLevel || 6, base * 4);
    const hot = blocks.filter(item => item.mean >= limit).sort((x, y) => y.mean - x.mean);
    const worst = blocks.reduce((p, q) => (q.mean > p.mean ? q : p));
    // 整体偏色取各块偏移的中位数：一小块衣服被改不该被当成整幅偏色
    const shift = { r: median(blocks.map(b => b.shift.r)), g: median(blocks.map(b => b.shift.g)), b: median(blocks.map(b => b.shift.b)) };
    return {
      blocks: blocks.length,
      base,
      limit,
      worst,
      hot,
      hotShare: hot.length / blocks.length,
      shift,
      meanShift: total ? { r: sumR / total, g: sumG / total, b: sumB / total } : null
    };
  }

  function outsideVerdict(result) {
    if (!result || !result.blocks) return { kind: 'unknown', text: '没有可比的未修区' };
    const s = result.shift;
    const tint = s ? `R${s.r >= 0 ? '+' : ''}${s.r.toFixed(1)} G${s.g >= 0 ? '+' : ''}${s.g.toFixed(1)} B${s.b >= 0 ? '+' : ''}${s.b.toFixed(1)}` : '';
    const global = s && Math.max(Math.abs(s.r), Math.abs(s.g), Math.abs(s.b)) >= 3;
    if (global) {
      return { kind: 'fail', global: true, text: `未修区整体偏色（${tint}），成片和原片的颜色处理不一致` };
    }
    if (result.hot.length) {
      const w = result.hot[0];
      return {
        kind: 'fail',
        at: { x: w.x, y: w.y, w: w.w, h: w.h },
        text: `贴回区以外有 ${result.hot.length} 块被改动（最大差 ${w.mean.toFixed(1)}，噪声基线 ${result.base.toFixed(1)}），位置约 x=${w.x} y=${w.y}`
      };
    }
    return { kind: 'ok', text: `贴回区以外只有编码噪声（基线 ${result.base.toFixed(1)}，最大块 ${result.worst.mean.toFixed(1)}）` };
  }

  // 保护区（原嘴、话筒）应完全来自原片：区内差异应和区外未修区的噪声同一水平
  function protectVerdict(inside, baseline) {
    if (!inside || !inside.blocks) return { kind: 'unknown', text: '保护区太小或在画外，没法比' };
    const noise = Math.max(1, baseline || inside.base);
    const worst = inside.worst.mean;
    if (worst >= Math.max(6, noise * 4)) {
      return { kind: 'fail', text: `保护区内有改动（最大差 ${worst.toFixed(1)}，未修区噪声 ${noise.toFixed(1)}），原嘴/保护内容没保住` };
    }
    return { kind: 'ok', text: `保护区和原片一致（最大差 ${worst.toFixed(1)}，噪声 ${noise.toFixed(1)}）` };
  }

  // 补丁跟着人动时，扫描框也得跟着动：每帧按当帧几何取同尺寸的框，
  // 对照区固定取第一帧选定的那一侧（中途换边会把两块不同的地方拿来比）。
  function createTrackedSampler(options = {}) {
    let size = null;
    let ctrlOffset = null;
    let prev = null;
    let prev2 = null;
    const fit = (r, w, h, width, height) => ({
      x: Math.max(0, Math.min(width - w, Math.round(r.x + r.w / 2 - w / 2))),
      y: Math.max(0, Math.min(height - h, Math.round(r.y + r.h / 2 - h / 2))),
      w,
      h
    });
    return {
      push(index, frame, rect) {
        if (!size) {
          size = { w: Math.max(2, Math.min(frame.width, Math.round(rect.w))), h: Math.max(2, Math.min(frame.height, Math.round(rect.h))) };
          const first = fit(rect, size.w, size.h, frame.width, frame.height);
          const c = options.control === false ? null : controlRect(first, frame.width, frame.height);
          ctrlOffset = c && (c.x !== first.x || c.y !== first.y) ? { dx: c.x - first.x, dy: c.y - first.y } : null;
        }
        const r = fit(rect, size.w, size.h, frame.width, frame.height);
        const cur = { roi: cropFrame(frame, r), ctrl: null, rect: r };
        if (ctrlOffset) {
          const cr = { x: r.x + ctrlOffset.dx, y: r.y + ctrlOffset.dy, w: r.w, h: r.h };
          if (cr.x >= 0 && cr.y >= 0 && cr.x + cr.w <= frame.width && cr.y + cr.h <= frame.height) cur.ctrl = cropFrame(frame, cr);
        }
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

  // 接点：窗口内第 at 帧（相对前一帧）的变化是不是孤立尖峰
  function junctionVerdict(samples, at) {
    const hit = samples.find(item => item.frame === at);
    const others = samples.filter(item => item.frame !== at).map(item => item.mean);
    if (!hit || others.length < 3) return { kind: 'unknown', ratio: 0, text: '接点前后帧数不够，量不了' };
    const base = Math.max(median(others), 0.6);
    const ratio = hit.mean / base;
    if (ratio >= 3) return { kind: 'fail', ratio, text: `第 ${at + 1} 帧接点跳变：变化是前后常态的 ${ratio.toFixed(1)} 倍` };
    if (ratio >= 2) return { kind: 'warn', ratio, text: `第 ${at + 1} 帧接点有轻微跳动（${ratio.toFixed(1)} 倍），慢放确认` };
    return { kind: 'ok', ratio, text: `第 ${at + 1} 帧接点过渡平稳（${ratio.toFixed(1)} 倍）` };
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
    clampRect,
    rgbToLab,
    meanLab,
    deltaE76,
    seamLab,
    seamLabRelative,
    seamColorVerdict,
    regionChange,
    outsideVerdict,
    protectVerdict,
    createTrackedSampler,
    junctionVerdict
  };
});
