#!/usr/bin/env node
'use strict';

// 无界面的穿帮检查命令行：所有结论用 JSON 输出，方便 agent / 脚本直接调。
// 判据全部复用 public/inspect.js（和 GUI 同一套，有单测），像素由 ffmpeg 的
// rawvideo 管道提供，不依赖 canvas。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseMediaInfo } = require('./server');
const INSPECT = require('./public/inspect');
const PatchPlan = require('./public/patch-plan');
const PatchCheck = require('./public/patch-check');

const RUNTIME_DIRS = {
  darwin: { arm64: 'darwin-arm64', x64: 'darwin-x64' },
  win32: { x64: 'win32-x64' }
};

function ffmpegPath() {
  if (process.env.VIDEO_CHECKER_FFMPEG) return process.env.VIDEO_CHECKER_FFMPEG;
  const archDir = RUNTIME_DIRS[process.platform]?.[process.arch];
  if (archDir) {
    const bundled = path.join(__dirname, 'vendor', 'bin', archDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(bundled)) return bundled;
  }
  return 'ffmpeg';
}

function fail(message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extra }, null, 2) + '\n');
  process.exit(1);
}

function emit(payload) {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + '\n');
}

// ffmpeg 只给 -i 不给输出文件时必然以 1 退出，元数据照样打印在 stderr，所以不看退出码
function probe(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    proc.on('error', reject);
    proc.on('exit', () => {
      const info = parseMediaInfo(stderr);
      if (!info.width || !info.height) {
        return reject(new Error('读不出视频信息: ' + (stderr.trim().split('\n').pop() || '').slice(0, 200)));
      }
      info.frames = info.fps > 0 ? Math.round(info.durationSec * info.fps) : 0;
      resolve(info);
    });
  });
}

const evenHeight = (info, width) => Math.max(2, Math.round(info.height * (width / info.width) / 2) * 2);

// 从 startFrame 起连续取 count 帧，逐帧回调；只缓冲一帧，内存不随 count 增长
function readFrames(file, info, { startFrame, count, width, onFrame }) {
  const height = evenHeight(info, width);
  const frameBytes = width * height * 4;
  // ffmpeg 的 -ss 会丢掉 PTS 早于目标时间的帧，所以不能用「帧中心」(N+0.5)/fps——
  // 那样取到的是第 N+1 帧（实测与 select=eq(n,N) 逐像素比对确认）。往前让 1/4 帧最稳。
  const startSec = Math.max(0, (startFrame - 0.25) / info.fps);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', startSec.toFixed(6),
    '-i', file,
    '-frames:v', String(count),
    '-vf', `scale=${width}:${height}`,
    '-pix_fmt', 'rgba',
    '-f', 'rawvideo', '-'
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0);
    let index = 0;
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    proc.stdout.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const slice = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        onFrame({
          frame: startFrame + index,
          data: new Uint8ClampedArray(slice),
          width,
          height
        });
        index++;
      }
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (index === 0) return reject(new Error(`取不到画面(ffmpeg ${code}): ${stderr.trim().slice(-200)}`));
      resolve(index);
    });
  });
}

