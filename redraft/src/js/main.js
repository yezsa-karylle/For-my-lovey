// App shell: file handling, autosave, export dialogs and keyboard shortcuts.
import { Editor, defaultSettings, PAINT_TOOLS } from './editor.js';
import { Panels, TOOLS } from './ui/panels.js';
import { icon } from './ui/icons.js';
import { $, $$, h, esc, toast, modal, closeModal, isModalOpen, progressModal, confirmDialog, initTooltips } from './ui/dialogs.js';
import { closePicker } from './ui/colorpicker.js';
import { importFile, extOf, baseName } from './io/importer.js';
import { serializeProject, loadProject } from './io/projectFile.js';
import { exportPdf, exportPng } from './io/exporter.js';
import { exportReplayMp4, ReplayEngine, pickCodec } from './io/replay.js';
import { analyzePage, rebuildOp } from './io/rebuild.js';
import { loadHandFonts, resetHandCache } from './render/hand.js';
import { openPlayer, playerOpen } from './ui/player.js';
import { newProject, newGridPage, clone, uid } from './core/model.js';
import { resetTextCache } from './render/draw.js';
void ReplayEngine;

const api = window.api;

const app = {
  path: null, // project file on disk
  autosavePath: false, // true when saving to the app's autosave folder
  dirty: false,
  saving: false,
  saveAgain: false,
  lastError: null,
  info: null,
};

const editor = new Editor($('#view'), $('#stage'));
window.__editor = editor; // handy for debugging & tests
window.__app = app;

// ------------------------------------------------------------ settings & theme
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('redraft.settings') || '{}');
    const d = defaultSettings();
    if (typeof s.stabilizer === 'number') d.stabilizer = s.stabilizer;
    if (s.markUnsure === false) d.markUnsure = false;
    for (const t of Object.keys(d.tools)) Object.assign(d.tools[t], (s.tools || {})[t] || {});
    editor.settings = d;
  } catch { /* defaults */ }
}
app.saveSettings = () => {
  try { localStorage.setItem('redraft.settings', JSON.stringify(editor.settings)); } catch { /* ignore */ }
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const css = getComputedStyle(document.documentElement);
  editor.workspaceColor = css.getPropertyValue('--workspace').trim();
  editor.accent = css.getPropertyValue('--accent').trim();
  $('#theme-icon').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  try { localStorage.setItem('redraft.theme', theme); } catch { /* ignore */ }
  editor.requestRender();
}
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// ------------------------------------------------------------ recent files
function recentList() { try { return JSON.parse(localStorage.getItem('redraft.recent') || '[]'); } catch { return []; } }
function addRecent(path, title) {
  if (!path || app.autosavePath) return;
  const list = recentList().filter((r) => r.path !== path);
  list.unshift({ path, title, t: Date.now() });
  localStorage.setItem('redraft.recent', JSON.stringify(list.slice(0, 8)));
}
function renderRecent() {
  const list = recentList();
  const el = $('#recent');
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<h4>Recent projects</h4>';
  for (const r of list) {
    const b = h(`<button><span>${esc(r.title || baseName(r.path))}</span><span class="path">${esc(r.path)}</span></button>`);
    b.onclick = async () => {
      if (!(await api.exists(r.path))) {
        localStorage.setItem('redraft.recent', JSON.stringify(recentList().filter((x) => x.path !== r.path)));
        renderRecent();
        toast('That file was moved or deleted');
        return;
      }
      openPaths([r.path]);
    };
    el.appendChild(b);
  }
}

// ------------------------------------------------------------ document lifecycle
function setDoc(project, assets, bitmaps, path, autosavePath = false) {
  app.path = path;
  app.autosavePath = autosavePath;
  app.dirty = false;
  editor.load(project, assets, bitmaps);
  $('#app').classList.remove('no-doc');
  panels.refreshAll();
  updateTitle();
  updateStatus();
  setSaveState(autosavePath ? 'Autosaved (not yet named)' : 'Saved');
}

function updateTitle() {
  const p = editor.project;
  $('#doc-title').textContent = p ? p.title : '';
  api.setTitle(p ? `${p.title} — Redraft` : 'Redraft');
  $('#st-path').textContent = app.path && !app.autosavePath ? app.path : app.autosavePath ? 'Autosaving to app folder — press Ctrl+S to choose a location' : '';
}

function setSaveState(text, err = false) {
  const el = $('#save-state');
  el.textContent = text;
  el.classList.toggle('err', err);
}

async function uniquePath(dir, base, ext) {
  let p = `${dir}${app.info.sep}${base}.${ext}`;
  for (let i = 2; await api.exists(p); i++) p = `${dir}${app.info.sep}${base} (${i}).${ext}`;
  return p;
}
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));

