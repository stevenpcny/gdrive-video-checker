(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DriveLink = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const ID = '[A-Za-z0-9_-]{10,100}';

  function parse(input) {
    const value = String(input || '').trim();
    if (!value) return null;

    let url;
    try { url = new URL(value); } catch { return null; }
    if (!/(^|\.)drive\.google\.com$/i.test(url.hostname)) return null;

    const folder = new RegExp('/folders/(' + ID + ')(?:/|$)').exec(url.pathname);
    if (folder) return { type: 'folder', id: folder[1] };

    let match = new RegExp('/file/d/(' + ID + ')(?:/|$)').exec(url.pathname);
    const queryId = url.searchParams.get('id');
    if (!match && queryId && new RegExp('^' + ID + '$').test(queryId)) match = [queryId, queryId];
    if (!match) return null;

    const resourceKey = url.searchParams.get('resourcekey') || '';
    const suffix = resourceKey ? '?resourcekey=' + encodeURIComponent(resourceKey) : '';
    return {
      type: 'file',
      id: match[1],
      resourceKey,
      previewUrl: 'https://drive.google.com/file/d/' + encodeURIComponent(match[1]) + '/preview' + suffix
    };
  }

  return Object.freeze({ parse });
});
