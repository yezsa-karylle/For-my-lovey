// Turn PDFs and images into pages. Each page's scan becomes a locked
// background asset; grid spacing/colours are detected for the cover tool.
import { newPage, uid } from '../core/model.js';
import { detectGrid } from '../render/paper.js';

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';

export const IMPORT_DPI = 200;
const MAX_SIDE = 4200;

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };
export const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
export const baseName = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

function applyGrid(page, bitmap) {
  try {
    const g = detectGrid(bitmap, page.w, page.h);
    if (g.found) Object.assign(page.grid, { sx: g.sx, sy: g.sy, ox: g.ox, oy: g.oy, paper: g.paper, line: g.line, lw: g.lw });
    else page.grid.paper = g.paper;
    page.gridDetected = !!g.found;
  } catch (e) {
    console.warn('grid detection failed', e);
  }
}

async function canvasToBytes(canvas, type = 'image/jpeg', quality = 0.9) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality }) : await new Promise((r) => canvas.toBlob(r, type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Import one file. Returns { pages, assets: Map, bitmaps: Map }.
 * onProgress(done, total, label)
 */
export async function importFile(path, bytes, onProgress = () => {}) {
  const ext = extOf(path);
  if (ext === 'pdf') return importPdf(bytes, onProgress);
  if (MIME[ext]) return importImage(bytes, MIME[ext], onProgress);
  throw new Error('Unsupported file type: .' + ext);
}

async function importPdf(bytes, onProgress) {
  const doc = await pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    cMapUrl: '../node_modules/pdfjs-dist/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '../node_modules/pdfjs-dist/standard_fonts/',
  }).promise;
  const pages = [], assets = new Map(), bitmaps = new Map();
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress(i - 1, doc.numPages, `Rendering page ${i} of ${doc.numPages}`);
    const pg = await doc.getPage(i);
    const base = pg.getViewport({ scale: 1 });
    let scale = IMPORT_DPI / 72;
    if (Math.max(base.width, base.height) * scale > MAX_SIDE) scale = MAX_SIDE / Math.max(base.width, base.height);
    const vp = pg.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const id = uid('a');
    assets.set(id, { mime: 'image/jpeg', bytes: await canvasToBytes(canvas, 'image/jpeg', 0.92) });
    const page = newPage({ w: canvas.width, h: canvas.height, dpi: scale * 72, bg: { kind: 'image', asset: id } });
    applyGrid(page, canvas);
    pages.push(page);
    if (i <= 3) bitmaps.set(id, await createImageBitmap(canvas));
    pg.cleanup();
  }
  onProgress(doc.numPages, doc.numPages, 'Done');
  await doc.destroy();
  return { pages, assets, bitmaps };
}

async function importImage(bytes, mime, onProgress) {
  onProgress(0, 1, 'Loading image');
  let bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  let w = bmp.width, h = bmp.height;
  let out = { mime, bytes };
  if (Math.max(w, h) > MAX_SIDE || !['image/png', 'image/jpeg'].includes(mime)) {
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    out = { mime: 'image/jpeg', bytes: await canvasToBytes(c, 'image/jpeg', 0.92) };
    bmp.close();
    bmp = await createImageBitmap(c);
  }
  const id = uid('a');
  // Assume an A4/Letter-ish sheet to derive print size.
  const dpi = Math.max(72, Math.max(w, h) / 11.69);
  const page = newPage({ w, h, dpi, bg: { kind: 'image', asset: id } });
  applyGrid(page, bmp);
  onProgress(1, 1, 'Done');
  return { pages: [page], assets: new Map([[id, out]]), bitmaps: new Map([[id, bmp]]) };
}