async function confirmLeave() {
  if (!editor.project) return true;
  if (app.dirty) await saveNow();
  return true;
}

async function openPaths(paths) {
  if (!paths || !paths.length) return;
  closeModal();
  const proj = paths.find((p) => extOf(p) === 'redraft');
  if (proj) return openProjectFile(proj);
  if (!(await confirmLeave())) return;
  const pr = progressModal('Opening notes');
  try {
    const project = newProject(baseName(paths[0]));
    const assets = new Map(), bitmaps = new Map();
    for (const [i, path] of paths.entries()) {
      const bytes = await api.readFile(path);
      const res = await importFile(path, bytes, (d, t, label) => pr.set(d, t, paths.length > 1 ? `File ${i + 1}/${paths.length}: ${label}` : label));
      project.pages.push(...res.pages);
      res.assets.forEach((v, k) => assets.set(k, v));
      res.bitmaps.forEach((v, k) => bitmaps.set(k, v));
    }
    project.initial = { pages: clone(project.pages) };
    const target = await uniquePath(dirOf(paths[0]), baseName(paths[0]), 'redraft');
    pr.close();
    setDoc(project, assets, bitmaps, target);
    app.dirty = true;
    await saveNow();
    addRecent(target, project.title);
    toast(`Opened ${project.pages.length} page${project.pages.length > 1 ? 's' : ''}. Autosaving to ${baseName(target)}.redraft next to your file.`, { ms: 4500 });
    if (!app.noRebuildPrompt) offerRebuild();
  } catch (e) {
    pr.close();
    console.error(e);
    toast('Could not open file: ' + e.message, { ms: 5000 });
  }
}

async function openProjectFile(path) {
  if (!(await confirmLeave())) return;
  const pr = progressModal('Opening project');
  try {
    const { project, assets } = await loadProject(await api.readFile(path));
    pr.close();
    setDoc(project, assets, new Map(), path);
    addRecent(path, project.title);
  } catch (e) {
    pr.close();
    console.error(e);
    toast('Could not open project: ' + e.message, { ms: 5000 });
  }
}

async function newNotebook() {
  if (!(await confirmLeave())) return;
  const project = newProject('Grid notebook');
  project.pages.push(newGridPage(200));
  project.initial = { pages: clone(project.pages) };
  const p = `${app.info.userData}${app.info.sep}Autosave${app.info.sep}${project.id}.redraft`;
  setDoc(project, new Map(), new Map(), p, true);
  app.dirty = true;
  saveSoon();
}

async function insertFiles() {
  if (!editor.project) return;
  const paths = await api.openDialog('import');
  if (!paths.length) return;
  const pr = progressModal('Inserting pages');
  try {
    const ops = [];
    let at = editor.pageIndex + 1;
    for (const path of paths) {
      const res = await importFile(path, await api.readFile(path), (d, t, l) => pr.set(d, t, l));
      res.assets.forEach((v, k) => editor.assets.set(k, v));
      res.bitmaps.forEach((v, k) => editor.bitmaps.set(k, v));
      for (const page of res.pages) ops.push({ type: 'insPage', pageData: page, index: at++ });
    }
    pr.close();
    editor.commit(ops.length === 1 ? ops[0] : { type: 'batch', ops });
    editor.setPage(editor.pageIndex + 1, true);
    toast(`Inserted ${ops.length} page${ops.length > 1 ? 's' : ''}`);
  } catch (e) {
    pr.close();
    toast('Could not insert: ' + e.message, { ms: 5000 });
  }
}

// ------------------------------------------------------------ saving
app.markDirty = () => { app.dirty = true; saveSoon(); };

let saveTimer = 0;
function saveSoon(ms = 1500) {
  if (!editor.project) return;
  setSaveState('Unsaved changes');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, ms);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!editor.project || !app.path) return;
  if (app.saving) { app.saveAgain = true; return app.savePromise; }
  app.saving = true;
  app.dirty = false;
  setSaveState('Saving…');
  app.savePromise = (async () => {
    try {
      const bytes = await serializeProject(editor.project, editor.assets);
      await api.writeFile(app.path, bytes);
      app.lastError = null;
      setSaveState(app.autosavePath ? 'Autosaved (not yet named)' : 'Saved');
    } catch (e) {
      console.error(e);
      app.dirty = true;
      app.lastError = e;
      setSaveState('Save failed — ' + e.message, true);
    } finally {
      app.saving = false;
      if (app.saveAgain) { app.saveAgain = false; await saveNow(); }
    }
  })();
  return app.savePromise;
}

