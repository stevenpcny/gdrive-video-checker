const VIDEO_EXT = new Set(['mp4','mov','m4v','mkv','webm','avi','ts','mts','flv','wmv','3gp']);
const MAX_DECODED_THUMBS = 600;
const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
let frameDur = 1 / 30;   // 探测到真实帧率前的兜底值
let mediaInfo = null;    // 当前视频的 {width,height,fps,bitDepth,codec,...}
let mediaSeq = 0;        // 探测信息自己一套序号: startFullLoad 会再推进 loadSeq
let mediaInfoReady = Promise.resolve(); // 当前视频帧率探测完成；自动对齐要用真实帧率
let decodeFailed = false;
let loopIn = null;       // 区间首帧
let loopOut = null;      // 区间尾帧(含)
let looping = false;
const DESKTOP = window.videoCheckerDesktop || null;
const { makeItem: makeBatchItem, validateMoveTarget } = window.BatchOps;
const INSPECT = window.Inspect;
const AUTO_FIT_WINDOW = !!DESKTOP || new URLSearchParams(location.search).has('standalone');
const $ = id => document.getElementById(id);
const video = $('video');

let curDir = '';
let dirs = [];
let videos = [];
let curIdx = -1;
let marks = {};
let fitWindowSeq = 0;
let publicMode = false;
let currentPublicLink = null;
const selectedKeys = new Set();
let batchBusy = false;

// 整片预载状态
let loadSeq = 0;
let cacheReady = false;

let curRemote = '';    // 当前账号(rclone remote 名，含冒号)；本地模式是 local-<id>:
let localMode = false;
let localDir = '';

const isLocalRemote = name => typeof name === 'string' && name.startsWith('local-');

const isVideo = name => VIDEO_EXT.has(name.split('.').pop().toLowerCase());
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const keyOf = v => (curDir ? curDir + '/' : '') + v.Name;
const pathOf = v => keyOf(v);
const markKey = v => curRemote + keyOf(v); // 标记按账号隔离
const streamUrl = (remote, p) => '/stream/' + encodeURIComponent(remote.replace(/:$/, '')) + '/' + encPath(p);
const fmt = s => { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

let loadDirSeq = 0; // 防止先发出的慢响应覆盖后点的文件夹
const warmedDirs = new Map();
const WARM_DIR_TTL_MS = 20_000;
let warmTimer = 0;

function showListMessage(text, isError = false) {
  const row = document.createElement('div');
  row.className = 'entry' + (isError ? ' error-row' : '');
  row.textContent = text;
  $('list').replaceChildren(row);
}

async function loadDir(p) {
  const seq = ++loadDirSeq;
  clearTimeout(warmTimer);
  selectedKeys.clear();
  curDir = p; curIdx = -1;
  showListMessage('加载中…');
  try {
    const [listing, m] = await Promise.all([
      api('/api/list?remote=' + encodeURIComponent(curRemote.replace(/:$/, '')) + '&path=' + encodeURIComponent(p)),
      api('/api/marks'),
    ]);
    if (seq !== loadDirSeq) return;
    marks = m;
    dirs = listing.entries.filter(e => e.IsDir);
    videos = listing.entries.filter(e => !e.IsDir && isVideo(e.Name));
    // 视频旁边的 JSON（flow-video-patch 的 *.report.json / merge.json），补丁验收自动载入用
    window.sideFiles = listing.entries.filter(e => !e.IsDir && /\.json$/i.test(e.Name));
    applySort();
    render();
    renderFlags();
    warmTimer = setTimeout(() => warmChildDirectories(seq), 250);
  } catch (e) {
    if (seq === loadDirSeq) showListMessage('加载失败: ' + e.message, true);
  }
}

async function warmChildDirectories(seq) {
  if (seq !== loadDirSeq || !curRemote) return;
  const remote = curRemote.replace(/:$/, '');
  const queue = dirs.slice(0, 12).map(dir => curDir ? `${curDir}/${dir.Name}` : dir.Name)
    .filter(path => {
      const key = `${remote}\0${path}`;
      if ((warmedDirs.get(key) || 0) > Date.now()) return false;
      warmedDirs.set(key, Date.now() + WARM_DIR_TTL_MS);
      return true;
    });
  const worker = async () => {
    while (seq === loadDirSeq && queue.length) {
      const path = queue.shift();
      try {
        await api('/api/list?remote=' + encodeURIComponent(remote) + '&path=' + encodeURIComponent(path));
      } catch { /* 预热失败不影响用户正常打开文件夹 */ }
    }
  };
  await Promise.all([worker(), worker()]);
}

// ---------- RAM 预热: 沿当前列表顺序缓存后续视频 ----------
const cachedSet = new Set(); // markKey -> 已预热
const PREFETCH_AHEAD_COUNT = 8;
let prefetchSeq = 0;

async function prefetchAround(center) {
  const seq = ++prefetchSeq;
  cachedSet.clear();
  render();
  const remote = curRemote.replace(/:$/, '');
  // videos 已按界面选中的排序方式排列；+1 永远代表用户接下来会看到的视频。
  // 当前视频由 startFullLoad 优先缓存，这里同时从下一个开始顺序预热，最后保留前一个供回看。
  const indexes = Array.from({ length: PREFETCH_AHEAD_COUNT }, (_, offset) => center + offset + 1);
  indexes.push(center - 1);
  const queue = indexes
    .filter(i => i >= 0 && i < videos.length)
    .map(i => ({ path: pathOf(videos[i]), key: markKey(videos[i]), size: videos[i].Size }));
  for (const item of queue) {
    if (seq !== prefetchSeq) return;
    try {
      const result = await api('/api/prefetch', { method: 'POST', body: JSON.stringify({ remote, path: item.path, size: item.size }) });
      if (seq !== prefetchSeq) return;
      if (result.cached) {
        cachedSet.add(item.key);
        render();
      }
      refreshRamStatus().catch(() => {});
    } catch { /* 邻近视频预载失败不影响当前播放 */ }
  }
}

let sortMode = 'name';

function sortCmp() {
  return sortMode === 'name'
    ? (a, b) => a.Name.localeCompare(b.Name, 'zh', { numeric: true })
    : sortMode === 'new'
      ? (a, b) => b.ModTime.localeCompare(a.ModTime)
      : (a, b) => a.ModTime.localeCompare(b.ModTime);
}

function applySort() {
  const cmp = sortCmp();
  dirs.sort(cmp);
  const curName = curIdx >= 0 ? videos[curIdx].Name : null;
  videos.sort(cmp);
  if (curName) curIdx = videos.findIndex(v => v.Name === curName);
}

function availableBatchItems() {
  return [
    ...dirs.map(entry => makeBatchItem(entry, true, curDir)),
    ...videos.map(entry => makeBatchItem(entry, false, curDir))
  ];
}

function selectedBatchItems() {
  return availableBatchItems().filter(item => selectedKeys.has(item.key));
}

function updateBatchBar() {
  const available = availableBatchItems();
  const selected = selectedBatchItems();
  const allSelected = available.length > 0 && selected.length === available.length;
  const selectAll = $('select-all');
  selectAll.checked = allSelected;
  selectAll.indeterminate = selected.length > 0 && !allSelected;
  selectAll.disabled = batchBusy || !available.length;
  document.querySelectorAll('.entry-select').forEach(checkbox => { checkbox.disabled = batchBusy; });
  $('selected-count').textContent = selected.length ? `已选 ${selected.length} 项` : '未选择';
  $('batch-move-btn').disabled = batchBusy || !selected.length;
  $('batch-delete-btn').disabled = batchBusy || !selected.length;
}

function setBatchBusy(busy, message = '') {
  batchBusy = busy;
  updateBatchBar();
  if (message) $('selected-count').textContent = message;
}

function addSelectionControl(el, item) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'entry-select';
  checkbox.checked = selectedKeys.has(item.key);
  checkbox.title = `选择「${item.name}」`;
  checkbox.onclick = event => event.stopPropagation();
  checkbox.onchange = () => {
    if (checkbox.checked) selectedKeys.add(item.key);
    else selectedKeys.delete(item.key);
    render();
  };
  el.prepend(checkbox);
  el.classList.toggle('selected', checkbox.checked);
}

function render() {
  const parts = curDir ? curDir.split('/') : [];
  const crumbs = $('crumbs');
  crumbs.replaceChildren();
  let acc = '';
  const addCrumb = (label, target) => {
    if (crumbs.childNodes.length) crumbs.appendChild(document.createTextNode(' / '));
    const link = document.createElement('a');
    link.textContent = label;
    link.onclick = () => loadDir(target);
    crumbs.appendChild(link);
  };
  addCrumb(localMode ? '💻 ' + (localDir.split('/').filter(Boolean).pop() || localDir) : '📁 根目录', '');
  for (const part of parts) {
    acc = acc ? acc + '/' + part : part;
    addCrumb(part, acc);
  }

  const list = $('list');
  list.innerHTML = '';
  for (const d of dirs) {
    const item = makeBatchItem(d, true, curDir);
    const el = document.createElement('div');
    el.className = 'entry';
    el.innerHTML = `<span class="icon">📁</span><span class="name"></span>` +
      `<span class="act-share" title="管理共享权限">👥</span><span class="act-move" title="移动文件夹">⇲</span><span class="actions"><span class="act-rename" title="重命名文件夹">✎</span><span class="act-del" title="删除文件夹（含内容）">🗑</span></span>`;
    el.querySelector('.name').textContent = d.Name;
    el.onclick = () => loadDir((curDir ? curDir + '/' : '') + d.Name);
    el.querySelector('.act-share').onclick = e => { e.stopPropagation(); openShareFolder(d); };
    el.querySelector('.act-move').onclick = e => { e.stopPropagation(); openMoveFolder(d); };
    el.querySelector('.act-rename').onclick = e => { e.stopPropagation(); renameEntry(d, true); };
    el.querySelector('.act-del').onclick = e => { e.stopPropagation(); deleteFolder(d); };
    addSelectionControl(el, item);
    list.appendChild(el);
  }
  videos.forEach((v, i) => {
    const el = document.createElement('div');
    el.className = 'entry' + (i === curIdx ? ' active' : '');
    el.dataset.idx = i;
    const flagCount = flagsOf(markKey(v)).length;
    el.innerHTML = `<span class="icon">🎬</span><span class="name"></span>` +
      (flagCount ? `<span class="badge bad" title="已记 ${flagCount} 个穿帮点">穿 ${flagCount}</span>` : '') +
      `<span class="cache-dot${cachedSet.has(markKey(v)) ? ' cached' : ''}" title="绿点=已预热，秒开"></span>` +
      `<span class="actions"><span class="act-rename" title="重命名视频">✎</span><span class="act-del" title="删除视频">🗑</span></span>`;
    el.querySelector('.name').textContent = v.Name;
    el.onclick = () => play(i);
    addSelectionControl(el, makeBatchItem(v, false, curDir));
    el.querySelector('.act-rename').onclick = e => { e.stopPropagation(); renameEntry(v, false); };
    el.querySelector('.act-del').onclick = e => { e.stopPropagation(); deleteVideo(v); };
    list.appendChild(el);
  });

  if (cmpOn) fillCompareSources();
  $('stats').textContent = videos.length ? `视频 ${videos.length} 个` : '此文件夹没有视频';
  updateBatchBar();
}

function updateNavHitAreas() {
  if (!$('player-wrap').classList.contains('has-video')) return;
  const wrapRect = $('player-wrap').getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  $('prev-btn').style.width = Math.max(76, videoRect.left - wrapRect.left) + 'px';
  $('next-btn').style.width = Math.max(76, wrapRect.right - videoRect.right) + 'px';
}

function fitWindowToVideo(seq, pass = 0) {
  if (seq !== fitWindowSeq || !AUTO_FIT_WINDOW || !video.videoWidth || !video.videoHeight) return;
  const sidebarWidth = $('sidebar').offsetWidth;
  const controlsHeight = $('seek-area').offsetHeight + $('bar').offsetHeight;
  const chromeWidth = window.outerWidth - window.innerWidth;
  const chromeHeight = window.outerHeight - window.innerHeight;
  const maxInnerWidth = screen.availWidth - chromeWidth;
  const maxInnerHeight = screen.availHeight - chromeHeight;
  const scale = Math.min(
    1,
    (maxInnerWidth - sidebarWidth) / video.videoWidth,
    (maxInnerHeight - controlsHeight) / video.videoHeight
  );
  const targetInnerWidth = Math.round(sidebarWidth + video.videoWidth * scale);
  const targetInnerHeight = Math.round(controlsHeight + video.videoHeight * scale);
  const width = targetInnerWidth + chromeWidth;
  const height = targetInnerHeight + chromeHeight;
  // 保留用户摆放的窗口位置；只在新尺寸会越界时向屏幕内收回。
  const left = Math.max(screen.availLeft, Math.min(Math.round(window.screenX), screen.availLeft + screen.availWidth - width));
  const top = Math.max(screen.availTop, Math.min(Math.round(window.screenY), screen.availTop + screen.availHeight - height));
  if (Math.abs(width - window.outerWidth) <= 1 && Math.abs(height - window.outerHeight) <= 1
      && Math.abs(left - window.screenX) <= 1 && Math.abs(top - window.screenY) <= 1) return;
  if (DESKTOP) DESKTOP.setWindowBounds({ width, height, x: left, y: top });
  else {
    window.resizeTo(width, height);
    window.moveTo(left, top);
  }
  if (seq !== fitWindowSeq) return;
  if (pass < 2) setTimeout(() => fitWindowToVideo(seq, pass + 1), 120);
}

