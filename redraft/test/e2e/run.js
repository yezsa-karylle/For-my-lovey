// End-to-end test: launches the real Electron app and drives it with the
// mouse and keyboard. Run with:  npm run test:e2e   (on Linux CI: xvfb-run -a npm run test:e2e)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import assert from 'assert/strict';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const { PDFDocument, rgb } = require('pdf-lib');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- fixture PDF
async function makeSamplePdf(file) {
  const pdf = await PDFDocument.create();
  const mm = 72 / 25.4;
  for (let n = 0; n < 2; n++) {
    const page = pdf.addPage([210 * mm, 297 * mm]);
    const { width, height } = page.getSize();
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.985, 0.98, 0.96) });
    for (let x = 0; x <= width; x += 5 * mm) page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: 0.5, color: rgb(0.72, 0.8, 0.88) });
    for (let y = 0; y <= height; y += 5 * mm) page.drawLine({ start: { x: 0, y }, end: { x: width, y }, thickness: 0.5, color: rgb(0.72, 0.8, 0.88) });
    // Two columns of "handwriting".
    for (const col of [15, 110]) {
      for (let row = 0; row < 18; row++) {
        const y = height - (25 + row * 14) * mm;
        let x = col * mm;
        page.drawLine({ start: { x, y }, end: { x: x + (40 + (row * 7) % 40) * mm, y: y + 1 }, thickness: 1.6, color: rgb(0.1, 0.1, 0.15) });
      }
    }
    page.drawText(`Page ${n + 1} - Structures`, { x: 15 * mm, y: height - 15 * mm, size: 16, color: rgb(0.1, 0.1, 0.4) });
  }
  fs.writeFileSync(file, await pdf.save());
}

// ---------------------------------------------------------------- helpers
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(['ok', name]);
    console.log(`ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push(['FAIL', name]);
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 4).join('\n     ')}`);
  }
}

const samplePdf = path.join(out, 'sample-notes.pdf');
await makeSamplePdf(samplePdf);

const electronApp = await _electron.launch({
  args: [root, '--no-sandbox'],
  env: { ...process.env, REDRAFT_MAXIMIZE: '0', REDRAFT_USER_DATA: path.join(out, 'user-data') },
});
const win = await electronApp.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await electronApp.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 920); });
await win.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

/** Make the next native open/save dialog return `p`. */
async function stubDialogs({ open, save } = {}) {
  await electronApp.evaluate(({ dialog }, { open, save }) => {
    if (open) dialog.showOpenDialog = async () => ({ canceled: false, filePaths: open });
    if (save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: save });
  }, { open, save });
}

const ed = (fn, arg) => win.evaluate(fn, arg);
const objCount = () => ed(() => window.__editor.layer.objects.length);
const lastObj = () => ed(() => { const o = window.__editor.layer.objects; return o[o.length - 1]; });

async function toScreen(px, py) {
  return ed(([x, y]) => {
    const e = window.__editor;
    const r = e.canvas.getBoundingClientRect();
    const s = e.toScreen([x, y]);
    return [r.left + s[0], r.top + s[1]];
  }, [px, py]);
}

/** Drag the mouse through page-coordinate points with human-ish jitter. */
async function drawPath(pts, { jitter = 1.5, hold = 0, steps = 4 } = {}) {
  const sp = [];
  for (const p of pts) sp.push(await toScreen(p[0], p[1]));
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * jitter;
  const sent = [sp[0]];
  await win.mouse.move(sp[0][0], sp[0][1]);
  await win.mouse.down();
  for (let i = 1; i < sp.length; i++) {
    for (let k = 1; k <= steps; k++) {
      const x = sp[i - 1][0] + ((sp[i][0] - sp[i - 1][0]) * k) / steps + rnd();
      const y = sp[i - 1][1] + ((sp[i][1] - sp[i - 1][1]) * k) / steps + rnd();
      sent.push([x, y]);
      await win.mouse.move(x, y);
      await win.waitForTimeout(8);
    }
  }
  const last = sp[sp.length - 1];
  await win.mouse.move(last[0], last[1]);
  if (hold) await win.waitForTimeout(hold);
  await win.mouse.up();
  await win.waitForTimeout(60);
  return sent;
}