async function saveAs() {
  if (!editor.project) return;
  const def = app.path && !app.autosavePath ? app.path : `${app.info.documents}${app.info.sep}${editor.project.title}.redraft`;
  const p = await api.saveDialog('project', def);
  if (!p) return;
  app.path = p.endsWith('.redraft') ? p : p + '.redraft';
  app.autosavePath = false;
  editor.project.title = baseName(app.path);
  updateTitle();
  app.dirty = true;
  await saveNow();
  addRecent(app.path, editor.project.title);
  toast('Saved. Future changes autosave here.');
}

async function save() {
  if (!editor.project) return;
  if (app.autosavePath) return saveAs();
  await saveNow();
  toast('Saved');
}

// ------------------------------------------------------------ export
function exportBase() { return app.path && !app.autosavePath ? dirOf(app.path) + app.info.sep + editor.project.title : `${app.info.documents}${app.info.sep}${editor.project.title}`; }

function exportDialog(kind) {
  if (!editor.project) return;
  const isPdf = kind === 'pdf';
  const m = modal(`<h2>${isPdf ? 'Export PDF' : 'Export PNG'}</h2>
    <p class="sub">Strokes and text are re-drawn at the export resolution, so they stay sharp in print.</p>
    <div class="row"><label>Pages</label><div class="seg" data-pages>
      <button data-v="all" class="${isPdf || kind === 'pngAll' ? 'on' : ''}">All ${editor.project.pages.length}</button><button data-v="current" class="${!isPdf && kind !== 'pngAll' ? 'on' : ''}">This page</button></div></div>
    <div class="row"><label>Quality</label><div class="seg" data-dpi>
      <button data-v="150">150 dpi</button><button data-v="300" class="on">300 dpi (print)</button><button data-v="600">600 dpi</button></div></div>
    <div class="actions"><button class="btn outline" data-cancel>Cancel</button><button class="btn primary" data-go>${icon('download')}Export</button></div>`);
  m.el.querySelectorAll('.seg').forEach((sg) => sg.querySelectorAll('button').forEach((b) => (b.onclick = () => { sg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); })));
  m.el.querySelector('[data-cancel]').onclick = () => m.close();
  m.el.querySelector('[data-go]').onclick = async () => {
    const which = m.el.querySelector('[data-pages] .on').dataset.v;
    const dpi = +m.el.querySelector('[data-dpi] .on').dataset.v;
    m.close();
    const pages = which === 'all' ? editor.project.pages : [editor.page];
    if (isPdf) await doExportPdf(pages, dpi);
    else await doExportPng(pages, dpi);
  };
}

async function doExportPdf(pages, dpi, target) {
  const p = target || (await api.saveDialog('pdf', exportBase() + '.pdf'));
  if (!p) return;
  const pr = progressModal('Exporting PDF');
  try {
    const bytes = await exportPdf(editor, pages, { dpi, onProgress: (d, t, l) => pr.set(d, t, l) });
    await api.writeFile(p, bytes);
    pr.close();
    toast('PDF exported', { action: { label: 'Show in folder', run: () => api.showInFolder(p) } });
  } catch (e) {
    pr.close();
    console.error(e);
    toast('Export failed: ' + e.message, { ms: 5000 });
  }
}

async function doExportPng(pages, dpi, target) {
  const single = pages.length === 1;
  const idx = (pg) => editor.project.pages.indexOf(pg) + 1;
  const def = exportBase() + (single ? `-p${idx(pages[0])}` : '') + '.png';
  const p = target || (await api.saveDialog('png', def));
  if (!p) return;
  const pr = progressModal('Exporting PNG');
  try {
    const stem = p.replace(/\.png$/i, '');
    for (const [i, page] of pages.entries()) {
      pr.set(i, pages.length, `Rendering page ${idx(page)}`);
      const bytes = await exportPng(editor, page, { dpi });
      await api.writeFile(single ? (p.endsWith('.png') ? p : p + '.png') : `${stem}-p${String(idx(page)).padStart(2, '0')}.png`, bytes);
    }
    pr.close();
    toast(single ? 'PNG exported' : `${pages.length} PNGs exported`, { action: { label: 'Show in folder', run: () => api.showInFolder(p) } });
  } catch (e) {
    pr.close();
    console.error(e);
    toast('Export failed: ' + e.message, { ms: 5000 });
  }
}

// ------------------------------------------------------------ make editable (rebuild)
async function offerRebuild() {
  const n = editor.project.pages.filter((p) => p.bg.kind === 'image').length;
  if (!n) return;
  const ok = await confirmDialog('Make these notes editable?',
    `Redraft can read the ${n} page${n > 1 ? 's' : ''} (OCR) and rebuild ${n > 1 ? 'them' : 'it'} as live objects: grid paper, every text line in the same handwriting font and colour, highlights, dashed boxes and sketches. It takes about 10–20 seconds per page. You can also do this later, page by page, with "Make editable".`,
    n > 1 ? `Rebuild all ${n} pages` : 'Rebuild page');
  if (ok) await rebuildPages(editor.project.pages);
}

