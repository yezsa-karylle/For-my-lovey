// Print-quality export to PDF and PNG. Strokes and text are vectors in the
// document, so they are re-rendered sharply at the export resolution.
import { renderPageCanvas, ensureImages } from '../render/draw.js';

async function toBytes(canvas, type, quality) {
  const blob = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Render a page at `dpi` using the editor's bitmap loader. */
export async function renderForExport(editor, page, dpi) {
  const bmp = await editor.ensureBitmap(page);
  await ensureImages(page.layers.flatMap((l) => l.objects));
  return renderPageCanvas(page, bmp, dpi / page.dpi);
}

export async function exportPdf(editor, pages, { dpi = 300, quality = 0.93, onProgress = () => {} } = {}) {
  const { PDFDocument } = window.PDFLib;
  const pdf = await PDFDocument.create();
  pdf.setProducer('Redraft');
  pdf.setTitle(editor.project.title || 'Notes');
  for (let i = 0; i < pages.length; i++) {
    onProgress(i, pages.length, `Rendering page ${i + 1} of ${pages.length}`);
    const page = pages[i];
    const canvas = await renderForExport(editor, page, dpi);
    const img = await pdf.embedJpg(await toBytes(canvas, 'image/jpeg', quality));
    const wPt = (page.w / page.dpi) * 72, hPt = (page.h / page.dpi) * 72;
    const p = pdf.addPage([wPt, hPt]);
    p.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress(pages.length, pages.length, 'Writing PDF');
  return pdf.save();
}

export async function exportPng(editor, page, { dpi = 300 } = {}) {
  const canvas = await renderForExport(editor, page, dpi);
  return withPngDpi(await toBytes(canvas, 'image/png'), dpi);
}

// ---- PNG pHYs chunk so print software knows the physical size.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function withPngDpi(png, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const ihdrEnd = 8 + 25; // signature + IHDR chunk
  const out = new Uint8Array(png.length + 21);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + 21);
  return out;
}