/** Mean turning angle per unit length: how wobbly a polyline is, independent of point spacing. */
function wobble(pts) {
  let turn = 0, len = 0;
  for (let i = 2; i < pts.length; i++) {
    const a = Math.atan2(pts[i - 1][1] - pts[i - 2][1], pts[i - 1][0] - pts[i - 2][0]);
    const b = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    turn += d;
  }
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return turn / len;
}

const shot = (name) => win.screenshot({ path: path.join(out, name + '.png') });

// ---------------------------------------------------------------- tests
await step('opens a scanned PDF: each page gets a locked scan background + grid detection', async () => {
  await stubDialogs({ open: [samplePdf] });
  await ed(() => window.__app.commands.open());
  await win.waitForFunction(() => window.__editor.project && window.__editor.project.pages.length === 2 && window.__app.path, null, { timeout: 30000 });
  const info = await ed(() => { const p = window.__editor.page; return { bg: p.bg.kind, layers: p.layers.length, grid: p.grid, detected: p.gridDetected, dpi: p.dpi, path: window.__app.path }; });
  assert.equal(info.bg, 'image');
  assert.equal(info.layers, 1);
  assert.ok(info.detected, 'grid detected');
  const expected = (5 / 25.4) * info.dpi;
  assert.ok(Math.abs(info.grid.sx - expected) < 1.5, `grid spacing ${info.grid.sx} vs ${expected}`);
  assert.ok(info.path.endsWith('sample-notes.redraft'));
  await win.waitForTimeout(1600);
  assert.ok(fs.existsSync(info.path), 'autosaved project created next to the PDF');
  await shot('01-opened');
});

await step('pen stroke with stabilizer is smoother than the raw mouse path', async () => {
  await win.keyboard.press('p');
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push([300 + i * 25, 300 + Math.sin(i / 3) * 40]);
  const sent = await drawPath(pts, { jitter: 3 });
  assert.equal(await objCount(), 1);
  const o = await lastObj();
  assert.equal(o.tool, 'pen');
  const p = o.paths[0];
  const z = await ed(() => window.__editor.view.zoom);
  const raw = sent.map(([x, y]) => [x / z, y / z]);
  const wr = wobble(raw), ws = wobble(p);
  console.log(`     wobble: mouse ${wr.toFixed(4)} -> stroke ${ws.toFixed(4)} rad/px`);
  assert.ok(ws < wr * 0.35, 'stroke is much smoother than the mouse input');
  assert.ok(p[p.length - 1][2] > 0, 'points carry timestamps for replay');
});

await step('undo / redo with Ctrl+Z and Ctrl+Y', async () => {
  await win.keyboard.press('Control+z');
  assert.equal(await objCount(), 0);
  await win.keyboard.press('Control+y');
  assert.equal(await objCount(), 1);
  await win.keyboard.press('Control+z');
  await win.keyboard.press('Control+Shift+z');
  assert.equal(await objCount(), 1);
});

await step('draw-and-hold snaps a rough box to a clean rectangle', async () => {
  await drawPath([[300, 600], [700, 604], [698, 850], [302, 846], [303, 606]], { jitter: 2, hold: 800 });
  const o = await lastObj();
  assert.equal(o.shape, 'rect');
});