function play(i) {
  if (i < 0 || i >= videos.length) return;
  curIdx = i;
  const v = videos[i];
  $('placeholder').style.display = 'none';
  video.style.display = '';
  $('player-wrap').classList.add('has-video');
  resetLoader();
  clearLoop();
  resetInspectTools();
  video.src = streamUrl(curRemote, pathOf(v));
  mediaInfoReady = loadMediaInfo(v, mediaSeq);
  renderFlags();
  requestAnimationFrame(updateNavHitAreas);
  video.play().catch(() => {});
  $('cur-name').textContent = `[${i + 1}/${videos.length}] ${v.Name}`;
  render();
  document.querySelector(`.entry[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  startFullLoad(v);
  prefetchAround(i);
  window.PatchUI?.onVideo(v);
}

// ---------- 整片预载: 服务端只下载一份持久缓存 ----------
function resetLoader() {
  loadSeq++;
  cacheReady = false;
  mediaSeq++;
  mediaInfo = null;
  decodeFailed = false;
  frameDur = 1 / 30;
  renderMediaInfo();
  if (dragSeekRaf) { cancelAnimationFrame(dragSeekRaf); dragSeekRaf = 0; }
  scrubPreviewSeq++;
  requestedScrubSrc = '';
  $('scrub-overlay').style.display = 'none';
  $('load-state').textContent = '';
  $('load-state').className = '';
  thumbSeq++;
  thumbs = null;
  thumbFrames.clear();
  thumbStride = 1;
}

// ---------- 媒体信息: 分辨率 / 帧率 / 色深 ----------
const fpsText = value => String(Number(value.toFixed(3)));

async function loadMediaInfo(v, seq) {
  try {
    const info = await api('/api/probe', {
      method: 'POST',
      body: JSON.stringify({ remote: curRemote.replace(/:$/, ''), path: pathOf(v) })
    });
    if (seq !== mediaSeq) return;
    mediaInfo = info;
    if (info.fps > 0) frameDur = 1 / info.fps;
    renderMediaInfo();
  } catch {
    if (seq === mediaSeq) renderMediaInfo();
  }
}

function renderMediaInfo() {
  const el = $('vinfo');
  if (!el) return;
  if (!mediaInfo) {
    el.textContent = '';
    el.title = '';
    el.classList.remove('warn');
    return;
  }
  const info = mediaInfo;
  const parts = [];
  if (info.width) parts.push(`${info.width}×${info.height}`);
  if (info.fps) parts.push(fpsText(info.fps) + 'fps');
  if (info.bitDepth) parts.push(info.bitDepth + 'bit');
  if (info.codec) parts.push(info.codec);
  const broken = decodeFailed || info.playable === false;
  if (broken) parts.push('⚠ 本机不能直接解码');
  el.textContent = parts.join(' · ');
  el.classList.toggle('warn', broken);
  el.title = [
    info.pixFmt && ('像素格式 ' + info.pixFmt),
    info.colorTags && ('色彩 ' + info.colorTags),
    info.bitrateKbps && (`码率 ${info.bitrateKbps} kb/s`),
    broken && '播放器放不了这个编码；信息和逐帧预览仍可用'
  ].filter(Boolean).join('\n');
}

async function startFullLoad(v) {
  const seq = ++loadSeq;
  const stateEl = $('load-state');
  try {
    stateEl.textContent = '预载中…完成后可连续拖动检查';
    const result = await api('/api/prefetch', {
      method: 'POST',
      body: JSON.stringify({ remote: curRemote.replace(/:$/, ''), path: pathOf(v), size: v.Size })
    });
    if (seq !== loadSeq) return; // 已切到别的视频
    if (!result.cached) {
      stateEl.textContent = (result.reason || '超过 RAM 限制') + '，流式播放';
      return;
    }
    cachedSet.add(markKey(v));
    render();
    refreshRamStatus().catch(() => {});
    cacheReady = true;
    stateEl.textContent = (result.local ? '✓ 本地文件·可连续拖动检查' : '✓ 已预载·可连续拖动检查')
      + (thumbFrames.size ? '·丝滑预览就绪' : '');
    stateEl.className = 'ready';
  } catch (e) {
    if (seq === loadSeq) stateEl.textContent = '';
  }
}

async function startPublicFullLoad(link) {
  const seq = ++loadSeq;
  const stateEl = $('load-state');
  try {
    stateEl.textContent = '边播边预载…';
    const result = await api('/api/public/prefetch', {
      method: 'POST',
      body: JSON.stringify({ fileId: link.id, resourceKey: link.resourceKey })
    });
    if (seq !== loadSeq || !publicMode) return;
    if (!result.cached) {
      stateEl.textContent = (result.reason || '超过 RAM 限制') + '，分段流播';
      return;
    }
    refreshRamStatus().catch(() => {});
    cacheReady = true;
    stateEl.textContent = '✓ 已预载到 RAM·可连续快速拖动' + (thumbFrames.size ? '·预览帧就绪' : '');
    stateEl.className = 'ready';
  } catch (e) {
    if (seq === loadSeq && publicMode) stateEl.textContent = '预载失败，继续分段流播';
  }
}

// ---------- 缩略帧条: 拖动时即时显示预解码画面 ----------
let thumbs = null;      // {base, fps, count}
let thumbSeq = 0;       // 防止切视频后旧结果写回
let scrubPreviewSeq = 0;
let requestedScrubSrc = '';
let thumbFrames = new Map();
let thumbStride = 1;

const thumbSrc = (info, n) => info.base + String(n).padStart(5, '0') + '.jpg';

async function decodeThumbFrames(info, seq) {
  thumbStride = Math.max(1, Math.ceil(info.count / MAX_DECODED_THUMBS));
  const indexes = [];
  for (let n = 1; n <= info.count; n += thumbStride) indexes.push(n);
  if (indexes[indexes.length - 1] !== info.count) indexes.push(info.count);
  let next = 0;
  const worker = async () => {
    while (next < indexes.length && seq === thumbSeq) {
      const n = indexes[next++];
      const img = new Image();
      img.src = thumbSrc(info, n);
      try {
        if (img.decode) await img.decode();
        else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
        if (seq === thumbSeq) thumbFrames.set(n, img);
      } catch { /* 单帧失败不阻断其他预览帧 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, indexes.length) }, worker));
}

async function loadThumbs(v) {
  const seq = ++thumbSeq;
  thumbs = null;
  thumbFrames = new Map();
  thumbStride = 1;
  requestedScrubSrc = '';
  try {
    const r = await api('/api/thumbs', { method: 'POST', body: JSON.stringify({ remote: curRemote.replace(/:$/, ''), path: pathOf(v), size: v.Size }) });
    if (seq !== thumbSeq) return;
    thumbs = r;
    $('load-state').textContent += '·丝滑预览准备中';
    await decodeThumbFrames(r, seq);
    if (seq !== thumbSeq) return;
    const state = $('load-state');
    state.textContent = state.textContent.replace('·丝滑预览准备中', '');
    if (!state.textContent.includes('丝滑预览就绪')) state.textContent += '·丝滑预览就绪';
  } catch { /* 无 ffmpeg 或生成失败: 拖动时保持当前完整画面 */ }
}

async function loadPublicThumbs(link) {
  thumbsLoadingSeq = loadSeq;
  const seq = ++thumbSeq;
  thumbs = null;
  thumbFrames = new Map();
  thumbStride = 1;
  requestedScrubSrc = '';
  const state = $('load-state');
  if (!state.textContent.includes('预览帧准备中')) state.textContent += '·预览帧准备中';
  try {
    const r = await api('/api/public/thumbs', {
      method: 'POST',
      body: JSON.stringify({ fileId: link.id, resourceKey: link.resourceKey })
    });
    if (seq !== thumbSeq || !publicMode) return;
    thumbs = r;
    await decodeThumbFrames(r, seq);
    if (seq !== thumbSeq || !publicMode) return;
    state.textContent = state.textContent.replace('·预览帧准备中', '');
    if (!state.textContent.includes('预览帧就绪')) state.textContent += '·预览帧就绪';
    state.className = 'ready';
  } catch {
    if (seq === thumbSeq && publicMode) state.textContent = state.textContent.replace('·预览帧准备中', '·预览帧生成失败');
  }
}

function showScrubFrame(t) {
  if (!thumbs) return false;
  const raw = Math.min(thumbs.count, Math.max(1, Math.round(t * thumbs.fps) + 1));
  const low = 1 + Math.floor((raw - 1) / thumbStride) * thumbStride;
  const high = Math.min(thumbs.count, low + thumbStride);
  const n = raw - low <= high - raw ? low : high;
  const frame = thumbFrames.get(n);
  if (!frame) return false;
  const ov = $('scrub-overlay');
  ov.src = frame.src;
  ov.style.display = 'block';
  return true;
}

// ---------- 自定义进度条: 连环 seek 拖动刷擦 ----------
const seekbar = $('seekbar');
let dragging = false;
let wasPausedBeforeDrag = false;
let pendingSeek = null;
let dragSeekRaf = 0;
let dragSeekTarget = 0;
let thumbsLoadingSeq = 0;

function triggerLoadThumbs() {
  if (thumbsLoadingSeq === loadSeq) return;
  thumbsLoadingSeq = loadSeq;
  if (publicMode && currentPublicLink) return loadPublicThumbs(currentPublicLink);
  const v = videos[curIdx];
  if (v) loadThumbs(v);
}

function chainSeek(t) {
  if (video.seeking) pendingSeek = t;
  else video.currentTime = t;
}
video.addEventListener('seeked', () => {
  if (pendingSeek !== null) { const t = pendingSeek; pendingSeek = null; video.currentTime = t; }
  else {
    if (zoomOn) requestAnimationFrame(drawZoom);
    // 暂停逐帧看的时候，B 必须跟着 A 走，否则对比的是两个不同的帧
    if (cmpOn && video.paused) syncCompare().then(drawCompare);
  }
});

function scheduleDragSeek(t) {
  dragSeekTarget = t;
  if (dragSeekRaf) return;
  dragSeekRaf = requestAnimationFrame(() => {
    dragSeekRaf = 0;
    if (dragging && cacheReady) chainSeek(dragSeekTarget);
  });
}

function barTime(clientX) {
  const rect = seekbar.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return frac * (video.duration || 0);
}

let dragTarget = 0; // 手指的精确位置，松手时落到这里

function onDragMove(clientX) {
  dragTarget = barTime(clientX);
  if (cacheReady) {
    // 原片已在本地/RAM：只用真实 seek 刷新原画质画面。
    // 不再和 240px 缩略帧来回切换——低清帧被拉满屏、又与高清帧交替闪现，就是拖动时的花屏。
    scrubPreviewSeq++;
    requestedScrubSrc = '';
    $('scrub-overlay').style.display = 'none';
    scheduleDragSeek(dragTarget);
  } else {
    // 流播时 seek 会卡在网络上，用缩略帧预览；某帧还没解码好就保留上一帧，不闪回旧画面。
    showScrubFrame(dragTarget);
  }
  showTip(clientX);
}

seekbar.addEventListener('pointerenter', triggerLoadThumbs);
seekbar.addEventListener('pointerdown', e => {
  triggerLoadThumbs();
  if (!video.duration) return;
  dragging = true;
  wasPausedBeforeDrag = video.paused;
  video.pause();
  seekbar.classList.add('dragging');
  seekbar.setPointerCapture(e.pointerId);
  onDragMove(e.clientX);
});
seekbar.addEventListener('pointermove', e => {
  if (dragging) onDragMove(e.clientX);
});
let resumeSeq = 0;
function resumePlay() {
  const seq = ++resumeSeq;
  video.play().catch(() => { if (seq === resumeSeq && !dragging) video.play().catch(() => {}); });
  // 看门狗: 流播模式下 seek 到未缓冲位置的数据请求可能挂起，重设 currentTime 促使浏览器重新拉数据。
  setTimeout(() => {
    if (seq !== resumeSeq || dragging || video.paused) return;
    if (video.seeking && video.readyState < 3) video.currentTime = video.currentTime;
  }, 3000);
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (dragSeekRaf) { cancelAnimationFrame(dragSeekRaf); dragSeekRaf = 0; }
  scrubPreviewSeq++;
  requestedScrubSrc = '';
  pendingSeek = null;
  seekbar.classList.remove('dragging');
  $('seek-tip').style.display = 'none';
  chainSeek(dragTarget); // 松手: 精确定位
  const hideOverlay = () => { $('scrub-overlay').style.display = 'none'; };
  video.addEventListener('seeked', hideOverlay, { once: true });
  setTimeout(hideOverlay, 500);
  if (!wasPausedBeforeDrag) resumePlay();
}
seekbar.addEventListener('pointerup', endDrag);
// 拖动被系统打断(触控板手势/指针捕获丢失)时不会有 pointerup，必须同样收尾，否则视频永久停在暂停态。
seekbar.addEventListener('pointercancel', endDrag);
seekbar.addEventListener('lostpointercapture', endDrag);

function showTip(clientX) {
  const tip = $('seek-tip');
  const rect = seekbar.getBoundingClientRect();
  tip.style.display = 'block';
  tip.style.left = (clientX - rect.left) + 'px';
  tip.textContent = fmt(barTime(clientX));
}

function updateBar() {
  const d = video.duration || 0;
  const frac = d ? (dragging ? dragTarget : video.currentTime) / d : 0;
  $('seek-played').style.width = (frac * 100) + '%';
  $('seek-handle').style.left = (frac * 100) + '%';
  $('time-cur').textContent = fmt(video.currentTime);
  $('time-dur').textContent = fmt(d);
  $('frame-info').textContent = mediaInfo && mediaInfo.fps && d
    ? `帧 ${currentFrame() + 1}/${Math.max(1, Math.round(d / frameDur))}`
    : '';
  if (looping && loopOut !== null && !dragging && d) {
    const start = ((loopIn === null ? 0 : loopIn) + 0.5) * frameDur;
    const end = (loopOut + 1) * frameDur;
    if (video.currentTime >= end || video.currentTime < start - frameDur) {
      pendingSeek = null; // 循环说了算，丢掉排队中的旧目标
      chainSeek(start);
    }
  }
  let buf = 0;
  for (let i = 0; i < video.buffered.length; i++) buf = Math.max(buf, video.buffered.end(i));
  $('seek-buffered').style.width = (d ? buf / d * 100 : 0) + '%';
  window.PatchUI?.tick();
  requestAnimationFrame(updateBar);
}
requestAnimationFrame(updateBar);

video.addEventListener('play', () => $('play-btn').textContent = '⏸');
video.addEventListener('pause', () => $('play-btn').textContent = '▶');
video.addEventListener('loadedmetadata', () => {
  renderFlags();
  renderLoop();
  updateNavHitAreas();
  layoutOverlays();
  fitWindowToVideo(++fitWindowSeq);
});
video.addEventListener('click', () => {
  // 拉幕时按下/拖动是在拖分界线，不能顺带切换播放（播放用空格）
  if (cmpOn && cmpMode === 'wipe') return;
  video.paused ? video.play() : video.pause();
});
window.addEventListener('resize', () => { updateNavHitAreas(); layoutOverlays(); });

// ---------- 重命名 / 删除 / 上传 ----------
// 变更后重载当前目录，并按名字复位正在播放的视频(不打断播放)。activeName 显式指定复位目标
async function reloadKeepingCurrent(activeName) {
  const playingName = activeName !== undefined ? activeName : (curIdx >= 0 ? videos[curIdx].Name : null);
  await loadDir(curDir);
  if (playingName) {
    const i = videos.findIndex(v => v.Name === playingName);
    if (i >= 0) {
      curIdx = i;
      render();
      document.querySelector(`.entry[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }
}

async function renameEntry(entry, isDir) {
  const oldName = entry.Name;
  const input = await askText(`重命名${isDir ? '文件夹' : '视频'}`, oldName);
  if (input === null) return;
  const newName = input.trim();
  if (!newName || newName === oldName) return;
  if (newName.includes('/')) return toast('名字里不能有斜杠');
  if ([...dirs, ...videos].some(e => e !== entry && e.Name === newName)) return toast(`「${newName}」已存在`);
  const remote = curRemote.replace(/:$/, '');
  const base = curDir ? curDir + '/' : '';
  const from = base + oldName, to = base + newName;
  const wasCurrent = !isDir && curIdx >= 0 && videos[curIdx] === entry;
  try {
    await api('/api/rename', { method: 'POST', body: JSON.stringify({ remote, from, to }) });
    // 迁移文件标记(marks 以路径为 key，不迁会失联；文件夹内子项标记无法批量迁，属既有限制)
    if (!isDir && marks[curRemote + from]) {
      const moved = marks[curRemote + from];
      await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: curRemote + to, flags: moved.flags || [] }) });
      await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: curRemote + from, flags: [] }) });
    }
    await reloadKeepingCurrent(wasCurrent ? newName : undefined);
    toast(`已重命名为「${newName}」`);
  } catch (e) {
    toast('重命名失败: ' + e.message);
  }
}

