// End-to-end test of the browser / PWA build (npm run build:web first).
// Serves web-dist at the same path as GitHub Pages and drives it as an iPhone:
// real multi-finger touch and pen pressure via the Chrome DevTools Protocol.
//   CHROME_PATH=/path/to/chrome npm run test:web
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import http from 'http';
import assert from 'assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const { PDFDocument, rgb } = require('pdf-lib');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'web-dist');
const out = path.join(here, 'out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(dist, 'redraft/index.html'))) throw new Error('Run "npm run build:web" first');

// ---------------------------------------------------------------- static server (like GitHub Pages)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const PREFIX = '/For-my-lovey';
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(PREFIX + '/')) { res.writeHead(404); return res.end(); }
  p = path.join(dist, p.slice(PREFIX.length));
  if (!p.startsWith(dist)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL0 = `http://localhost:${server.address().port}${PREFIX}/redraft/`;

// ---------------------------------------------------------------- fixtures
async function makePdf(file) {
  const pdf = await PDFDocument.create();
  const mm = 72 / 25.4;
  const page = pdf.addPage([210 * mm, 297 * mm]);
  const { width, height } = page.getSize();
  for (let x = 0; x <= width; x += 5 * mm) page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: 0.5, color: rgb(0.75, 0.8, 0.86) });
  for (let y = 0; y <= height; y += 5 * mm) page.drawLine({ start: { x: 0, y }, end: { x: width, y }, thickness: 0.5, color: rgb(0.75, 0.8, 0.86) });
  page.drawText('Housing notes', { x: 20 * mm, y: height - 20 * mm, size: 18 });
  fs.writeFileSync(file, await pdf.save());
}
const pdfPath = path.join(out, 'phone-notes.pdf');
await makePdf(pdfPath);

// ---------------------------------------------------------------- harness
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['ok', name]); console.log(`ok   ${name} (${Date.now() - t} ms)`); }
  catch (e) { results.push(['FAIL', name]); console.log(`FAIL ${name}\n     ${String(e.stack).split('\n').slice(0, 4).join('\n     ')}`); }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const iphone = devices['iPhone 13'];
const ctx = await browser.newContext({ ...iphone, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
const cdp = await ctx.newCDPSession(page);
const ed = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: path.join(out, name + '.png') });

async function pageToScreen(x, y) {
  return ed(([x, y]) => { const e = window.__editor; const r = e.canvas.getBoundingClientRect(); const s = e.toScreen([x, y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]);
}
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
async function fingerDraw(pts) {
  await touch('touchStart', [pts[0]]);
  for (const p of pts.slice(1)) { await touch('touchMove', [p]); await page.waitForTimeout(16); }
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
}
async function multiTap(n) {
  const pts = Array.from({ length: n }, (_, i) => [150 + i * 60, 400]);
  for (let i = 1; i <= n; i++) await touch('touchStart', pts.slice(0, i));
  await page.waitForTimeout(60);
  await touch('touchEnd', []);
  await page.waitForTimeout(120);
}
const strokes = () => ed(() => window.__editor.layer.objects.length);

// ---------------------------------------------------------------- tests
await step('loads as a phone web app with manifest, icons and no errors', async () => {
  await page.goto(URL0);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  assert.equal(await page.title(), 'Redraft');
  const m = await ed(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); return { ok: r.ok, j: await r.json(), touch: (await fetch(document.querySelector('link[rel=apple-touch-icon]').href)).ok }; });
  assert.ok(m.ok && m.j.display === 'standalone' && m.j.icons.length === 3 && m.touch);
  await ed(() => { window.__app.noRebuildPrompt = true; });
  await shot('01-phone-welcome');
});

await step('service worker installs, caches everything and controls the page', async () => {
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 30000 });
  await page.reload();
  await page.waitForFunction(() => window.__ready === true && !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  const n = await ed(async () => { const k = await caches.keys(); const c = await caches.open(k.find((x) => x.startsWith('redraft-'))); return (await c.keys()).length; });
  assert.ok(n > 150, 'precached files: ' + n);
  await ed(() => { window.__app.noRebuildPrompt = true; });
});