await step('draw-and-hold snaps circle, line and arrow', async () => {
  const circle = [];
  for (let i = 0; i <= 32; i++) circle.push([1000 + Math.cos((i / 32) * Math.PI * 2) * 120, 700 + Math.sin((i / 32) * Math.PI * 2) * 118]);
  await drawPath(circle, { jitter: 2, hold: 800 });
  assert.equal((await lastObj()).shape, 'ellipse');
  await drawPath([[300, 950], [800, 955]], { jitter: 2, hold: 800, steps: 12 });
  assert.equal((await lastObj()).shape, 'line');
  await drawPath([[300, 1100], [800, 1100], [760, 1070], [800, 1100], [760, 1130]], { jitter: 1, hold: 800, steps: 6 });
  assert.equal((await lastObj()).shape, 'arrow');
});

await step('pencil, marker and highlighter strokes', async () => {
  for (const [key, tool] of [['n', 'pencil'], ['m', 'marker'], ['h', 'highlighter']]) {
    await win.keyboard.press(key);
    const y = { pencil: 1250, marker: 1300, highlighter: 1350 }[tool];
    await drawPath([[300, y], [500, y + 10], [700, y - 5], [900, y + 5]], { jitter: 2 });
    assert.equal((await lastObj()).tool, tool);
  }
  await shot('02-strokes');
});

await step('ruler: strokes started at the edge stay perfectly straight', async () => {
  await win.keyboard.press('p');
  await win.keyboard.press('r');
  const r = await ed(() => { const e = window.__editor; e.ruler.x = 900; e.ruler.y = 1500; e.ruler.angle = 0; e.requestRender(); return e.rulerThickness(); });
  const y = 1500 + r / 2 + 6;
  await drawPath([[500, y], [700, y + 9], [900, y - 7], [1200, y + 8]], { jitter: 3 });
  const o = await lastObj();
  const ys = o.paths[0].map((q) => q[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 0.01, 'all points on one line');
  await win.keyboard.press('r');
});

await step('brush eraser never changes the scan', async () => {
  // Render a region with only scan underneath before and after erasing.
  const sample = () => ed(() => {
    const e = window.__editor;
    const c = new OffscreenCanvas(e.page.w, e.page.h);
    const ctx = c.getContext('2d');
    const bmp = e.bitmaps.get(e.page.bg.asset);
    ctx.drawImage(bmp, 0, 0);
    // composite exactly like the renderer does
    for (const l of e.page.layers) { e.ensureCaches(); ctx.drawImage(e.caches.get(l.id).page, 0, 0); }
    return Array.from(ctx.getImageData(1100, 200, 200, 60).data.slice(0, 4000)).join(',');
  });
  const before = await sample();
  await win.keyboard.press('e');
  assert.equal(await ed(() => window.__editor.settings.tools.eraser.mode), 'brush');
  await drawPath([[1100, 230], [1300, 230]], { jitter: 1 });
  assert.equal((await lastObj()).tool, 'eraser');
  assert.equal(await sample(), before, 'scan pixels identical after erasing');
});

await step('stroke eraser removes a whole stroke', async () => {
  await win.keyboard.press('e'); // toggles to stroke mode
  assert.equal(await ed(() => window.__editor.settings.tools.eraser.mode), 'stroke');
  const before = await objCount();
  await drawPath([[600, 250], [600, 380]], { jitter: 0 });
  assert.equal(await objCount(), before - 1, 'first pen stroke removed');
  await win.keyboard.press('e');
});

await step('text: click to type with a handwriting font, then retype it', async () => {
  await win.keyboard.press('t');
  const [x, y] = await toScreen(1000, 400);
  await win.mouse.click(x, y);
  await win.waitForSelector('.text-editor');
  await win.keyboard.type('Load path -> footing');
  await win.keyboard.press('Escape');
  const t = await lastObj();
  assert.equal(t.type, 'text');
  assert.equal(t.text, 'Load path -> footing');
  assert.equal(t.font, 'Caveat');
  // Click the text again to edit it.
  const [tx, ty] = await toScreen(t.x + 20, t.y + t.size * 0.6);
  await win.mouse.click(tx, ty);
  await win.waitForSelector('.text-editor');
  assert.equal(await win.inputValue('.text-editor'), 'Load path -> footing');
  await win.keyboard.press('End');
  await win.keyboard.type(' (see p.2)');
  await win.keyboard.press('Escape');
  assert.equal((await lastObj()).text, 'Load path -> footing (see p.2)');
  // Drag to move it.
  const before = await lastObj();
  const [sx, sy] = await toScreen(before.x + 30, before.y + before.size * 0.6);
  await win.mouse.move(sx, sy);
  await win.mouse.down();
  await win.mouse.move(sx + 40, sy + 30, { steps: 5 });
  await win.mouse.up();
  const after = await ed((id) => window.__editor.layer.objects.find((o) => o.id === id), before.id);
  assert.ok(after.x > before.x + 20 && after.y > before.y + 20, 'text moved');
  assert.equal(after.text, before.text);
});

await step('cover & rewrite: box mode paints grid paper over old writing', async () => {
  await win.keyboard.press('w');
  await win.keyboard.press('w'); // box mode
  assert.equal(await ed(() => window.__editor.settings.tools.cover.mode), 'box');
  const [x0, y0] = await toScreen(110, 250);
  const [x1, y1] = await toScreen(700, 330);
  await win.mouse.move(x0, y0);
  await win.mouse.down();
  await win.mouse.move(x1, y1, { steps: 6 });
  await win.mouse.up();
  const o = await lastObj();
  assert.equal(o.tool, 'cover');
  assert.ok(o.fill);
  // The covered area should now be light paper, not dark ink.
  const dark = await ed(() => {
    const e = window.__editor;
    e.ensureCaches();
    const d = e.caches.get(e.layer.id).page.getContext('2d').getImageData(150, 270, 400, 40).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 90) n++;
    return n;
  });
  assert.equal(dark, 0, 'no dark pixels inside the cover');
  await win.keyboard.press('p');
  await drawPath([[150, 300], [300, 290], [450, 305]], { jitter: 1 });
  await win.keyboard.press('w');
  await win.keyboard.press('w'); // back to brush
  await shot('03-cover');
});

