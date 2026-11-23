// Drawing of document objects onto a 2D canvas context in page coordinates.
import { getStroke } from '../../../node_modules/perfect-freehand/dist/esm/index.mjs';
import { drawGrid } from './paper.js';
import { bboxOfPoints } from '../core/geometry.js';
import { drawHand, measureHand, handReady } from './hand.js';

export const BRUSHES = {
  pen:         { thinning: 0.55, smoothing: 0.62, streamline: 0.32, taper: 2.5 },
  pencil:      { thinning: 0.3,  smoothing: 0.55, streamline: 0.32, taper: 2, grain: true },
  marker:      { thinning: 0.04, smoothing: 0.65, streamline: 0.38, taper: 0 },
  highlighter: { thinning: 0,    smoothing: 0.7,  streamline: 0.45, taper: 0, alphaMul: 0.42 },
  eraser:      { thinning: 0,    smoothing: 0.5,  streamline: 0.3,  taper: 0 },
  cover:       { thinning: 0,    smoothing: 0.5,  streamline: 0.3,  taper: 0 },
};

let pathCache = new WeakMap();

function addOutline(path, pts) {
  if (pts.length < 3) return;
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    path.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  path.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  path.closePath();
}

export function buildStrokePath(obj, paths = obj.paths) {
  const b = BRUSHES[obj.tool] || BRUSHES.pen;
  const path = new Path2D();
  if (obj.fill) {
    for (const pts of paths) {
      if (!pts.length) continue;
      path.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
      path.closePath();
    }
    return path;
  }
  const crisp = !!obj.shape;
  for (const pts of paths) {
    if (!pts.length) continue;
    const real = obj.pressure && !crisp; // Apple Pencil / pen pressure recorded per point
    const outline = getStroke(pts.map((p) => (real ? [p[0], p[1], p[3] ?? 0.5] : [p[0], p[1]])), {
      size: obj.size,
      thinning: crisp ? 0 : real ? Math.max(b.thinning, 0.45) : b.thinning,
      smoothing: b.smoothing,
      streamline: crisp ? 0 : b.streamline,
      simulatePressure: !real && !crisp && b.thinning > 0,
      start: { taper: crisp ? 0 : obj.size * b.taper, cap: true },
      end: { taper: crisp ? 0 : obj.size * b.taper, cap: true },
      last: true,
    });
    addOutline(path, outline);
  }
  return path;
}

export function strokePath(obj) {
  let p = pathCache.get(obj);
  if (!p) { p = buildStrokePath(obj); pathCache.set(obj, p); }
  return p;
}

const grainCache = new Map();
function grainPattern(ctx, color) {
  let c = grainCache.get(color);
  if (!c) {
    c = new OffscreenCanvas(96, 96);
    const g = c.getContext('2d');
    const img = g.createImageData(96, 96);
    const r = parseInt(color.slice(1, 3), 16), gg = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    let seed = 1234;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 96 * 96; i++) {
      img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = rnd() < 0.78 ? 150 + rnd() * 105 : rnd() * 60;
    }
    g.putImageData(img, 0, 0);
    grainCache.set(color, c);
  }
  return ctx.createPattern(c, 'repeat');
}

/** env: { grid } — the page grid used by the cover tool. */
export function drawStroke(ctx, obj, env, path = strokePath(obj)) {
  const b = BRUSHES[obj.tool] || BRUSHES.pen;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, obj.alpha ?? obj.opacity * (b.alphaMul || 1)));
  if (obj.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(path);
  } else if (obj.tool === 'cover') {
    ctx.clip(path);
    const box = bboxOfPoints(obj.paths.flat(), obj.size);
    if (box) drawGrid(ctx, env.grid, box);
  } else if (b.grain) {
    ctx.fillStyle = grainPattern(ctx, obj.color);
    ctx.fill(path);
  } else {
    ctx.fillStyle = obj.color;
    ctx.fill(path);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- text
const measureCtx = new OffscreenCanvas(4, 4).getContext('2d');
let layoutCache = new WeakMap();

export const fontString = (o) => `${o.weight || 400} ${o.size}px "${o.font}", "Segoe Print", cursive`;
export const LINE_HEIGHT = 1.25;

export function resetTextCache() { layoutCache = new WeakMap(); }

export function textLayout(o, text = o.text) {
  const cacheable = text === o.text;
  if (cacheable && layoutCache.has(o)) return layoutCache.get(o);
  measureCtx.font = fontString(o);
  const lines = [];
  for (const para of text.split('\n')) {
    if (!(o.w > 0)) { lines.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && measureCtx.measureText(test).width > o.w) { lines.push(line.trimEnd()); line = word.trimStart(); } else line = test;
    }
    lines.push(line);
  }
  let width = 0;
  for (const l of lines) width = Math.max(width, measureCtx.measureText(l).width);
  const m = measureCtx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent ?? o.size * 0.8, desc = m.fontBoundingBoxDescent ?? o.size * 0.2;
  const lineH = o.size * LINE_HEIGHT;
  const res = {
    lines, lineH,
    baseline: (lineH - (asc + desc)) / 2 + asc, // matches CSS line-height placement
    w: Math.max(width, o.w || 0, o.size * 0.4),
    h: Math.max(lineH, lines.length * lineH),
  };
  if (cacheable) layoutCache.set(o, res);
  return res;
}