async function deleteVideo(v) {
  if (!confirm(`删除「${v.Name}」？\n\n文件会移入 Google Drive 回收站，可在云端硬盘「回收站」里恢复。`)) return;
  const remote = curRemote.replace(/:$/, '');
  const p = keyOf(v);
  const wasCurrent = curIdx >= 0 && videos[curIdx] === v;
  try {
    await api('/api/delete', { method: 'POST', body: JSON.stringify({ remote, path: p }) });
    if (marks[curRemote + p]) await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: curRemote + p, flags: [] }) });
    if (wasCurrent) stopPlayback();
    await reloadKeepingCurrent(wasCurrent ? null : undefined);
    toast(`已删除「${v.Name}」（Drive 回收站可恢复）`);
  } catch (e) {
    toast('删除失败: ' + e.message);
  }
}

async function deleteFolder(d) {
  if (!confirm(`删除文件夹「${d.Name}」及其中全部内容？\n\n会移入 Google Drive 回收站，可在云端硬盘「回收站」里恢复。`)) return;
  const remote = curRemote.replace(/:$/, '');
  const p = (curDir ? curDir + '/' : '') + d.Name;
  try {
    await api('/api/delete', { method: 'POST', body: JSON.stringify({ remote, path: p, isDir: true }) });
    await reloadKeepingCurrent();
    toast(`已删除文件夹「${d.Name}」（Drive 回收站可恢复）`);
  } catch (e) {
    toast('删除失败: ' + e.message);
  }
}

let movingItems = [];
let moveFolderDir = '';
let moveFolderEntries = [];
let moveFolderAllEntries = [];
let moveFolderSeq = 0;

function closeMoveFolder() {
  moveFolderSeq++;
  movingItems = [];
  $('move-folder-modal').hidden = true;
  setBatchBusy(false);
}

function renderMoveFolderPicker() {
  const crumbs = $('move-folder-crumbs');
  crumbs.replaceChildren();
  const addCrumb = (label, target) => {
    if (crumbs.childNodes.length) crumbs.appendChild(document.createTextNode(' / '));
    const link = document.createElement('a');
    link.textContent = label;
    link.onclick = () => loadMoveFolderDir(target);
    crumbs.appendChild(link);
  };
  addCrumb('📁 根目录', '');
  let acc = '';
  for (const part of moveFolderDir ? moveFolderDir.split('/') : []) {
    acc = acc ? `${acc}/${part}` : part;
    addCrumb(part, acc);
  }

  const sourceFolders = movingItems.filter(item => item.isDir).map(item => item.path);
  const list = $('move-folder-list');
  list.replaceChildren();
  for (const entry of moveFolderEntries) {
    const path = moveFolderDir ? `${moveFolderDir}/${entry.Name}` : entry.Name;
    const button = document.createElement('button');
    button.className = 'move-folder-entry';
    button.textContent = '📁 ' + entry.Name;
    button.disabled = sourceFolders.some(source => path === source || path.startsWith(source + '/'));
    button.title = button.disabled ? '不能移入自身或子目录' : `打开「${entry.Name}」`;
    button.onclick = () => loadMoveFolderDir(path);
    list.appendChild(button);
  }
  if (!moveFolderEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'entry';
    empty.textContent = '此处没有子文件夹';
    list.appendChild(empty);
  }

  const error = validateMoveTarget(movingItems, moveFolderDir, moveFolderAllEntries);
  const confirm = $('move-folder-confirm-btn');
  confirm.disabled = !!error;
  const status = $('move-folder-status');
  status.className = error ? 'error' : '';
  status.textContent = error || `将 ${movingItems.length} 项移动到：${moveFolderDir || '根目录'}`;
}

async function loadMoveFolderDir(path) {
  if (!movingItems.length) return;
  const seq = ++moveFolderSeq;
  moveFolderDir = path;
  $('move-folder-list').textContent = '加载中…';
  $('move-folder-status').textContent = '';
  $('move-folder-confirm-btn').disabled = true;
  try {
    const listing = await api('/api/list?remote=' + encodeURIComponent(movingItems[0].remote) + '&path=' + encodeURIComponent(path));
    if (seq !== moveFolderSeq || !movingItems.length) return;
    moveFolderAllEntries = listing.entries;
    moveFolderEntries = listing.entries.filter(entry => entry.IsDir).sort(sortCmp());
    renderMoveFolderPicker();
  } catch (e) {
    if (seq !== moveFolderSeq || !movingItems.length) return;
    $('move-folder-list').textContent = '';
    $('move-folder-status').className = 'error';
    $('move-folder-status').textContent = '读取目录失败: ' + e.message;
  }
}

function openMoveItems(items) {
  if (!items.length) return;
  const remote = curRemote.replace(/:$/, '');
  movingItems = items.map(item => ({ ...item, remote }));
  const names = movingItems.slice(0, 3).map(item => `「${item.name}」`).join('、');
  const more = movingItems.length > 3 ? ` 等 ${movingItems.length} 项` : '';
  $('move-folder-source').textContent = `为 ${names}${more} 选择新位置，名称保持不变。`;
  $('move-folder-modal').hidden = false;
  setBatchBusy(true);
  loadMoveFolderDir('');
}

function openMoveFolder(entry) {
  openMoveItems([makeBatchItem(entry, true, curDir)]);
}

$('move-folder-cancel-btn').onclick = closeMoveFolder;
$('move-folder-confirm-btn').onclick = async () => {
  if (!movingItems.length) return;
  const items = movingItems.slice();
  const remote = items[0].remote;
  const button = $('move-folder-confirm-btn');
  button.disabled = true;
  $('move-folder-status').className = '';
  const failures = [];
  const warnings = [];
  let success = 0;
  let movedCurrent = false;
  for (const [index, item] of items.entries()) {
    $('move-folder-status').textContent = `正在移动 ${index + 1}/${items.length}：${item.name}`;
    const to = moveFolderDir ? `${moveFolderDir}/${item.name}` : item.name;
    try {
      await api('/api/move', { method: 'POST', body: JSON.stringify({ remote, from: item.path, to, isDir: item.isDir }) });
      success++;
      if (!item.isDir) {
        const fromMark = `${remote}:${item.path}`;
        const toMark = `${remote}:${to}`;
        if (marks[fromMark]) {
          try {
            await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: toMark, flags: marks[fromMark].flags || [] }) });
            await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: fromMark, flags: [] }) });
          } catch (error) {
            warnings.push(`${item.name}的检查标记未同步（${error.message}）`);
          }
        }
        if (curIdx >= 0 && videos[curIdx] === item.entry) movedCurrent = true;
      }
    } catch (error) {
      failures.push({ ...item, error: error.message });
    }
  }
  if (movedCurrent) stopPlayback();
  await reloadKeepingCurrent(movedCurrent ? null : undefined);
  if (!failures.length) {
    closeMoveFolder();
    const warningText = warnings.length ? `；${warnings.join('；')}` : '';
    toast(`已将 ${success} 项移动到「${moveFolderDir || '根目录'}」${warningText}`);
  } else {
    movingItems = failures;
    for (const item of failures) selectedKeys.add(item.key);
    render();
    $('move-folder-status').className = 'error';
    $('move-folder-status').textContent = `已移动 ${success} 项，${failures.length} 项失败：` + failures.map(item => `${item.name}（${item.error}）`).join('；');
    button.disabled = false;
  }
};

$('select-all').onchange = event => {
  const items = availableBatchItems();
  if (event.target.checked) items.forEach(item => selectedKeys.add(item.key));
  else selectedKeys.clear();
  render();
};

$('batch-move-btn').onclick = () => openMoveItems(selectedBatchItems());

$('batch-delete-btn').onclick = async () => {
  const items = selectedBatchItems();
  if (!items.length) return;
  const folderCount = items.filter(item => item.isDir).length;
  const videoCount = items.length - folderCount;
  const detail = [folderCount && `${folderCount} 个文件夹`, videoCount && `${videoCount} 个视频`].filter(Boolean).join('、');
  if (!confirm(`删除所选 ${detail}？\n\n文件夹中的全部内容也会删除。项目会移入 Google Drive 回收站，可在云端硬盘「回收站」恢复。`)) return;

  setBatchBusy(true, `正在删除 0/${items.length}`);
  const remote = curRemote.replace(/:$/, '');
  const failures = [];
  const warnings = [];
  let success = 0;
  let deletedCurrent = false;
  for (const [index, item] of items.entries()) {
    setBatchBusy(true, `正在删除 ${index + 1}/${items.length}：${item.name}`);
    try {
      await api('/api/delete', { method: 'POST', body: JSON.stringify({ remote, path: item.path, isDir: item.isDir }) });
      success++;
      if (!item.isDir && marks[`${remote}:${item.path}`]) {
        try {
          await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: `${remote}:${item.path}`, flags: [] }) });
        } catch (error) {
          warnings.push(`${item.name}的检查标记未清理（${error.message}）`);
        }
      }
      if (!item.isDir && curIdx >= 0 && videos[curIdx] === item.entry) deletedCurrent = true;
    } catch (error) {
      failures.push({ ...item, error: error.message });
    }
  }
  if (deletedCurrent) stopPlayback();
  await reloadKeepingCurrent(deletedCurrent ? null : undefined);
  for (const item of failures) selectedKeys.add(item.key);
  setBatchBusy(false);
  render();
  const failureText = failures.length ? `，${failures.length} 项失败：${failures.map(item => `${item.name}（${item.error}）`).join('；')}` : '';
  const warningText = warnings.length ? `；${warnings.join('；')}` : '';
  toast(`已删除 ${success} 项${failureText}${warningText}（Drive 回收站可恢复）`);
};

let sharingFolder = null;
let sharingData = null;
let shareSeq = 0;

function closeShareFolder() {
  shareSeq++;
  sharingFolder = null;
  sharingData = null;
  $('share-folder-modal').hidden = true;
}

function shareRoleLabel(role) {
  return ({ owner: '所有者', organizer: '管理员', fileOrganizer: '内容管理员', writer: '编辑者', commenter: '评论者', reader: '查看者' })[role] || role;
}

function permissionLabel(permission) {
  if (permission.type === 'anyone') return '🌐 知道链接的任何人';
  if (permission.type === 'domain') return `🏢 ${permission.domain || permission.displayName || '组织'}`;
  if (permission.type === 'group') return `👥 ${permission.emailAddress || permission.displayName || '群组'}`;
  return `👤 ${permission.emailAddress || permission.displayName || '用户'}`;
}

function renderSharePermissions() {
  if (!sharingFolder || !sharingData) return;
  const canShare = !!sharingData.file?.capabilities?.canShare;
  $('share-folder-title').textContent = `共享「${sharingData.file?.name || sharingFolder.name}」`;
  const anyone = sharingData.permissions.find(permission => permission.type === 'anyone');
  $('share-link-role').value = anyone?.role === 'writer' ? 'writer' : anyone ? 'reader' : 'restricted';
  $('share-link-role').disabled = !canShare || !!anyone?.inherited;
  $('share-link-apply-btn').disabled = !canShare || !!anyone?.inherited;
  $('share-email').disabled = !canShare;
  $('share-user-role').disabled = !canShare;
  $('share-user-add-btn').disabled = !canShare;

  const list = $('share-permission-list');
  list.replaceChildren();
  for (const permission of sharingData.permissions.filter(item => item.type !== 'anyone')) {
    const row = document.createElement('div');
    row.className = 'share-permission-row';
    const identity = document.createElement('div');
    identity.className = 'share-permission-identity';
    identity.textContent = permissionLabel(permission);
    if (permission.inherited) {
      const inherited = document.createElement('small');
      inherited.textContent = '继承自上级';
      identity.appendChild(inherited);
    }
    row.appendChild(identity);
    const fixed = permission.inherited || ['owner', 'organizer', 'fileOrganizer'].includes(permission.role) || !canShare;
    if (fixed) {
      const role = document.createElement('span');
      role.className = 'share-fixed-role';
      role.textContent = shareRoleLabel(permission.role);
      row.appendChild(role);
    } else {
      const select = document.createElement('select');
      for (const [value, label] of [['reader', '查看者'], ['commenter', '评论者'], ['writer', '编辑者']]) {
        const option = document.createElement('option');
        option.value = value; option.textContent = label; option.selected = permission.role === value;
        select.appendChild(option);
      }
      select.onchange = () => changeSharePermission(permission, select.value);
      row.appendChild(select);
      const remove = document.createElement('button');
      remove.textContent = '移除';
      remove.className = 'share-remove-btn';
      remove.onclick = () => removeSharePermission(permission);
      row.appendChild(remove);
    }
    list.appendChild(row);
  }
  if (!sharingData.permissions.some(item => item.type !== 'anyone')) {
    const empty = document.createElement('div');
    empty.className = 'share-empty'; empty.textContent = '没有其他用户或组织权限'; list.appendChild(empty);
  }
  const status = $('share-folder-status');
  status.className = canShare ? '' : 'error';
  status.textContent = canShare
    ? (anyone?.inherited ? '链接权限继承自上级，需要在权限来源处修改。' : '权限变更会立即同步到 Google Drive。')
    : '当前账号只能查看权限，无权修改共享设置。';
}

async function loadSharePermissions() {
  if (!sharingFolder) return;
  const seq = ++shareSeq;
  $('share-folder-loading').hidden = false;
  $('share-folder-content').hidden = true;
  $('share-folder-status').className = '';
  $('share-folder-status').textContent = '';
  try {
    const data = await api('/api/folder-permissions?remote=' + encodeURIComponent(sharingFolder.remote) + '&fileId=' + encodeURIComponent(sharingFolder.id));
    if (seq !== shareSeq || !sharingFolder) return;
    sharingData = data;
    $('share-folder-loading').hidden = true;
    $('share-folder-content').hidden = false;
    renderSharePermissions();
  } catch (e) {
    if (seq !== shareSeq || !sharingFolder) return;
    $('share-folder-loading').textContent = '读取权限失败: ' + e.message;
    $('share-folder-status').className = 'error';
  }
}

function openShareFolder(entry) {
  if (!entry.ID) return toast('这个文件夹没有可用的 Google Drive ID');
  sharingFolder = { id: entry.ID, name: entry.Name, remote: curRemote.replace(/:$/, '') };
  $('share-folder-modal').hidden = false;
  $('share-folder-loading').textContent = '正在读取 Google Drive 权限…';
  loadSharePermissions();
}

async function applyShareAction(payload) {
  if (!sharingFolder) return;
  $('share-folder-status').className = '';
  $('share-folder-status').textContent = '正在同步到 Google Drive…';
  for (const id of ['share-link-apply-btn', 'share-user-add-btn']) $(id).disabled = true;
  try {
    const data = await api('/api/folder-permissions', {
      method: 'POST',
      body: JSON.stringify({ remote: sharingFolder.remote, fileId: sharingFolder.id, ...payload })
    });
    sharingData = data.file ? data : await api('/api/folder-permissions?remote=' + encodeURIComponent(sharingFolder.remote) + '&fileId=' + encodeURIComponent(sharingFolder.id));
    renderSharePermissions();
    toast('共享权限已更新');
  } catch (e) {
    $('share-folder-status').className = 'error';
    $('share-folder-status').textContent = '更新失败: ' + e.message;
    renderSharePermissions();
  }
}

async function changeSharePermission(permission, role) {
  await applyShareAction({ action: 'update', permissionId: permission.id, role });
}

async function removeSharePermission(permission) {
  if (!confirm(`移除「${permissionLabel(permission).slice(2)}」对这个文件夹的权限？`)) return;
  await applyShareAction({ action: 'delete', permissionId: permission.id });
}