await step('lasso: select, scale, copy/paste, delete', async () => {
  await win.keyboard.press('l');
  await drawPath([[250, 550], [1200, 550], [1200, 900], [250, 900], [250, 552]], { jitter: 0 });
  const sel = await ed(() => window.__editor.selection.items.length);
  assert.ok(sel >= 2, 'rect + circle selected, got ' + sel);
  const box0 = await ed(() => window.__editor.selection.box);
  // Drag the south-east handle to scale.
  const h = await ed(() => { const e = window.__editor; const r = e.canvas.getBoundingClientRect(); const p = e.selectionHandles().se; return [r.left + p[0], r.top + p[1]]; });
  await win.mouse.move(h[0], h[1]);
  await win.mouse.down();
  await win.mouse.move(h[0] + 60, h[1] + 40, { steps: 6 });
  await win.mouse.up();
  const box1 = await ed(() => window.__editor.selection.box);
  assert.ok(box1.w > box0.w * 1.05, 'selection got bigger');
  const n = await objCount();
  await win.keyboard.press('Control+c');
  await win.keyboard.press('Control+v');
  assert.equal(await objCount(), n + sel);
  await win.keyboard.press('Delete');
  assert.equal(await objCount(), n);
  // Recolour via swatch key while selected.
  await drawPath([[250, 550], [1200, 550], [1200, 900], [250, 900], [250, 552]], { jitter: 0 });
  await win.keyboard.press('3');
  const colors = await ed(() => window.__editor.selectedObjects().map((s) => s.obj.color));
  assert.ok(colors.every((c) => c === '#d62828'), 'recoloured red: ' + colors);
  await win.keyboard.press('Escape');
});

