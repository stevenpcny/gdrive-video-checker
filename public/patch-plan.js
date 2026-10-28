(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatchPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 读 flow-video-patch 的 merge.json 或合成后旁置的 *.report.json，
  // 换算成「第几帧、补丁在成片的哪块像素」。几何规则必须和 flow_patch.py 一模一样：
  //   - 关键帧 [{frame, value}] 按绝对源帧号线性插值，两端沿用端值（np.interp）
  //   - 矩形四舍五入成整数
  //   - crop 在原片像素里；matte.region / protect 在 work_size 局部画布里，
  //     贴回时按 crop.w/work.w、crop.h/work.h 缩放
  //   - 帧号从 0 开始，target 是 [start, end) 左闭右开

  function fail(message) { throw new Error(message); }

  function parseFps(value) {
    if (typeof value === 'number' && value > 0) return value;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(String(value || ''));
    if (!m) return 0;
    const fps = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
    return Number.isFinite(fps) && fps > 0 ? fps : 0;
  }

  // 常量向量，或线性关键帧
  function curve(value, frame) {
    if (!Array.isArray(value) || !value.length) fail('需要非空数值向量');
    if (value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) {
      const keys = value;
      for (let i = 1; i < keys.length; i++) {
        if (!(keys[i - 1].frame < keys[i].frame)) fail('关键帧的 frame 必须严格递增');
      }
      const dims = keys[0].value.length;
      const out = [];
      for (let d = 0; d < dims; d++) {
        if (frame <= keys[0].frame) { out.push(keys[0].value[d]); continue; }
        if (frame >= keys[keys.length - 1].frame) { out.push(keys[keys.length - 1].value[d]); continue; }
        let k = 0;
        while (keys[k + 1].frame < frame) k++;
        const a = keys[k];
        const b = keys[k + 1];
        const t = (frame - a.frame) / (b.frame - a.frame);
        out.push(a.value[d] + (b.value[d] - a.value[d]) * t);
      }
      return out;
    }
    return value.map(Number);
  }

  // Python 的 round 是银行家舍入，矩形坐标落在 .5 上时要和它一致
  function roundHalfEven(v) {
    const r = Math.round(v);
    return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }

  function rectAt(value, frame) {
    const [x, y, w, h] = curve(value, frame).map(roundHalfEven);
    return { x, y, w, h };
  }

  // 工作画布坐标 → 成片像素坐标
  function workToSource(rect, crop, work) {
    const sx = crop.w / work[0];
    const sy = crop.h / work[1];
    return { x: crop.x + rect.x * sx, y: crop.y + rect.y * sy, w: rect.w * sx, h: rect.h * sy };
  }

  // 输入可以是 merge.json、report.json（configuration 字段里就是 merge 配置），
  // 或者已经 JSON.parse 过的对象。返回统一结构。
  function parse(input) {
    let doc = input;
    if (typeof doc === 'string') {
      try { doc = JSON.parse(doc); } catch { fail('不是合法的 JSON'); }
    }
    if (!doc || typeof doc !== 'object') fail('补丁配置为空');
    const report = doc.configuration && Array.isArray(doc.configuration.patches) ? doc : null;
    const cfg = report ? doc.configuration : doc;
    if (!Array.isArray(cfg.patches) || !cfg.patches.length) {
      fail(doc.mode === 'prepare' || doc.prepare ? '这是 prepare 的配置/报告，没有贴回信息；请用 merge 的配置或报告' : '找不到 patches，不是 flow-video-patch 的 merge 配置或报告');
    }
    const fps = parseFps(cfg.fps);
    const sourceSize = Array.isArray(cfg.source_size) ? cfg.source_size.map(Number) : null;
    const patches = cfg.patches.map((p, index) => {
      if (!Array.isArray(p.target) || p.target.length !== 2) fail(`第 ${index + 1} 个补丁缺 target`);
      const [start, end] = p.target.map(Number);
      if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start)) fail(`第 ${index + 1} 个补丁的 target 不合法`);
      if (!p.crop || !Array.isArray(p.work_size) || !p.matte || !p.matte.region) fail(`第 ${index + 1} 个补丁缺 crop / work_size / matte.region`);
      return {
        index,
        name: String(p.name || `patch-${index + 1}`),
        start,
        end,
        crop: p.crop,
        work: p.work_size.map(Number),
        region: p.matte.region,
        shape: p.matte.shape === 'ellipse' ? 'ellipse' : 'rect',
        feather: Number.isFinite(Number(p.matte.feather)) ? Number(p.matte.feather) : 16,
        protect: Array.isArray(p.matte.protect) ? p.matte.protect : [],
        blend: p.blend || 'alpha',
        fade: Number(p.fade_frames) || 0,
        frameMap: Array.isArray(p.frame_map) ? p.frame_map : null
      };
    });
    const out = report && report.output ? report.output : null;
    return {
      kind: report ? 'report' : 'merge',
      fps,
      sourceSize,
      frames: out && Number.isInteger(out.frames) ? out.frames : null,
      outputSize: out && Array.isArray(out.size) ? out.size : null,
      audioSha: report ? report.audio_payload_sha256 || null : null,
      decodePass: report ? report.decode_pass === true : null,
      outputSha: report ? report.output_sha256 || null : null,
      sourcePath: typeof cfg.source === 'string' ? cfg.source : '',
      patches
    };
  }

  // 第 frame 帧上这个补丁的几何（成片像素）。不在 target 里返回 null。
  // scale：成片实际尺寸 / 配置里的 source_size（预览缩小版也能对上）
  function geometryAt(patch, frame, scale = { x: 1, y: 1 }) {
    if (frame < patch.start || frame >= patch.end) return null;
    const crop = rectAt(patch.crop, frame);
    const region = rectAt(patch.region, frame);
    const s = r => ({ x: r.x * scale.x, y: r.y * scale.y, w: r.w * scale.x, h: r.h * scale.y });
    const matte = s(workToSource(region, crop, patch.work));
    // 羽化是从 region 边往里收的，完全替换的核心要再缩进 feather
    const fx = patch.feather * crop.w / patch.work[0] * scale.x;
    const fy = patch.feather * crop.h / patch.work[1] * scale.y;
    const core = { x: matte.x + fx, y: matte.y + fy, w: Math.max(0, matte.w - 2 * fx), h: Math.max(0, matte.h - 2 * fy) };
    return {
      crop: s(crop),
      matte,
      core,
      featherPx: Math.max(fx, fy),
      protect: patch.protect.map(box => s(workToSource(rectAt(box, frame), crop, patch.work))),
      shape: patch.shape
    };
  }

  // 成片里要特别看的时间点：每个补丁的起止（原片↔生成切换处），
  // 以及同一人相邻分段的接点（前一段 end == 后一段 start）
  function junctions(plan) {
    const points = new Map();
    const add = (frame, kind, patch) => {
      const key = frame;
      const item = points.get(key) || { frame, kinds: new Set(), patches: new Set() };
      item.kinds.add(kind);
      item.patches.add(patch.name);
      points.set(key, item);
    };
    for (const p of plan.patches) {
      add(p.start, 'start', p);
      add(p.end, 'end', p);
    }
    for (const a of plan.patches) {
      for (const b of plan.patches) {
        if (a !== b && a.end === b.start) {
          const item = points.get(a.end);
          item.kinds.add('segment');
        }
      }
    }
    return [...points.values()]
      .map(item => ({ frame: item.frame, kinds: [...item.kinds], patches: [...item.patches], segment: item.kinds.has('segment') }))
      .sort((x, y) => x.frame - y.frame);
  }

  // 全部补丁覆盖的帧数（多个补丁重叠的帧只算一次）
  function patchedFrames(plan) {
    const set = new Set();
    for (const p of plan.patches) for (let f = p.start; f < p.end; f++) set.add(f);
    return [...set].sort((a, b) => a - b);
  }

  // 成片与配置的基本一致性：尺寸、帧率、帧数
  function checkMedia(plan, info) {
    const issues = [];
    if (plan.sourceSize && info.width && (plan.sourceSize[0] !== info.width || plan.sourceSize[1] !== info.height)) {
      issues.push(`成片 ${info.width}×${info.height} 与配置 source_size ${plan.sourceSize[0]}×${plan.sourceSize[1]} 不一致（按比例换算补丁位置）`);
    }
    if (plan.fps && info.fps && Math.abs(plan.fps - info.fps) > 0.01) {
      issues.push(`成片帧率 ${info.fps} 与配置 ${plan.fps} 不一致，帧号对不上`);
    }
    if (plan.frames && info.frames && Math.abs(plan.frames - info.frames) > 1) {
      issues.push(`成片约 ${info.frames} 帧，合成报告记录 ${plan.frames} 帧`);
    }
    const last = Math.max(...plan.patches.map(p => p.end));
    if (info.frames && last > info.frames + 1) issues.push(`补丁区间到第 ${last} 帧，超出成片长度 ${info.frames} 帧`);
    return issues;
  }

  function scaleFor(plan, width, height) {
    if (!plan.sourceSize || !width || !height) return { x: 1, y: 1 };
    return { x: width / plan.sourceSize[0], y: height / plan.sourceSize[1] };
  }

  return Object.freeze({ parse, parseFps, curve, rectAt, geometryAt, junctions, patchedFrames, checkMedia, scaleFor });
});