await step('opens a PDF with the file picker (Files app on iPhone)', async () => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.tap('.big-action[data-cmd=open]')]);
  assert.equal(await chooser.element().getAttribute('accept'), null, 'no type filter on iOS so .redraft can be picked');
  await chooser.setFiles(pdfPath);
  await page.waitForFunction(() => window.__editor.project?.pages.length === 1 && window.__app.path, null, { timeout: 30000 });
  assert.ok((await ed(() => window.__app.path)).startsWith('idb:'));
  await page.waitForTimeout(400);
  await shot('02-phone-editor');
});

await step('touch-friendly layout: bottom tool dock, slide-in drawers', async () => {
  const bar = await page.locator('#toolbar').boundingBox();
  const vp = page.viewportSize();
  assert.ok(bar.y + bar.height > vp.height - 120, 'toolbar docked at the bottom');
  const tool = await page.locator('#toolbar .tool').first().boundingBox();
  assert.ok(tool.width >= 44 && tool.height >= 44, 'tool buttons at least 44pt: ' + tool.width);
  const off = await page.locator('#side-panel').boundingBox();
  assert.ok(off.x >= vp.width - 2, 'panel hidden off-screen');
  await page.tap('[data-cmd=togglePanel]');
  await page.waitForTimeout(350);
  const on = await page.locator('#side-panel').boundingBox();
  assert.ok(on.x < vp.width - 100, 'panel slides in');
  await shot('03-phone-panel');
  await page.tap('#view', { position: { x: 30, y: 300 } });
  await page.waitForTimeout(350);
  assert.ok((await page.locator('#side-panel').boundingBox()).x >= vp.width - 2, 'tapping the page closes it');
  await ed(() => { window.__editor.undo(); });
});

await step('one finger draws a stroke', async () => {
  await ed(() => window.__editor.setTool('pen'));
  const before = await strokes();
  const pts = [];
  for (let i = 0; i <= 14; i++) pts.push(await pageToScreen(300 + i * 40, 600 + Math.sin(i / 2) * 30));
  await fingerDraw(pts);
  assert.equal(await strokes(), before + 1);
});

await step('two fingers pinch-zoom and pan without drawing', async () => {
  const before = await strokes();
  const z0 = await ed(() => window.__editor.view.zoom);
  await touch('touchStart', [[150, 400]]);
  await touch('touchStart', [[150, 400], [250, 400]]);
  for (let k = 1; k <= 8; k++) { await touch('touchMove', [[150 - k * 10, 400 + k * 3], [250 + k * 10, 400 + k * 3]]); await page.waitForTimeout(16); }
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  const z1 = await ed(() => window.__editor.view.zoom);
  assert.ok(z1 > z0 * 1.5, `zoomed ${z0} -> ${z1}`);
  assert.equal(await strokes(), before, 'no stroke from the gesture');
  await ed(() => window.__editor.fit());
});

await step('two-finger tap = undo, three-finger tap = redo', async () => {
  const n = await strokes();
  await multiTap(2);
  assert.equal(await strokes(), n - 1, 'undo');
  await multiTap(3);
  assert.equal(await strokes(), n, 'redo');
});

await step('Apple Pencil pressure changes the line width; palm touches are ignored', async () => {
  const n = await strokes();
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push(await pageToScreen(300 + i * 30, 900));
  const pen = (type, [x, y], force) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force });
  await pen('mousePressed', pts[0], 0.15);
  for (let i = 1; i < pts.length; i++) {
    await pen('mouseMoved', pts[i], 0.15 + (0.8 * i) / pts.length);
    if (i === 8) { await touch('touchStart', [[60, 700]]); await touch('touchEnd', []); } // palm
    await page.waitForTimeout(16);
  }
  await pen('mouseReleased', pts[pts.length - 1], 0);
  await page.waitForTimeout(100);
  assert.equal(await strokes(), n + 1, 'one stroke, palm ignored');
  const o = await ed(() => { const a = window.__editor.layer.objects; return a[a.length - 1]; });
  assert.ok(o.pressure, 'pressure recorded');
  const ps = o.paths[0].map((p) => p[3]).filter((v) => v !== undefined);
  assert.ok(Math.max(...ps) - Math.min(...ps) > 0.4, 'pressure varies: ' + Math.min(...ps) + '..' + Math.max(...ps));
  await shot('04-phone-pencil');
});

await step('autosaves to IndexedDB and reopens after a reload', async () => {
  await page.waitForFunction(() => !window.__app.dirty && !window.__app.saving, null, { timeout: 10000 });
  const n = await strokes();
  await page.reload();
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  await page.waitForSelector('.recent-row');
  await shot('05-phone-projects');
  await page.tap('.recent-row .open');
  await page.waitForFunction(() => window.__editor.project?.pages.length === 1, null, { timeout: 30000 });
  assert.equal(await strokes(), n);
});

