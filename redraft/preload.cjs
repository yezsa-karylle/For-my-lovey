// Narrow, explicit bridge between the sandboxed UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: (kind) => ipcRenderer.invoke('open-dialog', kind),
  saveDialog: (kind, defaultPath) => ipcRenderer.invoke('save-dialog', { kind, defaultPath }),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  exists: (p) => ipcRenderer.invoke('exists', p),
  pathInfo: () => ipcRenderer.invoke('path-info'),
  launchFile: () => ipcRenderer.invoke('launch-file'),
  setTitle: (t) => ipcRenderer.invoke('set-title', t),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  toggleDevtools: () => ipcRenderer.invoke('toggle-devtools'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  closeReady: () => ipcRenderer.invoke('close-ready'),
  onCloseRequest: (cb) => ipcRenderer.on('close-request', () => cb()),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
});
