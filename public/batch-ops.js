(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BatchOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const joinPath = (parent, name) => parent ? `${parent}/${name}` : name;

  function makeItem(entry, isDir, parent) {
    const path = joinPath(parent, entry.Name);
    return {
      entry,
      isDir: !!isDir,
      name: entry.Name,
      parent,
      path,
      key: `${isDir ? 'dir' : 'file'}\0${path}`
    };
  }

  function validateMoveTarget(items, targetDir, targetEntries) {
    if (!items.length) return '请先选择要移动的项目';
    if (items.every(item => item.parent === targetDir)) return '这里就是原位置';

    const selectedFolders = items.filter(item => item.isDir);
    if (selectedFolders.some(item => targetDir === item.path || targetDir.startsWith(item.path + '/'))) {
      return '不能把文件夹移入自身或它的子目录';
    }

    const existing = new Set(targetEntries.map(entry => entry.Name));
    const conflicts = [...new Set(items.filter(item => existing.has(item.name)).map(item => item.name))];
    if (conflicts.length) return `目标位置已存在：${conflicts.join('、')}`;
    return '';
  }

  return { joinPath, makeItem, validateMoveTarget };
});
