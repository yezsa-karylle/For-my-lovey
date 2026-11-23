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
await win.evaluate(() => { window.__app.noRebuildPrompt = true; });

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
  assert.equal(t.font, 'Gaegu');
  assert.ok(t.hand && t.seed, 'natural handwriting is on by default');
  // Snapped onto a grid-row baseline.
  const g = await ed(() => window.__editor.page.grid);
  const off = ((t.y - g.oy) % g.sy + g.sy) % g.sy;
  assert.ok(Math.abs(off - (g.sy - 7 * g.sy / 46)) < 0.5 || Math.abs(off - (await ed(() => window.__editor.page.baseOffset ?? -1))) < 0.5, 'baseline on grid row');
  // Click the text again to edit it.
  const [tx, ty] = await toScreen(t.x + 20, t.y - t.size * 0.3);
  await win.mouse.click(tx, ty);
  await win.waitForSelector('.text-editor');
  assert.equal(await win.inputValue('.text-editor'), 'Load path -> footing');
  await win.keyboard.press('End');
  await win.keyboard.type(' (see p.2)');
  await win.keyboard.press('Escape');
  assert.equal((await lastObj()).text, 'Load path -> footing (see p.2)');
  // Drag to move it.
  const before = await lastObj();
  const [sx, sy] = await toScreen(before.x + 30, before.y - before.size * 0.3);
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
  assert.ok(colors.every((c) => c === '#e3453d'), 'recoloured red: ' + colors);
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
  assert.equal(await ed(() => window.__editor.settings.tools.pen.color), '#212126');
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

await step('replay player and MP4 export (1080p, 30 fps)', async () => {
  await win.keyboard.press('Control+Shift+r');
  await win.waitForSelector('.player');
  const st = await ed(() => ({ d: window.__player.state.engine.duration, n: window.__player.state.engine.segs.length }));
  assert.ok(st.d > 1000 && st.n > 5, 'timeline built');
  await ed((t) => { const s = window.__player.state; s.playing = false; s.t = t; s.jump = true; s.dirty = true; }, st.d / 2);
  await win.waitForTimeout(200);
  await shot('09-player');
  await win.keyboard.press('Escape');
  assert.equal(await win.locator('.player').count(), 0);
  const p = path.join(out, 'replay.mp4');
  const res = await ed((p) => window.__app.doExportReplay({ pageIds: [window.__editor.page.id], mode: 'history', speed: 16, format: 'landscape' }, p).then((r) => r && { codec: r.codec, frames: r.frames, w: r.width, h: r.height, s: r.seconds }), p);
  assert.ok(res, 'replay produced');
  console.log('     replay:', JSON.stringify(res));
  assert.equal(res.w, 1920); assert.equal(res.h, 1080);
  const b = fs.readFileSync(p);
  assert.equal(b.toString('latin1', 4, 8), 'ftyp');
  const meta = await ed(async () => {
    const blob = await (await fetch('../test/e2e/out/replay.mp4')).blob();
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(blob);
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('video error ' + v.error?.code)); });
    return { d: v.duration, w: v.videoWidth, h: v.videoHeight };
  });
  assert.ok(meta.d > 1, 'duration ' + meta.d);
  assert.equal(meta.w, 1920);
});