// 流式读帧：一个 ffmpeg 进程顺序吐帧，按需拉取（stdout 自带背压），4K 长片也不爆内存
async function* streamFrames(file, info, startFrame, count, width) {
  const height = evenHeight(info, width);
  const frameBytes = width * height * 4;
  const startSec = Math.max(0, (startFrame - 0.25) / info.fps);
  const proc = spawn(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-ss', startSec.toFixed(6), '-i', file,
    '-frames:v', String(count), '-vf', `scale=${width}:${height}`, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const exited = new Promise(resolve => proc.on('close', resolve));
  let pending = Buffer.alloc(0);
  let index = 0;
  try {
    for await (const chunk of proc.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes && index < count) {
        const data = new Uint8ClampedArray(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        yield { frame: startFrame + index, data, width, height };
        index++;
      }
    }
  } finally {
    if (proc.exitCode === null) proc.kill('SIGTERM');
  }
  const code = await exited;
  if (index === 0) throw new Error(`取不到画面(ffmpeg ${code}): ${stderr.trim().slice(-200)}`);
}

// 帧号列表 → 连续段，每段一个 ffmpeg 进程
async function* readFrameList(file, info, frames, width) {
  const w = width === 'full' ? info.width : width;
  const sorted = [...new Set(frames)].filter(f => f >= 0).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    // 间隔 ≤ 8 帧就并成一段顺序解，比重新 seek 快
    while (j + 1 < sorted.length && sorted[j + 1] - sorted[j] <= 8) j++;
    const want = new Set(sorted.slice(i, j + 1));
    for await (const f of streamFrames(file, info, sorted[i], sorted[j] - sorted[i] + 1, w)) {
      if (want.has(f.frame)) yield { frame: f.frame, image: f };
    }
    i = j + 1;
  }
}

// RGBA 像素 → PNG（交给 ffmpeg 编码，不额外依赖图像库）
function writePng(image, file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
      '-s', `${image.width}x${image.height}`, '-i', '-', '-frames:v', '1', file
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => (code === 0 ? resolve(file) : reject(new Error('写 PNG 失败: ' + stderr.slice(-200)))));
    proc.stdin.end(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength));
  });
}

const MAX_SHEET_TILES = 400;

async function cmdPatchcheck(file, flags) {
  if (!flags.plan || !fs.existsSync(flags.plan)) throw new Error('要用 --plan 指定 merge.json 或 *.report.json');
  const plan = PatchPlan.parse(fs.readFileSync(flags.plan, 'utf8'));
  const info = await probe(file);
  const sourceFile = typeof flags.source === 'string' ? flags.source : null;
  if (sourceFile && !fs.existsSync(sourceFile)) throw new Error('找不到原片: ' + sourceFile);
  const sourceInfo = sourceFile ? await probe(sourceFile) : null;
  let offset = Number(flags.offset) || 0;
  let align = null;
  if (sourceFile && flags.align) {
    align = await alignOffset(file, info, sourceFile, sourceInfo, 360, Number(flags.search) || 10);
    if (align && flags.offset === undefined) offset = align.offset;
  }
  const provider = {
    read: (frames, width) => readFrameList(file, info, frames, width),
    readSource: sourceFile ? async function* (frames, width) {
      // 原片统一缩放到成片尺寸，逐像素比较才成立
      for await (const item of readFrameList(sourceFile, sourceInfo, frames.map(f => f + offset), width === 'full' ? info.width : width)) {
        yield { frame: item.frame - offset, image: item.image };
      }
    } : null
  };
  // 联系图：所有修补帧（太多时等间隔抽），边检查边缩
  const patched = PatchPlan.patchedFrames(plan).length;
  const stride = Math.max(1, Math.ceil(patched / MAX_SHEET_TILES));
  const tiles = [];
  const wantSheet = typeof flags.sheet === 'string';
  const result = await PatchCheck.run({
    plan,
    info,
    provider,
    onProgress: flags.quiet ? undefined : (text => process.stderr.write(`\r${text}            `)),
    onPatchFrame: wantSheet ? (p, frame, image, g) => {
      if ((frame - p.start) % stride === 0) tiles.push(PatchCheck.tile(image, g, frame, Number(flags['tile-width']) || 160));
    } : undefined
  });
  if (!flags.quiet) process.stderr.write('\n');
  const outputs = {};
  if (wantSheet && tiles.length) {
    tiles.sort((a, b) => a.frame - b.frame);
    outputs.sheet = await writePng(PatchCheck.contactSheet(tiles), flags.sheet);
    outputs.sheetFrames = { count: tiles.length, stride, note: stride > 1 ? `修补帧太多，每 ${stride} 帧取 1 帧` : '全部修补帧' };
  }
  // 证据图：每个补丁首/中/末 + 自动发现问题的帧，成片/原片/差异三联
  if (typeof flags.evidence === 'string') {
    fs.mkdirSync(flags.evidence, { recursive: true });
    const scale = PatchPlan.scaleFor(plan, info.width, info.height);
    const wanted = new Map();
    for (const p of plan.patches) for (const f of PatchCheck.spread(p.start, p.end, 3)) wanted.set(f, p);
    for (const f of result.findings) {
      if (!Number.isInteger(f.frame) || wanted.size >= 24) continue;
      const p = plan.patches.find(q => q.start <= f.frame && f.frame < q.end) || plan.patches.find(q => q.name === f.patch);
      if (p) wanted.set(Math.min(p.end - 1, Math.max(p.start, f.frame)), p);
    }
    const frames = [...wanted.keys()].sort((a, b) => a - b);
    const src = new Map();
    if (provider.readSource) for await (const item of provider.readSource(frames, 'full')) src.set(item.frame, item.image);
    outputs.evidence = [];
    for await (const { frame, image } of provider.read(frames, 'full')) {
      const g = PatchPlan.geometryAt(wanted.get(frame), frame, scale);
      const pad = Math.max(16, g.featherPx * 2);
      const rect = { x: g.matte.x - pad, y: g.matte.y - pad, w: g.matte.w + pad * 2, h: g.matte.h + pad * 2 };
      const zoom = Math.max(1, Math.min(4, Math.floor(480 / rect.w)));
      const out = path.join(flags.evidence, `frame-${String(frame + 1).padStart(6, '0')}.png`);
      await writePng(PatchCheck.triptych(image, src.get(frame) || null, rect, { zoom, frame }), out);
      outputs.evidence.push({ frame, file: out });
    }
  }
  if (typeof flags.review === 'string') {
    const record = PatchCheck.reviewRecord({
      plan,
      result,
      finalFile: path.basename(file),
      technicalReport: plan.kind === 'report' ? path.basename(flags.plan) : null,
      sheet: outputs.sheet || null
    });
    fs.writeFileSync(flags.review, JSON.stringify(record, null, 2));
    outputs.review = flags.review;
  }
  emit({ file, plan: flags.plan, source: sourceFile, offset, align, ...result, outputs });
}

