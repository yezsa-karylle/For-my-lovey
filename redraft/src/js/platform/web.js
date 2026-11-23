// Browser / PWA implementation of the small `window.api` surface that the
// Electron preload provides. Paths are virtual:
//   file:<n>/<name>   a File the user picked (or dropped)
//   idb:<projectId>   a project autosaved in IndexedDB
//   download:<name>   an export: offered through the share sheet / download
if (!window.api) {
  const files = new Map();
  let seq = 0;
  const register = (f) => { const id = ++seq; files.set(String(id), f); return `file:${id}/${f.name}`; };
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ---------------------------------------------------------------- IndexedDB
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('redraft', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'key' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('projects', mode);
      const req = fn(t.objectStore('projects'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage aborted (is the device full?)'));
    });
  };

  // ---------------------------------------------------------------- picking files
  function pick(accept, multiple = true) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = multiple;
      if (accept) inp.accept = accept;
      inp.style.display = 'none';
      document.body.appendChild(inp);
      const done = (list) => { inp.remove(); resolve(list); };
      inp.addEventListener('change', () => done([...inp.files]));
      inp.addEventListener('cancel', () => done([]));
      inp.click();
    });
  }

  // ---------------------------------------------------------------- exports
  const MIME = { pdf: 'application/pdf', png: 'image/png', mp4: 'video/mp4', webm: 'video/webm', redraft: 'application/zip' };
  function offerFile(name, bytes) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const file = new File([bytes], name, { type: MIME[ext] || 'application/octet-stream' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal"><h2>Ready to save</h2>
      <p class="sub"></p>
      <div class="actions">
        <button class="btn outline" data-close>Close</button>
        ${canShare ? '<button class="btn outline" data-dl>Download</button><button class="btn primary" data-share>Share / Save to Files</button>' : '<button class="btn primary" data-dl>Download</button>'}
      </div></div>`;
    back.querySelector('.sub').textContent = `${name} · ${(bytes.length / 1e6).toFixed(1)} MB`;
    document.getElementById('modal-root').appendChild(back);
    const close = () => back.remove();
    back.querySelector('[data-close]').onclick = close;
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    back.querySelector('[data-dl]').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      close();
    };
    const sh = back.querySelector('[data-share]');
    if (sh) sh.onclick = async () => { try { await navigator.share({ files: [file], title: name }); close(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); } };
    window.__lastOffer = { name, size: bytes.length };
  }

  window.api = {
    web: true,
    isIOS,
    async openDialog(kind) {
      // iOS greys out unknown types such as .redraft when filtering, so don't filter there.
      const accept = isIOS && kind !== 'import' ? '' : kind === 'project' ? '.redraft' : kind === 'import' ? 'application/pdf,image/*' : 'application/pdf,image/*,.redraft';
      return (await pick(accept)).map(register);
    },
    async saveDialog(_kind, defaultPath) { return 'download:' + String(defaultPath).split(/[\\/]/).pop(); },
    async readFile(p) {
      if (p.startsWith('file:')) {
        const f = files.get(p.slice(5).split('/')[0]);
        if (!f) throw new Error('File is no longer available');
        return new Uint8Array(await f.arrayBuffer());
      }
      if (p.startsWith('idb:')) {
        const rec = await tx('readonly', (s) => s.get(p));
        if (!rec) throw new Error('Project not found in this browser');
        return rec.bytes;
      }
      throw new Error('Cannot read ' + p);
    },
    async writeFile(p, data, meta = {}) {
      if (p.startsWith('idb:')) {
        await tx('readwrite', (s) => s.put({ key: p, bytes: data, title: meta.title || 'Untitled', pages: meta.pages || 0, updated: Date.now() }));
        return true;
      }
      if (p.startsWith('download:')) { offerFile(p.slice(9), data); return true; }
      throw new Error('Cannot write ' + p);
    },
    async exists(p) {
      if (p.startsWith('idb:')) return !!(await tx('readonly', (s) => s.getKey(p)));
      return p.startsWith('file:');
    },
    async listProjects() {
      const all = (await tx('readonly', (s) => s.getAll())) || [];
      return all.map(({ key, title, pages, updated, bytes }) => ({ path: key, title, pages, updated, size: bytes?.length || 0 })).sort((a, b) => b.updated - a.updated);
    },
    async deleteProject(p) { await tx('readwrite', (s) => s.delete(p)); },
    async pathInfo() { return { web: true, userData: 'idb:', documents: '', sep: '/' }; },
    async launchFile() { return null; },
    async setTitle(t) { document.title = t; },
    async showInFolder() {},
    async toggleDevtools() {},
    async toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    },
    async closeReady() {},
    onCloseRequest(cb) {
      // Flush autosave whenever the app goes to the background (iOS may never "close" it).
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cb(); });
      window.addEventListener('pagehide', () => cb());
    },
    pathForFile: (f) => register(f),
    onOpenPath() {},
  };

  // Keep the app's data even under storage pressure (granted automatically for Home Screen apps).
  navigator.storage?.persist?.().catch(() => {});

  // Offline support / installability.
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch((e) => console.warn('SW', e)));
  }
  // Stop Safari's own page pinch-zoom; the canvas handles pinch itself.
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