async function rebuildPages(pages, { quiet = false } = {}) {
  const todo = pages.filter((p) => p.bg.kind === 'image' || (p.ref && !p.rebuilt));
  if (!todo.length) { if (!quiet) toast(pages.length === 1 && pages[0].rebuilt ? 'This page is already editable' : 'No scanned pages to rebuild'); return []; }
  const pr = progressModal('Making notes editable');
  pr.cancellable();
  const stats = [];
  try {
    for (const [k, page] of todo.entries()) {
      if (pr.cancelled) break;
      const no = editor.project.pages.indexOf(page) + 1;
      const bmp = await editor.scanBitmap(page);
      const res = await analyzePage(bmp, page.w, page.h, {
        onProgress: (label) => pr.set(k + 0.5, todo.length, `Page ${no}: ${label}`),
        textItems: page.pdfText || null,
      });
      const live = editor.project.pages.find((p) => p.id === page.id);
      editor.commit(rebuildOp(live, res), { rebuild: true, page: page.id });
      stats.push({ page: no, ...res.stats });
      pr.set(k + 1, todo.length, `Page ${no} done`);
    }
  } catch (e) {
    console.error(e);
    toast('Rebuild failed: ' + e.message, { ms: 6000 });
  } finally {
    pr.close();
  }
  if (stats.length) {
    editor.caches.clear();
    const textLayer = editor.page.layers.find((l) => l.name === 'Text');
    if (textLayer) editor.setActiveLayer(textLayer.id);
    editor.requestRender();
    panels.refreshAll();
    if (!quiet) toast(`Rebuilt ${stats.length} page${stats.length > 1 ? 's' : ''}: ${stats.reduce((s, x) => s + x.text, 0)} text lines, ${stats.reduce((s, x) => s + x.highlights, 0)} highlights, ${stats.reduce((s, x) => s + x.lines + x.sketches, 0)} lines & sketches. Show "Original scan (compare)" in Layers to check.`, { ms: 7000 });
  }
  return stats;
}
app.rebuildPages = rebuildPages;

// ------------------------------------------------------------ replay
function openReplay() {
  if (!editor.project) return;
  closeModal();
  openPlayer(editor, app);
}

app.replayExportDialog = ({ pageId = editor.page.id, mode = 'auto', speed = 8 } = {}) => {
  const speeds = [1, 2, 4, 8, 16];
  const m = modal(`<h2>Export replay video</h2>
    <p class="sub">MP4, 1080p at 30 frames per second, in fast forward.</p>
    <div class="row"><label>Pages</label><div class="seg" data-pages><button data-v="one" class="on">This page</button><button data-v="all">All ${editor.project.pages.length} pages</button></div></div>
    <div class="row"><label>Content</label><div class="seg" data-mode><button data-v="auto" class="${mode === 'auto' ? 'on' : ''}">Write the page</button><button data-v="history" class="${mode === 'history' ? 'on' : ''}">Page + my edits</button></div></div>
    <div class="row"><label>Format</label><div class="seg" data-format><button data-v="landscape" class="on">1920×1080 · follow pen</button><button data-v="portrait">1080×1920 · whole page</button></div></div>
    <div class="row"><label>Speed</label><div class="seg" data-speed>${speeds.map((x) => `<button data-v="${x}" class="${x === speed ? 'on' : ''}">${x}×</button>`).join('')}</div></div>
    <p class="hint" data-est></p>
    <div class="actions"><button class="btn outline" data-cancel>Cancel</button><button class="btn primary" data-go>${icon('play')}Export MP4</button></div>`);
  const val = (k) => m.el.querySelector(`[data-${k}] .on`).dataset.v;
  const est = () => {
    const ids = val('pages') === 'all' ? editor.project.pages.map((p) => p.id) : [pageId];
    const total = ids.reduce((s, id) => s + new ReplayEngine(editor, id, { mode: val('mode') }).duration, 0);
    m.el.querySelector('[data-est]').textContent = `Video length about ${Math.max(1, Math.round(total / +val('speed') / 1000))} s (${Math.round(total / 60000)} min of writing at 1×).`;
  };
  m.el.querySelectorAll('.seg').forEach((sg) => sg.querySelectorAll('button').forEach((b) => (b.onclick = () => { sg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); est(); })));
  est();
  m.el.querySelector('[data-cancel]').onclick = () => m.close();
  m.el.querySelector('[data-go]').onclick = async () => {
    const opts = { pageIds: val('pages') === 'all' ? editor.project.pages.map((p) => p.id) : [pageId], mode: val('mode'), speed: +val('speed'), format: val('format') };
    m.close();
    await doExportReplay(opts);
  };
};