$('share-folder-close-btn').onclick = closeShareFolder;
$('share-link-apply-btn').onclick = async () => {
  const value = $('share-link-role').value;
  if (value === 'writer' && !confirm('确实允许拿到链接的任何人编辑、上传和删除这个文件夹中的内容？')) return;
  await applyShareAction({ action: 'set-link', role: value === 'restricted' ? null : value });
};
$('share-user-add-btn').onclick = async () => {
  const email = $('share-email').value.trim();
  if (!email) return toast('请输入邮箱地址');
  await applyShareAction({ action: 'add-user', email, role: $('share-user-role').value });
  $('share-email').value = '';
};

async function uploadFiles(files) {
  const remote = curRemote.replace(/:$/, '');
  const base = curDir ? curDir + '/' : '';
  const existing = new Set([...dirs, ...videos].map(e => e.Name));
  let done = 0, fail = 0;
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    if (existing.has(f.name)) { toast(`「${f.name}」已存在，跳过`); fail++; continue; }
    const id = Math.random().toString(36).slice(2);
    const label = `上传中 ${n + 1}/${files.length}：${f.name}`;
    toast(label + ' …');
    // 轮询服务端 copyto 进度(浏览器→本地服务器几乎瞬时，耗时在服务器→Drive)
    const poll = setInterval(async () => {
      try {
        const r = await api('/api/upload/progress?id=' + id);
        toast(`${label} ${r.pct}%`);
      } catch { /* 忽略单次轮询失败 */ }
    }, 400);
    try {
      const r = await fetch('/api/upload?remote=' + encodeURIComponent(remote) + '&path=' + encodeURIComponent(base + f.name) + '&id=' + id, { method: 'POST', body: f });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || r.status); }
      existing.add(f.name);
      done++;
    } catch (e) { fail++; toast(`上传「${f.name}」失败: ${e.message}`); }
    finally { clearInterval(poll); }
  }
  await reloadKeepingCurrent();
  if (done) toast(`已上传 ${done} 个视频${fail ? `，${fail} 个跳过/失败` : ''}`);
}

$('upload-btn').onclick = () => $('upload-file').click();
$('upload-file').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) uploadFiles(fs); };

// ---------- 切换 ----------
function next() { if (curIdx + 1 < videos.length) play(curIdx + 1); else toast('已经是最后一个了'); }
function prev() { if (curIdx > 0) play(curIdx - 1); }

// 跳到父文件夹里的上/下一个同级文件夹(按当前排序)，自动播放第一个视频
async function gotoFolder(delta) {
  if (!curDir) return toast('已在根目录，没有上一级');
  const cut = curDir.lastIndexOf('/');
  const parent = cut < 0 ? '' : curDir.slice(0, cut);
  const name = cut < 0 ? curDir : curDir.slice(cut + 1);
  $('next-folder-btn').disabled = $('prev-folder-btn').disabled = true;
  try {
    const r = await api('/api/list?remote=' + encodeURIComponent(curRemote.replace(/:$/, '')) + '&path=' + encodeURIComponent(parent));
    const folders = r.entries.filter(e => e.IsDir).sort(sortCmp());
    const i = folders.findIndex(f => f.Name === name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= folders.length) {
      return toast(delta > 0 ? '已经是上一级里的最后一个文件夹了' : '已经是上一级里的第一个文件夹了');
    }
    const target = (parent ? parent + '/' : '') + folders[j].Name;
    stopPlayback();
    await loadDir(target);
    if (videos.length) play(0); else toast(`「${folders[j].Name}」里没有视频`);
  } catch (e) {
    toast('切换失败: ' + e.message);
  } finally {
    $('next-folder-btn').disabled = $('prev-folder-btn').disabled = false;
  }
}
$('prev-folder-btn').onclick = () => gotoFolder(-1);
$('next-folder-btn').onclick = () => gotoFolder(1);

// 按视频编号从小到大，复制检查结果，一行一个，可粘贴到表格一列。
// 穿帮 = 记过穿帮点(F)的视频；其余 = 已完成。
async function copyResult() {
  const numOf = name => { const n = parseInt(name, 10); return Number.isNaN(n) ? Infinity : n; };
  const rows = videos.map(v => ({ name: v.Name, bad: flagsOf(markKey(v)).length > 0 }));
  if (!rows.length) { toast('这个文件夹没有可复制的结果'); return; }
  rows.sort((a, b) => numOf(a.name) - numOf(b.name) || a.name.localeCompare(b.name, 'zh', { numeric: true }));
  const badCount = rows.filter(r => r.bad).length;
  const text = rows.map(r => r.bad ? '穿帮' : '✅ 已完成').join('\n');
  if (await writeClipboard(text)) {
    toast(`已复制 ${rows.length} 条结果（穿帮 ${badCount}），按编号从小到大`);
  } else {
    toast('复制失败，请检查浏览器剪贴板权限');
  }
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到 execCommand 兜底 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
$('copy-result-btn').onclick = copyResult;

let toastTimer;
function toast(msg) {
  $('toast-msg').textContent = msg;
  $('toast').style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('toast').style.display = 'none'; }

// ---------- 播放速度 ----------
function renderSpeed(rate) {
  // 和下拉框一致时不再重复显示；长按扫描时由 startArrowHold 写入「快进 4×」
  $('speed').textContent = Number($('speed-sel').value) === rate ? '' : Number(rate.toFixed(2)) + 'x';
}

function setSpeed(rate, persist = true) {
  const value = Math.min(4, Math.max(0.0625, Number(rate) || 1));
  // defaultPlaybackRate 一起设，否则换视频时 playbackRate 会被重置回 1。
  video.defaultPlaybackRate = value;
  video.playbackRate = value;
  $('speed-sel').value = SPEEDS.includes(value) ? String(value) : '';
  renderSpeed(value);
  if (persist) saveSettings({ playbackRate: value }).catch(() => {});
}

function nudgeSpeed(direction) {
  const current = video.defaultPlaybackRate || 1;
  let index = SPEEDS.findIndex(rate => rate >= current - 1e-6);
  if (index < 0) index = SPEEDS.length - 1;
  setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, index + direction))]);
}

$('speed-sel').onchange = e => setSpeed(Number(e.target.value));
$('frame-info').onclick = () => askJumpFrame();

// ---------- 逐帧 ----------
const frameAt = t => Math.max(0, Math.round(t / frameDur - 0.5));
const currentFrame = () => frameAt(video.currentTime);
// seek 还在路上时 video.currentTime 仍是旧值；取排队中的目标，
// 否则「跳帧之后马上按 F / O / L」会落在上一个位置上。
const targetFrame = () => frameAt(pendingSeek !== null ? pendingSeek : video.currentTime);

function stepFrame(delta) {
  // 从排队中的目标帧往前走：连按 , / . 时上一次 seek 还没落地，用 currentTime 会丢步。
  const target = Math.max(0, targetFrame() + delta);
  // 落在帧中心，避免精度误差把画面停在相邻帧上。
  chainSeek(Math.min(video.duration || Infinity, (target + 0.5) * frameDur));
}

// ---------- 快捷键 ----------
let arrowHold = null;

function finishArrowHold(commitShort = true) {
  const hold = arrowHold;
  if (!hold) return;
  arrowHold = null;
  clearTimeout(hold.timer);
  if (hold.interval) clearInterval(hold.interval);
  video.playbackRate = hold.originalPlaybackRate;
  renderSpeed(hold.originalPlaybackRate);
  $('scrub-overlay').style.display = 'none';
  if (hold.active) {
    if (hold.wasPlaying) video.play().catch(() => {});
    else video.pause();
  } else if (commitShort && video.duration) {
    chainSeek(video.currentTime + hold.direction * (hold.shiftKey ? 30 : 5));
  }
}

function startArrowHold(key, shiftKey) {
  if (!video.duration || arrowHold) return;
  const direction = key === 'ArrowRight' ? 1 : -1;
  const hold = {
    key,
    direction,
    shiftKey,
    active: false,
    wasPlaying: !video.paused,
    originalPlaybackRate: video.playbackRate,
    interval: null,
    lastTick: 0,
    timer: null
  };
  arrowHold = hold;
  hold.timer = setTimeout(() => {
    if (arrowHold !== hold) return;
    hold.active = true;
    const rate = Number($('hold-seek-rate').value) || 4;
    $('speed').textContent = (direction > 0 ? '快进 ' : '倒退 ') + rate + '×';
    if (direction > 0) {
      // 向前扫描使用浏览器的真实倍速播放，让连续动作始终可见；高倍速下允许解码自然降帧。
      $('scrub-overlay').style.display = 'none';
      video.playbackRate = rate;
      video.play().catch(() => {});
      return;
    }
    // 浏览器不支持负播放速度，倒退继续用高频 seek + 预览帧。
    video.pause();
    hold.lastTick = performance.now();
    hold.interval = setInterval(() => {
      if (arrowHold !== hold) return;
      const now = performance.now();
      const elapsed = Math.min(0.25, (now - hold.lastTick) / 1000);
      hold.lastTick = now;
      const target = Math.min(video.duration, Math.max(0, video.currentTime + direction * rate * elapsed));
      chainSeek(target);
      if (!cacheReady) showScrubFrame(target);
    }, 50);
  }, 1000);
}

document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
  if (!$('ask-modal').hidden) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (k === 'ArrowRight' || k === 'ArrowLeft') {
    e.preventDefault();
    if (!e.repeat) startArrowHold(k, e.shiftKey);
  }
  else if (k === ',') { video.pause(); stepFrame(-1); }
  else if (k === '.') { video.pause(); stepFrame(1); }
  else if (k === '[') { e.preventDefault(); nudgeSpeed(-1); }
  else if (k === ']') { e.preventDefault(); nudgeSpeed(1); }
  else if (k === 'f' || k === 'F') { e.preventDefault(); addFlag(); }
  else if (k === 'j' || k === 'J') { e.preventDefault(); askJumpFrame(); }
  else if (k === 'i' || k === 'I') { e.preventDefault(); setLoopEdge('in'); }
  else if (k === 'o' || k === 'O') { e.preventDefault(); setLoopEdge('out'); }
  else if ((k === 'l' || k === 'L') && e.shiftKey) { e.preventDefault(); setLoopVideo(!video.loop); }
  else if (k === 'l' || k === 'L') { e.preventDefault(); toggleLoop(); }
  else if (k === 'd' || k === 'D') { e.preventDefault(); toggleDiffView(); }
  else if (k === 'z' || k === 'Z') { e.preventDefault(); toggleZoom(); }
  else if (k === 'r' || k === 'R') { e.preventDefault(); toggleRoi(); }
  else if (k === 's' || k === 'S') { e.preventDefault(); scanRange(); }
  else if (k === 'c' || k === 'C') { e.preventDefault(); toggleCompare(); }
  else if (k === 'x' || k === 'X') { e.preventDefault(); flipCompare(); }
  else if (k === 'v' || k === 'V') { e.preventDefault(); cycleCompareMode(); }
  else if (k === 'Escape') { if (looping || loopIn !== null) { clearLoop(); toast('已清除区间'); } }
  else if (k === 'ArrowUp') {
    e.preventDefault();
    if (!e.repeat) prev();
  }
  else if (k === 'ArrowDown') {
    e.preventDefault();
    if (!e.repeat) next();
  }
  else if (k === 'm' || k === 'M') { video.muted = !video.muted; $('mute-btn').textContent = video.muted ? '🔇' : '🔊'; }
  else if (k === 'Enter') next();
  else if (k === 'p' || k === 'P') prev();
});
document.addEventListener('keyup', e => {
  if (arrowHold && e.key === arrowHold.key) {
    e.preventDefault();
    finishArrowHold(true);
  }
});
window.addEventListener('blur', () => finishArrowHold(false));

$('play-btn').onclick = () => video.paused ? video.play() : video.pause();
$('mute-btn').onclick = () => { video.muted = !video.muted; $('mute-btn').textContent = video.muted ? '🔇' : '🔊'; };
$('next-btn').onclick = next;
$('prev-btn').onclick = prev;
// A/B 对比时播完停在最后一帧：跳到下一个会把 B 那条片换成 A，变成自己比自己
video.addEventListener('ended', () => { if (!cmpOn) next(); });

// 整个视频循环：用原生 loop，播完直接回到开头，不会触发 ended 跳下一个。
function setLoopVideo(on, save = true) {
  video.loop = on;
  $('loop-video-btn').classList.toggle('on', on);
  if (save) {
    saveSettings({ loopVideo: on }).catch(() => {});
    toast(on ? '已开启循环播放：当前视频播完从头再来（Shift+L 关闭）' : '已关闭循环播放：播完自动跳下一个');
  }
}
$('loop-video-btn').onclick = () => setLoopVideo(!video.loop);

// ---------- 账号切换 / 导入 ----------
let oauthFlow = null;

async function saveSettings(patch) {
  return api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
}

async function refreshRamStatus() {
  const status = await api('/api/cache/status');
  $('ram-hint').textContent = `本机 ${status.totalMemoryGb}GB · 实际上限 ${status.cacheLimitGb}GB / 单视频 ${status.maxVideoGb}GB · 已用 ${status.usedGb}GB（${status.items} 个）`;
  return status;
}

const optionalGb = id => {
  const value = $(id).value.trim();
  return value ? Number(value) : 0;
};

async function saveRamSettings() {
  await saveSettings({
    ramCacheGb: optionalGb('ram-cache-gb'),
    ramMaxVideoGb: optionalGb('ram-video-gb')
  });
  await refreshRamStatus();
  cachedSet.clear();
  if (curIdx >= 0) prefetchAround(curIdx);
}

function showAccountModal(show = true) {
  $('account-modal').hidden = !show;
  if (!show) {
    $('oauth-panel').hidden = true;
    $('account-choices').hidden = false;
  }
}

async function loadRemotes() {
  const r = await api('/api/remotes');
  const options = [];
  for (const name of r.remotes) {
    const base = name.replace(/:$/, '');
    options.push({ value: name, label: base });
    options.push({ value: base + ',shared_with_me:', label: base + ' (共享给我)' });
  }
  const sel = $('remote-sel');
  sel.innerHTML = '';
  if (!options.length) {
    curRemote = '';
    sel.disabled = true;
    const opt = document.createElement('option');
    opt.textContent = '请先添加账号';
    sel.appendChild(opt);
    $('list').textContent = '';
    $('stats').textContent = '尚未连接 Google Drive；也可在上方粘贴公开视频链接免登录播放';
    return false;
  }
  sel.disabled = false;
  if (!options.some(o => o.value === curRemote)) {
    curRemote = r.remotes.includes('gdrive:') ? 'gdrive:' : options[0].value;
    await saveSettings({ remote: curRemote });
  }
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    opt.selected = option.value === curRemote;
    sel.appendChild(opt);
  }
  return true;
}

// ---------- 输入框 ----------
// Electron 的渲染进程里 window.prompt 会直接抛错，所以自己做一个。
let askResolve = null;

function askText(title, value = '', hint = '') {
  $('ask-title').textContent = title;
  $('ask-hint').textContent = hint;
  const input = $('ask-input');
  input.value = value;
  $('ask-modal').hidden = false;
  input.focus();
  input.select();
  return new Promise(resolve => { askResolve = resolve; });
}

function closeAsk(value) {
  if (!askResolve) return;
  const resolve = askResolve;
  askResolve = null;
  $('ask-modal').hidden = true;
  resolve(value);
}

$('ask-ok-btn').onclick = () => closeAsk($('ask-input').value);
$('ask-cancel-btn').onclick = () => closeAsk(null);
$('ask-input').onkeydown = e => {
  e.stopPropagation();
  if (e.key === 'Enter') closeAsk($('ask-input').value);
  else if (e.key === 'Escape') closeAsk(null);
};