async function readOneFrame(file, info, frame, width) {
  let out = null;
  await readFrames(file, info, { startFrame: frame, count: 1, width, onFrame: f => { out = f; } });
  return out;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else positional.push(token);
  }
  return { positional, flags };
}

const HELP = `穿帮检查命令行（帧号从 0 开始，区间是 [from, to) 左闭右开）

  node cli.js probe   <文件>
  node cli.js scan    <文件> --from 110 --to 136 [--rect x,y,w,h] [--width 360]
  node cli.js compare <成片> <原片> [--frame N] [--offset N] [--align] [--width 360]
  node cli.js roi     <文件> --frame 60 --rect x,y,w,h
  node cli.js patchcheck <成片> --plan merge.json|成片.report.json [--source 原片] [--offset N | --align]
                         [--review 验收记录.json] [--sheet 联系图.png] [--evidence 证据目录] [--quiet]

patchcheck 按 flow-video-patch 的补丁配置逐个补丁体检：补丁区内闪烁/跳变/抖动（框跟着关键帧走）、
接缝台阶与呼吸、接缝 LAB 色差（CIE76）、每个接点前后跳变；给了原片还会查贴回区以外有没有被改、
保护区有没有保住。--review 输出视觉验收记录（人工项保持 not_run，自动发现写进 evidence）。

公共选项
  --width N   分析用的缩放宽度，默认 360（roi 固定用原始像素；scan 给了 --rect 时默认原始像素）
  --rect      只在这块区域内扫描，并自动取一块同尺寸的区外对照区做归因。
              补丁占画幅 ≤2% 时全画幅扫描会把它的闪烁稀释到判不出来
  --ffmpeg 或 VIDEO_CHECKER_FFMPEG 指定 ffmpeg，默认用 vendor/bin 里自带的

输出全是 JSON；出错时 {"ok":false,"error":...} 且退出码为 1。
注意：所有数值字段的帧号从 0 开始；verdict.text 是给人看的句子，里面的帧号是 +1 后的
界面编号（同时给了 peakFrame 和 peakFrameDisplay 两个字段，别弄混）。`;