async function doExportReplay(opts, target) {
  const p = target || (await api.saveDialog('mp4', exportBase() + ' replay.mp4'));
  if (!p) return null;
  const pr = progressModal('Rendering replay video');
  pr.cancellable();
  try {
    const res = await exportReplayMp4(editor, opts.pageIds || [editor.page.id], {
      ...opts,
      onProgress: (d, t) => pr.set(d, t, `Frame ${d} of ${t}`),
      isCancelled: () => pr.cancelled,
    });
    await api.writeFile(p, res.bytes);
    pr.close();
    toast(`Replay saved (${Math.round(res.seconds)} s, ${res.width}×${res.height})`, { action: { label: 'Show in folder', run: () => api.showInFolder(p) } });
    return res;
  } catch (e) {
    pr.close();
    if (e.message !== 'cancelled') { console.error(e); toast('Replay failed: ' + e.message, { ms: 6000 }); }
    return null;
  }
}

// ------------------------------------------------------------ pages
function addGridPage() {
  if (!editor.project) return;
  const like = editor.page;
  const page = newGridPage(200, like && like.bg.kind === 'grid' ? like : null);
  if (like && like.bg.kind === 'image') { page.w = like.w; page.h = like.h; page.dpi = like.dpi; page.grid = clone(like.grid); }
  editor.commit({ type: 'insPage', pageData: page, index: editor.pageIndex + 1 });
  editor.setPage(editor.pageIndex + 1, true);
}

function duplicatePage() {
  if (!editor.project) return;
  const copy = clone(editor.page);
  copy.id = uid('p');
  copy.layers.forEach((l) => { l.id = uid('l'); l.objects.forEach((o) => { o.id = uid(o.type === 'text' ? 't' : 's'); }); });
  editor.commit({ type: 'insPage', pageData: copy, index: editor.pageIndex + 1 });
  editor.setPage(editor.pageIndex + 1, true);
  toast('Page duplicated');
}

async function deletePage() {
  if (!editor.project) return;
  if (editor.project.pages.length <= 1) { toast('A project needs at least one page'); return; }
  const i = editor.pageIndex;
  editor.commit({ type: 'delPage', pageData: clone(editor.page), index: i });
  editor.setPage(Math.min(i, editor.project.pages.length - 1), true);
  toast('Page deleted', { action: { label: 'Undo', run: () => editor.undo() } });
}

app.movePage = (from, to) => {
  editor.commit({ type: 'movePage', from, to });
  editor.setPage(to);
};

app.pageMenu = (x, y) => {
  document.querySelector('.ctx-menu')?.remove();
  const m = h(`<div class="menu open ctx-menu" style="position:fixed;left:${x}px;top:${y}px">
    <button data-c="addGridPage">${icon('grid')}New grid page after</button>
    <button data-c="duplicatePage">${icon('dup')}Duplicate</button>
    <button data-c="up">${icon('up')}Move up</button>
    <button data-c="down">${icon('down')}Move down</button>
    <hr><button data-c="deletePage" style="color:var(--danger)">${icon('trash')}Delete page</button></div>`);
  document.body.appendChild(m);
  m.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    m.remove();
    const c = b.dataset.c;
    const i = editor.pageIndex;
    if (c === 'up' && i > 0) app.movePage(i, i - 1);
    else if (c === 'down' && i < editor.project.pages.length - 1) app.movePage(i, i + 1);
    else if (commands[c]) commands[c]();
  }));
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!m.contains(e.target)) m.remove(); }, { once: true }), 0);
};

