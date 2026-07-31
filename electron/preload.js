'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoCheckerDesktop', Object.freeze({
  setWindowBounds(bounds) {
    return ipcRenderer.invoke('window:set-bounds', bounds);
  }
}));
