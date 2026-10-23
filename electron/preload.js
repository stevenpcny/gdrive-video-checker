'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('videoCheckerDesktop', Object.freeze({
  setWindowBounds(bounds) {
    return ipcRenderer.invoke('window:set-bounds', bounds);
  },
  // Electron 32 起 File.path 已被移除，拖进来的文件只能用 webUtils 换真实路径。
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  pickLocalVideos() {
    return ipcRenderer.invoke('dialog:pick-local-videos');
  }
}));