// ------------------------------------------------------------ help
const SHORTCUTS = [
  ['Tools', [['Pen', 'P'], ['Pencil', 'N'], ['Marker', 'M'], ['Highlighter', 'H'], ['Eraser (press again: brush / whole stroke)', 'E'], ['Cover & rewrite (again: brush / box)', 'W'], ['Text', 'T'], ['Lasso select', 'L or S'], ['Eyedropper', 'I'], ['Pick colour with any brush', 'Alt + click'], ['Ruler on/off', 'R'], ['Colour picker', 'C']]],
  ['Brush', [['Smaller / bigger', '[  ]'], ['Less / more opacity', 'Shift + [  ]'], ['Swatch 1–9', '1 … 9'], ['Straight line', 'Shift + drag'], ['Snap to shape', 'Hold still at end'], ['Stabilizer weaker / stronger', ', .']]],
  ['Edit', [['Undo', 'Ctrl + Z'], ['Redo', 'Ctrl + Y / Ctrl + Shift + Z'], ['Select all on layer', 'Ctrl + A'], ['Copy / Cut / Paste', 'Ctrl + C / X / V'], ['Duplicate selection', 'Ctrl + D'], ['Delete selection', 'Del'], ['Nudge selection', 'Arrows (Shift = ×10)'], ['Deselect / finish text', 'Esc']]],
  ['View', [['Pan', 'Space + drag, scroll, middle-drag'], ['Zoom', 'Ctrl + scroll, pinch'], ['Zoom in / out', 'Ctrl + = / Ctrl + −'], ['Fit page', 'Ctrl + 0'], ['Actual size', 'Ctrl + 1'], ['Fit width', 'Ctrl + 2'], ['Hide panels', 'Tab'], ['Full screen', 'F11'], ['Dark / light', 'Ctrl + Shift + L']]],
  ['Pages & layers', [['Next / previous page', 'PgDn / PgUp'], ['First / last page', 'Home / End'], ['New grid page', 'Ctrl + N'], ['Duplicate page', 'Ctrl + Shift + D'], ['Delete page', 'Ctrl + Shift + Del'], ['New layer', 'Ctrl + Shift + N'], ['Layer up / down', 'Ctrl + ] / Ctrl + ['], ['Show / hide scan', 'Shift + B']]],
  ['File', [['Open', 'Ctrl + O'], ['Insert PDF/image pages', 'Ctrl + Shift + O'], ['Save', 'Ctrl + S'], ['Save as', 'Ctrl + Shift + S'], ['Export PDF', 'Ctrl + E'], ['Export PNG', 'Ctrl + Shift + E'], ['Replay (watch, scrub, export MP4)', 'Ctrl + Shift + R'], ['Make page editable (OCR)', 'Ctrl + Shift + T'], ['Shortcuts', 'F1 or ?']]],
];
function showHelp() {
  modal(`<h2>Keyboard shortcuts</h2><p class="sub">Everything also works with a touchpad: two-finger scroll pans, pinch zooms.</p>
    <div class="shortcuts">${SHORTCUTS.map(([t, rows]) => `<section><h4>${t}</h4>${rows.map(([a, k]) => `<div><span>${esc(a)}</span><span><kbd>${esc(k)}</kbd></span></div>`).join('')}</section>`).join('')}</div>
    <div class="actions"><button class="btn primary" onclick="this.closest('.modal-backdrop').remove()">Got it</button></div>`, { wide: true });
}

// ------------------------------------------------------------ commands
const commands = {
  open: async () => openPaths(await api.openDialog('open')),
  insertFiles,
  newNotebook,
  save,
  saveAs,
  exportPdf: () => exportDialog('pdf'),
  exportPng: () => exportDialog('png'),
  exportPngAll: () => exportDialog('pngAll'),
  exportReplay: () => editor.project && app.replayExportDialog(),
  replay: openReplay,
  rebuildPage: () => editor.project && rebuildPages([editor.page]),
  rebuildAll: () => editor.project && rebuildPages(editor.project.pages),
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  zoomIn: () => editor.zoomAt(1.25),
  zoomOut: () => editor.zoomAt(0.8),
  zoom100: () => editor.page && editor.setZoom(96 / editor.page.dpi),
  fit: () => editor.fit(),
  theme: toggleTheme,
  help: showHelp,
  addGridPage,
  duplicatePage,
  deletePage,
};
app.commands = commands;
app.doExportPdf = doExportPdf;
app.doExportPng = doExportPng;
app.doExportReplay = doExportReplay;
app.saveNow = saveNow;
app.openPaths = openPaths;
app.pickCodec = pickCodec;
app.openReplay = openReplay;

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cmd]');
  if (c && commands[c.dataset.cmd]) { $$('.menu.open').forEach((m) => m.classList.remove('open')); commands[c.dataset.cmd](); return; }
  const mb = e.target.closest('[data-menu]');
  if (mb) { const m = document.getElementById(mb.dataset.menu); const open = !m.classList.contains('open'); $$('.menu.open').forEach((x) => x.classList.remove('open')); m.classList.toggle('open', open); return; }
  if (!e.target.closest('.menu')) $$('.menu.open').forEach((m) => m.classList.remove('open'));
});

// ------------------------------------------------------------ keyboard
const isTyping = (e) => e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');