await step('export PDF goes to the share sheet / download', async () => {
  await ed(() => window.__app.doExportPdf(window.__editor.project.pages, 150, 'download:phone-notes.pdf'));
  await page.waitForSelector('[data-dl]');
  await shot('06-phone-share');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('[data-dl]')]);
  assert.equal(dl.suggestedFilename(), 'phone-notes.pdf');
  const p = path.join(out, 'phone-notes-export.pdf');
  await dl.saveAs(p);
  assert.equal(fs.readFileSync(p).toString('latin1', 0, 5), '%PDF-');
});

await step('replay video: MP4 when H.264 encoding exists, else WebM, else MediaRecorder', async () => {
  const r = await ed(async () => {
    const { exportReplayVideo, pickCodec } = await import('./js/io/replay.js');
    const e = window.__editor;
    const sig = (b) => Array.from(b.slice(0, 12)).map((x) => x.toString(16).padStart(2, '0')).join('');
    const best = await pickCodec(1920, 1080, 30);
    const a = await exportReplayVideo(e, [e.page.id], { speed: 16, format: 'portrait' });
    const mp4 = window.Mp4Muxer;
    window.Mp4Muxer = undefined; // pretend H.264 isn't available
    const b = await exportReplayVideo(e, [e.page.id], { speed: 16, format: 'portrait' });
    window.Mp4Muxer = mp4;
    const c = await exportReplayVideo(e, [e.page.id], { speed: 16, format: 'portrait', forceRecorder: true });
    return { best: best && best.container, a: [a.container, sig(a.bytes)], b: [b.container, sig(b.bytes)], c: [c.container, c.bytes.length] };
  });
  console.log('     video:', JSON.stringify(r));
  assert.equal(r.a[0], r.best);
  if (r.a[0] === 'mp4') assert.equal(r.a[1].slice(8, 16), '66747970', 'ftyp box');
  assert.equal(r.b[0], 'webm');
  assert.equal(r.b[1].slice(0, 8), '1a45dfa3', 'EBML header');
  assert.ok(r.c[1] > 1000, 'MediaRecorder fallback produced a file');
});

await step('works offline (Home Screen app with no signal)', async () => {
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  await page.waitForSelector('.recent-row');
  await page.tap('.recent-row .open');
  await page.waitForFunction(() => window.__editor.project?.pages.length === 1, null, { timeout: 30000 });
  await ed(() => window.__app.noRebuildPrompt = true);
  // OCR also runs offline: rebuild the PDF page.
  const stats = await ed(() => window.__app.rebuildPages([window.__editor.page], { quiet: true }));
  assert.ok(stats.length === 1 && stats[0].text >= 1, 'rebuilt offline: ' + JSON.stringify(stats));
  const t = await ed(() => window.__editor.page.layers.find((l) => l.name === 'Text').objects.map((o) => o.text).join(' | '));
  assert.match(t, /Housing notes/);
  await ctx.setOffline(false);
});

await step('iPad layout keeps side panels and big touch targets', async () => {
  const ipad = await browser.newContext({ ...devices['iPad (gen 7)'] });
  const p2 = await ipad.newPage();
  await p2.goto(URL0 + '?nosw');
  await p2.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  await p2.evaluate(() => { window.__app.noRebuildPrompt = true; return window.__app.commands.newNotebook(); });
  await p2.waitForTimeout(500);
  const side = await p2.locator('#side-panel').boundingBox();
  const vw = p2.viewportSize().width;
  assert.ok(side.x + side.width <= vw + 1 && side.width > 200, `side panel fully on screen: ${side.x}+${side.width} vs ${vw}`);
  const right = await p2.locator('.tb-right').boundingBox(), left = await p2.locator('.tb-left').boundingBox();
  assert.ok(left.x + left.width <= right.x + 1 && right.x + right.width <= vw + 1, 'top bar fits without overlap');
  const tool = await p2.locator('#toolbar .tool').first().boundingBox();
  assert.ok(tool.width >= 44);
  await p2.screenshot({ path: path.join(out, '07-ipad.png') });
  await ipad.close();
});

await step('no uncaught errors', async () => { assert.deepEqual(errors, [], errors.join('\n')); });

await browser.close();
server.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