// ---------- 穿帮点 ----------
const fmtAt = t => {
  const cs = Math.max(0, Math.round(t * 100));
  const sec = Math.floor(cs / 100);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const flagsOf = key => (marks[key] && marks[key].flags) || [];
const curFlagKey = () => (curIdx >= 0 && videos[curIdx] ? markKey(videos[curIdx]) : '');

async function saveFlags(key, list) {
  const sorted = [...list].sort((a, b) => a.frame - b.frame);
  if (sorted.length) marks[key] = { ...(marks[key] || {}), flags: sorted };
  else delete marks[key];
  renderFlags();
  render();
  try {
    await api('/api/marks', { method: 'POST', body: JSON.stringify({ key, flags: sorted }) });
  } catch (error) {
    toast('穿帮点没能保存: ' + error.message);
  }
}

function addFlag() {
  const key = curFlagKey();
  if (!key || !video.duration) return;
  const frame = targetFrame();
  const list = flagsOf(key);
  if (list.some(item => item.frame === frame)) {
    toast(`第 ${frame + 1} 帧已经标过了`);
    return;
  }
  saveFlags(key, [...list, { frame, t: Number(((frame + 0.5) * frameDur).toFixed(3)) }]);
  toast(`已记穿帮点：第 ${frame + 1} 帧 · ${fmtAt(video.currentTime)}`);
}

function removeFlag(frame) {
  const key = curFlagKey();
  if (!key) return;
  saveFlags(key, flagsOf(key).filter(item => item.frame !== frame));
}

function renderFlags() {
  const panel = $('flag-panel');
  const key = curFlagKey();
  const list = key ? flagsOf(key) : [];
  panel.hidden = curIdx < 0;
  $('flag-title').textContent = list.length ? `穿帮点 ${list.length} 个` : '穿帮点（按 F 记录）';
  $('flag-clear-btn').disabled = !list.length;
  const rows = list.map(item => {
    const row = document.createElement('div');
    row.className = 'flag-row';
    row.innerHTML = '<span class="frame"></span><span class="at"></span><span class="del" title="删掉这个点">✕</span>';
    row.querySelector('.frame').textContent = '帧 ' + (item.frame + 1);
    row.querySelector('.at').textContent = item.note ? fmtAt(item.t) + ' · ' + item.note : fmtAt(item.t);
    if (item.note) row.title = item.note;
    row.onclick = () => jumpToFrame(item.frame);
    row.querySelector('.del').onclick = e => { e.stopPropagation(); removeFlag(item.frame); };
    return row;
  });
  $('flag-list').replaceChildren(...rows);

  const ticks = video.duration
    ? list.map(item => {
      const tick = document.createElement('i');
      tick.style.left = (item.t / video.duration * 100) + '%';
      return tick;
    })
    : [];
  $('seek-flags').replaceChildren(...ticks);
}

$('flag-clear-btn').onclick = () => {
  const key = curFlagKey();
  if (key && flagsOf(key).length) saveFlags(key, []);
};

$('flag-copy-btn').onclick = async () => {
  const rows = [];
  for (const v of videos) {
    for (const item of flagsOf(markKey(v))) {
      rows.push(`${v.Name}\t帧 ${item.frame + 1}\t${fmtAt(item.t)}${item.note ? '\t' + item.note : ''}`);
    }
  }
  if (!rows.length) return toast('这个文件夹还没有穿帮点');
  if (await writeClipboard(rows.join('\n'))) toast(`已复制 ${rows.length} 个穿帮点（文件名/帧号/时间）`);
  else toast('复制失败，请检查剪贴板权限');
};

// ---------- 查穿帮：差分 / 放大镜 / 框选 / 区间扫描 ----------
const grabCanvas = document.createElement('canvas');
const grabCtx = grabCanvas.getContext('2d', { willReadFrequently: true });
const fxCanvas = $('fx-canvas');
const fxCtx = fxCanvas.getContext('2d');
const zoomCanvas = $('zoom-canvas');
const zoomCtx = zoomCanvas.getContext('2d');

let diffOn = false;
let zoomOn = false;
let zoomFactor = 4;
let zoomPoint = null;
let roiOn = false;
let roiRect = null;        // 视频源像素坐标
let roiDrag = null;
let prevGrab = null;
let diffHandle = 0;
let scanning = false;
let scanSamples = [];

const frameReady = () => video.readyState >= 2 && video.videoWidth > 0;

// 抓一帧到 ImageData；maxWidth 控制精度与开销
function grabFrameFrom(source, canvas, ctx, maxWidth) {
  if (!source || source.readyState < 2 || !source.videoWidth) return null;
  const scale = Math.min(1, maxWidth / source.videoWidth);
  const w = Math.max(2, Math.round(source.videoWidth * scale));
  const h = Math.max(2, Math.round(source.videoHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  try {
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // 受保护内容等
  }
}

function grabFrame(maxWidth = 480) {
  return frameReady() ? grabFrameFrom(video, grabCanvas, grabCtx, maxWidth) : null;
}

// 几个覆盖层要贴着画面实际显示的位置（视频在黑边里居中）
function videoBox() {
  const wrap = $('player-wrap').getBoundingClientRect();
  const rect = video.getBoundingClientRect();
  return { left: rect.left - wrap.left, top: rect.top - wrap.top, width: rect.width, height: rect.height };
}

function layoutOverlays() {
  const box = videoBox();
  const cmp = $('cmp-canvas');
  cmp.style.left = box.left + 'px';
  cmp.style.top = box.top + 'px';
  cmp.style.width = box.width + 'px';
  cmp.style.height = box.height + 'px';
  if (cmpOn) {
    cmp.width = Math.max(2, Math.round(box.width));
    cmp.height = Math.max(2, Math.round(box.height));
    drawCompare();
  }
  for (const el of [fxCanvas, $('roi-layer')]) {
    el.style.left = box.left + 'px';
    el.style.top = box.top + 'px';
    el.style.width = box.width + 'px';
    el.style.height = box.height + 'px';
  }
  renderRoiBox();
  window.PatchUI?.layout();
}

function stopDiffView() {
  diffOn = false;
  prevGrab = null;
  fxCanvas.hidden = true;
  $('diff-btn').classList.remove('on');
  if (diffHandle) {
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(diffHandle);
    else cancelAnimationFrame(diffHandle);
    diffHandle = 0;
  }
}

function toggleDiffView() {
  if (diffOn) {
    stopDiffView();
    setInspectText('');
    return;
  }
  if (!frameReady()) return toast('这个视频本机解不了码，差分视图用不了');
  diffOn = true;
  prevGrab = null;
  fxCanvas.hidden = false;
  $('diff-btn').classList.add('on');
  layoutOverlays();
  const tick = () => {
    if (!diffOn) return;
    const cur = grabFrame(480);
    if (cur) {
      if (fxCanvas.width !== cur.width || fxCanvas.height !== cur.height) {
        fxCanvas.width = cur.width;
        fxCanvas.height = cur.height;
      }
      if (prevGrab && prevGrab.width === cur.width) {
        const out = fxCtx.createImageData(cur.width, cur.height);
        INSPECT.diffImage(prevGrab, cur, Number($('speed-sel').dataset.gain || 8), out.data);
        fxCtx.putImageData(out, 0, 0);
        const stats = INSPECT.frameDiffStats(prevGrab, cur);
        setInspectText(`差分视图：整体抖动 <b>${stats.mean.toFixed(2)}</b>　局部峰值 <b>${stats.max.toFixed(0)}</b>\n亮的地方=这一帧变了；接缝整条发亮就是闪烁，人物边缘出现双线就是重影/错位`);
      }
      prevGrab = cur;
    }
    diffHandle = video.requestVideoFrameCallback
      ? video.requestVideoFrameCallback(tick)
      : requestAnimationFrame(tick);
  };
  tick();
}

function toggleZoom() {
  zoomOn = !zoomOn;
  zoomCanvas.hidden = !zoomOn;
  $('zoom-btn').classList.toggle('on', zoomOn);
  if (!zoomOn) return;
  if (!frameReady()) {
    zoomOn = false;
    zoomCanvas.hidden = true;
    $('zoom-btn').classList.remove('on');
    return toast('这个视频本机解不了码，放大镜用不了');
  }
  zoomCanvas.width = 260;
  zoomCanvas.height = 260;
  drawZoom();
}

function drawZoom() {
  if (!zoomOn || !frameReady()) return;
  const box = videoBox();
  const point = zoomPoint || { x: box.width / 2, y: box.height / 2 };
  const sx = point.x / box.width * video.videoWidth;
  const sy = point.y / box.height * video.videoHeight;
  const span = zoomCanvas.width / zoomFactor;
  zoomCtx.imageSmoothingEnabled = false;
  zoomCtx.fillStyle = '#000';
  zoomCtx.fillRect(0, 0, zoomCanvas.width, zoomCanvas.height);
  try {
    zoomCtx.drawImage(video, sx - span / 2, sy - span / 2, span, span, 0, 0, zoomCanvas.width, zoomCanvas.height);
  } catch { /* 解不了码就留黑 */ }
  zoomCtx.strokeStyle = 'rgba(255,184,77,.9)';
  zoomCtx.strokeRect(zoomCanvas.width / 2 - 6, zoomCanvas.height / 2 - 6, 12, 12);
  zoomCtx.fillStyle = 'rgba(0,0,0,.6)';
  zoomCtx.fillRect(0, zoomCanvas.height - 16, 56, 16);
  zoomCtx.fillStyle = '#e8eaed';
  zoomCtx.font = '11px system-ui';
  zoomCtx.fillText(zoomFactor + '×', 6, zoomCanvas.height - 4);
}

function toggleRoi() {
  roiOn = !roiOn;
  $('roi-layer').hidden = !roiOn;
  $('roi-btn').classList.toggle('on', roiOn);
  if (roiOn) {
    layoutOverlays();
    setInspectText('在画面上拖一个框圈住补丁区域，松手出结果');
  } else {
    roiRect = null;
    renderRoiBox();
  }
}

function renderRoiBox() {
  const box = $('roi-box');
  if (!roiRect || !video.videoWidth) { box.hidden = true; return; }
  const view = videoBox();
  box.hidden = false;
  box.style.left = (roiRect.x / video.videoWidth * view.width) + 'px';
  box.style.top = (roiRect.y / video.videoHeight * view.height) + 'px';
  box.style.width = (roiRect.w / video.videoWidth * view.width) + 'px';
  box.style.height = (roiRect.h / video.videoHeight * view.height) + 'px';
}

function analyzeRoi() {
  if (!roiRect) return;
  const frame = grabFrame(video.videoWidth); // 清晰度/色差要用原始像素
  if (!frame) return setInspectText('取不到画面像素，可能是本机解不了这个编码');
  const result = INSPECT.analyzeSelection(frame, roiRect);
  const upscaled = result.effective.confident && result.effective.scale > 1;
  // 色差比的是边内外均值(偏色)，台阶比的是跨边梯度(硬边/切断)，两个分工不同
  const step = INSPECT.seamStepVerdict(INSPECT.edgeStepProfile(frame, roiRect));
  setInspectText([
    `选区 <b>${result.width}×${result.height}</b> 像素`,
    `清晰度：区内 ${result.innerSharp.toFixed(1)} / 周围 ${result.ringSharp.toFixed(1)} → <b>${result.sharpVerdict}</b>`,
    `实际细节：<b class="${upscaled ? 'hit' : ''}">${result.effectiveVerdict}</b>`,
    `色差：<b class="${result.seamMaxDelta >= 8 ? 'hit' : ''}">${result.seamVerdict}</b>`,
    `接缝：<b class="${step.kind === 'ok' || step.kind === 'unknown' ? '' : 'hit'}">${step.text}</b>`
  ].join('\n'));
}

$('roi-layer').addEventListener('pointerdown', e => {
  if (!video.videoWidth) return;
  const view = videoBox();
  const rect = $('roi-layer').getBoundingClientRect();
  roiDrag = {
    x: (e.clientX - rect.left) / view.width * video.videoWidth,
    y: (e.clientY - rect.top) / view.height * video.videoHeight
  };
  $('roi-layer').setPointerCapture(e.pointerId);
});

$('player-wrap').addEventListener('pointermove', e => {
  if (!zoomOn) return;
  const rect = video.getBoundingClientRect();
  zoomPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  drawZoom();
});

$('roi-layer').addEventListener('pointermove', e => {
  if (!roiDrag) return;
  const view = videoBox();
  const rect = $('roi-layer').getBoundingClientRect();
  const px = (e.clientX - rect.left) / view.width * video.videoWidth;
  const py = (e.clientY - rect.top) / view.height * video.videoHeight;
  roiRect = {
    x: Math.min(roiDrag.x, px),
    y: Math.min(roiDrag.y, py),
    w: Math.abs(px - roiDrag.x),
    h: Math.abs(py - roiDrag.y)
  };
  renderRoiBox();
});

$('roi-layer').addEventListener('pointerup', () => {
  if (!roiDrag) return;
  roiDrag = null;
  if (roiRect && roiRect.w > 8 && roiRect.h > 8) analyzeRoi();
  else { roiRect = null; renderRoiBox(); }
});

$('player-wrap').addEventListener('wheel', e => {
  if (!zoomOn) return;
  e.preventDefault();
  const steps = [2, 4, 8, 16];
  const index = steps.indexOf(zoomFactor);
  zoomFactor = steps[Math.min(steps.length - 1, Math.max(0, index + (e.deltaY > 0 ? -1 : 1)))];
  drawZoom();
}, { passive: false });

function setInspectText(html) {
  const panel = $('inspect-panel');
  $('inspect-text').innerHTML = html;
  $('scan-chart').hidden = !scanSamples.length;
  panel.hidden = !html && !scanSamples.length;
}

// 逐帧扫描区间：每帧 seek 后抓图，比相邻帧差异
function seekAndGrab(frame, width = 360) {
  return new Promise(resolve => {
    const done = () => {
      video.removeEventListener('seeked', done);
      requestAnimationFrame(() => resolve(grabFrame(width)));
    };
    video.addEventListener('seeked', done);
    pendingSeek = null;
    video.currentTime = (frame + 0.5) * frameDur;
  });
}

function seekB(time) {
  return new Promise(resolve => {
    const done = () => { videoB.removeEventListener('seeked', done); resolve(); };
    videoB.addEventListener('seeked', done);
    videoB.currentTime = time;
    setTimeout(done, 800);
  });
}

async function scanRange() {
  if (scanning) return;
  if (!frameReady()) return toast('这个视频本机解不了码，扫描用不了');
  const base = targetFrame();
  const from = loopIn !== null ? loopIn : Math.max(0, base - 10);
  const to = loopOut !== null ? loopOut : from + 20;
  const last = Math.max(0, Math.round(video.duration / frameDur) - 1);
  const end = Math.min(last, to);
  if (end - from < 2) return toast('区间太短，先用 I/O 设一个区间');
  scanning = true;
  video.pause();
  stopDiffView();
  $('scan-btn').classList.add('on');
  // 框选过就只扫补丁区：补丁占画幅 ≤2% 时，全画幅的帧间均值会把它的闪烁
  // 稀释到判不出来（实测同一个闪烁补丁 17% 时 2.7 倍、1.9% 时 0.84 倍）。
  // 同时取一块同尺寸的区外对照区，用来回答「是补丁自己的问题还是整幅都这样」。
  const scanRect = roiRect && roiRect.w > 8 && roiRect.h > 8 ? roiRect : null;
  const scanCtrl = scanRect ? INSPECT.controlRect(scanRect, video.videoWidth, video.videoHeight) : null;
  // 全画幅那条路径保持原来的 360，不动既有标定；补丁区要原始像素才量得准
  const grabWidth = scanRect ? video.videoWidth : 360;
  setInspectText(scanRect
    ? `在框选区内扫描第 ${from + 1}–${end + 1} 帧…`
    : `扫描第 ${from + 1}–${end + 1} 帧…`);
  const samples = [];
  const seamSeries = [];
  const sampler = INSPECT.createScanSampler({ rect: scanRect, control: scanCtrl });
  try {
    for (let frame = from; frame <= end; frame++) {
      const cur = await seekAndGrab(frame, grabWidth);
      if (!cur) break;
      const sample = sampler.push(frame, cur);
      if (sample) samples.push(sample);
      if (scanRect) {
        const profile = INSPECT.edgeStepProfile(cur, scanRect);
        const edges = Object.values(profile).filter(Boolean);
        seamSeries.push(edges.length ? Math.max(...edges.map(e => e.runStep)) : 0);
      }
      if (!(frame % 5)) setInspectText(`扫描中… ${frame - from + 1}/${end - from + 1}`);
    }
  } finally {
    scanning = false;
    $('scan-btn').classList.remove('on');
  }
  scanSamples = samples;
  const verdict = INSPECT.scanVerdict(samples, scanRect ? { scope: '补丁区' } : {});
  const breathing = scanRect ? INSPECT.breathingVerdict(seamSeries) : null;
  renderScan(verdict, breathing);
}

function renderScan(verdict, breathing) {
  const canvas = $('scan-chart');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  if (!scanSamples.length) return;
  const peak = Math.max(...scanSamples.map(item => item.mean), 0.001);
  const barWidth = width / scanSamples.length;
  scanSamples.forEach((item, index) => {
    const barHeight = Math.max(1, item.mean / peak * (height - 8));
    ctx.fillStyle = verdict.peak && item.frame === verdict.peak.frame ? '#ff5c5c' : '#4c8dff';
    ctx.fillRect(index * barWidth, height - barHeight, Math.max(1, barWidth - 1), barHeight);
  });
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.beginPath();
  const baseY = height - Math.max(1, verdict.base / peak * (height - 8));
  ctx.moveTo(0, baseY);
  ctx.lineTo(width, baseY);
  ctx.stroke();
  const label = { jump: '动作跳变', shake: '抖动/闪烁', flicker: '隔帧闪烁', ok: '平稳', unknown: '样本不足' }[verdict.kind];
  const breathLine = breathing && breathing.kind !== 'unknown'
    ? `\n接缝：<b class="${breathing.kind === 'ok' ? '' : 'hit'}">${breathing.text}</b>`
    : '';
  setInspectText(`扫描 ${scanSamples.length + 1} 帧：<b class="${verdict.kind === 'ok' ? '' : 'hit'}">${label}</b>\n${verdict.text}${breathLine}\n柱子=相邻帧变化量，横线=区间常态，点柱子可跳过去`);
  $('scan-flag-btn').hidden = !verdict.peak || verdict.kind === 'ok';
  $('scan-flag-btn').dataset.frame = verdict.peak ? String(verdict.peak.frame) : '';
}

$('scan-chart').onclick = e => {
  if (!scanSamples.length) return;
  const rect = $('scan-chart').getBoundingClientRect();
  const index = Math.floor((e.clientX - rect.left) / rect.width * scanSamples.length);
  const sample = scanSamples[Math.max(0, Math.min(scanSamples.length - 1, index))];
  if (sample) jumpToFrame(sample.frame);
};

$('scan-flag-btn').onclick = () => {
  const frame = parseInt($('scan-flag-btn').dataset.frame, 10);
  if (!Number.isFinite(frame)) return;
  jumpToFrame(frame);
  setTimeout(addFlag, 150);
};

$('inspect-close-btn').onclick = () => {
  scanSamples = [];
  $('inspect-panel').hidden = true;
};

$('scan-btn').onclick = scanRange;
$('diff-btn').onclick = toggleDiffView;
$('zoom-btn').onclick = toggleZoom;
$('roi-btn').onclick = toggleRoi;

function resetInspectTools() {
  stopDiffView();
  if (cmpOn) closeCompare();
  $('scan-chart').hidden = true;
  if (zoomOn) toggleZoom();
  if (roiOn) toggleRoi();
  scanSamples = [];
  roiRect = null;
  renderRoiBox();
  $('inspect-panel').hidden = true;
}

// ---------- A/B 对比：成片(A) vs 原片(B) ----------
const videoB = $('video-b');
const cmpCanvas = $('cmp-canvas');
const cmpCtx = cmpCanvas.getContext('2d');
const grabCanvasB = document.createElement('canvas');
const grabCtxB = grabCanvasB.getContext('2d', { willReadFrequently: true });
const diffCanvas = document.createElement('canvas');
const diffCtx = diffCanvas.getContext('2d');

let cmpOn = false;
let cmpMode = 'toggle';
let cmpOffset = 0;        // 以 A 的帧为单位
let cmpShowB = false;
let cmpWipe = 0.5;
let cmpAlpha = 0.5;   // 叠加模式下 A 的不透明度
let cmpWipeDrag = false;
let cmpName = '';
let cmpRaf = 0;
let cmpAligning = false; // 自动对齐自己在挪 B，暂停跟随要让开
let cmpLock = false;      // 同帧慢放开关
let lockRunning = false;  // 同帧慢放正在逐帧推进

const cmpTimeFor = () => Math.max(0, video.currentTime + cmpOffset * frameDur);

function cmpSetStatus(text) {
  $('cmp-status').innerHTML = text;
}

function fillCompareSources() {
  const select = $('cmp-src');
  const current = select.value;
  const options = ['<option value="">选对照片（原片）…</option>'];
  videos.forEach((v, index) => {
    if (index === curIdx) return;
    options.push(`<option value="${index}"></option>`);
  });
  select.innerHTML = options.join('');
  [...select.options].forEach(option => {
    if (option.value) option.textContent = videos[Number(option.value)].Name;
  });
  if (current && select.querySelector(`option[value="${current}"]`)) select.value = current;
}

async function openCompare() {
  if (curIdx < 0) return toast('先选一个要检查的视频');
  cmpOn = true;
  $('cmp-panel').hidden = false;
  cmpCanvas.hidden = false;
  fillCompareSources();
  layoutOverlays();
  if (!videoB.getAttribute('src')) cmpSetStatus('选一条原片作为对照，然后用 X 翻、V 换方式');
  startCompareLoop();
}

function closeCompare() {
  cmpOn = false;
  cmpShowB = false;
  $('cmp-panel').hidden = true;
  cmpCanvas.hidden = true;
  document.body.classList.remove('cmp-wipe');
  if (cmpRaf) { cancelAnimationFrame(cmpRaf); cmpRaf = 0; }
  videoB.pause();
  videoB.removeAttribute('src');
  videoB.load();
  cmpName = '';
}

function toggleCompare() {
  if (cmpOn) closeCompare();
  else openCompare();
}

async function loadCompareSource(index) {
  const entry = videos[index];
  if (!entry) return;
  cmpName = entry.Name;
  videoB.src = streamUrl(curRemote, pathOf(entry));
  cmpSetStatus(`正在载入对照片 ${entry.Name}…`);
  await new Promise(resolve => {
    const done = () => { videoB.removeEventListener('loadeddata', done); resolve(); };
    videoB.addEventListener('loadeddata', done);
    setTimeout(done, 8000);
  });
  if (!videoB.videoWidth) {
    cmpSetStatus(`<span class="hit">对照片载不进来，可能本机解不了这个编码</span>`);
    return;
  }
  await syncCompare();
  describeCompare();
}

function describeCompare(extra = '') {
  const sizeMismatch = videoB.videoWidth !== video.videoWidth || videoB.videoHeight !== video.videoHeight;
  const lenA = video.duration ? Math.round(video.duration / frameDur) : 0;
  const lenB = videoB.duration ? Math.round(videoB.duration / frameDur) : 0;
  const lines = [`对照片：<b>${cmpName}</b>`];
  if (sizeMismatch) {
    lines.push(`<span class="hit">尺寸不一致：成片 ${video.videoWidth}×${video.videoHeight}，原片 ${videoB.videoWidth}×${videoB.videoHeight}</span>`);
  }
  if (lenA && lenB && lenA !== lenB) {
    lines.push(`<span class="hit">总帧数不一致：成片 ${lenA} 帧，原片 ${lenB} 帧（差 ${lenA - lenB} 帧）</span>`);
  }
  if (extra) lines.push(extra);
  cmpSetStatus(lines.join('\n'));
}

// 暂停时逐帧对齐；播放时让 B 跟着跑，偏差大了再纠一次
function syncCompare() {
  if (!videoB.getAttribute('src') || !videoB.duration) return Promise.resolve();
  const target = Math.min(Math.max(0, videoB.duration - 0.001), cmpTimeFor());
  if (video.paused) {
    videoB.pause();
    if (Math.abs(videoB.currentTime - target) < frameDur / 4) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { videoB.removeEventListener('seeked', done); resolve(); };
      videoB.addEventListener('seeked', done);
      videoB.currentTime = target;
      setTimeout(done, 1500);
    });
  }
  // 小偏差靠微调速度慢慢追上（硬 seek 会让 B 顿一下），偏得多才直接跳
  const drift = videoB.currentTime - target;
  if (Math.abs(drift) > frameDur * 4) {
    videoB.currentTime = target;
    videoB.playbackRate = video.playbackRate;
  } else {
    const nudge = Math.max(-0.1, Math.min(0.1, -drift / 0.5));
    videoB.playbackRate = video.playbackRate * (1 + nudge);
  }
  if (videoB.paused) videoB.play().catch(() => {});
  return Promise.resolve();
}

function drawCompare() {
  if (!cmpOn) return;
  const w = cmpCanvas.width;
  const h = cmpCanvas.height;
  cmpCtx.clearRect(0, 0, w, h);
  if (!videoB.videoWidth) return;
  // 同帧慢放：A 也画到画布上，否则底下的 <video> 会比 B 先换帧
  if (lockRunning) cmpCtx.drawImage(video, 0, 0, w, h);
  if (cmpMode === 'toggle') {
    if (cmpShowB) {
      cmpCtx.drawImage(videoB, 0, 0, w, h);
      badge('原片 B', 0);
    }
    return;
  }
  if (cmpMode === 'wipe') {
    const split = Math.round(w * cmpWipe);
    cmpCtx.save();
    cmpCtx.beginPath();
    cmpCtx.rect(split, 0, w - split, h);
    cmpCtx.clip();
    cmpCtx.drawImage(videoB, 0, 0, w, h);
    cmpCtx.restore();
    cmpCtx.strokeStyle = '#ffb84d';
    cmpCtx.lineWidth = 2;
    cmpCtx.beginPath();
    cmpCtx.moveTo(split, 0);
    cmpCtx.lineTo(split, h);
    cmpCtx.stroke();
    // 分界线中间的拖动把手
    cmpCtx.fillStyle = '#ffb84d';
    cmpCtx.beginPath();
    cmpCtx.arc(split, h / 2, 9, 0, Math.PI * 2);
    cmpCtx.fill();
    cmpCtx.fillStyle = '#202124';
    cmpCtx.beginPath();
    cmpCtx.moveTo(split - 6, h / 2); cmpCtx.lineTo(split - 2, h / 2 - 4); cmpCtx.lineTo(split - 2, h / 2 + 4);
    cmpCtx.moveTo(split + 6, h / 2); cmpCtx.lineTo(split + 2, h / 2 - 4); cmpCtx.lineTo(split + 2, h / 2 + 4);
    cmpCtx.fill();
    badge('成片 A', 0);
    badge('原片 B', split + 6);
    return;
  }
  if (cmpMode === 'overlay') {
    // 画布盖在 A 上：先铺满 B，再按不透明度把 A 叠回来
    cmpCtx.drawImage(videoB, 0, 0, w, h);
    cmpCtx.globalAlpha = cmpAlpha;
    cmpCtx.drawImage(video, 0, 0, w, h);
    cmpCtx.globalAlpha = 1;
    badge(`A ${Math.round(cmpAlpha * 100)}% / B`, 0);
    return;
  }
  // 差异图：两片相减放大，补丁范围会整块亮起来
  const a = grabFrame(480);
  const b = grabFrameFrom(videoB, grabCanvasB, grabCtxB, 480);
  if (!a || !b || a.width !== b.width || a.height !== b.height) return;
  if (diffCanvas.width !== a.width || diffCanvas.height !== a.height) {
    diffCanvas.width = a.width;
    diffCanvas.height = a.height;
  }
  const out = diffCtx.createImageData(a.width, a.height);
  INSPECT.diffImage(b, a, 6, out.data);
  diffCtx.putImageData(out, 0, 0);
  cmpCtx.drawImage(diffCanvas, 0, 0, w, h);
  badge('差异 |A−B|', 0);
}

function badge(text, x) {
  cmpCtx.fillStyle = 'rgba(0,0,0,.55)';
  cmpCtx.fillRect(x + 6, 6, 78, 18);
  cmpCtx.fillStyle = '#e8eaed';
  cmpCtx.font = '12px system-ui';
  cmpCtx.fillText(text, x + 11, 19);
}

function startCompareLoop() {
  if (cmpRaf) cancelAnimationFrame(cmpRaf);
  const tick = () => {
    if (!cmpOn) return;
    // 同帧慢放时只在两边都落定后由慢放循环画，避免画到一新一旧
    if (videoB.getAttribute('src') && !lockRunning) {
      if (!video.paused) syncCompare();
      drawCompare();
    }
    cmpRaf = requestAnimationFrame(tick);
  };
  tick();
}

// 自动对齐：在候选偏移里找整体差异最小的那个
async function autoAlign() {
  if (!videoB.videoWidth) return toast('先选一条对照片');
  const wasPaused = video.paused;
  cmpAligning = true;
  video.pause();
  videoB.pause();
  cmpSetStatus('正在对齐…');
  const anchorFrames = [0.3, 0.5, 0.7].map(ratio => Math.round((video.duration * ratio) / frameDur));
  const SEARCH = 10;
  const offsets = [];
  for (let offset = -SEARCH; offset <= SEARCH; offset++) offsets.push(offset);
  // A 的锚点帧只抓一次：原来每个偏移都重新 seek 一遍 A，白白多花一倍时间
  const anchors = [];
  for (const frame of anchorFrames) {
    const a = await seekAndGrab(frame, 240);
    if (a) anchors.push({ frame, a });
  }
  const perAnchor = anchors.map(() => []);
  const totals = new Map();
  let step = 0;
  for (const [anchorIndex, anchor] of anchors.entries()) {
    for (const offset of offsets) {
      const tB = (anchor.frame + offset + 0.5) * frameDur;
      if (tB < 0 || tB > videoB.duration) continue;
      await seekB(tB);
      const b = grabFrameFrom(videoB, grabCanvasB, grabCtxB, 240);
      if (!b || b.width !== anchor.a.width) continue;
      const mean = INSPECT.frameDiffStats(anchor.a, b).mean;
      perAnchor[anchorIndex].push({ offset, diff: mean });
      const bucket = totals.get(offset) || { sum: 0, used: 0 };
      bucket.sum += mean;
      bucket.used++;
      totals.set(offset, bucket);
      if (!(++step % 6)) cmpSetStatus(`对齐中… ${step}/${anchors.length * offsets.length}`);
    }
  }
  const scores = [...totals.entries()].map(([offset, bucket]) => ({ offset, diff: bucket.sum / bucket.used }));
  const picked = INSPECT.pickBestOffset(scores);
  if (!scores.length) { cmpAligning = false; return cmpSetStatus('<span class="hit">对不了：取不到画面</span>'); }
  cmpAligning = false;
  cmpOffset = picked.offset;
  $('cmp-offset').textContent = cmpOffset + ' 帧';
  await syncCompare();
  // 片头/片中/片尾分别量一次：三处对不上同一个偏移，说明中间丢过帧
  const spots = perAnchor
    .map((list, index) => ({ list, frame: anchors[index].frame }))
    .filter(item => item.list.length)
    .map(item => ({ frame: item.frame, ...INSPECT.pickBestOffset(item.list) }));
  const distinct = [...new Set(spots.map(spot => spot.offset))];
  const lines = [];
  if (distinct.length > 1) {
    lines.push(`<span class="hit">不同位置量出的偏移不一致</span>：${spots.map(spot => `第 ${spot.frame + 1} 帧处 ${spot.offset}`).join('、')} —— 中间多半丢过帧，没有统一偏移`);
  }
  if (Math.abs(picked.offset) >= SEARCH || spots.some(spot => Math.abs(spot.offset) >= SEARCH)) {
    lines.push(`<span class="hit">偏移顶到了 ±${SEARCH} 帧的搜索上限</span>，真实偏移可能更大`);
  }
  lines.push(picked.confident
    ? `自动对齐：偏移 <b>${picked.offset} 帧</b>（差异 ${picked.best.toFixed(2)}，次优 ${picked.runnerUp.toFixed(2)}）`
    : `<span class="hit">这个偏移不可信</span>：最优 ${picked.best.toFixed(2)} vs 次优 ${picked.runnerUp.toFixed(2)}，差距太小，已按 ${picked.offset} 帧设置，请自己核对`);
  describeCompare(lines.join('\n'));
  if (!wasPaused) video.play().catch(() => {});
}

// 播放时 B 靠循环跟随，循环只在 A 播放时同步；A 一停必须显式让 B 停到同一帧，否则 B 会继续播
video.addEventListener('pause', () => { if (cmpOn && !cmpAligning && !lockRunning) syncCompare(); });

// ---------- 同帧慢放：每一步两边都跳到位了再一起显示，保证每帧成对 ----------
function seekEl(el, time) {
  return new Promise(resolve => {
    const done = () => { el.removeEventListener('seeked', done); resolve(); };
    el.addEventListener('seeked', done);
    el.currentTime = time;
    setTimeout(done, 1500);
  });
}

// 原生播放会让两边各走各的，开着同帧慢放时把「播放」改成启动/停止慢放
video.addEventListener('play', () => {
  if (!cmpOn || !cmpLock || !videoB.videoWidth) return;
  video.pause();
  if (lockRunning) lockRunning = false;
  else runLockedPlayback();
});

async function runLockedPlayback() {
  lockRunning = true;
  const last = Math.round(video.duration / frameDur) - 1;
  let steps = 0;
  const started = performance.now();
  while (lockRunning && cmpOn && cmpLock) {
    const frame = targetFrame() + 1; // 每步重读，拖进度条后从新位置接着放
    if (frame > last) break;
    const stepStart = performance.now();
    const tA = (frame + 0.5) * frameDur;
    const tB = Math.min(videoB.duration - 0.001, Math.max(0, tA + cmpOffset * frameDur));
    await Promise.all([seekEl(video, tA), seekEl(videoB, tB)]);
    if (!lockRunning) break;
    drawCompare();
    $('play-btn').textContent = '⏸';
    steps++;
    // 小片解得比原速还快时，压回原速
    const minStep = (frameDur / video.playbackRate) * 1000;
    const spent = performance.now() - stepStart;
    if (spent < minStep) await new Promise(resolve => setTimeout(resolve, minStep - spent));
    if (steps % 12 === 0) {
      const fps = steps / ((performance.now() - started) / 1000);
      $('cmp-lock-rate').textContent = `${fps.toFixed(1)} 帧/秒（原速 ${Math.round(1 / frameDur)}）`;
    }
  }
  lockRunning = false;
  $('play-btn').textContent = '▶';
  $('cmp-lock-rate').textContent = '';
  drawCompare();
}

$('cmp-lock').onclick = () => {
  cmpLock = !cmpLock;
  $('cmp-lock').classList.toggle('on', cmpLock);
  if (!cmpLock) lockRunning = false;
  else if (!video.paused) video.pause(); // 正在原生播放就先停下，再按播放进入慢放
  toast(cmpLock ? '同帧慢放已开：按空格或 ▶ 开始，两边每一帧都对上' : '已切回正常播放');
};

$('cmp-src').onchange = e => { if (e.target.value) loadCompareSource(Number(e.target.value)); };
$('cmp-close-btn').onclick = closeCompare;
$('cmp-off-minus').onclick = async () => { cmpOffset--; $('cmp-offset').textContent = cmpOffset + ' 帧'; await syncCompare(); drawCompare(); };
$('cmp-off-plus').onclick = async () => { cmpOffset++; $('cmp-offset').textContent = cmpOffset + ' 帧'; await syncCompare(); drawCompare(); };
$('cmp-auto').onclick = autoAlign;
$('cmp-swap').onclick = () => {
  const b = Number($('cmp-src').value);
  if (!$('cmp-src').value || !videos[b]) return toast('先选一条对照片');
  openAB(b, curIdx);
};

function videoLoaded() {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('loadeddata', done); resolve(); };
    video.addEventListener('loadeddata', done);
    setTimeout(done, 8000);
  });
}