// ---------------------------------------------------------------- notes: rebuild + replay
const NOTES = [
  { t: 'TOPIC 3', x: 78, row: 2, size: 44, w: 400, c: 'ink', hl: 'pink' },
  { t: 'AUGUST 29, 2026', x: 600, row: 2, size: 28, c: 'gray' },
  { t: 'SITE PLANNING BASICS', x: 78, row: 3, size: 34, c: 'ink', hl: 'yellow' },
  { t: 'Site analysis studies the land before design.', x: 88, row: 5, size: 36, c: 'ink' },
  { t: 'It covers slope, soil, drainage and access.', x: 88, row: 6, size: 36, c: 'ink' },
  { t: 'Key factors :', x: 58, row: 8, size: 36, c: 'ink', ul: true },
  { t: '1. Topography and slope', x: 88, row: 9, size: 36, c: 'ink' },
  { t: 'steep slopes need retaining walls', x: 150, row: 10, size: 32, c: 'red' },
  { t: '2. Orientation and sun path', x: 88, row: 11, size: 36, c: 'ink' },
  { t: 'living areas face the morning sun', x: 150, row: 12, size: 32, c: 'red' },
  { t: '3. Utilities and road access', x: 88, row: 13, size: 36, c: 'ink' },
  { t: 'IN SUMMARY :', x: 70, row: 16, size: 30, c: 'red' },
  { t: 'Good planning starts with the site itself.', x: 100, row: 17, size: 30, c: 'blue' },
  { t: 'Housing density depends on the zoning.', x: 940, row: 5, size: 36, c: 'ink' },
  { t: 'Open space makes a healthy community.', x: 940, row: 6, size: 36, c: 'ink' },
];
const NOTE_COLORS = { ink: '#212126', red: '#e3453d', blue: '#296bd9', gray: '#737880' };

