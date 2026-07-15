const VIDEO_EXT = new Set(['mp4','mov','m4v','mkv','webm','avi','ts','mts','flv','wmv','3gp']);
const MAX_DECODED_THUMBS = 600;
const FRAME = 1 / 30;
const DESKTOP = window.videoCheckerDesktop || null;
const AUTO_FIT_WINDOW = !!DESKTOP || new URLSearchParams(location.search).has('standalone');
const $ = id => document.getElementById(id);
const video = $('video');

let curDir = '';
let dirs = [];
let videos = [];
let curIdx = -1;
let marks = {};
let lastMove = null;
let fitWindowSeq = 0;

// 整片预载状态
let loadSeq = 0;
let cacheReady = false;

let curRemote = '';    // 当前账号(rclone remote 名，含冒号)

const isVideo = name => VIDEO_EXT.has(name.split('.').pop().toLowerCase());
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const keyOf = v => (curDir ? curDir + '/' : '') + v.Name;
const pathOf = v => v.movedTo || keyOf(v); // 不合格已移入子文件夹的，用新路径播放
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

function showListMessage(text, isError = false) {
  const row = document.createElement('div');
  row.className = 'entry' + (isError ? ' error-row' : '');
  row.textContent = text;
  $('list').replaceChildren(row);
}

async function loadDir(p) {
  const seq = ++loadDirSeq;
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
    applySort();
    render();
  } catch (e) {
    if (seq === loadDirSeq) showListMessage('加载失败: ' + e.message, true);
  }
}

// ---------- RAM 预热: 只保留当前、下一个、上一个 ----------
const cachedSet = new Set(); // markKey -> 已预热
let prefetchSeq = 0;