// 指定两条片直接开 A/B：拖入两个文件，或勾选两个后右键
async function openAB(aIndex, bIndex) {
  play(aIndex);
  video.pause();
  await Promise.all([mediaInfoReady, videoLoaded()]);
  if (!video.videoWidth) return toast('成片载不进来，可能本机解不了这个编码');
  await openCompare();
  cmpOffset = 0;
  $('cmp-offset').textContent = '0 帧';
  $('cmp-src').value = String(bIndex);
  await loadCompareSource(bIndex);
  if (videoB.videoWidth) await autoAlign();
}

document.querySelectorAll('.cmp-modes button').forEach(button => {
  button.onclick = () => setCompareMode(button.dataset.mode);
});

function setCompareMode(mode) {
  cmpMode = mode;
  document.querySelectorAll('.cmp-modes button').forEach(button => {
    button.classList.toggle('on', button.dataset.mode === mode);
  });
  document.body.classList.toggle('cmp-wipe', mode === 'wipe');
  $('cmp-overlay-row').hidden = mode !== 'overlay';
  drawCompare();
}

function cycleCompareMode() {
  if (!cmpOn) return;
  const modes = ['toggle', 'wipe', 'overlay', 'diff'];
  setCompareMode(modes[(modes.indexOf(cmpMode) + 1) % modes.length]);
}