export const measureText = (o) => {
  if (o.hand && handReady(o)) return measureHand(o);
  const L = textLayout(o);
  return { x0: 0, y0: o.hand ? -L.baseline : 0, w: L.w, h: L.h };
};

export function drawText(ctx, o, text = o.text, opts) {
  if (o.hand) {
    if (handReady(o)) return drawHand(ctx, o, { ...opts, text }) || null;
    // Fonts still loading: draw plainly at the same baseline.
    return drawText(ctx, { ...o, hand: false, y: o.y - textLayout(o).baseline }, text);
  }
  const L = textLayout(o, text);
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rot) ctx.rotate(o.rot);
  ctx.globalAlpha = o.opacity ?? 1;
  ctx.fillStyle = o.color;
  ctx.font = fontString(o);
  ctx.textBaseline = 'alphabetic';
  L.lines.forEach((line, i) => ctx.fillText(line, 0, i * L.lineH + L.baseline));
  ctx.restore();
}

// ---------------------------------------------------------------- pictures (diagrams kept from scans)
const images = new Map(); // assetId -> ImageBitmap | 'loading'
let getAsset = () => null, onImageReady = () => {};
/** The editor tells the renderer where image assets live and what to do when one finishes decoding. */
export function setImageSource(get, onReady) { getAsset = get; onImageReady = onReady; }
async function decode(id) {
  const a = getAsset(id);
  if (!a) return null;
  images.set(id, 'loading');
  const bmp = await createImageBitmap(new Blob([a.bytes], { type: a.mime }));
  images.set(id, bmp);
  return bmp;
}
/** Make sure every picture among `objs` is decoded (call before synchronous renders like export). */
export async function ensureImages(objs) {
  const ids = new Set(objs.filter((o) => o.type === 'image' && !(images.get(o.asset) instanceof ImageBitmap)).map((o) => o.asset));
  await Promise.all([...ids].map(decode));
}
export function drawImageObj(ctx, o, clip) {
  const bmp = images.get(o.asset);
  if (!(bmp instanceof ImageBitmap)) {
    if (!bmp) decode(o.asset).then((b) => b && onImageReady()).catch(() => {});
    return;
  }
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rot) ctx.rotate(o.rot);
  ctx.globalAlpha = o.opacity ?? 1;
  if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
  ctx.drawImage(bmp, 0, 0, o.w, o.h);
  ctx.restore();
}

// ---------------------------------------------------------------- dispatch
export function drawObject(ctx, o, env) {
  if (o.type === 'stroke') drawStroke(ctx, o, env);
  else if (o.type === 'text') drawText(ctx, o);
  else if (o.type === 'image') drawImageObj(ctx, o);
}

/** Draw a layer's objects onto a (transparent) context. */
export function renderLayer(ctx, layer, env, exclude) {
  for (const o of layer.objects) {
    if (exclude && exclude.has(o.id)) continue;
    drawObject(ctx, o, env);
  }
}

/** bitmap = scan image for image pages; refBitmap = original scan shown for comparison on rebuilt pages. */
export function drawBackground(ctx, page, bitmap, refBitmap) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, page.w, page.h);
  if (page.bgVisible !== false) {
    ctx.globalAlpha = page.bgOpacity ?? 1;
    if (page.bg.kind === 'image' && bitmap) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, page.w, page.h);
    } else if (page.bg.kind === 'grid') {
      drawGrid(ctx, page.grid, { x: 0, y: 0, w: page.w, h: page.h });
      const d = page.bg.divider;
      if (d) { ctx.fillStyle = d.color; ctx.fillRect(d.x - d.w / 2, 0, d.w, page.h); }
    }
  }
  if (page.ref && page.refVisible && refBitmap) {
    ctx.globalAlpha = page.refOpacity ?? 0.5;
    ctx.drawImage(refBitmap, 0, 0, page.w, page.h);
  }
  ctx.restore();
}

/**
 * Render a whole page (background + visible layers) into a new canvas at `scale`.
 * Used for export, thumbnails and replay.
 */
export function renderPageCanvas(page, bitmap, scale, { exclude, maxSide = 12000, refBitmap } = {}) {
  const k = Math.min(scale, maxSide / Math.max(page.w, page.h));
  const W = Math.max(1, Math.round(page.w * k)), H = Math.max(1, Math.round(page.h * k));
  const out = new OffscreenCanvas(W, H);
  const ctx = out.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawBackground(ctx, page, bitmap, refBitmap);
  const tmp = new OffscreenCanvas(W, H);
  const t = tmp.getContext('2d');
  const env = { grid: page.grid };
  for (const layer of page.layers) {
    if (!layer.visible || !layer.objects.length) continue;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.clearRect(0, 0, W, H);
    t.setTransform(k, 0, 0, k, 0, 0);
    renderLayer(t, layer, env, exclude);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blend || 'source-over';
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }
  return out;
}