await step('rebuild: a notes page becomes editable text, highlights, box and lines', async () => {
  const b64 = await ed(async ({ NOTES, NOTE_COLORS }) => {
    const { drawHand, loadHandFonts } = await import('./js/render/hand.js');
    const { drawStroke, buildStrokePath } = await import('./js/render/draw.js');
    const { dashPolyline } = await import('./js/io/rebuild.js');
    await loadHandFonts();
    const W = 1700, H = 2200, G = 46;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(140,145,153,0.55)'; g.lineWidth = 1.2; g.beginPath();
    for (let x = 0; x <= W; x += G) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); }
    for (let y = 0; y <= H; y += G) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
    g.stroke();
    g.fillStyle = '#999a9e'; g.fillRect(845, 0, 10, H);
    let seed = 5;
    for (const n of NOTES) {
      const o = { type: 'text', hand: true, font: 'Gaegu', weight: n.w || 300, size: n.size, color: NOTE_COLORS[n.c], x: n.x, y: n.row * G - 7, text: n.t, seed: seed++, opacity: 1 };
      drawHand(g, o);
      const { layoutHand } = await import('./js/render/hand.js');
      const L = layoutHand(o);
      const a = n.x + L.box.x0, b = n.x + L.box.x1;
      if (n.hl) {
        const hs = { type: 'stroke', tool: 'highlighter', shape: 'line', color: n.hl === 'pink' ? '#fa7366' : '#ffdb26', size: 20, alpha: 0.75, opacity: 1, paths: [[[a - 2, o.y - 6, 0], [b + 4, o.y - 6, 0]]] };
        g.save(); g.globalCompositeOperation = 'multiply'; drawStroke(g, hs, {}, buildStrokePath(hs)); g.restore();
      }
      if (n.ul) { g.strokeStyle = '#212126'; g.lineWidth = 2.2; g.lineCap = 'round'; g.beginPath(); g.moveTo(a - 2, o.y + 7); g.lineTo(b + 4, o.y + 7); g.stroke(); }
    }
    // Red dashed summary box around rows 16-17.
    g.strokeStyle = '#e3453d'; g.lineWidth = 2.4; g.setLineDash([9, 8]); g.lineCap = 'round';
    g.beginPath(); g.roundRect(58, 15 * G + 12, 800 - 58, 3 * G - 32, 8); g.stroke();
    void dashPolyline;
    const blob = await c.convertToBlob({ type: 'image/png' });
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
  }, { NOTES, NOTE_COLORS });
  const png = path.join(out, 'synthetic-notes.png');
  fs.writeFileSync(png, Buffer.from(b64, 'base64'));
  await ed(() => { window.__app.noRebuildPrompt = true; });
  await stubDialogs({ open: [png] });
  await ed(() => window.__app.commands.open());
  await win.waitForFunction(() => window.__editor.project?.title === 'synthetic-notes' && window.__editor.page.bg.kind === 'image', null, { timeout: 30000 });
  const stats = await ed(() => window.__app.rebuildPages([window.__editor.page], { quiet: true }));
  console.log('     rebuild:', JSON.stringify(stats));
  const page = await ed(() => { const p = window.__editor.page; return { bg: p.bg, ref: !!p.ref, grid: p.grid, layers: p.layers.map((l) => ({ name: l.name, blend: l.blend, objs: l.objects })) }; });
  assert.equal(page.bg.kind, 'grid');
  assert.ok(page.bg.divider && Math.abs(page.bg.divider.x - 850) < 3, 'divider found');
  assert.ok(Math.abs(page.grid.sx - 46) < 0.5, 'grid 46px');
  assert.ok(page.ref, 'original scan kept for comparison');
  assert.deepEqual(page.layers.map((l) => l.name), ['Highlights', 'Lines & sketches', 'Text']);
  assert.equal(page.layers[0].blend, 'multiply');
  const texts = page.layers[2].objs;
  const hl = page.layers[0].objs;
  const lines = page.layers[1].objs;
  assert.equal(hl.length, 2, 'two highlights');
  assert.ok(lines.some((o) => o.kind === 'dashbox' && o.color === '#e3453d'), 'red dashed box');
  assert.ok(lines.some((o) => o.kind === 'line'), 'underline');
  // OCR accuracy vs what we drew.
  const lev = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { let p = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] !== b[j - 1])); p = t; } } return d[b.length]; };
  const order = (o) => (o.x > 850 ? 1e6 : 0) + o.y * 10 + o.x / 1000;
  const got = texts.slice().sort((a, b) => order(a) - order(b)).map((o) => o.text).join(' ');
  const want = NOTES.slice().sort((a, b) => order({ x: a.x, y: a.row * 46 }) - order({ x: b.x, y: b.row * 46 })).map((n) => n.t).join(' ');
  const cer = lev(got, want) / want.length;
  console.log(`     OCR character error rate: ${(cer * 100).toFixed(1)}%`);
  assert.ok(cer < 0.08, 'CER ' + cer);
  // Colours, sizes and positions.
  for (const n of NOTES) {
    const o = texts.find((t) => Math.abs(t.y - (n.row * 46 - 7)) < 4 && Math.abs(t.x - n.x) < 25);
    assert.ok(o, 'line found: ' + n.t);
    assert.equal(o.color, NOTE_COLORS[n.c], 'colour of ' + n.t);
    assert.ok(Math.abs(o.size - n.size) <= 3, `size of "${n.t}": ${o.size} vs ${n.size}`);
    assert.ok(o.hand && o.font === 'Gaegu', 'handwriting font');
  }
  assert.equal(texts.find((t) => /TOPIC/.test(t.text)).weight, 400, 'TOPIC is bold');
  await win.keyboard.press('Control+0');
  await win.waitForTimeout(300);
  await shot('10-rebuilt');
  // Undo goes back to the scan, redo restores the rebuild.
  await win.keyboard.press('Control+z');
  assert.equal(await ed(() => window.__editor.page.bg.kind), 'image');
  await win.keyboard.press('Control+y');
  assert.equal(await ed(() => window.__editor.page.bg.kind), 'grid');
});

await step('every letter gets its own jitter; retyping keeps earlier letters', async () => {
  const r = await ed(async () => {
    const { layoutHand } = await import('./js/render/hand.js');
    const o = { type: 'text', hand: true, font: 'Gaegu', weight: 300, size: 36, text: 'aaaa', seed: 9, x: 0, y: 0 };
    const L = layoutHand(o);
    const boxes = L.glyphs.map((g) => [+(g.box.x1 - g.box.x0).toFixed(2), +(g.box.y1 - g.box.y0).toFixed(2), +g.by.toFixed(2)]);
    const o2 = { ...o, text: 'aaaab' };
    const L2 = layoutHand(o2);
    return { boxes, same: L2.glyphs.slice(0, 4).every((g, i) => g.box.x0 === L.glyphs[i].box.x0 && g.by === L.glyphs[i].by) };
  });
  assert.equal(new Set(r.boxes.map(String)).size, 4, 'four different "a" shapes: ' + JSON.stringify(r.boxes));
  assert.ok(r.same, 'adding a letter keeps the earlier ones');
});