function flipCompare() {
  if (!cmpOn || !videoB.videoWidth) return;
  if (cmpMode !== 'toggle') setCompareMode('toggle');
  cmpShowB = !cmpShowB;
  drawCompare();
}

$('player-wrap').addEventListener('pointerdown', e => {
  if (!cmpOn || cmpMode !== 'wipe') return;
  cmpWipeDrag = true;
  moveWipe(e);
});
$('player-wrap').addEventListener('pointermove', e => { if (cmpWipeDrag) moveWipe(e); });
document.addEventListener('pointerup', () => { cmpWipeDrag = false; });

$('cmp-alpha').oninput = e => {
  cmpAlpha = Number(e.target.value) / 100;
  $('cmp-alpha-val').textContent = e.target.value + '%';
  drawCompare();
};

function moveWipe(e) {
  const rect = video.getBoundingClientRect();
  cmpWipe = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  drawCompare();
}

// ---------- 跳帧 / 区间循环 ----------
function jumpToFrame(frame) {
  if (!video.duration) return;
  const last = Math.max(0, Math.round(video.duration / frameDur) - 1);
  const target = Math.min(last, Math.max(0, frame));
  video.pause();
  chainSeek((target + 0.5) * frameDur);
}

async function askJumpFrame() {
  if (!video.duration) return;
  const total = Math.round(video.duration / frameDur);
  const typed = await askText('跳到第几帧', String(targetFrame() + 1), `这个视频共 ${total} 帧（从 1 开始）`);
  if (typed === null) return;
  const frame = parseInt(typed.trim(), 10);
  if (!Number.isFinite(frame)) return toast('请输入帧号数字');
  jumpToFrame(frame - 1);
}

function renderLoop() {
  const band = $('seek-loop');
  const label = $('loop-state');
  if (loopIn === null && loopOut === null) {
    band.hidden = true;
    label.textContent = '';
    return;
  }
  const from = loopIn === null ? 0 : loopIn;
  const to = loopOut === null ? Math.round((video.duration || 0) / frameDur) - 1 : loopOut;
  label.textContent = `区间 ${from + 1}–${to + 1} 帧（${to - from + 1} 帧）` + (looping ? ' · 循环中' : ' · 按 L 循环');
  if (!video.duration) { band.hidden = true; return; }
  const left = from * frameDur / video.duration * 100;
  const right = (to + 1) * frameDur / video.duration * 100;
  band.hidden = false;
  band.style.left = Math.max(0, left) + '%';
  band.style.width = Math.max(0.6, Math.min(100, right) - Math.max(0, left)) + '%';
}

function setLoopEdge(which) {
  if (!video.duration) return;
  const frame = targetFrame();
  if (which === 'in') loopIn = frame;
  else loopOut = frame;
  if (loopIn !== null && loopOut !== null && loopOut < loopIn) [loopIn, loopOut] = [loopOut, loopIn];
  renderLoop();
  toast(which === 'in' ? `区间首帧 = 第 ${frame + 1} 帧` : `区间尾帧 = 第 ${frame + 1} 帧`);
}

function toggleLoop() {
  if (!video.duration) return;
  if (looping) {
    looping = false;
    renderLoop();
    toast('已停止区间循环');
    return;
  }
  // 没设区间时，默认围绕当前帧取 ±10 帧——补丁接点就是这么看的
  if (loopIn === null || loopOut === null) {
    const frame = targetFrame();
    loopIn = Math.max(0, frame - 10);
    loopOut = frame + 10;
  }
  looping = true;
  renderLoop();
  jumpToFrame(loopIn);
  video.play().catch(() => {});
  toast(`循环第 ${loopIn + 1}–${loopOut + 1} 帧，按 L 停止`);
}

function clearLoop() {
  loopIn = loopOut = null;
  looping = false;
  renderLoop();
}

// ---------- 列表右键：勾选两个视频做 A/B ----------
const ctxMenu = $('ctx-menu');

function closeCtxMenu() { ctxMenu.hidden = true; }

$('list').addEventListener('contextmenu', e => {
  e.preventDefault();
  const picked = selectedBatchItems()
    .filter(item => !item.isDir)
    .map(item => videos.findIndex(v => v.Name === item.name))
    .filter(index => index >= 0)
    .sort((a, b) => a - b);
  ctxMenu.replaceChildren();
  const addItem = (label, action) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.disabled = !action;
    if (action) button.onclick = () => { closeCtxMenu(); action(); };
    ctxMenu.appendChild(button);
  };
  if (picked.length === 2) {
    const [a, b] = picked;
    addItem(`A/B 对比：A=${videos[a].Name}，B=${videos[b].Name}`, () => openAB(a, b));
    addItem(`对调后对比：A=${videos[b].Name}，B=${videos[a].Name}`, () => openAB(b, a));
  } else {
    addItem(`勾选两个视频后可做 A/B 对比（已勾选 ${picked.length} 个）`, null);
  }
  ctxMenu.hidden = false;
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - ctxMenu.offsetWidth - 8) + 'px';
  ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - ctxMenu.offsetHeight - 8) + 'px';
});
document.addEventListener('pointerdown', e => { if (!ctxMenu.contains(e.target)) closeCtxMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });
$('list').addEventListener('scroll', closeCtxMenu);

// ---------- 本地视频: 拖进来或自己选 ----------
async function openLocalPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  try {
    const result = await api('/api/local/open', { method: 'POST', body: JSON.stringify({ paths: list }) });
    await enterLocalMode(result, list.length);
  } catch (error) {
    toast('打开本地视频失败: ' + error.message);
  }
}

async function enterLocalMode(result, requested) {
  stopPlayback();
  localMode = true;
  localDir = result.dir;
  curRemote = result.remote + ':';
  document.body.classList.add('local-mode');
  const sel = $('remote-sel');
  let option = sel.querySelector('option[data-local="1"]');
  if (!option) {
    option = document.createElement('option');
    option.dataset.local = '1';
    sel.appendChild(option);
  }
  option.value = curRemote;
  option.textContent = '📂 ' + (result.dir.split('/').filter(Boolean).pop() || result.dir);
  sel.disabled = false;
  sel.value = curRemote;
  await loadDir('');
  $('stats').textContent = '本地文件夹：' + result.dir;
  if (!videos.length) {
    toast('这个文件夹里没有可识别的视频文件');
    return;
  }
  const picked = (result.startNames || [])
    .map(name => videos.findIndex(v => v.Name === name))
    .filter(index => index >= 0);
  // 正好给了两个：第一个当成片 A，第二个当原片 B，直接对比
  if (requested === 2 && picked.length === 2) return openAB(picked[0], picked[1]);
  play(picked.length ? picked[0] : 0);
  if (requested === 2) toast('A/B 对比需要同一个文件夹里的两个视频，这次只打开了第一个');
}

function exitLocalMode() {
  localMode = false;
  localDir = '';
  document.body.classList.remove('local-mode');
  $('remote-sel').querySelector('option[data-local="1"]')?.remove();
}

$('local-btn').onclick = async () => {
  if (DESKTOP && DESKTOP.pickLocalVideos) return openLocalPaths(await DESKTOP.pickLocalVideos());
  // 浏览器里拿不到真实路径，只能让用户给出文件夹路径。
  const typed = await askText('打开本地文件夹', localDir || '', '浏览器模式下读不到拖拽文件的真实路径，请直接输入文件夹路径');
  if (typed && typed.trim()) openLocalPaths([typed.trim()]);
};

let dropDepth = 0;
const showDropHint = show => { $('drop-hint').hidden = !show; };

document.addEventListener('dragenter', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dropDepth++;
  showDropHint(true);
});
document.addEventListener('dragover', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth) showDropHint(false);
});
document.addEventListener('drop', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dropDepth = 0;
  showDropHint(false);
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (!DESKTOP || !DESKTOP.getPathForFile) {
    toast('浏览器模式下拿不到文件路径，请在「视频检查器」应用里拖拽，或用「📂 本地」输入文件夹路径');
    return;
  }
  openLocalPaths(files.map(file => DESKTOP.getPathForFile(file)));
});

function stopPlayback() {
  finishArrowHold(false);
  publicMode = false;
  currentPublicLink = null;
  document.body.classList.remove('public-mode');
  document.body.classList.remove('public-preview-mode');
  $('public-preview').hidden = true;
  $('public-preview').removeAttribute('src');
  $('public-fallback-btn').hidden = true;
  video.pause();
  resetLoader();
  video.removeAttribute('src');
  video.load();
  video.style.display = 'none';
  $('placeholder').style.display = '';
  $('player-wrap').classList.remove('has-video');
  $('cur-name').textContent = '未选择视频';
  clearLoop();
  renderFlags();
  window.PatchUI?.onClear();
}

