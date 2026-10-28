#!/usr/bin/env node
// 用已经人工判定过的真实成片校准 patchcheck 的阈值。
//
//   node scripts/calibrate.mjs 样本.csv [--out 结果.json]
//
// CSV 第一行是表头，至少有 video,plan,label 三列，可选 source,offset：
//   video,plan,source,label
//   A01/成片.mp4,A01/成片.report.json,A01/原片.mp4,pass
//   A02/成片.mp4,A02/merge.json,A02/原片.mp4,fail
// 路径相对 CSV 所在目录。label：pass=人工看过没问题，fail=人工确认有穿帮。
// 每条样本跑一次 `cli.js patchcheck`，取各判据的原始数值，对每个判据扫一遍阈值，
// 报告当前阈值的检出率/误报率和让「检出率−误报率」最大的建议阈值。
// 样本太少时建议值没有意义——每类至少 10 条再看。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

// 判据：从 patchcheck 输出里取值的方式 + 当前代码里的判线
export const METRICS = [
  { id: 'flickerRatio', label: '补丁区隔帧闪烁比', current: 2.0, pick: r => max(r.patches.map(p => p.scan.flickerRatio)) },
  { id: 'peakRatio', label: '补丁区跳变倍数', current: 3.0, pick: r => max(r.patches.map(p => (p.scan.inherited ? 0 : p.scan.peakRatio))) },
  { id: 'breathingCv', label: '接缝呼吸变异系数', current: 0.35, pick: r => max(r.patches.map(p => (p.breathing.kind === 'unknown' ? 0 : p.breathing.cv))) },
  { id: 'seamDeltaE', label: '接缝色差 ΔE76', current: 8, pick: r => max(r.patches.map(p => (p.seamColor.max ? p.seamColor.max.dE : 0))) },
  { id: 'seamRunRatio', label: '接缝硬边台阶倍数', current: 3, pick: r => max(r.patches.map(p => p.seamStep.maxRunRatio || 0)) },
  { id: 'junctionRatio', label: '接点跳变倍数', current: 3, pick: r => max(r.junctions.map(j => j.ratio || 0)) },
  { id: 'outsideWorst', label: '遮罩外最大改动', current: 6, pick: r => (r.source ? max(r.source.frames.map(f => f.outside.worst || 0)) : null) }
];

function max(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? Math.max(...v) : 0;
}

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  const split = line => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]).map(h => h.toLowerCase());
  for (const need of ['video', 'plan', 'label']) if (!head.includes(need)) throw new Error(`CSV 表头缺少 ${need}`);
  return lines.slice(1).map(line => Object.fromEntries(split(line).map((v, i) => [head[i], v])));
}

// 每个判据：扫所有候选阈值（预测「穿帮」= 数值 ≥ 阈值）
export function sweep(rows, metric) {
  const data = rows.filter(r => Number.isFinite(r.metrics[metric.id])).map(r => ({ v: r.metrics[metric.id], bad: r.label === 'fail' }));
  const pos = data.filter(d => d.bad).length;
  const neg = data.length - pos;
  const rate = thr => {
    const tp = data.filter(d => d.bad && d.v >= thr).length;
    const fp = data.filter(d => !d.bad && d.v >= thr).length;
    return { threshold: thr, tpr: pos ? tp / pos : null, fpr: neg ? fp / neg : null, tp, fp, fn: pos - tp, tn: neg - fp };
  };
  const candidates = [...new Set(data.map(d => d.v))].sort((a, b) => a - b);
  let best = null;
  for (const thr of candidates) {
    const r = rate(thr);
    if (r.tpr === null || r.fpr === null) continue;
    const j = r.tpr - r.fpr;
    if (!best || j > best.j || (j === best.j && thr > best.threshold)) best = { ...r, j };
  }
  return { id: metric.id, label: metric.label, samples: data.length, positives: pos, negatives: neg, current: rate(metric.current), suggested: best, enough: pos >= 10 && neg >= 10 };
}