async function prefetchAround(center) {
  const seq = ++prefetchSeq;
  cachedSet.clear();
  render();
  const remote = curRemote.replace(/:$/, '');
  const queue = [center, center + 1, center - 1]
    .filter((i, pos, all) => i >= 0 && i < videos.length && all.indexOf(i) === pos)
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
  addCrumb('📁 根目录', '');
  for (const part of parts) {
    acc = acc ? acc + '/' + part : part;
    addCrumb(part, acc);
  }

  const list = $('list');
  list.innerHTML = '';
  for (const d of dirs) {
    const el = document.createElement('div');
    el.className = 'entry';
    el.innerHTML = `<span class="icon">📁</span><span class="name"></span>` +
      `<span class="actions"><span class="act-rename" title="重命名文件夹">✎</span><span class="act-del" title="删除文件夹（含内容）">🗑</span></span>`;
    el.querySelector('.name').textContent = d.Name;
    el.onclick = () => loadDir((curDir ? curDir + '/' : '') + d.Name);
    el.querySelector('.act-rename').onclick = e => { e.stopPropagation(); renameEntry(d, true); };
    el.querySelector('.act-del').onclick = e => { e.stopPropagation(); deleteFolder(d); };
    list.appendChild(el);
  }
  videos.forEach((v, i) => {
    const el = document.createElement('div');
    el.className = 'entry' + (i === curIdx ? ' active' : '') + (v.movedTo ? ' badrow' : '');
    el.dataset.idx = i;
    const mark = v.movedTo ? { status: 'bad' } : marks[markKey(v)];
    el.innerHTML = `<span class="icon">🎬</span><span class="name"></span>` +
      (mark ? `<span class="badge ${mark.status}">${mark.status === 'ok' ? '合格' : '不合格'}</span>` : '') +
      `<span class="cache-dot${cachedSet.has(markKey(v)) ? ' cached' : ''}" title="绿点=已预热，秒开"></span>` +
      (v.movedTo ? '' : `<span class="actions"><span class="act-rename" title="重命名视频">✎</span><span class="act-del" title="删除视频">🗑</span></span>`);
    el.querySelector('.name').textContent = v.Name;
    el.onclick = () => play(i);
    if (!v.movedTo) {
      el.querySelector('.act-rename').onclick = e => { e.stopPropagation(); renameEntry(v, false); };
      el.querySelector('.act-del').onclick = e => { e.stopPropagation(); deleteVideo(v); };
    }
    list.appendChild(el);
  });

  const done = videos.filter(v => v.movedTo || marks[markKey(v)]).length;
  $('stats').textContent = videos.length ? `视频 ${videos.length} 个 · 已检查 ${done} 个` : '此文件夹没有视频';
  $('folder-done-btn').style.display = videos.length && done === videos.length ? 'block' : 'none';
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
  video.src = streamUrl(curRemote, pathOf(v));
  requestAnimationFrame(updateNavHitAreas);
  video.play().catch(() => {});
  $('cur-name').textContent = `[${i + 1}/${videos.length}] ${v.Name}`;
  render();
  document.querySelector(`.entry[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  startFullLoad(v);
  prefetchAround(i);
}

// ---------- 整片预载: 服务端只下载一份持久缓存 ----------
function resetLoader() {
  loadSeq++;
  cacheReady = false;
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
    stateEl.textContent = '✓ 已预载·可连续拖动检查' + (thumbFrames.size ? '·丝滑预览就绪' : '');
    stateEl.className = 'ready';
  } catch (e) {
    if (seq === loadSeq) stateEl.textContent = '';
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
  const v = videos[curIdx];
  if (v) loadThumbs(v);
}

function chainSeek(t) {
  if (video.seeking) pendingSeek = t;
  else video.currentTime = t;
}
video.addEventListener('seeked', () => {
  if (pendingSeek !== null) { const t = pendingSeek; pendingSeek = null; video.currentTime = t; }
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
  if (showScrubFrame(dragTarget)) {
    if (dragSeekRaf) { cancelAnimationFrame(dragSeekRaf); dragSeekRaf = 0; }
  } else if (cacheReady) {
    // 用本地原片持续更新高清画面；每帧只保留最新位置，避免过期 seek 堆积花屏。
    scrubPreviewSeq++;
    requestedScrubSrc = '';
    $('scrub-overlay').style.display = 'none';
    scheduleDragSeek(dragTarget);
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
seekbar.addEventListener('pointerup', e => {
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
  if (!wasPausedBeforeDrag) video.play().catch(() => {});
});

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
  let buf = 0;
  for (let i = 0; i < video.buffered.length; i++) buf = Math.max(buf, video.buffered.end(i));
  $('seek-buffered').style.width = (d ? buf / d * 100 : 0) + '%';
  requestAnimationFrame(updateBar);
}
requestAnimationFrame(updateBar);

video.addEventListener('play', () => $('play-btn').textContent = '⏸');
video.addEventListener('pause', () => $('play-btn').textContent = '▶');
video.addEventListener('loadedmetadata', () => {
  updateNavHitAreas();
  fitWindowToVideo(++fitWindowSeq);
});
video.addEventListener('click', () => video.paused ? video.play() : video.pause());
window.addEventListener('resize', updateNavHitAreas);

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
  const input = prompt(`重命名${isDir ? '文件夹' : '视频'}：`, oldName);
  if (input === null) return;
  const newName = input.trim();
  if (!newName || newName === oldName) return;
  if (newName.includes('/')) return toast('名字里不能有斜杠', false);
  if ([...dirs, ...videos].some(e => e !== entry && e.Name === newName)) return toast(`「${newName}」已存在`, false);
  const remote = curRemote.replace(/:$/, '');
  const base = curDir ? curDir + '/' : '';
  const from = base + oldName, to = base + newName;
  const wasCurrent = !isDir && curIdx >= 0 && videos[curIdx] === entry;
  try {
    await api('/api/rename', { method: 'POST', body: JSON.stringify({ remote, from, to }) });
    // 迁移文件标记(marks 以路径为 key，不迁会失联；文件夹内子项标记无法批量迁，属既有限制)
    if (!isDir && marks[curRemote + from]) {
      await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: curRemote + to, status: marks[curRemote + from].status }) });
      await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: curRemote + from, status: null }) });
    }
    await reloadKeepingCurrent(wasCurrent ? newName : undefined);
    toast(`已重命名为「${newName}」`, false);
  } catch (e) {
    toast('重命名失败: ' + e.message, false);
  }
}

async function deleteVideo(v) {
  if (!confirm(`删除「${v.Name}」？\n\n文件会移入 Google Drive 回收站，可在云端硬盘「回收站」里恢复。`)) return;
  const remote = curRemote.replace(/:$/, '');
  const p = keyOf(v);
  const wasCurrent = curIdx >= 0 && videos[curIdx] === v;
  try {
    await api('/api/delete', { method: 'POST', body: JSON.stringify({ remote, path: p }) });
    if (marks[curRemote + p]) await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: curRemote + p, status: null }) });
    if (wasCurrent) stopPlayback();
    await reloadKeepingCurrent(wasCurrent ? null : undefined);
    toast(`已删除「${v.Name}」（Drive 回收站可恢复）`, false);
  } catch (e) {
    toast('删除失败: ' + e.message, false);
  }
}

async function deleteFolder(d) {
  if (!confirm(`删除文件夹「${d.Name}」及其中全部内容？\n\n会移入 Google Drive 回收站，可在云端硬盘「回收站」里恢复。`)) return;
  const remote = curRemote.replace(/:$/, '');
  const p = (curDir ? curDir + '/' : '') + d.Name;
  try {
    await api('/api/delete', { method: 'POST', body: JSON.stringify({ remote, path: p, isDir: true }) });
    await reloadKeepingCurrent();
    toast(`已删除文件夹「${d.Name}」（Drive 回收站可恢复）`, false);
  } catch (e) {
    toast('删除失败: ' + e.message, false);
  }
}

async function uploadFiles(files) {
  const remote = curRemote.replace(/:$/, '');
  const base = curDir ? curDir + '/' : '';
  const existing = new Set([...dirs, ...videos].map(e => e.Name));
  let done = 0, fail = 0;
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    if (existing.has(f.name)) { toast(`「${f.name}」已存在，跳过`, false); fail++; continue; }
    const id = Math.random().toString(36).slice(2);
    const label = `上传中 ${n + 1}/${files.length}：${f.name}`;
    toast(label + ' …', false);
    // 轮询服务端 copyto 进度(浏览器→本地服务器几乎瞬时，耗时在服务器→Drive)
    const poll = setInterval(async () => {
      try {
        const r = await api('/api/upload/progress?id=' + id);
        toast(`${label} ${r.pct}%`, false);
      } catch { /* 忽略单次轮询失败 */ }
    }, 400);
    try {
      const r = await fetch('/api/upload?remote=' + encodeURIComponent(remote) + '&path=' + encodeURIComponent(base + f.name) + '&id=' + id, { method: 'POST', body: f });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || r.status); }
      existing.add(f.name);
      done++;
    } catch (e) { fail++; toast(`上传「${f.name}」失败: ${e.message}`, false); }
    finally { clearInterval(poll); }
  }
  await reloadKeepingCurrent();
  if (done) toast(`已上传 ${done} 个视频${fail ? `，${fail} 个跳过/失败` : ''}`, false);
}

$('upload-btn').onclick = () => $('upload-file').click();
$('upload-file').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) uploadFiles(fs); };

// ---------- 标记 / 移动 ----------
function next() { if (curIdx + 1 < videos.length) play(curIdx + 1); else toast('已经是最后一个了', false); }
function prev() { if (curIdx > 0) play(curIdx - 1); }

async function markOk() {
  if (curIdx < 0) return;
  const key = markKey(videos[curIdx]);
  await api('/api/marks', { method: 'POST', body: JSON.stringify({ key, status: 'ok' }) });
  marks[key] = { status: 'ok' };
  next();
}

let moveInFlight = Promise.resolve(); // 后台移动队列，undo 需等它

function markBad() {
  if (curIdx < 0) return;
  const v = videos[curIdx];
  const sub = $('subdir').value.trim() || '不合格';
  const from = keyOf(v);
  const to = (curDir ? curDir + '/' : '') + sub + '/' + v.Name;
  const remote = curRemote.replace(/:$/, '');
  const markRemote = curRemote;
  const cur = curIdx;
  if (v.movedTo) return; // 已经标过

  // 立即标红并切下一个，移动在后台执行，不打断节奏
  v.movedTo = to;
  curIdx = -1;
  if (cur + 1 < videos.length) play(cur + 1); else { stopPlayback(); render(); }
  toast(`已移入「${sub}」: ${v.Name}`, true);

  moveInFlight = moveInFlight.then(async () => {
    try {
      await api('/api/move', { method: 'POST', body: JSON.stringify({ remote, from, to }) });
      await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: markRemote + to, status: 'bad' }) });
      lastMove = { from, to, name: v.Name };
    } catch (e) {
      v.movedTo = null; // 失败: 撤掉红标并提示
      render();
      toast(`移动失败，已恢复标记: ${e.message}`, false);
    }
  });
}

async function undo() {
  await moveInFlight; // 等后台移动落定，lastMove 才是最新状态
  if (!lastMove) return;
  const { from, to, name } = lastMove;
  lastMove = null;
  hideToast();
  try {
    await api('/api/move', { method: 'POST', body: JSON.stringify({ remote: curRemote.replace(/:$/, ''), from: to, to: from }) });
    await api('/api/marks', { method: 'POST', body: JSON.stringify({ key: curRemote + to, status: null }) });
    await loadDir(curDir);
    const i = videos.findIndex(v => v.Name === name);
    if (i >= 0) play(i);
  } catch (e) {
    toast('撤销失败: ' + e.message, false);
  }
}

// 跳到父文件夹里的上/下一个同级文件夹(按当前排序)，自动播放第一个视频
async function gotoFolder(delta) {
  if (!curDir) return toast('已在根目录，没有上一级', false);
  const cut = curDir.lastIndexOf('/');
  const parent = cut < 0 ? '' : curDir.slice(0, cut);
  const name = cut < 0 ? curDir : curDir.slice(cut + 1);
  $('next-folder-btn').disabled = $('prev-folder-btn').disabled = true;
  try {
    const r = await api('/api/list?remote=' + encodeURIComponent(curRemote.replace(/:$/, '')) + '&path=' + encodeURIComponent(parent));
    const sub = $('subdir').value.trim() || '不合格';
    const folders = r.entries.filter(e => e.IsDir && e.Name !== sub).sort(sortCmp());
    const i = folders.findIndex(f => f.Name === name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= folders.length) {
      return toast(delta > 0 ? '已经是上一级里的最后一个文件夹了' : '已经是上一级里的第一个文件夹了', false);
    }
    const target = (parent ? parent + '/' : '') + folders[j].Name;
    stopPlayback();
    await loadDir(target);
    if (videos.length) play(0); else toast(`「${folders[j].Name}」里没有视频`, false);
  } catch (e) {
    toast('切换失败: ' + e.message, false);
  } finally {
    $('next-folder-btn').disabled = $('prev-folder-btn').disabled = false;
  }
}
$('prev-folder-btn').onclick = () => gotoFolder(-1);
$('next-folder-btn').onclick = () => gotoFolder(1);

// 按视频编号从小到大，复制检查结果，一行一个，可粘贴到表格一列。
// 穿帮 = 已被移入「不合格」子文件夹的视频；其余（源文件夹现存）= 已完成。
async function copyResult() {
  const remote = curRemote.replace(/:$/, '');
  const sub = $('subdir').value.trim() || '不合格';
  const numOf = name => { const n = parseInt(name, 10); return Number.isNaN(n) ? Infinity : n; };
  // 源文件夹现存视频 → 已完成；排除本会话刚移走(movedTo)的，避免与子文件夹重复
  const rows = videos.filter(v => !v.movedTo).map(v => ({ name: v.Name, status: '✅ 已完成' }));
  // 「不合格」子文件夹里的视频 → 穿帮
  let badCount = 0;
  try {
    const badPath = (curDir ? curDir + '/' : '') + sub;
    const listing = await api('/api/list?remote=' + encodeURIComponent(remote) + '&path=' + encodeURIComponent(badPath));
    for (const e of listing.entries) {
      if (!e.IsDir && isVideo(e.Name)) { rows.push({ name: e.Name, status: '穿帮' }); badCount++; }
    }
  } catch { /* 没有「不合格」子文件夹 = 没有穿帮 */ }
  if (!rows.length) { toast('这个文件夹没有可复制的结果', false); return; }
  rows.sort((a, b) => numOf(a.name) - numOf(b.name) || a.name.localeCompare(b.name, 'zh', { numeric: true }));
  const text = rows.map(r => r.status).join('\n');
  if (await writeClipboard(text)) {
    toast(`已复制 ${rows.length} 条结果（穿帮 ${badCount}），按编号从小到大`, false);
  } else {
    toast('复制失败，请检查浏览器剪贴板权限', false);
  }
}

// 优先用 clipboard API，失败时回退到 execCommand（对焦点/手势要求更宽松）
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
$('folder-done-btn').onclick = () => gotoFolder(1);

let toastTimer;
function toast(msg, undoable) {
  $('toast-msg').textContent = msg;
  $('undo-btn').style.display = undoable ? '' : 'none';
  $('toast').style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('toast').style.display = 'none'; }

// ---------- 快捷键 ----------
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (k === 'ArrowRight') { e.preventDefault(); chainSeek(video.currentTime + (e.shiftKey ? 30 : 5)); }
  else if (k === 'ArrowLeft') { e.preventDefault(); chainSeek(video.currentTime - (e.shiftKey ? 30 : 5)); }
  else if (k === ',') { video.pause(); chainSeek(Math.max(0, video.currentTime - FRAME)); }
  else if (k === '.') { video.pause(); chainSeek(video.currentTime + FRAME); }
  else if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    let i = SPEEDS.indexOf(video.playbackRate);
    if (i < 0) i = 2;
    i = Math.min(SPEEDS.length - 1, Math.max(0, i + (k === 'ArrowUp' ? 1 : -1)));
    video.playbackRate = SPEEDS[i];
    $('speed').textContent = SPEEDS[i] + 'x';
  }
  else if (k === 'm' || k === 'M') { video.muted = !video.muted; $('mute-btn').textContent = video.muted ? '🔇' : '🔊'; }
  else if (k === 'g' || k === 'G') markOk();
  else if (k === 'b' || k === 'B') markBad();
  else if (k === 'Enter') next();
  else if (k === 'p' || k === 'P') prev();
});

$('play-btn').onclick = () => video.paused ? video.play() : video.pause();
$('mute-btn').onclick = () => { video.muted = !video.muted; $('mute-btn').textContent = video.muted ? '🔇' : '🔊'; };
$('ok-btn').onclick = markOk;
$('bad-btn').onclick = markBad;
$('next-btn').onclick = next;
$('prev-btn').onclick = prev;
$('undo-btn').onclick = undo;
video.addEventListener('ended', next);

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
    $('stats').textContent = '尚未连接 Google Drive';
    showAccountModal(true);
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

function stopPlayback() {
  video.pause();
  resetLoader();
  video.removeAttribute('src');
  video.load();
  video.style.display = 'none';
  $('placeholder').style.display = '';
  $('player-wrap').classList.remove('has-video');
  $('cur-name').textContent = '未选择视频';
}

$('remote-sel').onchange = async e => {
  if (!e.target.value) return;
  curRemote = e.target.value;
  await saveSettings({ remote: curRemote });
  stopPlayback();
  loadDir('');
};

$('sort-sel').onchange = async e => {
  sortMode = e.target.value;
  await saveSettings({ sortMode });
  applySort();
  render();
};

$('subdir').onchange = () => saveSettings({ subdir: $('subdir').value.trim() || '不合格' });
$('ram-cache-gb').onchange = saveRamSettings;
$('ram-video-gb').onchange = saveRamSettings;
let ramSaveTimer;
for (const id of ['ram-cache-gb', 'ram-video-gb']) {
  $(id).oninput = () => {
    clearTimeout(ramSaveTimer);
    ramSaveTimer = setTimeout(() => saveRamSettings().catch(e => toast('保存 RAM 设置失败: ' + e.message, false)), 400);
  };
}

$('link-btn').onclick = async () => {
  if (!curRemote) return toast('请先添加 Google Drive 账号', false);
  let link;
  try {
    const r = await api('/api/link?remote=' + encodeURIComponent(curRemote.replace(/:$/, '')) + '&path=' + encodeURIComponent(curDir));
    link = r.url;
  } catch (e) {
    return toast('取链接失败: ' + e.message, false);
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('已复制链接: ' + link, false);
  } catch {
    prompt('自动复制失败，请手动复制：', link);
  }
};

function parseDriveFolderId(input) {
  input = input.trim();
  let m = /\/folders\/([A-Za-z0-9_-]{10,100})/.exec(input);
  if (m) return m[1];
  m = /^[A-Za-z0-9_-]{10,100}$/.exec(input);
  return m ? m[0] : null;
}

$('link-paste-btn').onclick = () => {
  if (!curRemote) return toast('请先添加 Google Drive 账号', false);
  const folderId = parseDriveFolderId($('link-paste-input').value);
  if (!folderId) return toast('看不出这是个文件夹链接（单个文件的链接暂不支持）', false);
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
    toast('Google OAuth 授权完成: ' + response.remote, false);
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
  toast('已读取 OAuth JSON，请点击“开始配置”完成 Google 登录', false);
  return true;
}

$('import-file').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  let key;
  try { key = JSON.parse(text); }
  catch { return toast('导入失败: 不是有效的 JSON 文件', false); }
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
    toast(`已导入 ${result.remote} — 请把目标文件夹分享给 ${result.email}`, false);
  } catch (error) {
    toast('导入失败: ' + error.message, false);
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
    toast(`已导入 ${result.remotes.length} 个 rclone 账号`, false);
  } catch (error) {
    toast(error.message, false);
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
    toast(error.message, false);
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
    toast(error.message, false);
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
    $('subdir').value = settings.subdir || '不合格';
    $('ram-cache-gb').value = settings.ramCacheGb > 0 ? settings.ramCacheGb : '';
    $('ram-video-gb').value = settings.ramMaxVideoGb > 0 ? settings.ramMaxVideoGb : '';
    await refreshRamStatus();
    if (await loadRemotes()) await loadDir('');
  } catch (error) {
    toast('启动失败: ' + error.message, false);
    showAccountModal(true);
  }
}

initialize();