function openPublicVideo(link) {
  stopPlayback();
  exitLocalMode();
  publicMode = true;
  currentPublicLink = link;
  document.body.classList.add('public-mode');
  curDir = '';
  dirs = [];
  videos = [];
  curIdx = -1;
  $('crumbs').textContent = '🔗 公开链接（免登录·只读）';
  $('list').innerHTML = '';
  const row = document.createElement('div');
  row.className = 'entry active';
  row.innerHTML = '<span class="icon">🎬</span><span class="name"></span>';
  row.querySelector('.name').textContent = 'Google Drive 公开视频';
  $('list').appendChild(row);
  $('stats').textContent = '免登录播放；链接必须设为「知道链接的任何人可查看」';
  $('placeholder').style.display = 'none';
  video.style.display = '';
  $('player-wrap').classList.add('has-video');
  resetLoader();
  const key = link.resourceKey ? '?resourcekey=' + encodeURIComponent(link.resourceKey) : '';
  video.src = '/public-stream/' + encodeURIComponent(link.id) + key;
  video.play().catch(() => {});
  startPublicFullLoad(link);
  loadPublicThumbs(link);
  $('cur-name').textContent = '公开 Drive 视频·只读模式';
  $('link-paste-input').value = '';
  showAccountModal(false);
  toast('已用本地播放器打开公开视频，支持快进和倍速');
}

function openPublicPreviewFallback() {
  if (!currentPublicLink) return;
  video.pause();
  video.style.display = 'none';
  $('player-wrap').classList.remove('has-video');
  document.body.classList.add('public-preview-mode');
  const preview = $('public-preview');
  preview.src = currentPublicLink.previewUrl;
  preview.hidden = false;
  $('public-fallback-btn').hidden = true;
  $('load-state').textContent = '';
}

$('public-fallback-btn').onclick = openPublicPreviewFallback;
async function diagnosePublicPlayback() {
  try {
    await api('/api/health');
  } catch {
    return '本地播放服务已断开，请关闭窗口后重新打开「视频检查器」';
  }
  try {
    const response = await fetch(video.src, { headers: { Range: 'bytes=0-0' } });
    if (response.ok) {
      response.body?.cancel();
      return 'Google 文件可读，但当前视频编码无法被 Chrome 播放';
    }
    const result = await response.json().catch(() => null);
    return result?.error || `Google 文件请求失败（${response.status}）`;
  } catch {
    return '本地服务正常，但无法连接 Google Drive';
  }
}

video.addEventListener('error', () => {
  if (publicMode || !video.getAttribute('src')) return;
  decodeFailed = true;
  renderMediaInfo();
  const codec = mediaInfo && mediaInfo.codec ? mediaInfo.codec + (mediaInfo.bitDepth ? ` ${mediaInfo.bitDepth}bit` : '') : '这个编码';
  toast(`播放器无法解码 ${codec}；信息栏和逐帧预览仍可用`);
});

video.addEventListener('error', async () => {
  if (!publicMode || document.body.classList.contains('public-preview-mode')) return;
  $('public-fallback-btn').hidden = false;
  const reason = await diagnosePublicPlayback();
  if (!publicMode || document.body.classList.contains('public-preview-mode')) return;
  toast('直连播放失败：' + reason + '；也可点「改用 Google 预览」');
});

$('remote-sel').onchange = async e => {
  if (!e.target.value) return;
  curRemote = e.target.value;
  if (isLocalRemote(curRemote)) {
    // 本地文件夹只在本次会话里有效，不写进设置，否则下次启动会指向一个没注册的根目录。
    localMode = true;
    document.body.classList.add('local-mode');
  } else {
    exitLocalMode();
    await saveSettings({ remote: curRemote });
  }
  stopPlayback();
  loadDir('');
};

$('sort-sel').onchange = async e => {
  sortMode = e.target.value;
  await saveSettings({ sortMode });
  applySort();
  render();
  if (curIdx >= 0) prefetchAround(curIdx);
};

$('ram-cache-gb').onchange = saveRamSettings;
$('ram-video-gb').onchange = saveRamSettings;
$('hold-seek-rate').onchange = () => saveSettings({ holdSeekRate: Number($('hold-seek-rate').value) });
let ramSaveTimer;
for (const id of ['ram-cache-gb', 'ram-video-gb']) {
  $(id).oninput = () => {
    clearTimeout(ramSaveTimer);
    ramSaveTimer = setTimeout(() => saveRamSettings().catch(e => toast('保存 RAM 设置失败: ' + e.message)), 400);
  };
}

$('link-btn').onclick = async () => {
  if (!curRemote) return toast('请先添加 Google Drive 账号');
  let link;
  try {
    const r = await api('/api/link?remote=' + encodeURIComponent(curRemote.replace(/:$/, '')) + '&path=' + encodeURIComponent(curDir));
    link = r.url;
  } catch (e) {
    return toast('取链接失败: ' + e.message);
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('已复制链接: ' + link);
  } catch {
    prompt('自动复制失败，请手动复制：', link);
  }
};

// ---------- YouTube: 后台用 yt-dlp 下载到本机，下完按本地视频打开 ----------
let youtubeJob = null; // { id, timer }

function renderYoutube(status) {
  const bar = $('yt-bar');
  const text = $('yt-text');
  bar.hidden = false;
  text.classList.toggle('error', status.state === 'error');
  $('yt-cancel-btn').textContent = status.state === 'running' ? '取消' : '关闭';
  const pct = Number(status.percent) || 0;
  $('yt-progress').hidden = status.state === 'error';
  $('yt-progress-fill').style.width = pct + '%';
  const name = status.title ? `「${status.title}」` : '';
  if (status.state === 'running') {
    // 1080p 以上画面和声音分开下：第 1 段是画面，第 2 段是声音，最后合并
    const phase = status.phase > 1 ? '声音' : '画面';
    text.textContent = pct >= 100 && status.phase > 1 ? `合并中…${name}` : `YouTube 下载${phase} ${pct.toFixed(0)}% ${name}`;
  } else if (status.state === 'error') {
    text.textContent = 'YouTube 下载失败：' + (status.error || '未知原因');
  } else {
    text.textContent = '下载完成 ' + name;
  }
  text.title = text.textContent;
}

function stopYoutubePolling() {
  if (youtubeJob) clearTimeout(youtubeJob.timer);
  youtubeJob = null;
}

async function pollYoutube(id) {
  if (!youtubeJob || youtubeJob.id !== id) return;
  let status;
  try {
    status = await api('/api/youtube/status?id=' + encodeURIComponent(id));
  } catch (e) {
    status = { id, state: 'error', error: e.message };
  }
  if (!youtubeJob || youtubeJob.id !== id) return;
  renderYoutube(status);
  if (status.state === 'running') {
    youtubeJob.timer = setTimeout(() => pollYoutube(id), 700);
    return;
  }
  stopYoutubePolling();
  if (status.state === 'done' && status.local) {
    $('yt-bar').hidden = true;
    await enterLocalMode(status.local, 1);
    toast('YouTube 视频已下载到本机，可以逐帧检查' + (status.title ? '：' + status.title : ''));
  }
}

async function openYoutube(link) {
  stopYoutubePolling();
  try {
    const status = await api('/api/youtube/download', { method: 'POST', body: JSON.stringify({ id: link.id }) });
    $('link-paste-input').value = '';
    youtubeJob = { id: link.id, timer: 0 };
    renderYoutube(status);
    pollYoutube(link.id);
  } catch (e) {
    renderYoutube({ state: 'error', error: e.message });
  }
}

$('yt-cancel-btn').onclick = async () => {
  const job = youtubeJob;
  stopYoutubePolling();
  $('yt-bar').hidden = true;
  if (job) api('/api/youtube/cancel', { method: 'POST', body: JSON.stringify({ id: job.id }) }).catch(() => {});
};

$('link-paste-btn').onclick = () => {
  const youtube = YoutubeLink.parse($('link-paste-input').value);
  if (youtube) return openYoutube(youtube);
  const link = DriveLink.parse($('link-paste-input').value);
  if (!link) return toast('看不出这是有效的 Google Drive 或 YouTube 链接');
  if (link.type === 'file') return openPublicVideo(link);
  if (!curRemote) return toast('单个公开视频可免登录播放；打开整个文件夹仍需先添加账号');
  const folderId = link.id;
  const value = curRemote.replace(/:$/, '').split(',')[0] + ',root_folder_id=' + folderId + ':';
  const sel = $('remote-sel');
  let opt = [...sel.options].find(o => o.value === value);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = value;
    opt.textContent = '🔗 链接文件夹 ' + folderId.slice(0, 8) + '…';
    sel.appendChild(opt);
  }
  sel.value = value;
  curRemote = value;
  saveSettings({ remote: curRemote });
  $('link-paste-input').value = '';
  stopPlayback();
  loadDir('');
};

function renderHelp(container, text) {
  container.innerHTML = '';
  const parts = String(text || '').split(/(https?:\/\/[^\s]+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const link = document.createElement('a');
      link.href = part;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = part;
      container.appendChild(link);
    } else container.appendChild(document.createTextNode(part));
  }
}

function renderOAuthStep(response) {
  if (response.done) {
    oauthFlow = null;
    loadRemotes().then(() => {
      $('remote-sel').value = response.remote;
      $('remote-sel').dispatchEvent(new Event('change'));
    });
    showAccountModal(false);
    toast('Google OAuth 授权完成: ' + response.remote);
    return;
  }
  oauthFlow = { sessionId: response.sessionId, state: response.state };
  const option = response.option || {};
  $('oauth-question').hidden = false;
  renderHelp($('oauth-question'), [response.error, option.Help].filter(Boolean).join('\n\n'));
  $('oauth-answer-row').hidden = false;
  $('oauth-step-buttons').hidden = false;
  $('oauth-answer-label').textContent = option.Name || '回答';
  const control = $('oauth-answer-control');
  control.innerHTML = '';
  let input;
  if (option.Examples?.length) {
    input = document.createElement('select');
    for (const example of option.Examples) {
      const item = document.createElement('option');
      item.value = String(example.Value);
      item.textContent = example.Help ? `${example.Value} — ${example.Help}` : String(example.Value);
      input.appendChild(item);
    }
    input.value = String(option.Default ?? option.Examples[0].Value);
  } else {
    input = document.createElement('input');
    input.type = option.IsPassword ? 'password' : 'text';
    input.value = option.Default == null ? '' : String(option.Default);
    input.required = !!option.Required;
  }
  input.id = 'oauth-answer';
  control.appendChild(input);
}

$('import-btn').onclick = () => showAccountModal(true);
$('account-close-btn').onclick = () => showAccountModal(false);
$('service-account-btn').onclick = () => $('import-file').click();
$('rclone-config-btn').onclick = () => $('config-file').click();
$('oauth-btn').onclick = () => {
  $('account-choices').hidden = true;
  $('oauth-panel').hidden = false;
  $('oauth-json-status').textContent = '';
};
$('oauth-json-btn').onclick = () => $('import-file').click();

function loadOAuthJson(key, fileName) {
  const credentials = key.installed || key.web;
  if (!credentials || typeof credentials.client_id !== 'string' || typeof credentials.client_secret !== 'string') {
    return false;
  }
  $('account-choices').hidden = true;
  $('oauth-panel').hidden = false;
  $('oauth-client-id').value = credentials.client_id;
  $('oauth-client-secret').value = credentials.client_secret;
  const suggestedName = String(credentials.project_id || fileName.replace(/\.json$/i, ''))
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 32);
  if (suggestedName) $('oauth-name').value = suggestedName;
  $('oauth-json-status').textContent = '✓ 已读取 OAuth JSON，现在请点击“开始配置”';
  toast('已读取 OAuth JSON，请点击“开始配置”完成 Google 登录');
  return true;
}

$('import-file').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  let key;
  try { key = JSON.parse(text); }
  catch { return toast('导入失败: 不是有效的 JSON 文件'); }
  if (loadOAuthJson(key, file.name)) return;
  const fallback = file.name.replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || 'gdrive2';
  const name = prompt('给这个账号起个名字（字母数字-_）：', fallback);
  if (!name) return;
  try {
    const result = await api('/api/remotes/import', { method: 'POST', body: JSON.stringify({ name, json: text }) });
    await loadRemotes();
    $('remote-sel').value = result.remote;
    $('remote-sel').dispatchEvent(new Event('change'));
    showAccountModal(false);
    toast(`已导入 ${result.remote} — 请把目标文件夹分享给 ${result.email}`);
  } catch (error) {
    toast('导入失败: ' + error.message);
  }
};

$('config-file').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !confirm('导入会替换应用当前的私有 rclone.conf，并自动备份旧配置。继续吗？')) return;
  try {
    const result = await api('/api/remotes/import-config', { method: 'POST', body: JSON.stringify({ content: await file.text() }) });
    curRemote = result.remotes[0] || '';
    await saveSettings({ remote: curRemote });
    await loadRemotes();
    if (curRemote) loadDir('');
    showAccountModal(false);
    toast(`已导入 ${result.remotes.length} 个 rclone 账号`);
  } catch (error) {
    toast(error.message);
  }
};

$('oauth-start-btn').onclick = async () => {
  const button = $('oauth-start-btn');
  button.disabled = true;
  try {
    const response = await api('/api/remotes/oauth/start', {
      method: 'POST',
      body: JSON.stringify({
        name: $('oauth-name').value.trim(),
        clientId: $('oauth-client-id').value.trim(),
        clientSecret: $('oauth-client-secret').value.trim()
      })
    });
    renderOAuthStep(response);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};

$('oauth-continue-btn').onclick = async () => {
  if (!oauthFlow) return;
  const button = $('oauth-continue-btn');
  button.disabled = true;
  try {
    const response = await api('/api/remotes/oauth/continue', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: oauthFlow.sessionId,
        state: oauthFlow.state,
        result: $('oauth-answer').value
      })
    });
    renderOAuthStep(response);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};

$('oauth-cancel-btn').onclick = async () => {
  if (oauthFlow) {
    await api('/api/remotes/oauth/cancel', { method: 'POST', body: JSON.stringify({ sessionId: oauthFlow.sessionId }) }).catch(() => {});
  }
  oauthFlow = null;
  showAccountModal(false);
};

async function initialize() {
  try {
    const settings = await api('/api/settings');
    curRemote = settings.remote || '';
    sortMode = settings.sortMode || 'name';
    $('sort-sel').value = sortMode;
    $('ram-cache-gb').value = settings.ramCacheGb > 0 ? settings.ramCacheGb : '';
    $('ram-video-gb').value = settings.ramMaxVideoGb > 0 ? settings.ramMaxVideoGb : '';
    $('hold-seek-rate').value = String([0.5, 1, 2, 4, 8, 16].includes(Number(settings.holdSeekRate)) ? Number(settings.holdSeekRate) : 4);
    setSpeed(SPEEDS.includes(Number(settings.playbackRate)) ? Number(settings.playbackRate) : 1, false);
    setLoopVideo(settings.loopVideo === true, false);
    await refreshRamStatus();
    if (await loadRemotes()) await loadDir('');
  } catch (error) {
    toast('启动失败: ' + error.message);
    showAccountModal(true);
  }
}

initialize();