await step('edits are recorded with timestamps and replay letter by letter, with erase-and-rewrite', async () => {
  // Retype a rebuilt line.
  const t = await ed(() => window.__editor.page.layers.find((l) => l.name === 'Text').objects.find((o) => /Topography/.test(o.text)));
  await ed((id) => window.__editor.setActiveLayer(window.__editor.page.layers.find((l) => l.name === 'Text').id));
  await win.keyboard.press('t');
  const [x, y] = await toScreen(t.x + 60, t.y - 10);
  await win.mouse.click(x, y);
  await win.waitForFunction(() => document.activeElement?.classList.contains('text-editor'));
  await win.keyboard.press('End');
  for (let i = 0; i < 5; i++) await win.keyboard.press('Backspace');
  await win.keyboard.type('grade', { delay: 30 });
  await win.keyboard.press('Escape');
  const entry = await ed(() => { const j = window.__editor.project.journal; return j[j.length - 1]; });
  assert.equal(entry.op.type, 'setObjs');
  assert.ok(entry.anim.length >= 11, 'each keystroke recorded: ' + entry.anim.length);
  assert.ok(entry.anim.every((a, i) => i === 0 || a[0] >= entry.anim[i - 1][0]), 'timestamps increase');
  assert.ok(typeof entry.t === 'number');
  // Auto replay: natural slips (written wrong, erased, rewritten).
  const auto = await ed(async () => {
    const { ReplayEngine } = await import('./js/io/replay.js');
    const E = new ReplayEngine(window.__editor, window.__editor.page.id, { mode: 'auto' });
    const textSegs = E.segs.filter((s) => s.kind === 'text');
    const slip = textSegs.find((s) => s.acts.some((a) => a.type === 'del'));
    return { n: textSegs.length, slips: textSegs.filter((s) => s.acts.some((a) => a.type === 'del')).length, at: slip && slip.t0 + slip.acts.find((a) => a.type === 'del').t0 + 80, dur: E.duration };
  });
  assert.ok(auto.n >= NOTES.length - 1, 'every line is written');
  assert.ok(auto.slips >= 1 && auto.slips <= 3, 'a few erase-and-rewrite moments: ' + auto.slips);
  // History replay contains the retype as delete + add actions.
  const hist = await ed(async () => {
    const { ReplayEngine } = await import('./js/io/replay.js');
    const E = new ReplayEngine(window.__editor, window.__editor.page.id, { mode: 'history' });
    const last = E.segs.filter((s) => s.kind === 'text').pop();
    return { edits: E.editCount, acts: last.acts.map((a) => a.type) };
  });
  assert.ok(hist.edits >= 1);
  assert.ok(hist.acts.includes('del') && hist.acts.includes('add'), 'erase then rewrite: ' + hist.acts);
  // Look at a mid-slip frame and a mid-letter frame in the player.
  await win.keyboard.press('Control+Shift+r');
  await win.waitForSelector('.player');
  await ed((t) => { const s = window.__player.state; s.playing = false; s.t = t; s.jump = true; s.dirty = true; }, auto.at);
  await win.waitForTimeout(250);
  await shot('11-replay-slip');
  await win.keyboard.press('Escape');
});