function parseRect(value, label) {
  const parts = String(value || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
    throw new Error(`${label} 要写成 x,y,w,h（原始像素坐标）`);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

async function cmdProbe(file) {
  const info = await probe(file);
  emit({ file, ...info });
}

async function cmdScan(file, flags) {
  const info = await probe(file);
  const rect = flags.rect ? parseRect(flags.rect, '--rect') : null;
  // 给了 --rect 就默认用原始像素：补丁缩到 360 宽只剩十几个像素，接缝量不准。
  const width = Number(flags.width) || (rect ? info.width : 360);
  const from = Math.max(0, Number(flags.from) || 0);
  const to = flags.to !== undefined ? Number(flags.to) : Math.min(info.frames, from + 31);
  if (!(to > from + 1)) throw new Error('区间太短，至少要 2 帧');
  const scale = width / info.width;
  const scaled = rect ? {
    x: Math.round(rect.x * scale), y: Math.round(rect.y * scale),
    w: Math.max(2, Math.round(rect.w * scale)), h: Math.max(2, Math.round(rect.h * scale))
  } : null;
  const control = scaled ? INSPECT.controlRect(scaled, width, evenHeight(info, width)) : null;
  const sampler = INSPECT.createScanSampler({ rect: scaled, control });
  const samples = [];
  const seamSeries = [];
  await readFrames(file, info, {
    startFrame: from,
    count: to - from,
    width,
    onFrame: frame => {
      const sample = sampler.push(frame.frame, frame);
      if (sample) samples.push(sample);
      if (scaled) {
        // 每帧量一次接缝台阶，用来判边界呼吸
        const profile = INSPECT.edgeStepProfile(frame, scaled);
        const edges = Object.values(profile).filter(Boolean);
        seamSeries.push(edges.length ? Math.max(...edges.map(e => e.runStep)) : 0);
      }
    }
  });
  const verdict = INSPECT.scanVerdict(samples, scaled ? { scope: '补丁区' } : {});
  const breathing = scaled ? INSPECT.breathingVerdict(seamSeries) : null;
  emit({
    file,
    range: { from, to, frameBase: 0, note: '[from, to) 左闭右开' },
    fps: info.fps,
    rect: rect || null,
    control: control && !flags.width ? { x: Math.round(control.x / scale), y: Math.round(control.y / scale), w: Math.round(control.w / scale), h: Math.round(control.h / scale) } : control,
    scope: scaled ? 'rect' : 'frame',
    verdict: {
      kind: verdict.kind,
      text: verdict.text,
      base: verdict.base,
      flickerRatio: verdict.flickerRatio,
      localized: verdict.localized,
      peakFrame: verdict.peak ? verdict.peak.frame : null,
      peakFrameDisplay: verdict.peak ? verdict.peak.frame + 1 : null,
      peakRatio: verdict.peak ? verdict.peak.ratio : null,
      textFrameBase: 1
    },
    controlVerdict: verdict.control ? { kind: verdict.control.kind, text: verdict.control.text } : null,
    breathing: breathing && { kind: breathing.kind, text: breathing.text, cv: Number(breathing.cv.toFixed(3)) },
    samples: samples.map(item => ({
      frame: item.frame,
      mean: Number(item.mean.toFixed(4)),
      p99: item.p99,
      max: Number(item.max.toFixed(2)),
      mean2: item.mean2 === undefined ? null : Number(item.mean2.toFixed(4)),
      controlMean: item.control ? Number(item.control.mean.toFixed(4)) : null
    }))
  });
}

// 对齐：每个锚点只解一次 A，再把 B 在 ±SEARCH 的窗口一次性解出来比，
// 比逐个偏移反复 seek 快一个数量级
async function alignOffset(fileA, infoA, fileB, infoB, width, search) {
  const anchors = [0.3, 0.5, 0.7]
    .map(ratio => Math.round(infoA.frames * ratio))
    .filter(frame => frame - search >= 0 && frame + search < infoB.frames);
  if (!anchors.length) return null;
  const totals = new Map();
  const spots = [];
  for (const anchor of anchors) {
    const a = await readOneFrame(fileA, infoA, anchor, width);
    if (!a) continue;
    const scores = [];
    await readFrames(fileB, infoB, {
      startFrame: anchor - search,
      count: search * 2 + 1,
      width,
      onFrame: b => {
        if (b.width !== a.width || b.height !== a.height) return;
        const diff = INSPECT.frameDiffStats(a, b).mean;
        scores.push({ offset: b.frame - anchor, diff });
        const bucket = totals.get(b.frame - anchor) || { sum: 0, used: 0 };
        bucket.sum += diff;
        bucket.used++;
        totals.set(b.frame - anchor, bucket);
      }
    });
    if (scores.length) spots.push({ frame: anchor, ...INSPECT.pickBestOffset(scores) });
  }
  const scores = [...totals.entries()].map(([offset, bucket]) => ({ offset, diff: bucket.sum / bucket.used }));
  if (!scores.length) return null;
  const picked = INSPECT.pickBestOffset(scores);
  const distinct = [...new Set(spots.map(spot => spot.offset))];
  return {
    offset: picked.offset,
    confident: picked.confident,
    best: Number(picked.best.toFixed(4)),
    runnerUp: Number(picked.runnerUp.toFixed(4)),
    perPosition: spots.map(spot => ({ frame: spot.frame, offset: spot.offset, confident: spot.confident })),
    consistent: distinct.length === 1,
    hitSearchLimit: Math.abs(picked.offset) >= search || spots.some(spot => Math.abs(spot.offset) >= search),
    warning: distinct.length > 1
      ? '不同位置量出的偏移不一致，中间多半丢过帧，没有统一偏移'
      : (picked.confident ? null : '最优与次优差距太小，这个偏移不可信')
  };
}

async function cmdCompare(fileA, fileB, flags) {
  const [infoA, infoB] = await Promise.all([probe(fileA), probe(fileB)]);
  const width = Number(flags.width) || 360;
  const search = Number(flags.search) || 10;
  let align = null;
  let offset = Number(flags.offset) || 0;
  if (flags.align) {
    align = await alignOffset(fileA, infoA, fileB, infoB, width, search);
    if (align && flags.offset === undefined) offset = align.offset;
  }
  const frame = flags.frame !== undefined ? Number(flags.frame) : Math.round(infoA.frames / 2);
  const a = await readOneFrame(fileA, infoA, frame, width);
  const b = await readOneFrame(fileB, infoB, frame + offset, width);
  if (!a || !b) throw new Error('取不到对比帧');
  if (a.width !== b.width || a.height !== b.height) throw new Error('两片尺寸不一致，没法逐像素比');
  const diff = INSPECT.frameDiffStats(a, b);
  emit({
    a: { file: fileA, width: infoA.width, height: infoA.height, fps: infoA.fps, frames: infoA.frames, bitDepth: infoA.bitDepth },
    b: { file: fileB, width: infoB.width, height: infoB.height, fps: infoB.fps, frames: infoB.frames, bitDepth: infoB.bitDepth },
    mismatch: {
      size: infoA.width !== infoB.width || infoA.height !== infoB.height,
      fps: Math.abs(infoA.fps - infoB.fps) > 0.001,
      frames: infoA.frames !== infoB.frames ? infoA.frames - infoB.frames : 0,
      bitDepth: infoA.bitDepth !== infoB.bitDepth
    },
    align,
    comparedAt: { frameA: frame, frameB: frame + offset, offset },
    diff: { mean: Number(diff.mean.toFixed(4)), p99: diff.p99, max: Number(diff.max.toFixed(2)) }
  });
}

async function cmdRoi(file, flags) {
  const info = await probe(file);
  const frame = Number(flags.frame) || 0;
  const rect = parseRect(flags.rect, '--rect');
  // 清晰度和色差必须用原始像素，不能缩放
  const full = await readOneFrame(file, info, frame, info.width);
  if (!full) throw new Error('取不到这一帧');
  const result = INSPECT.analyzeSelection(full, rect);
  const stepProfile = INSPECT.edgeStepProfile(full, rect);
  const stepVerdict = INSPECT.seamStepVerdict(stepProfile);
  emit({
    file,
    frame,
    rect: result.rect,
    sharp: {
      inner: Number(result.innerSharp.toFixed(2)),
      ring: Number(result.ringSharp.toFixed(2)),
      ratio: Number(result.sharpRatio.toFixed(4)),
      verdict: result.sharpVerdict
    },
    detail: {
      scale: result.effective.scale,
      width: result.effective.width,
      height: result.effective.height,
      confident: result.effective.confident,
      verdict: result.effectiveVerdict,
      note: '量的是细节尺度，不是生成时的标称分辨率；插值越糊这个数越小'
    },
    seam: result.seam && {
      dr: Number(result.seam.dr.toFixed(2)),
      dg: Number(result.seam.dg.toFixed(2)),
      db: Number(result.seam.db.toFixed(2)),
      dy: Number(result.seam.dy.toFixed(2)),
      maxDelta: Number(result.seamMaxDelta.toFixed(2)),
      verdict: result.seamVerdict
    },
    // 接缝台阶：量「跨边的梯度台阶 vs 边外本地梯度」，抓的是硬边和切断。
    // 和上面的 seam 分工：seam 比内外均值(偏色)，这里比梯度(硬边)。
    seamStep: {
      kind: stepVerdict.kind,
      verdict: stepVerdict.text,
      worst: stepVerdict.worst && {
        edge: stepVerdict.worst.edge,
        runRatio: Number(stepVerdict.worst.runRatio.toFixed(2)),
        run: Number(stepVerdict.worst.run.toFixed(3)),
        step: Number(stepVerdict.worst.step.toFixed(2)),
        noise: Number(stepVerdict.worst.noise.toFixed(2))
      },
      edges: Object.fromEntries(Object.entries(stepProfile).map(([k, v]) => [k, v && {
        runRatio: Number(v.runRatio.toFixed(2)),
        run: Number(v.run.toFixed(3)),
        coverage: Number(v.coverage.toFixed(3))
      }]))
    }
  });
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.ffmpeg && typeof flags.ffmpeg === 'string') process.env.VIDEO_CHECKER_FFMPEG = flags.ffmpeg;
  const [command, ...rest] = positional;
  if (!command || flags.help || command === 'help') {
    process.stdout.write(HELP + '\n');
    return;
  }
  const needFile = name => {
    if (!rest[0]) throw new Error(`${name} 要给一个视频文件`);
    if (!fs.existsSync(rest[0])) throw new Error('找不到文件: ' + rest[0]);
  };
  if (command === 'probe') { needFile('probe'); return cmdProbe(rest[0]); }
  if (command === 'scan') { needFile('scan'); return cmdScan(rest[0], flags); }
  if (command === 'roi') { needFile('roi'); return cmdRoi(rest[0], flags); }
  if (command === 'patchcheck') { needFile('patchcheck'); return cmdPatchcheck(rest[0], flags); }
  if (command === 'compare') {
    needFile('compare');
    if (!rest[1] || !fs.existsSync(rest[1])) throw new Error('compare 要给两个文件：成片 原片');
    return cmdCompare(rest[0], rest[1], flags);
  }
  throw new Error('不认识的命令: ' + command);
}

main().catch(error => fail(error.message));