function runPatchcheck(row, baseDir) {
  const abs = p => (path.isAbsolute(p) ? p : path.join(baseDir, p));
  const args = [CLI, 'patchcheck', abs(row.video), '--plan', abs(row.plan), '--quiet'];
  if (row.source) args.push('--source', abs(row.source));
  if (row.offset) args.push('--offset', row.offset);
  else if (row.source) args.push('--align');
  return new Promise(resolve => {
    execFile(process.execPath, args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: (error && error.message) || stdout.slice(0, 200) }); }
    });
  });
}

const pct = v => (v === null || v === undefined ? '—' : (v * 100).toFixed(0) + '%');

async function main() {
  const argv = process.argv.slice(2);
  const csvPath = argv.find(a => !a.startsWith('--'));
  if (!csvPath) {
    process.stdout.write('用法：node scripts/calibrate.mjs 样本.csv [--out 结果.json]\n');
    process.exit(1);
  }
  const outIndex = argv.indexOf('--out');
  const baseDir = path.dirname(path.resolve(csvPath));
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const results = [];
  for (const [i, row] of rows.entries()) {
    if (!['pass', 'fail'].includes(row.label)) { process.stderr.write(`跳过第 ${i + 2} 行：label 只能是 pass/fail\n`); continue; }
    process.stderr.write(`[${i + 1}/${rows.length}] ${row.video}\n`);
    const r = await runPatchcheck(row, baseDir);
    if (!r.ok) { process.stderr.write(`  失败：${r.error}\n`); continue; }
    const metrics = Object.fromEntries(METRICS.map(m => [m.id, m.pick(r)]));
    const flagged = r.findings.some(f => f.severity === 'fail');
    results.push({ video: row.video, label: row.label, metrics, flagged, findings: r.findings.map(f => f.text) });
  }
  const pos = results.filter(r => r.label === 'fail');
  const neg = results.filter(r => r.label === 'pass');
  const overall = {
    detected: pos.filter(r => r.flagged).length,
    missed: pos.filter(r => !r.flagged).map(r => r.video),
    falseAlarms: neg.filter(r => r.flagged).map(r => r.video),
    positives: pos.length,
    negatives: neg.length
  };
  const table = METRICS.map(m => sweep(results, m));
  process.stdout.write(`\n样本：穿帮 ${pos.length} 条，合格 ${neg.length} 条${pos.length < 10 || neg.length < 10 ? '（每类不足 10 条，建议阈值仅供参考）' : ''}\n`);
  process.stdout.write(`整体：穿帮检出 ${overall.detected}/${overall.positives}，合格片误报 ${overall.falseAlarms.length}/${overall.negatives}\n\n`);
  process.stdout.write('| 判据 | 当前阈值 | 检出率 | 误报率 | 建议阈值 | 检出率 | 误报率 |\n|---|---|---|---|---|---|---|\n');
  for (const t of table) {
    const s = t.suggested;
    process.stdout.write(`| ${t.label} | ${t.current.threshold} | ${pct(t.current.tpr)} | ${pct(t.current.fpr)} | ${s ? Number(s.threshold.toFixed(3)) : '—'} | ${s ? pct(s.tpr) : '—'} | ${s ? pct(s.fpr) : '—'} |\n`);
  }
  if (overall.missed.length) process.stdout.write(`\n漏掉的穿帮片：${overall.missed.join('、')}\n`);
  if (overall.falseAlarms.length) process.stdout.write(`误报的合格片：${overall.falseAlarms.join('、')}\n`);
  if (outIndex >= 0 && argv[outIndex + 1]) {
    fs.writeFileSync(argv[outIndex + 1], JSON.stringify({ overall, metrics: table, samples: results }, null, 2));
    process.stdout.write(`\n明细已写入 ${argv[outIndex + 1]}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(error.stack + '\n'); process.exit(1); });
}