await step('letter eraser: rub out letters, the rest stays exactly in place and editable', async () => {
  const textLayer = await ed(() => window.__editor.page.layers.find((l) => l.name === 'Text').id);
  await ed((id) => window.__editor.setActiveLayer(id), textLayer);
  const t = await ed(() => window.__editor.layer.objects.find((o) => /density/.test(o.text)));
  // Page boxes of every letter before erasing.
  const boxes = (ids) => ed(async (ids) => {
    const { layoutHand } = await import('./js/render/hand.js');
    const e = window.__editor, out = {};
    for (const o of e.layer.objects.filter((x) => ids.includes(x.id) || (x.i0 !== undefined && x.seed === ids.seed))) {
      const L = layoutHand(o);
      for (const g of L.glyphs) if (g.box) out[(o.i0 || 0) + g.i] = [+(o.x + g.box.x0).toFixed(2), +(o.y + g.box.y0).toFixed(2), +(o.x + g.box.x1).toFixed(2)];
    }
    return out;
  }, ids);
  const before = await boxes([t.id]);
  // Choose letters 10..13 and swipe over their centre.
  const mid = await ed(async (id) => {
    const { layoutHand } = await import('./js/render/hand.js');
    const o = window.__editor.layer.objects.find((x) => x.id === id);
    const g = layoutHand(o).glyphs.filter((x) => x.box && x.i >= 10 && x.i <= 12);
    return [o.x + (g[0].box.x0 + g[0].box.x1) / 2, o.x + (g[g.length - 1].box.x0 + g[g.length - 1].box.x1) / 2, o.y - o.size * 0.25];
  }, t.id);
  await win.keyboard.press('e');
  await ed(() => { const s = window.__editor.settings.tools.eraser; s.mode = 'stroke'; s.size = 8; window.__editor.emit('settings'); });
  const [x0, y0] = await toScreen(mid[0], mid[2]);
  const [x1] = await toScreen(mid[1], mid[2]);
  await win.mouse.move(x0, y0); await win.mouse.down();
  await win.mouse.move(x1, y0, { steps: 6 }); await win.mouse.up();
  const after = await ed((seed) => window.__editor.layer.objects.filter((o) => o.seed === seed).map((o) => ({ id: o.id, text: o.text, i0: o.i0 || 0 })), t.seed);
  assert.equal(after.length, 2, 'line split into two editable pieces: ' + JSON.stringify(after));
  const erased = t.text.length - after.reduce((n, a) => n + a.text.length, 0) - (t.text.split(' ').length - after.reduce((n, a) => n + a.text.split(' ').length, 0));
  assert.ok(erased >= 2, 'some letters erased');
  const now = await ed(async (seed) => {
    const { layoutHand } = await import('./js/render/hand.js');
    const out = {};
    for (const o of window.__editor.layer.objects.filter((x) => x.seed === seed)) for (const g of layoutHand(o).glyphs) if (g.box) out[(o.i0 || 0) + g.i] = [+(o.x + g.box.x0).toFixed(2), +(o.y + g.box.y0).toFixed(2), +(o.x + g.box.x1).toFixed(2)];
    return out;
  }, t.seed);
  for (const [i, b] of Object.entries(now)) {
    assert.ok(before[i], 'letter ' + i + ' existed before');
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(before[i][k] - b[k]) < 0.05, `letter ${i} moved: ${before[i]} -> ${b}`);
  }
  const entry = await ed(() => { const j = window.__editor.project.journal; return j[j.length - 1]; });
  assert.ok(entry.letterErase && entry.letterErase[0].erased.length >= 2, 'erase recorded for replay');
  const segKinds = await ed(async () => {
    const { ReplayEngine } = await import('./js/io/replay.js');
    const E = new ReplayEngine(window.__editor, window.__editor.page.id, { mode: 'history' });
    return E.segs.filter((s) => s.kind === 'text' && s.acts.some((a) => a.type === 'erase')).length;
  });
  assert.equal(segKinds, 1, 'replay shows the letters being rubbed out');
  // Undo puts the whole line back.
  await win.keyboard.press('Control+z');
  assert.equal(await ed((id) => window.__editor.layer.objects.filter((o) => o.id === id).length, t.id), 1);
  await win.keyboard.press('Control+y');
  await ed(() => { window.__editor.settings.tools.eraser.mode = 'brush'; });
  await win.keyboard.press('Control+0');
  await win.waitForTimeout(300);
  await shot('12-letter-erase');
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