window.addEventListener('keydown', (e) => {
  if (isTyping(e) || playerOpen()) return;
  // A text box is open but lost focus: send the keys back to it.
  if (editor.textEditor && !e.ctrlKey && !e.metaKey && !/^F\d+$/.test(e.key)) {
    if (e.key === 'Escape') editor.closeTextEditor();
    else editor.refocusText();
    return;
  }
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  const lower = k.length === 1 ? k.toLowerCase() : k;

  if (k === 'F1' || (k === '?' && !ctrl)) { e.preventDefault(); showHelp(); return; }
  if (k === 'F11') { e.preventDefault(); api.toggleFullscreen(); return; }
  if (k === 'F12') { api.toggleDevtools(); return; }
  if (k === 'Escape') {
    if (document.querySelector('.ctx-menu, .menu.open')) { $$('.ctx-menu').forEach((m) => m.remove()); $$('.menu.open').forEach((m) => m.classList.remove('open')); return; }
    if (isModalOpen()) { closeModal(); return; }
    closePicker();
    editor.clearSelection();
    return;
  }
  if (isModalOpen()) return;

  if (ctrl) {
    const map = {
      z: () => (e.shiftKey ? editor.redo() : editor.undo()),
      y: () => editor.redo(),
      o: () => (e.shiftKey ? insertFiles() : commands.open()),
      s: () => (e.shiftKey ? saveAs() : save()),
      e: () => (e.shiftKey ? exportDialog('png') : exportDialog('pdf')),
      r: () => e.shiftKey && openReplay(),
      t: () => e.shiftKey && commands.rebuildPage(),
      n: () => (e.shiftKey ? editor.project && editor.addLayer() : editor.project ? addGridPage() : newNotebook()),
      d: () => (e.shiftKey ? duplicatePage() : editor.duplicateSelection()),
      a: () => editor.selectAll(),
      c: () => editor.copySelection(),
      x: () => editor.copySelection(true),
      v: () => editor.paste(),
      l: () => e.shiftKey && toggleTheme(),
      0: () => editor.fit(),
      1: () => commands.zoom100(),
      2: () => editor.fitWidth(),
      '=': () => editor.zoomAt(1.25), '+': () => editor.zoomAt(1.25),
      '-': () => editor.zoomAt(0.8), _: () => editor.zoomAt(0.8),
      ']': () => editor.layer && editor.moveLayer(editor.activeLayerId, 1),
      '[': () => editor.layer && editor.moveLayer(editor.activeLayerId, -1),
      Delete: () => e.shiftKey && deletePage(),
      Backspace: () => e.shiftKey && deletePage(),
    };
    const fn = map[lower] || map[k];
    if (fn) { e.preventDefault(); if (editor.project || ['o', 'n'].includes(lower) || lower === 'l') fn(); }
    return;
  }
  if (!editor.project) return;

  if (k === ' ') { e.preventDefault(); if (!e.repeat) editor.setSpace(true); return; }
  if (k === 'Tab') { e.preventDefault(); $('#app').classList.toggle('panels-hidden'); return; }
  if (k === 'PageDown') { e.preventDefault(); editor.setPage(editor.pageIndex + 1, true); return; }
  if (k === 'PageUp') { e.preventDefault(); editor.setPage(editor.pageIndex - 1, true); return; }
  if (k === 'Home') { editor.setPage(0, true); return; }
  if (k === 'End') { editor.setPage(editor.project.pages.length - 1, true); return; }
  if ((k === 'Delete' || k === 'Backspace') && editor.selection) { e.preventDefault(); editor.deleteSelection(); return; }
  if (k.startsWith('Arrow') && editor.selection) {
    e.preventDefault();
    const n = e.shiftKey ? 10 : 1;
    editor.nudge(k === 'ArrowLeft' ? -n : k === 'ArrowRight' ? n : 0, k === 'ArrowUp' ? -n : k === 'ArrowDown' ? n : 0);
    return;
  }
  if (e.shiftKey && lower === 'b') { editor.setPageProps({ bgVisible: editor.page.bgVisible === false }); return; }

  const toolKeys = Object.fromEntries(TOOLS.map(([t, key]) => [key.toLowerCase(), t]));
  toolKeys.s = 'lasso';
  if (!e.shiftKey && !e.altKey && toolKeys[lower]) { editor.setTool(toolKeys[lower]); return; }
  if (lower === 'r' && !e.shiftKey) { editor.toggleRuler(); return; }
  if (lower === 'c' && !e.shiftKey) { panels.openColorPicker(panels.swatchNow); return; }

  const t = editor.tool === 'eyedropper' ? editor.prevTool : editor.tool;
  const s = editor.settings.tools[t];
  if (k === '[' || k === ']' || k === '{' || k === '}') {
    if (!s) return;
    const up = k === ']' || k === '}';
    if (e.shiftKey && 'opacity' in s) editor.setToolSetting('opacity', Math.max(0.05, Math.min(1, +(s.opacity + (up ? 0.1 : -0.1)).toFixed(2))));
    else if ('size' in s) editor.setToolSetting('size', Math.max(0.5, Math.min(t === 'text' ? 220 : 300, +(s.size * (up ? 1.2 : 1 / 1.2)).toFixed(1))));
    editor.toast(e.shiftKey ? `Opacity ${Math.round((s.opacity || 1) * 100)}%` : `Size ${s.size}`);
    panels.renderToolCard();
    return;
  }
  if (k === ',' || k === '.') {
    editor.settings.stabilizer = Math.max(0, Math.min(100, editor.settings.stabilizer + (k === '.' ? 10 : -10)));
    editor.toast('Stabilizer ' + editor.settings.stabilizer);
    panels.renderToolCard();
    app.saveSettings();
    return;
  }
  if (/^[1-9]$/.test(k)) {
    const c = editor.project.swatches[+k - 1];
    if (c) { editor.setColor(c); if (!PAINT_TOOLS.includes(editor.tool) && editor.tool !== 'text' && editor.tool !== 'lasso') editor.setTool(PAINT_TOOLS.includes(editor.prevTool) ? editor.prevTool : 'pen'); }
  }
});

