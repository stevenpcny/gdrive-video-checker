(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YoutubeLink = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // YouTube 视频 ID 固定 11 位；只认 ID，交给 yt-dlp 的永远是我们自己拼出来的规范链接。
  const ID = /^[A-Za-z0-9_-]{11}$/;
  const HOSTS = /^(?:www\.|m\.|music\.)?youtube\.com$|^youtube-nocookie\.com$|^www\.youtube-nocookie\.com$/i;

  function parse(input) {
    const value = String(input || '').trim();
    if (!value) return null;

    let url;
    try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : 'https://' + value); } catch { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;

    let id = '';
    if (/^youtu\.be$/i.test(url.hostname)) {
      id = url.pathname.split('/')[1] || '';
    } else if (HOSTS.test(url.hostname)) {
      const path = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(url.pathname);
      id = path ? path[1] : (url.pathname === '/watch' ? url.searchParams.get('v') || '' : '');
    } else {
      return null;
    }
    if (!ID.test(id)) return null;
    return { type: 'youtube', id, url: 'https://www.youtube.com/watch?v=' + id };
  }

  return Object.freeze({ parse, isId: id => ID.test(String(id || '')) });
});
