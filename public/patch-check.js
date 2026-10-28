(function (root, factory) {
  const deps = typeof module === 'object' && module.exports
    ? [require('./inspect'), require('./patch-plan')]
    : [root.Inspect, root.PatchPlan];
  const api = factory(...deps);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatchCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (INSPECT, PatchPlan) {
  'use strict';

  // 按 flow-video-patch 的补丁配置给成片做自动体检。CLI 和 GUI 共用，
  // 区别只在「怎么取帧」：调用方提供
  //   provider.read(frames, width)        → async iterable of {frame, image}（成片，升序）
  //   provider.readSource(frames, width)  → 同上（原片，已按偏移对齐）；没有原片时不提供
  // image 是 {data(RGBA), width, height}。width 传 'full' 表示原始像素。
  //
  // 自动检查只给「发现了什么」和证据，不替人下验收结论：
  // flow-video-patch 规定自动检查通过不等于视觉验收，未正常速度播放不能声称无接缝。

  const JUNCTION_HALF = 6;      // 接点前后各看几帧
  const SEAM_SAMPLES = 12;      // 每个补丁量接缝颜色/台阶的采样帧数
  const SOURCE_SAMPLES = 5;     // 每个补丁和原片比的采样帧数
  const ANALYSIS_WIDTH = 960;   // 和原片比「未修区」用的分析宽度

  // flow-video-patch 视觉验收模板里的 13 项（顺序同模板）
  const REVIEW_CHECKS = [
    ['decode_dimensions_fps_frames', '解码、尺寸、帧率、帧数'],
    ['original_audio_payload', '原音轨载荷'],
    ['independent_return_alignment', '返回片独立对齐'],
    ['all_patched_frames_static', '全部修补帧静态检查（联系图）'],
    ['matte_core_protection_and_flicker', '遮罩核心、保护区与闪烁'],
    ['native_and_magnified_edges', '原尺寸与放大边缘'],
    ['cut_boundaries_and_occlusions', '分段接点与遮挡'],
    ['expression_gaze_and_bilateral_blinks', '表情、视线、双眼眨眼'],
    ['face_neck_hand_color_and_texture', '脸/脖子/手的颜色与质感'],
    ['normal_speed_full_playback', '正常速度完整播放'],
    ['actual_player_color', '实际播放器颜色'],
    ['audio_listening_and_lip_sync', '听音与口型'],
    ['independent_patch_pasteback', '独立补丁贴回']
  ];

  async function collect(iterable, onFrame) {
    for await (const item of iterable) await onFrame(item);
  }

  function spread(start, end, count) {
    const len = end - start;
    if (len <= 0) return [];
    if (len <= count) return Array.from({ length: len }, (_, i) => start + i);
    const out = new Set([start, end - 1, start + (len >> 1)]);
    for (let i = 0; out.size < count && i < count; i++) out.add(start + Math.round((len - 1) * i / (count - 1)));
    return [...out].sort((a, b) => a - b);
  }

  const scaleRect = (r, k) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
  const grow = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
  const clampFrame = (p, f) => Math.min(p.end - 1, Math.max(p.start, f));

  // 成片和原片按帧号成对迭代；没有原片时 src 为 null
  async function* pairs(provider, frames, paired) {
    if (!paired) {
      for await (const item of provider.read(frames, 'full')) yield { ...item, src: null };
      return;
    }
    const a = provider.read(frames, 'full')[Symbol.asyncIterator]();
    const b = provider.readSource(frames, 'full')[Symbol.asyncIterator]();
    let x = await a.next();
    let y = await b.next();
    while (!x.done) {
      while (!y.done && y.value.frame < x.value.frame) y = await b.next();
      const src = !y.done && y.value.frame === x.value.frame
        && y.value.image.width === x.value.image.width && y.value.image.height === x.value.image.height ? y.value.image : null;
      yield { frame: x.value.frame, image: x.value.image, src };
      x = await a.next();
    }
    if (b.return) await b.return();
  }

  // 硬边/切断只算补丁引入的：原片同一条边本来就有同等台阶（内容边缘）就不算
  function introducedStep(profile, srcProfile) {
    if (!srcProfile) return INSPECT.seamStepVerdict(profile);
    const own = {};
    for (const [edge, v] of Object.entries(profile)) {
      const o = srcProfile[edge];
      own[edge] = v && o && o.runRatio * 1.5 >= v.runRatio && o.run >= v.run * 0.6 ? { ...v, run: 0, runRatio: 0, ratio: 0 } : v;
    }
    return INSPECT.seamStepVerdict(own);
  }

  async function run(options) {
    const { plan, info, provider } = options;
    const progress = options.onProgress || (() => {});
    const stopped = options.shouldStop || (() => false);
    const scale = PatchPlan.scaleFor(plan, info.width, info.height);
    const geom = (p, f) => PatchPlan.geometryAt(p, clampFrame(p, f), scale);
    const findings = [];
    const add = (check, severity, text, extra = {}) => findings.push({ check, severity, text, ...extra });
    const totalFrames = info.frames || Math.max(...plan.patches.map(p => p.end));

    const media = PatchPlan.checkMedia(plan, info);
    for (const text of media) add('decode_dimensions_fps_frames', 'fail', text);

    const workTotal = plan.patches.reduce((n, p) => n + (p.end - p.start), 0) || 1;
    let workDone = 0;
    const patches = [];

    // 有原片就成对读：每个判据都拿原片同位置同算法跑一遍，只报补丁「新引入」的问题。
    // 实测 testsrc2 这类内容丰富的画面上，不减原片时干净的成片也会被报出接缝色差、
    // 硬切、呼吸和抖动——那都是画面内容本身跨过了贴回框。
    const paired = !!provider.readSource;
    const hedge = paired ? '' : '（没有原片参照，可能是画面内容本身，需人工确认）';
    const contentSev = sev => (paired ? sev : 'warn');

    for (const p of plan.patches) {
      if (stopped()) break;
      const out = { name: p.name, start: p.start, end: p.end, shape: p.shape, paired };
      // 1) 补丁区内逐帧：闪烁/跳变/抖动 + 接缝台阶（呼吸）+ 采样帧的接缝颜色与硬边
      const sampler = INSPECT.createTrackedSampler();
      const srcSampler = paired ? INSPECT.createTrackedSampler({ control: false }) : null;
      const samples = [];
      const srcSamples = [];
      const seamSeries = [];
      const colorSeries = [];
      const stepVerdicts = [];
      const sampleSet = new Set(spread(p.start, p.end, SEAM_SAMPLES));
      const frames = [];
      for (let f = p.start; f < Math.min(p.end, totalFrames); f++) frames.push(f);
      const worstRun = profile => {
        const edges = Object.values(profile).filter(Boolean);
        return edges.length ? Math.max(...edges.map(e => e.runStep)) : 0;
      };
      await collect(pairs(provider, frames, paired), ({ frame, image, src }) => {
        if (stopped()) return;
        const g = geom(p, frame);
        const sample = sampler.push(frame, image, g.matte);
        if (sample) samples.push(sample);
        const profile = INSPECT.edgeStepProfile(image, g.matte);
        const srcProfile = src ? INSPECT.edgeStepProfile(src, g.matte) : null;
        // 呼吸看「补丁加上去的台阶」：成片台阶减原片同位置台阶
        seamSeries.push(src ? Math.max(0, worstRun(profile) - worstRun(srcProfile)) : worstRun(profile));
        if (src) {
          const t = srcSampler.push(frame, src, g.matte);
          if (t) srcSamples.push(t);
        }
        if (options.onPatchFrame) options.onPatchFrame(p, frame, image, g);
        if (sampleSet.has(frame)) {
          const opts = { feather: g.featherPx, shape: g.shape, frameHeight: info.height };
          colorSeries.push({ frame, ...(src ? INSPECT.seamLabRelative(image, src, g.matte, opts) : INSPECT.seamLab(image, g.matte, opts)) });
          if (g.shape === 'rect') stepVerdicts.push({ frame, ...introducedStep(profile, srcProfile) });
        }
        workDone++;
        progress(`「${p.name}」逐帧检查 ${frame - p.start + 1}/${p.end - p.start}`, workDone / workTotal);
      });
      const scan = INSPECT.scanVerdict(samples, { scope: '补丁区' });
      const srcScan = paired && srcSamples.length ? INSPECT.scanVerdict(srcSamples, { scope: '原片同位置' }) : null;
      // 原片同位置也是同一种毛病（同一帧附近），说明是内容本身的运动，不算补丁的
      const inherited = srcScan && srcScan.kind === scan.kind
        && (scan.kind !== 'jump' || (srcScan.peak && scan.peak && Math.abs(srcScan.peak.frame - scan.peak.frame) <= 1));
      out.scan = { kind: scan.kind, text: scan.text, flickerRatio: scan.flickerRatio, peakFrame: scan.peak ? scan.peak.frame : null, peakRatio: scan.peak ? scan.peak.ratio : null, localized: scan.localized, source: srcScan && { kind: srcScan.kind, text: srcScan.text }, inherited: !!inherited };
      if (scan.kind !== 'ok' && scan.kind !== 'unknown' && !inherited) {
        // 隔帧闪烁的 lag-2 指纹内容很少能造出来，没有原片也判失败；跳变/抖动可能是镜头内容本身
        const sev = scan.kind === 'flicker' ? 'fail' : contentSev('fail');
        add('matte_core_protection_and_flicker', sev, `「${p.name}」${scan.text}${scan.kind === 'flicker' ? '' : hedge}`, { patch: p.name, frame: scan.peak ? scan.peak.frame : p.start, metric: scan.kind === 'flicker' ? 'flickerRatio' : 'peakRatio', value: scan.kind === 'flicker' ? scan.flickerRatio : scan.peak && scan.peak.ratio });
      }
      const breathing = INSPECT.breathingVerdict(seamSeries);
      out.breathing = { kind: breathing.kind, text: breathing.text, cv: breathing.cv, relative: paired };
      if (breathing.kind === 'breathing') add('matte_core_protection_and_flicker', contentSev('fail'), `「${p.name}」${paired ? '补丁加上的' : ''}${breathing.text}${hedge}`, { patch: p.name, frame: p.start, metric: 'breathingCv', value: breathing.cv });
      const color = INSPECT.seamColorVerdict(colorSeries);
      out.seamColor = { kind: color.kind, text: color.text, max: color.max && { frame: color.max.frame, edge: color.max.edge, dE: color.max.dE, dL: color.max.dL, da: color.max.da, db: color.max.db }, jump: color.jump, relative: paired, method: 'sRGB(D65)→CIELAB, ΔE=CIE76；内带越过羽化，按 4K 16–70px 随画高缩放' + (paired ? '；数值是成片(内-外)减原片(内-外)' : '') };
      if (color.kind === 'fail' || color.kind === 'warn') add('face_neck_hand_color_and_texture', color.kind === 'fail' ? contentSev('fail') : 'warn', `「${p.name}」${color.text}${hedge}`, { patch: p.name, frame: color.max ? color.max.frame : p.start, metric: 'seamDeltaE', value: color.max && color.max.dE });
      const stepHits = stepVerdicts.filter(v => v.kind === 'seam' || v.kind === 'cut');
      out.seamStep = stepHits.length
        ? { kind: stepHits[0].kind, frames: stepHits.map(v => v.frame), text: stepHits[0].text }
        : { kind: stepVerdicts.length ? 'ok' : 'unknown', text: stepVerdicts.length ? '采样帧四条边都没有补丁引入的贯通硬边或切断' : '椭圆贴回区不做矩形硬边判据' };
      // 校准用：采样帧里补丁引入的最强台阶
      out.seamStep.maxRunRatio = Math.max(0, ...stepVerdicts.map(v => (v.worst ? v.worst.runRatio : 0)));
      if (stepHits.length >= Math.max(2, stepVerdicts.length * 0.3)) {
        add('native_and_magnified_edges', contentSev('fail'), `「${p.name}」${stepHits.length}/${stepVerdicts.length} 个采样帧有硬边：${stepHits[0].text}${hedge}`, { patch: p.name, frame: stepHits[0].frame, metric: 'seamRunRatio', value: stepHits[0].worst && stepHits[0].worst.runRatio });
      } else if (stepHits.length) {
        add('native_and_magnified_edges', 'warn', `「${p.name}」第 ${stepHits[0].frame + 1} 帧：${stepHits[0].text}${hedge}`, { patch: p.name, frame: stepHits[0].frame });
      }
      patches.push(out);
    }

    // 2) 接点：每个补丁的起止 + 分段接点，前后各看几帧有没有孤立跳变
    const junctionResults = [];
    for (const j of PatchPlan.junctions(plan)) {
      if (stopped()) break;
      if (j.frame <= 0 || j.frame >= totalFrames) continue;
      const owner = plan.patches.find(p => p.start <= j.frame && j.frame < p.end) || plan.patches.find(p => p.end === j.frame);
      const from = Math.max(0, j.frame - JUNCTION_HALF);
      const to = Math.min(totalFrames, j.frame + JUNCTION_HALF);
      const frames = [];
      for (let f = from; f < to; f++) frames.push(f);
      const sampler = INSPECT.createTrackedSampler({ control: false });
      const samples = [];
      await collect(provider.read(frames, 'full'), ({ frame, image }) => {
        const g = geom(owner, frame);
        const s = sampler.push(frame, image, grow(g.matte, g.featherPx));
        if (s) samples.push(s);
      });
      const v = INSPECT.junctionVerdict(samples, j.frame);
      const label = j.segment ? '分段接点' : j.kinds.includes('start') ? '补丁开始' : '补丁结束';
      junctionResults.push({ frame: j.frame, label, patches: j.patches, kind: v.kind, ratio: v.ratio, text: `${label}：${v.text}` });
      if (v.kind === 'fail' || v.kind === 'warn') add('cut_boundaries_and_occlusions', v.kind, `${label}（${j.patches.join('、')}）${v.text}`, { frame: j.frame, metric: 'junctionRatio', value: v.ratio });
      progress(`接点 ${j.frame + 1}`, 1);
    }

    // 3) 和原片比：未修区不该变、保护区不该变
    let source = null;
    if (provider.readSource && !stopped()) {
      const width = Math.min(ANALYSIS_WIDTH, info.width);
      const k = width / info.width;
      const want = new Set();
      for (const p of plan.patches) spread(p.start, p.end, SOURCE_SAMPLES).forEach(f => want.add(f));
      // 补丁以外的时间也抽几帧：整片调色、整片偏移在这里暴露
      for (const r of [0.1, 0.5, 0.9]) want.add(Math.min(totalFrames - 1, Math.round(totalFrames * r)));
      const list = [...want].filter(f => f >= 0 && f < totalFrames).sort((a, b) => a - b);
      const fin = new Map();
      await collect(provider.read(list, width), ({ frame, image }) => { fin.set(frame, image); });
      const rows = [];
      await collect(provider.readSource(list, width), ({ frame, image }) => {
        const a = fin.get(frame);
        if (!a || a.width !== image.width || a.height !== image.height) return;
        const active = plan.patches.filter(p => p.start <= frame && frame < p.end);
        const block = Math.max(8, Math.round(Math.min(a.width, a.height) / 24));
        const mattes = active.map(p => {
          const g = PatchPlan.geometryAt(p, frame, scale);
          return { g, rect: grow(scaleRect(g.matte, k), g.featherPx * k + block) };
        });
        const outside = INSPECT.regionChange(a, image, { exclude: mattes.map(m => m.rect), block });
        const ov = INSPECT.outsideVerdict(outside);
        const row = { frame, patches: active.map(p => p.name), outside: { kind: ov.kind, text: ov.text, base: outside.base, worst: outside.worst && outside.worst.mean, shift: outside.shift } };
        const protect = mattes.flatMap(m => m.g.protect.map(r => scaleRect(r, k)));
        if (protect.length) {
          const pv = INSPECT.protectVerdict(INSPECT.regionChange(a, image, { only: protect, block: Math.max(4, block >> 1) }), outside.base);
          row.protect = { kind: pv.kind, text: pv.text };
          if (pv.kind === 'fail') add('matte_core_protection_and_flicker', 'fail', `第 ${frame + 1} 帧${pv.text}`, { frame });
        }
        if (ov.kind === 'fail') row.outside.at = ov.at ? scaleRect(ov.at, 1 / k) : null;
        rows.push(row);
      });
      // 同一处改动通常每个采样帧都在，合成一条，列出帧号
      const changed = rows.filter(r => r.outside.kind === 'fail');
      if (changed.length) {
        const worst = changed.reduce((a, b) => ((b.outside.worst || 0) > (a.outside.worst || 0) ? b : a));
        add('unchanged_outside_matte', 'fail', `${changed.length}/${rows.length} 个采样帧贴回区以外被改动，例如第 ${worst.frame + 1} 帧：${worst.outside.text}（帧 ${changed.map(r => r.frame + 1).join('、')}）`, { frame: worst.frame, at: worst.outside.at, frames: changed.map(r => r.frame) });
      }
      // 补丁以外的帧都差很多，多半是没对齐或拿错了原片——这时其他结论都不可信
      const bare = rows.filter(r => !r.patches.length);
      const misaligned = bare.length && bare.every(r => r.outside.base >= 10);
      if (misaligned) add('independent_return_alignment', 'fail', `补丁以外的帧和原片整体差很多（噪声基线 ${bare.map(r => r.outside.base.toFixed(1)).join('/')}），原片没对齐或不是同一条片，和原片比的结论不可信`);
      source = { width, frames: rows, misaligned: !!misaligned };
    }

    return {
      tool: 'video-checker patch-check',
      frameBase: 0,
      intervalNote: '[start, end) 左闭右开；text 里的帧号是 +1 后的界面编号',
      media: { width: info.width, height: info.height, fps: info.fps, frames: info.frames, issues: media },
      patches,
      junctions: junctionResults,
      source,
      findings,
      stopped: stopped()
    };
  }

  // 生成 flow-video-patch 的视觉验收记录。人工审看的状态由 reviewer 决定；
  // 自动检查只写进 evidence / automated，不替人判 pass。
  function reviewRecord(options) {
    const { plan, result, finalFile = '', finalSha256 = null, reviewer = {}, coverage = null, sheet = null } = options;
    const checks = {};
    const autoFor = id => (result ? result.findings.filter(f => f.check === id) : []);
    for (const [id] of REVIEW_CHECKS) {
      const human = reviewer[id] || {};
      const auto = autoFor(id);
      const evidence = [];
      if (human.note) evidence.push(human.note);
      for (const f of auto) evidence.push(`[自动·${f.severity === 'fail' ? '问题' : '提示'}] ${f.text}`);
      checks[id] = { status: ['pass', 'fail', 'not_applicable'].includes(human.status) ? human.status : 'not_run', evidence: evidence.length ? evidence.join('\n') : null };
      if (auto.length) checks[id].auto_suggestion = auto.some(f => f.severity === 'fail') ? 'fail' : 'review';
    }
    if (result && checks.all_patched_frames_static && sheet) {
      checks.all_patched_frames_static.evidence = [checks.all_patched_frames_static.evidence, `联系图：${sheet}`].filter(Boolean).join('\n');
    }
    // merge 报告里的技术核验原样作为证据（解码/尺寸/帧数、原音轨载荷哈希）
    if (plan && plan.kind === 'report') {
      const d = checks.decode_dimensions_fps_frames;
      d.evidence = [d.evidence, `合成报告：decode_pass=${plan.decodePass}，${plan.outputSize ? plan.outputSize.join('×') : '?'}，${plan.frames ?? '?'} 帧，${plan.fps ? plan.fps.toFixed(3) : '?'} fps`].filter(Boolean).join('\n');
      if (plan.audioSha) {
        const a = checks.original_audio_payload;
        a.evidence = [a.evidence, `合成报告：第一条原音轨载荷 SHA-256 ${plan.audioSha}（merge 时已与原片核对一致）`].filter(Boolean).join('\n');
      }
    }
    if (coverage) {
      const text = `正常速度（0.9–1.1×）实际播放覆盖修补帧 ${coverage.watched}/${coverage.total}（${(coverage.ratio * 100).toFixed(1)}%）` + (coverage.missing.length ? `；未看：${coverage.missing.slice(0, 8).map(([s, e]) => `${s + 1}–${e}`).join('、')}${coverage.missing.length > 8 ? ' …' : ''}` : '');
      const c = checks.normal_speed_full_playback;
      c.evidence = [c.evidence, text].filter(Boolean).join('\n');
      if (c.status === 'pass' && coverage.ratio < 1) c.status = 'not_run'; // 没看完不能写通过
    }
    const statuses = Object.values(checks).map(c => c.status);
    const status = statuses.includes('fail') ? 'visual_fail' : statuses.includes('not_run') ? 'pending_visual_review' : 'visual_pass';
    return {
      schema_version: 1,
      status,
      status_options: ['pending_visual_review', 'visual_fail', 'visual_pass'],
      scope: reviewer.scope || null,
      final_file: finalFile,
      final_sha256: finalSha256 || (plan && plan.outputSha) || null,
      source_frame_interval: plan ? plan.patches.map(p => ({ name: p.name, target: [p.start, p.end] })) : null,
      frame_mapping_evidence: null,
      technical_report: options.technicalReport || null,
      checks,
      check_status_options: ['not_run', 'pass', 'fail', 'not_applicable'],
      automated: result ? {
        tool: result.tool,
        note: '自动检查只用于定位，不等于视觉验收；未正常速度完整播放不得声称无接缝/无重影',
        findings: result.findings,
        unchanged_outside_matte: result.findings.filter(f => f.check === 'unchanged_outside_matte'),
        seam_color_method: 'sRGB(D65)→CIELAB，ΔE=CIE76，不是 OpenCV 8 位 LAB 距离'
      } : null,
      instructions: 'Record reviewer, evidence paths, frame/time intervals, people and limits in each evidence entry. Explain every not_applicable. Any failed applicable check means visual_fail; any unrun applicable check means pending_visual_review. Do not infer playback acceptance from technical tests or still images. Keep filled records private to the task.'
    };
  }

  // 正常速度播放覆盖：watched 是 [start, end) 区间列表
  function coverage(plan, watched) {
    const patched = PatchPlan.patchedFrames(plan);
    const seen = f => watched.some(([s, e]) => f >= s && f < e);
    const missing = [];
    let count = 0;
    for (const f of patched) {
      if (seen(f)) { count++; continue; }
      const last = missing[missing.length - 1];
      if (last && last[1] === f) last[1] = f + 1;
      else missing.push([f, f + 1]);
    }
    return { total: patched.length, watched: count, ratio: patched.length ? count / patched.length : 0, missing };
  }

  // 区间并集（播放覆盖记录用）
  function addRange(ranges, start, end) {
    if (!(end > start)) return ranges;
    const all = [...ranges, [start, end]].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of all) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    return out;
  }

  // ---------- 联系图 / 证据图：纯像素拼图，CLI（无 canvas）和 GUI 通用 ----------
  // 3×5 点阵字，只用来在图上标帧号和 A/B/D
  const GLYPHS = {
    0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
    5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111',
    A: '010101111101101', B: '110101110101110', D: '110101101101110', '-': '000000111000000', '#': '101111101111101'
  };

  function blank(width, height, gray = 24) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = gray; data[i + 1] = gray; data[i + 2] = gray; data[i + 3] = 255; }
    return { data, width, height };
  }

  function stamp(img, text, x0, y0, size = 2, color = [255, 220, 60]) {
    let x = x0;
    for (const ch of String(text)) {
      const g = GLYPHS[ch];
      if (g) {
        for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
          if (g[gy * 3 + gx] !== '1') continue;
          for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
            const px = x + gx * size + dx;
            const py = y0 + gy * size + dy;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
            const i = (py * img.width + px) * 4;
            img.data[i] = color[0]; img.data[i + 1] = color[1]; img.data[i + 2] = color[2];
          }
        }
      }
      x += 4 * size;
    }
  }

  // 双线性缩放一块区域到 w×h
  function resize(src, rect, w, h) {
    const out = blank(w, h, 0);
    const r = INSPECT.clampRect(rect, src.width, src.height);
    for (let y = 0; y < h; y++) {
      const sy = r.y + (y + 0.5) * r.h / h - 0.5;
      const y0 = Math.max(r.y, Math.min(r.y + r.h - 1, Math.floor(sy)));
      const y1 = Math.min(r.y + r.h - 1, y0 + 1);
      const fy = Math.max(0, Math.min(1, sy - y0));
      for (let x = 0; x < w; x++) {
        const sx = r.x + (x + 0.5) * r.w / w - 0.5;
        const x0 = Math.max(r.x, Math.min(r.x + r.w - 1, Math.floor(sx)));
        const x1 = Math.min(r.x + r.w - 1, x0 + 1);
        const fx = Math.max(0, Math.min(1, sx - x0));
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const p = (yy, xx) => src.data[(yy * src.width + xx) * 4 + c];
          out.data[o + c] = (p(y0, x0) * (1 - fx) + p(y0, x1) * fx) * (1 - fy) + (p(y1, x0) * (1 - fx) + p(y1, x1) * fx) * fy;
        }
      }
    }
    return out;
  }

  function blit(dst, src, x0, y0) {
    for (let y = 0; y < src.height; y++) {
      const py = y0 + y;
      if (py < 0 || py >= dst.height) continue;
      for (let x = 0; x < src.width; x++) {
        const px = x0 + x;
        if (px < 0 || px >= dst.width) continue;
        const s = (y * src.width + x) * 4;
        const d = (py * dst.width + px) * 4;
        dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1]; dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = 255;
      }
    }
  }

  // 在图上画矩形框（贴回区边界）
  function outline(img, r, color = [255, 80, 80]) {
    const x0 = Math.round(r.x);
    const y0 = Math.round(r.y);
    const x1 = Math.round(r.x + r.w) - 1;
    const y1 = Math.round(r.y + r.h) - 1;
    const put = (x, y) => {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
      const i = (y * img.width + x) * 4;
      img.data[i] = color[0]; img.data[i + 1] = color[1]; img.data[i + 2] = color[2];
    };
    for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y1); }
    for (let y = y0; y <= y1; y++) { put(x0, y); put(x1, y); }
  }

  // 一个修补帧 → 联系图小格：取人物裁切框缩到 tileW 宽，红框标出贴回区。
  // 边走边缩，长片也不用把整帧全留在内存里。
  function tile(image, g, frame, tileW = 160) {
    const rect = INSPECT.clampRect(g.crop, image.width, image.height);
    const tileH = Math.max(2, Math.round(tileW * rect.h / rect.w));
    const small = resize(image, rect, tileW, tileH);
    const kx = tileW / rect.w;
    const ky = tileH / rect.h;
    outline(small, { x: (g.matte.x - rect.x) * kx, y: (g.matte.y - rect.y) * ky, w: g.matte.w * kx, h: g.matte.h * ky });
    return { frame, small };
  }

  // 按网格拼起来，每格标帧号（界面编号 = frame+1）
  function contactSheet(tiles, options = {}) {
    const cols = Math.min(options.columns || 10, tiles.length);
    const tileW = Math.max(...tiles.map(t => t.small.width));
    const tileH = Math.max(...tiles.map(t => t.small.height));
    const rows = Math.ceil(tiles.length / cols);
    const pad = 4;
    const label = 14;
    const sheet = blank(cols * (tileW + pad) + pad, rows * (tileH + pad + label) + pad);
    tiles.forEach((t, i) => {
      const x = pad + (i % cols) * (tileW + pad);
      const y = pad + Math.floor(i / cols) * (tileH + pad + label);
      blit(sheet, t.small, x, y + label);
      stamp(sheet, t.frame + 1, x, y + 2, 2);
    });
    return sheet;
  }

  // 原片(A=成片 / B=原片 / D=差异×4) 三联放大图
  function triptych(finished, source, rect, options = {}) {
    const zoom = options.zoom || 2;
    const r = INSPECT.clampRect(rect, finished.width, finished.height);
    const w = Math.max(2, Math.round(r.w * zoom));
    const h = Math.max(2, Math.round(r.h * zoom));
    const a = resize(finished, r, w, h);
    const panels = [['A', a]];
    if (source) {
      const b = resize(source, r, w, h);
      const d = blank(w, h, 0);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.min(255, (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3 * 4);
        d.data[i] = v; d.data[i + 1] = v; d.data[i + 2] = v;
      }
      panels.push(['B', b], ['D', d]);
    }
    const pad = 6;
    const label = 16;
    const out = blank(panels.length * (w + pad) + pad, h + label + pad * 2);
    panels.forEach(([name, img], i) => {
      const x = pad + i * (w + pad);
      blit(out, img, x, pad + label);
      stamp(out, name, x, pad, 2);
    });
    if (Number.isInteger(options.frame)) stamp(out, options.frame + 1, out.width - 60, pad, 2);
    return out;
  }

  return Object.freeze({ run, reviewRecord, coverage, addRange, tile, contactSheet, triptych, REVIEW_CHECKS, spread });
});