window.addEventListener('keyup', (e) => { if (e.key === ' ') editor.setSpace(false); });
window.addEventListener('blur', () => editor.setSpace(false));

// ------------------------------------------------------------ status bar
function updateStatus() {
  const p = editor.project;
  $('#st-page').textContent = p ? `Page ${editor.pageIndex + 1} of ${p.pages.length}` : '';
  const z = editor.page ? Math.round(editor.view.zoom * 100 * (96 / editor.page.dpi)) : 100;
  $('#st-zoom').textContent = p ? `Zoom ${z}%` : '';
  $('#zoom-label').textContent = z + '%';
  const hints = {
    pen: 'Draw. Hold still at the end of a stroke to snap to a shape. Shift = straight line.',
    pencil: 'Textured pencil. Hold still at the end to snap to a shape.',
    marker: 'Solid marker. Hold still at the end to snap to a shape.',
    highlighter: 'See-through highlighter. Shift-drag for a straight highlight.',
    eraser: editor.settings.tools.eraser.mode === 'brush' ? 'Brush eraser: rubs out your ink (never the scan). E toggles whole-stroke mode.' : 'Stroke eraser: touch a stroke to remove all of it. E toggles brush mode.',
    cover: 'Paint grid paper over old writing, then write on top. W toggles brush / box.',
    text: 'Click to type. Click text to edit, drag to move.',
    lasso: 'Loop around strokes or text to select. Drag to move, corners to scale, knob to rotate.',
    eyedropper: 'Click to pick a colour from the page.',
  };
  $('#st-hint').textContent = p ? hints[editor.tool] || '' : '';
  const canUndo = !!editor.history?.canUndo, canRedo = !!editor.history?.canRedo;
  $('[data-cmd=undo]').disabled = !canUndo;
  $('[data-cmd=redo]').disabled = !canRedo;
}

// ------------------------------------------------------------ boot
loadSettings();
const panels = new Panels(editor, app);
app.panels = panels;
document.querySelectorAll('[data-icon]').forEach((el) => { if (el.id || el.className) el.innerHTML = icon(el.dataset.icon); else el.outerHTML = icon(el.dataset.icon); });
applyTheme(localStorage.getItem('redraft.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
initTooltips();

editor.on('toast', (m) => toast(m));
editor.on('view', updateStatus);
editor.on('page', updateStatus);
editor.on('tool', () => { updateStatus(); app.saveSettings(); });
editor.on('settings', () => { clearTimeout(app._st); app._st = setTimeout(app.saveSettings, 500); });
editor.on('doc', (d) => { updateStatus(); if (d.kind !== 'load') { app.dirty = true; saveSoon(); } });
editor.setTool('pen');

// Drag & drop files.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (editor.project && !paths.some((p) => extOf(p) === 'redraft')) {
    confirmDialog('Add these pages?', 'Insert the dropped files as new pages after the current page, or open them as a new project.', 'Insert pages').then(async (ok) => {
      if (ok) {
        const orig = api.openDialog;
        api.openDialog = async () => paths;
        try { await insertFiles(); } finally { api.openDialog = orig; }
      } else openPaths(paths);
    });
  } else openPaths(paths);
});

api.onCloseRequest(async () => {
  try {
    editor.closeTextEditor();
    if (app.dirty || app.saving) await saveNow();
    if (app.saving) await app.savePromise;
  } finally {
    api.closeReady();
  }
});
api.onOpenPath((p) => openPaths([p]));

(async () => {
  app.info = await api.pathInfo();
  renderRecent();
  // Fonts load lazily; re-measure text once they're ready.
  const fams = ['Caveat', 'Patrick Hand', 'Kalam', 'Architects Daughter', 'Indie Flower', 'Gaegu'];
  await Promise.allSettled([...fams.flatMap((f) => [300, 400, 700].map((w) => document.fonts.load(`${w} 40px "${f}"`))), loadHandFonts()]);
  resetTextCache();
  resetHandCache();
  editor.invalidateAll();
  editor.requestRender();
  const f = await api.launchFile();
  if (f) openPaths([f]);
  window.__ready = true;
})();
