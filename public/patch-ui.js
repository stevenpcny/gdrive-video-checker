// ---------- 补丁验收：读 flow-video-patch 配置，画补丁框、体检、记录播放覆盖、导出验收 ----------
// 在 app.js 之后加载，直接用它的全局函数（video、seekAndGrab、jumpToFrame、saveFlags…）。
(function () {
  'use strict';

  const layer = $('patch-layer');
  const layerCtx = layer.getContext('2d');
  const sizedCanvas = document.createElement('canvas');
  const sizedCtx = sizedCanvas.getContext('2d', { willReadFrequently: true });

  const state = {
    key: '',            // 当前视频的 markKey
    videoName: '',
    plan: null,
    planName: '',
    planText: '',
    review: {},         // 服务端存的 { checks, watched, scope }
    watched: [],
    lastFrame: null,
    saveTimer: 0,
    result: null,
    tiles: null,
    running: false,
    stop: false,
    showBoxes: true,
    seq: 0
  };

  const totalFrames = () => (video.duration ? Math.max(1, Math.round(video.duration / frameDur)) : 0);
  const scale = () => PatchPlan.scaleFor(state.plan, video.videoWidth, video.videoHeight);

  // ---------- 载入 ----------
  function setPlan(text, name, persist) {
    let plan;
    try {
      plan = PatchPlan.parse(text);
    } catch (e) {
      toast('补丁配置读不了：' + e.message);
      return false;
    }
    state.plan = plan;
    state.planName = name;
    state.planText = text;
    state.result = null;
    state.tiles = null;
    if (persist && state.key) api('/api/review', { method: 'POST', body: JSON.stringify({ key: state.key, plan: { name, text } }) }).catch(() => {});
    render();
    return true;
  }

  async function onVideo(v) {
    const seq = ++state.seq;
    flushWatched();
    state.key = markKey(v);
    state.videoName = v.Name;
    state.plan = null;
    state.planName = '';
    state.result = null;
    state.tiles = null;
    state.watched = [];
    state.lastFrame = null;
    state.review = {};
    render();
    let review = {};
    try { review = await api('/api/review?key=' + encodeURIComponent(state.key)); } catch { /* 没有记录 */ }
    if (seq !== state.seq) return;
    state.review = review || {};
    state.watched = Array.isArray(review.watched) ? review.watched : [];
    if (review.plan && review.plan.text && setPlan(review.plan.text, review.plan.name, false)) return;
    // 自动找同文件夹里的旁置文件：<名>.report.json 优先，其次 <名>.merge.json / <名>.json
    const base = v.Name.replace(/\.[^.]+$/, '');
    const candidates = [`${base}.report.json`, `${base}.merge.json`, `${base}.json`];
    const found = candidates.map(name => (window.sideFiles || []).find(f => f.Name === name)).find(Boolean);
    if (!found) return render();
    try {
      const path = (curDir ? curDir + '/' : '') + found.Name;
      const r = await api('/api/sidecar?remote=' + encodeURIComponent(curRemote.replace(/:$/, '')) + '&path=' + encodeURIComponent(path));
      if (seq !== state.seq) return;
      if (setPlan(r.text, found.Name, false)) toast(`已自动载入补丁配置：${found.Name}`);
    } catch (e) {
      if (seq === state.seq) toast(`找到 ${found.Name} 但读取失败：${e.message}`);
    }
  }

  function onClear() {
    flushWatched();
    state.seq++;
    state.key = '';
    state.plan = null;
    state.result = null;
    state.tiles = null;
    render();
  }

  $('patch-load-btn').onclick = () => $('patch-file').click();
  $('patch-file').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!state.key) return toast('先打开要检查的成片，再载入它的补丁配置');
    if (setPlan(await file.text(), file.name, true)) toast(`已载入 ${file.name}，按 B 显示/隐藏补丁框`);
  };
  $('patch-unload-btn').onclick = () => {
    if (state.key) api('/api/review', { method: 'POST', body: JSON.stringify({ key: state.key, plan: null }) }).catch(() => {});
    state.plan = null;
    state.result = null;
    state.tiles = null;
    render();
  };

  // ---------- 面板 / 进度条 ----------
  function render() {
    const panel = $('patch-panel');
    panel.hidden = !state.key || publicMode;
    const plan = state.plan;
    $('patch-title').textContent = plan ? `补丁 ${plan.patches.length} 个 · ${state.planName}` : '补丁配置';
    $('patch-title').title = plan ? `${state.planName}（${plan.kind === 'report' ? '合成报告' : 'merge 配置'}）` : '';
    $('patch-unload-btn').hidden = !plan;
    $('patch-actions').hidden = !plan;
    const list = $('patch-list');
    if (!plan) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '没找到 <视频名>.report.json；点「载入」选 merge.json 或合成报告，就能按补丁位置体检';
      list.replaceChildren(hint);
    } else {
      list.replaceChildren(...plan.patches.map(p => {
        const row = document.createElement('div');
        row.className = 'patch-row';
        row.innerHTML = '<span class="name"></span><span class="range"></span>';
        row.querySelector('.name').textContent = p.name;
        row.querySelector('.range').textContent = `帧 ${p.start + 1}–${p.end}`;
        row.title = `[${p.start}, ${p.end}) · ${p.blend} · ${p.shape}${p.protect.length ? ' · 有保护区' : ''}`;
        row.onclick = () => jumpToFrame(p.start);
        return row;
      }));
    }
    renderCoverage();
    renderFindings();
    renderSeek();
  }

  function renderSeek() {
    const box = $('seek-patches');
    if (!state.plan || !video.duration) return box.replaceChildren();
    const d = video.duration;
    const items = state.plan.patches.map(p => {
      const band = document.createElement('i');
      band.className = 'band';
      band.style.left = (p.start * frameDur / d * 100) + '%';
      band.style.width = ((p.end - p.start) * frameDur / d * 100) + '%';
      return band;
    });
    for (const j of PatchPlan.junctions(state.plan)) {
      const tick = document.createElement('i');
      tick.className = 'jt' + (j.segment ? ' seg' : '');
      tick.style.left = (j.frame * frameDur / d * 100) + '%';
      items.push(tick);
    }
    box.replaceChildren(...items);
  }

  function coverageNow() {
    return state.plan ? PatchCheck.coverage(state.plan, state.watched) : null;
  }

  function renderCoverage() {
    const el = $('patch-coverage');
    const c = coverageNow();
    if (!c || !c.total) { el.textContent = ''; el.className = ''; return; }
    el.className = c.ratio >= 1 ? 'full' : '';
    el.textContent = c.ratio >= 1
      ? `✓ 修补帧已全部按正常速度看过（${c.total} 帧）`
      : `正常速度看过修补帧 ${c.watched}/${c.total}（${(c.ratio * 100).toFixed(0)}%）` + (c.missing.length ? `，还差第 ${c.missing[0][0] + 1} 帧起` : '');
    el.title = '只统计 0.9–1.1× 速度连续播放经过的帧；拖动、逐帧、慢放都不算';
  }

  function renderFindings() {
    const box = $('patch-findings');
    const r = state.result;
    if (!r) return box.replaceChildren();
    const rows = [];
    const summary = document.createElement('div');
    const fails = r.findings.filter(f => f.severity === 'fail').length;
    const warns = r.findings.length - fails;
    summary.className = 'finding ' + (fails ? 'fail' : warns ? 'warn' : 'ok');
    summary.textContent = (r.stopped ? '（已停止，结果不完整）' : '')
      + (fails || warns ? `体检发现 ${fails} 个问题、${warns} 个提示（点击跳到帧）` : '体检没有发现补丁引入的问题（仍需正常速度完整看一遍）')
      + (r.source ? '' : '；没开 A/B 对比，未和原片比');
    rows.push(summary);
    for (const f of r.findings) {
      const row = document.createElement('div');
      row.className = 'finding ' + f.severity;
      row.textContent = (f.severity === 'fail' ? '✗ ' : '△ ') + f.text;
      if (Number.isInteger(f.frame)) row.onclick = () => jumpToFrame(f.frame);
      rows.push(row);
    }
    if (r.findings.some(f => Number.isInteger(f.frame))) {
      const btn = document.createElement('button');
      btn.textContent = '把问题帧记为穿帮点';
      btn.onclick = flagFindings;
      rows.push(btn);
    }
    box.replaceChildren(...rows);
  }

  function flagFindings() {
    const key = curFlagKey();
    if (!key || !state.result) return;
    const list = [...flagsOf(key)];
    let added = 0;
    for (const f of state.result.findings) {
      if (!Number.isInteger(f.frame) || list.some(x => x.frame === f.frame)) continue;
      list.push({ frame: f.frame, t: Number(((f.frame + 0.5) * frameDur).toFixed(3)), note: f.text.slice(0, 160) });
      added++;
    }
    if (!added) return toast('这些帧已经都记过了');
    saveFlags(key, list);
    toast(`已记 ${added} 个穿帮点（带问题说明）`);
  }

  // ---------- 画面上的补丁框 ----------
  function layout() {
    const box = videoBox();
    layer.style.left = box.left + 'px';
    layer.style.top = box.top + 'px';
    layer.style.width = box.width + 'px';
    layer.style.height = box.height + 'px';
    const dpr = window.devicePixelRatio || 1;
    layer.width = Math.max(2, Math.round(box.width * dpr));
    layer.height = Math.max(2, Math.round(box.height * dpr));
    renderSeek();
  }

  function drawBoxes() {
    const show = !!state.plan && state.showBoxes && !!video.videoWidth && video.style.display !== 'none';
    layer.hidden = !show;
    if (!show) return;
    const frame = targetFrame();
    const kx = layer.width / video.videoWidth;
    const ky = layer.height / video.videoHeight;
    layerCtx.clearRect(0, 0, layer.width, layer.height);
    const dpr = window.devicePixelRatio || 1;
    const rect = (r, color, dash, label) => {
      layerCtx.strokeStyle = color;
      layerCtx.setLineDash(dash);
      layerCtx.lineWidth = 1.5 * dpr;
      layerCtx.strokeRect(r.x * kx, r.y * ky, r.w * kx, r.h * ky);
      if (label) {
        layerCtx.setLineDash([]);
        layerCtx.fillStyle = color;
        layerCtx.font = `${11 * dpr}px -apple-system, sans-serif`;
        layerCtx.fillText(label, r.x * kx + 3 * dpr, r.y * ky - 4 * dpr);
      }
    };
    const s = scale();
    for (const p of state.plan.patches) {
      const g = PatchPlan.geometryAt(p, frame, s);
      if (!g) continue;
      rect(g.crop, 'rgba(255,255,255,.35)', [4 * dpr, 4 * dpr]);
      if (g.shape === 'ellipse') {
        layerCtx.strokeStyle = '#ff6b6b';
        layerCtx.setLineDash([]);
        layerCtx.lineWidth = 1.5 * dpr;
        layerCtx.beginPath();
        layerCtx.ellipse((g.matte.x + g.matte.w / 2) * kx, (g.matte.y + g.matte.h / 2) * ky, g.matte.w / 2 * kx, g.matte.h / 2 * ky, 0, 0, Math.PI * 2);
        layerCtx.stroke();
        layerCtx.fillStyle = '#ff6b6b';
        layerCtx.fillText(p.name, g.matte.x * kx, g.matte.y * ky - 4 * dpr);
      } else {
        rect(g.matte, '#ff6b6b', [], p.name);
      }
      if (g.core.w > 0 && g.core.h > 0 && g.featherPx >= 2) rect(g.core, 'rgba(255,107,107,.45)', [2 * dpr, 3 * dpr]);
      for (const pr of g.protect) rect(pr, '#69f0ae', [6 * dpr, 3 * dpr], '保护');
    }
  }

  // ---------- 正常速度播放覆盖 ----------
  function tick() {
    if (!state.plan) return;
    drawBoxes();
    const normal = !video.paused && !video.seeking && !dragging && Math.abs(video.playbackRate - 1) <= 0.1 && !lockRunning;
    if (!normal) { state.lastFrame = null; return; }
    const f = currentFrame();
    if (state.lastFrame !== null && f >= state.lastFrame && f - state.lastFrame <= 3) {
      const before = state.watched.length;
      const next = PatchCheck.addRange(state.watched, state.lastFrame, f + 1);
      if (next.length !== before || JSON.stringify(next) !== JSON.stringify(state.watched)) {
        state.watched = next;
        scheduleWatchedSave();
        if (!(f % 6)) renderCoverage();
      }
    }
    state.lastFrame = f;
  }

  function scheduleWatchedSave() {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(flushWatched, 4000);
  }

  function flushWatched() {
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    if (!state.key || !state.plan) return;
    api('/api/review', { method: 'POST', body: JSON.stringify({ key: state.key, watched: state.watched }) }).catch(() => {});
    renderCoverage();
  }

  video.addEventListener('pause', () => { state.lastFrame = null; flushWatched(); });

  // ---------- 体检 ----------
  // 原片取成和成片完全一样的尺寸，逐像素比较才成立
  function grabSized(el, w, h) {
    if (!el || el.readyState < 2) return null;
    if (sizedCanvas.width !== w || sizedCanvas.height !== h) { sizedCanvas.width = w; sizedCanvas.height = h; }
    try {
      sizedCtx.drawImage(el, 0, 0, w, h);
      return sizedCtx.getImageData(0, 0, w, h);
    } catch { return null; }
  }

  const dims = width => {
    const w = width === 'full' ? video.videoWidth : Math.min(width, video.videoWidth);
    return { w, h: Math.max(2, Math.round(video.videoHeight * w / video.videoWidth)) };
  };

  const sourceReady = () => cmpOn && videoB.getAttribute('src') && videoB.readyState >= 2;

  function provider() {
    return {
      read: async function* (frames, width) {
        const { w } = dims(width);
        for (const frame of frames) {
          if (state.stop) return;
          const image = await seekAndGrab(frame, w);
          if (image) yield { frame, image };
        }
      },
      readSource: sourceReady() ? async function* (frames, width) {
        const { w, h } = dims(width);
        for (const frame of frames) {
          if (state.stop) return;
          await seekB(Math.max(0, (frame + cmpOffset + 0.5) * frameDur));
          const image = grabSized(videoB, w, h);
          if (image) yield { frame, image };
        }
      } : null
    };
  }

  async function runCheck() {
    if (state.running || !state.plan) return;
    if (!frameReady()) return toast('这个视频本机解不了码，体检用不了');
    const resume = video.currentTime;
    const wasPlaying = !video.paused;
    video.pause();
    if (cmpLock) $('cmp-lock').click(); // 同帧慢放会抢着 seek，体检期间关掉
    state.running = true;
    state.stop = false;
    $('patch-progress').hidden = false;
    $('patch-check-btn').disabled = true;
    const info = { width: video.videoWidth, height: video.videoHeight, fps: 1 / frameDur, frames: totalFrames() };
    const patched = PatchPlan.patchedFrames(state.plan).length;
    const stride = Math.max(1, Math.ceil(patched / 400));
    const tiles = [];
    const prov = provider();
    if (!prov.readSource) toast('没开 A/B 对比（C 键选原片），这次只查成片本身；接缝/硬边等只给提示');
    try {
      state.result = await PatchCheck.run({
        plan: state.plan,
        info,
        provider: prov,
        shouldStop: () => state.stop,
        onProgress: text => { $('patch-progress-text').textContent = text; },
        onPatchFrame: (p, frame, image, g) => {
          if ((frame - p.start) % stride === 0) tiles.push(PatchCheck.tile(image, g, frame, 160));
        }
      });
      state.tiles = tiles.sort((a, b) => a.frame - b.frame);
      state.tileStride = stride;
    } catch (e) {
      toast('体检出错：' + e.message);
    } finally {
      state.running = false;
      $('patch-progress').hidden = true;
      $('patch-check-btn').disabled = false;
      video.currentTime = resume;
      if (wasPlaying) video.play().catch(() => {});
    }
    renderFindings();
  }

  $('patch-check-btn').onclick = runCheck;
  $('patch-stop-btn').onclick = () => { state.stop = true; };

  // ---------- 导出：PNG / JSON ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function downloadImage(image, name) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    canvas.toBlob(blob => download(blob, name), 'image/png');
  }

  const baseName = () => state.videoName.replace(/\.[^.]+$/, '');

  $('patch-sheet-btn').onclick = async () => {
    if (!state.tiles || !state.tiles.length) {
      // 没体检过就单独跑一遍取帧（只缩图，不做判据）
      if (state.running) return;
      state.running = true;
      state.stop = false;
      $('patch-progress').hidden = false;
      const resume = video.currentTime;
      video.pause();
      const s = scale();
      const frames = PatchPlan.patchedFrames(state.plan);
      const stride = Math.max(1, Math.ceil(frames.length / 400));
      const tiles = [];
      try {
        const picked = frames.filter((f, i) => i % stride === 0);
        for await (const { frame, image } of provider().read(picked, 'full')) {
          const p = state.plan.patches.find(q => q.start <= frame && frame < q.end);
          tiles.push(PatchCheck.tile(image, PatchPlan.geometryAt(p, frame, s), frame, 160));
          $('patch-progress-text').textContent = `联系图取帧 ${tiles.length}/${picked.length}`;
        }
      } finally {
        state.running = false;
        $('patch-progress').hidden = true;
        video.currentTime = resume;
      }
      state.tiles = tiles;
      state.tileStride = stride;
    }
    if (!state.tiles.length) return toast('没取到修补帧');
    downloadImage(PatchCheck.contactSheet(state.tiles), `${baseName()}.修补帧联系图.png`);
    toast(`已导出联系图：${state.tiles.length} 帧` + (state.tileStride > 1 ? `（每 ${state.tileStride} 帧取 1）` : ''));
  };

  $('patch-evidence-btn').onclick = async () => {
    const frame = targetFrame();
    const s = scale();
    const p = state.plan.patches.find(q => q.start <= frame && frame < q.end);
    if (!p) return toast('当前帧不在任何补丁区间里，先跳到补丁上（N 键）');
    const g = PatchPlan.geometryAt(p, frame, s);
    const image = await seekAndGrab(frame, video.videoWidth);
    let src = null;
    if (sourceReady()) {
      await seekB(Math.max(0, (frame + cmpOffset + 0.5) * frameDur));
      src = grabSized(videoB, image.width, image.height);
    }
    const pad = Math.max(16, g.featherPx * 2);
    const rect = { x: g.matte.x - pad, y: g.matte.y - pad, w: g.matte.w + pad * 2, h: g.matte.h + pad * 2 };
    const zoom = Math.max(1, Math.min(4, Math.floor(480 / rect.w)));
    downloadImage(PatchCheck.triptych(image, src, rect, { zoom, frame }), `${baseName()}.第${frame + 1}帧.证据.png`);
    toast(src ? '已导出 成片/原片/差异 三联图' : '已导出成片放大图（开 A/B 对比后会带原片和差异）');
  };

  // ---------- 验收记录 ----------
  const STATUS_TEXT = [['not_run', '未看'], ['pass', '通过'], ['fail', '不通过'], ['not_applicable', '不适用']];

  function openReview() {
    const checks = (state.review && state.review.checks) || {};
    const record = currentRecord();
    $('review-scope').value = (state.review && state.review.scope) || '';
    $('review-rows').replaceChildren(...PatchCheck.REVIEW_CHECKS.map(([id, label]) => {
      const row = document.createElement('div');
      row.className = 'review-row';
      row.dataset.id = id;
      const name = document.createElement('div');
      name.textContent = label;
      name.title = id;
      const sel = document.createElement('select');
      for (const [value, text] of STATUS_TEXT) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        sel.appendChild(opt);
      }
      sel.value = (checks[id] && checks[id].status) || 'not_run';
      const note = document.createElement('input');
      note.placeholder = '证据：看了哪些帧/区域、谁看的、限制';
      note.value = (checks[id] && checks[id].note) || '';
      row.append(name, sel, note);
      const auto = record.checks[id];
      const autoText = (auto.evidence || '').split('\n').filter(line => line.startsWith('[自动') || line.startsWith('合成报告') || line.startsWith('正常速度') || line.startsWith('联系图')).join('\n');
      if (autoText) {
        const a = document.createElement('div');
        a.className = 'auto' + (auto.auto_suggestion === 'fail' ? ' fail' : '');
        a.textContent = autoText;
        row.appendChild(a);
      }
      sel.onchange = note.onchange = () => { saveReview(); updateReviewStatus(); };
      return row;
    }));
    $('review-scope').onchange = saveReview;
    updateReviewStatus();
    $('review-modal').hidden = false;
  }

  function collectChecks() {
    const checks = {};
    for (const row of $('review-rows').children) {
      checks[row.dataset.id] = { status: row.querySelector('select').value, note: row.querySelector('input').value.trim() };
    }
    return checks;
  }

  function saveReview() {
    if (!state.key) return;
    const checks = collectChecks();
    const scope = $('review-scope').value.trim();
    state.review = { ...state.review, checks, scope };
    api('/api/review', { method: 'POST', body: JSON.stringify({ key: state.key, checks, scope }) }).catch(e => toast('验收记录没能保存：' + e.message));
  }

  function currentRecord() {
    const checks = (state.review && state.review.checks) || {};
    const reviewer = { scope: (state.review && state.review.scope) || null };
    for (const [id, v] of Object.entries(checks)) reviewer[id] = v;
    return PatchCheck.reviewRecord({
      plan: state.plan,
      result: state.result,
      finalFile: state.videoName,
      technicalReport: state.plan && state.plan.kind === 'report' ? state.planName : null,
      reviewer,
      coverage: coverageNow(),
      sheet: state.tiles && state.tiles.length ? `${baseName()}.修补帧联系图.png` : null
    });
  }

  function updateReviewStatus() {
    const record = currentRecord();
    const text = { pending_visual_review: '待完成审看（pending_visual_review）', visual_fail: '不通过（visual_fail）', visual_pass: '通过（visual_pass）' }[record.status];
    const c = coverageNow();
    const warn = c && c.ratio < 1 && (state.review.checks || {}).normal_speed_full_playback?.status === 'pass'
      ? '　·　正常速度只看了 ' + (c.ratio * 100).toFixed(0) + '%，「完整播放」按未完成计' : '';
    $('review-status').textContent = '当前结论：' + text + warn;
  }

  $('patch-review-btn').onclick = openReview;
  $('review-close-btn').onclick = () => { $('review-modal').hidden = true; };
  $('review-export-btn').onclick = () => {
    saveReview();
    const record = currentRecord();
    download(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }), `${baseName()}.visual-review.json`);
    toast('已导出验收记录：' + record.status);
  };

  // ---------- 快捷键 ----------
  function jumpJunction(direction) {
    if (!state.plan) return false;
    const now = targetFrame();
    const points = PatchPlan.junctions(state.plan).map(j => j.frame).filter(f => f < totalFrames());
    const next = direction > 0 ? points.find(f => f > now) : [...points].reverse().find(f => f < now);
    if (next === undefined) { toast(direction > 0 ? '后面没有补丁接点了' : '前面没有补丁接点了'); return true; }
    jumpToFrame(next);
    return true;
  }

  document.addEventListener('keydown', e => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (!$('ask-modal').hidden || !$('review-modal').hidden) return;
    if (!state.plan) return;
    if (e.key === 'b' || e.key === 'B') {
      state.showBoxes = !state.showBoxes;
      drawBoxes();
      toast(state.showBoxes ? '显示补丁框（红=贴回区，虚线=完全替换核心，绿=保护区）' : '已隐藏补丁框');
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      jumpJunction(e.shiftKey ? -1 : 1);
    }
  });

  window.addEventListener('beforeunload', flushWatched);
  video.addEventListener('loadedmetadata', () => { layout(); renderSeek(); });

  window.PatchUI = { onVideo, onClear, tick, layout, render };
})();