await step('eyedropper picks a colour from the page', async () => {
  await win.keyboard.press('p');
  await win.keyboard.press('i');
  const [x, y] = await toScreen(5, 5);
  await win.mouse.click(x, y);
  const c = await ed(() => window.__editor.settings.tools.pen.color);
  assert.match(c, /^#f[0-9a-f]{5}$/i, 'picked near-white paper: ' + c);
  assert.equal(await ed(() => window.__editor.tool), 'pen', 'returns to previous tool');
  await win.keyboard.press('1');
  assert.equal(await ed(() => window.__editor.settings.tools.pen.color), '#1b1b1f');
});

await step('layers: add, hide, opacity, reorder, delete', async () => {
  await win.keyboard.press('Control+Shift+n');
  assert.equal(await ed(() => window.__editor.page.layers.length), 2);
  await drawPath([[400, 1700], [800, 1720]], { jitter: 1 });
  const top = await ed(() => window.__editor.activeLayerId);
  await ed((id) => window.__editor.setLayerProps(id, { visible: false }), top);
  await ed((id) => window.__editor.setLayerProps(id, { visible: true, opacity: 0.5 }), top);
  await ed((id) => window.__editor.moveLayer(id, -1), top);
  assert.equal(await ed((id) => window.__editor.page.layers[0].id === id, top), true);
  await win.keyboard.press('Control+z');
  assert.equal(await ed((id) => window.__editor.page.layers[1].id === id, top), true);
  await ed(() => window.__editor.deleteLayer());
  assert.equal(await ed(() => window.__editor.page.layers.length), 1);
  await win.keyboard.press('Control+z');
  assert.equal(await ed(() => window.__editor.page.layers.length), 2);
  await shot('04-layers');
});

await step('zoom (Ctrl+wheel) and pan (space+drag, wheel)', async () => {
  const v0 = await ed(() => ({ ...window.__editor.view }));
  const [cx, cy] = await toScreen(600, 600);
  await win.mouse.move(cx, cy);
  await win.keyboard.down('Control');
  await win.mouse.wheel(0, -300);
  await win.keyboard.up('Control');
  const v1 = await ed(() => ({ ...window.__editor.view }));
  assert.ok(v1.zoom > v0.zoom * 1.3, 'zoomed in');
  await win.waitForTimeout(300);
  await shot('05-zoomed');
  await win.keyboard.down(' ');
  await win.mouse.down();
  await win.mouse.move(cx + 120, cy + 50, { steps: 5 });
  await win.mouse.up();
  await win.keyboard.up(' ');
  const v2 = await ed(() => ({ ...window.__editor.view }));
  assert.ok(Math.abs(v2.x - v1.x - 120) < 2, 'panned with space-drag');
  await win.mouse.wheel(0, 100);
  const v3 = await ed(() => ({ ...window.__editor.view }));
  assert.ok(v3.y < v2.y, 'wheel scrolls');
  await win.keyboard.press('Control+0');
});

await step('pages: new grid page, duplicate, delete, navigate', async () => {
  await win.keyboard.press('Control+n');
  let info = await ed(() => ({ n: window.__editor.project.pages.length, i: window.__editor.pageIndex, bg: window.__editor.page.bg.kind }));
  assert.deepEqual(info, { n: 3, i: 1, bg: 'grid' });
  await win.keyboard.press('t');
  const [x, y] = await toScreen(200, 200);
  await win.mouse.click(x, y);
  await win.keyboard.type('Blank grid page');
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+Shift+d');
  info = await ed(() => ({ n: window.__editor.project.pages.length, i: window.__editor.pageIndex, txt: window.__editor.layer.objects[0]?.text }));
  assert.deepEqual(info, { n: 4, i: 2, txt: 'Blank grid page' });
  await win.keyboard.press('Control+Shift+Delete');
  assert.equal(await ed(() => window.__editor.project.pages.length), 3);
  await win.keyboard.press('Home');
  assert.equal(await ed(() => window.__editor.pageIndex), 0);
  await win.keyboard.press('PageDown');
  assert.equal(await ed(() => window.__editor.pageIndex), 1);
  await win.keyboard.press('End');
  assert.equal(await ed(() => window.__editor.pageIndex), 2);
  await win.keyboard.press('PageUp');
  assert.equal(await ed(() => window.__editor.pageIndex), 1);
  await win.keyboard.press('Home');
  await win.waitForTimeout(700);
  assert.equal(await win.locator('.thumb').count(), 3);
  await shot('06-pages');
});

const projPath = path.join(out, 'sample-notes.redraft');
await step('autosave + reopen restores everything', async () => {
  await ed(() => window.__app.saveNow());
  const counts = await ed(() => window.__editor.project.pages.map((p) => p.layers.map((l) => l.objects.length)));
  const journal = await ed(() => window.__editor.project.journal.length);
  assert.ok(fs.statSync(projPath).size > 50000);
  await ed((p) => window.__app.openPaths([p]), projPath);
  await win.waitForFunction(() => window.__editor.project && window.__editor.history.undoStack.length === 0, null, { timeout: 15000 });
  const counts2 = await ed(() => window.__editor.project.pages.map((p) => p.layers.map((l) => l.objects.length)));
  assert.deepEqual(counts2, counts);
  assert.equal(await ed(() => window.__editor.project.journal.length), journal);
});

await step('export PDF at 300 dpi', async () => {
  const p = path.join(out, 'export.pdf');
  await ed((p) => window.__app.doExportPdf(window.__editor.project.pages, 300, p), p);
  const doc = await PDFDocument.load(fs.readFileSync(p));
  assert.equal(doc.getPageCount(), 3);
  const { width } = doc.getPage(0).getSize();
  assert.ok(Math.abs(width - 595) < 2, 'A4 width in points: ' + width);
});

await step('export PNG at print quality with DPI metadata', async () => {
  const p = path.join(out, 'export.png');
  await ed((p) => window.__app.doExportPng([window.__editor.page], 300, p), p);
  const b = fs.readFileSync(p);
  const w = b.readUInt32BE(16), hgt = b.readUInt32BE(20);
  const page = await ed(() => ({ w: window.__editor.page.w, h: window.__editor.page.h, dpi: window.__editor.page.dpi }));
  assert.equal(w, Math.round((page.w * 300) / page.dpi));
  assert.equal(hgt, Math.round((page.h * 300) / page.dpi));
  assert.equal(b.toString('latin1', 37, 41), 'pHYs');
  assert.equal(b.toString('latin1').split('pHYs').length - 1, 1, 'exactly one pHYs chunk');
  assert.equal(b.readUInt32BE(41), Math.round(300 / 0.0254));
});

await step('replay export writes a playable MP4 timelapse', async () => {
  const p = path.join(out, 'replay.mp4');
  const res = await ed((p) => window.__app.doExportReplay(32, p).then((r) => r && { codec: r.codec, frames: r.frames, w: r.width, h: r.height, s: r.seconds }), p);
  assert.ok(res, 'replay produced');
  console.log('     replay:', JSON.stringify(res));
  const b = fs.readFileSync(p);
  assert.equal(b.toString('latin1', 4, 8), 'ftyp');
  // Decode it with the app's own video element.
  const meta = await ed(async (bytes) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('video error ' + v.error?.code)); });
    return { d: v.duration, w: v.videoWidth, h: v.videoHeight };
  }, [...b]);
  assert.ok(meta.d > 1, 'duration ' + meta.d);
  assert.equal(meta.w, res.w);
});

await step('theme toggle and help overlay', async () => {
  await win.keyboard.press('Control+Shift+l');
  assert.equal(await win.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await win.waitForTimeout(200);
  await shot('07-dark');
  await win.keyboard.press('F1');
  await win.waitForSelector('.shortcuts');
  await shot('08-help');
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+Shift+l');
});

await step('no uncaught errors in the renderer', async () => {
  assert.deepEqual(errors, [], errors.join('\n'));
});

await electronApp.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
