'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets exactly these four things and nothing else. No fs, no
// child_process, no ipcRenderer surface it could use to reach anything wider.
contextBridge.exposeInMainWorld('switchboard', {
  getEndpoint: () => ipcRenderer.invoke('sb:endpoint'),
  openExternal: (url) => ipcRenderer.invoke('sb:open-external', url),
  restartGateway: () => ipcRenderer.invoke('sb:restart'),
  platform: process.platform,
});
