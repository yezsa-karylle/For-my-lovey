// Electron main process: window, app:// protocol, file dialogs and disk IO.
const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
// Lets tests run with a clean, throwaway settings folder.
if (process.env.REDRAFT_USER_DATA) app.setPath('userData', process.env.REDRAFT_USER_DATA);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.wasm': 'application/wasm',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
let pendingOpen = fileFromArgv(process.argv);
let allowClose = false;

function fileFromArgv(argv) {
  const f = argv.slice(1).find((a) => /\.(redraft|pdf|png|jpe?g|webp|bmp|gif)$/i.test(a) && fs.existsSync(a));
  return f ? path.resolve(f) : null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) win.webContents.send('open-path', f);
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    backgroundColor: '#1b1b1e',
    title: 'Redraft',
    show: false,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => { win.show(); if (process.env.REDRAFT_MAXIMIZE !== '0') win.maximize(); });
  win.loadURL('app://redraft/src/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('close-request');
    // Safety net: never trap the user if the renderer is stuck.
    setTimeout(() => { allowClose = true; if (win && !win.isDestroyed()) win.close(); }, 8000);
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname);
    const full = path.normalize(path.join(ROOT, rel));
    if (!full.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(full);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- IPC
const FILTERS = {
  open: [
    { name: 'Notes (PDF, images, Redraft projects)', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'redraft'] },
    { name: 'PDF', extensions: ['pdf'] },
    { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
    { name: 'Redraft project', extensions: ['redraft'] },
  ],
  import: [
    { name: 'PDF or images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
  ],
  project: [{ name: 'Redraft project', extensions: ['redraft'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  png: [{ name: 'PNG image', extensions: ['png'] }],
  mp4: [{ name: 'MP4 video', extensions: ['mp4'] }],
};

ipcMain.handle('open-dialog', async (_e, kind = 'open') => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: FILTERS[kind] || FILTERS.open,
  });
  if (r.canceled || !r.filePaths.length) return [];
  return r.filePaths;
});

ipcMain.handle('save-dialog', async (_e, { kind, defaultPath }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: FILTERS[kind] || [] });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('read-file', async (_e, p) => {
  const buf = await fs.promises.readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

ipcMain.handle('write-file', async (_e, p, data) => {
  // Write to a temp file then rename, so a crash never leaves a half-written project.
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  await fs.promises.writeFile(tmp, Buffer.from(data));
  await fs.promises.rename(tmp, p);
  return true;
});

ipcMain.handle('exists', async (_e, p) => fs.existsSync(p));
ipcMain.handle('path-info', async () => ({
  userData: app.getPath('userData'),
  documents: app.getPath('documents'),
  sep: path.sep,
}));
ipcMain.handle('launch-file', async () => { const f = pendingOpen; pendingOpen = null; return f; });
ipcMain.handle('set-title', async (_e, t) => { if (win) win.setTitle(t); });
ipcMain.handle('show-in-folder', async (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('toggle-devtools', async () => win && win.webContents.toggleDevTools());
ipcMain.handle('toggle-fullscreen', async () => win && win.setFullScreen(!win.isFullScreen()));
ipcMain.handle('close-ready', async () => { allowClose = true; if (win) win.close(); });
