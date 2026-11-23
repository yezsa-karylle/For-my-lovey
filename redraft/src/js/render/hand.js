// Natural handwriting text. Glyph outlines come from the real font file
// (opentype.js) and every letter instance gets its own size, rotation, slant,
// baseline offset and wobble, the same recipe as the notes engine that
// produced the original pages. Randomness is seeded per object + letter index,
// so retyping keeps earlier letters stable.
//
// Each glyph also has a centre-line "skeleton" so the replay can draw letters
// as pen strokes instead of popping them in.

const fs = (pkg, name, w) => `../node_modules/@fontsource/${pkg}/files/${name}-latin-${w}-normal.woff`;
export const HAND_FONTS = {
  Gaegu: { 300: fs('gaegu', 'gaegu', 300), 400: fs('gaegu', 'gaegu', 400), 700: fs('gaegu', 'gaegu', 700) },
  Caveat: { 400: fs('caveat', 'caveat', 400), 700: fs('caveat', 'caveat', 700) },
  'Patrick Hand': { 400: fs('patrick-hand', 'patrick-hand', 400) },
  Kalam: { 300: fs('kalam', 'kalam', 300), 400: fs('kalam', 'kalam', 400), 700: fs('kalam', 'kalam', 700) },
  'Architects Daughter': { 400: fs('architects-daughter', 'architects-daughter', 400) },
  'Indie Flower': { 400: fs('indie-flower', 'indie-flower', 400) },
};

const fonts = new Map(); // "Gaegu:300" -> { font, upm, cache }
let loading = null;

export function loadHandFonts() {
  if (loading) return loading;
  const ot = (typeof window !== 'undefined' && window.opentype) || null;
  loading = (async () => {
    if (!ot) return;
    for (const [family, weights] of Object.entries(HAND_FONTS)) {
      for (const [w, url] of Object.entries(weights)) {
        try {
          const buf = await (await fetch(url)).arrayBuffer();
          const font = ot.parse(buf);
          fonts.set(`${family}:${w}`, { font, upm: font.unitsPerEm, glyphs: new Map(), skel: new Map() });
        } catch (e) { console.warn('hand font failed', family, w, e); }
      }
    }
  })();
  return loading;
}

export const isHandFamily = (f) => !!HAND_FONTS[f];
function fontFor(o) {
  const ws = HAND_FONTS[o.font] ? Object.keys(HAND_FONTS[o.font]).map(Number) : [];
  if (!ws.length) return null;
  const want = o.weight || 300;
  const w = ws.reduce((b, x) => (Math.abs(x - want) < Math.abs(b - want) ? x : b), ws[0]);
  return fonts.get(`${o.font}:${w}`) || null;
}
export const handReady = (o) => !!fontFor(o);

// ---------------------------------------------------------------- glyph outlines
function glyphData(F, ch) {
  let g = F.glyphs.get(ch);
  if (g) return g;
  const gl = F.font.charToGlyph(ch);
  if (!gl || gl.index === 0) {
    g = { contours: [], adv: F.upm * 0.35, bbox: null };
  } else {
    const contours = [];
    let cur = null, px = 0, py = 0;
    for (const c of gl.path.commands) {
      if (c.type === 'M') { if (cur && cur.length) contours.push(cur); cur = [[c.x, c.y]]; px = c.x; py = c.y; }
      else if (c.type === 'L') { cur.push([c.x, c.y]); px = c.x; py = c.y; }
      else if (c.type === 'C') {
        for (let i = 1; i <= 8; i++) {
          const t = i / 8, u = 1 - t;
          cur.push([u ** 3 * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x, u ** 3 * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y]);
        }
        px = c.x; py = c.y;
      } else if (c.type === 'Q') {
        for (let i = 1; i <= 6; i++) {
          const t = i / 6, u = 1 - t;
          cur.push([u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y]);
        }
        px = c.x; py = c.y;
      } else if (c.type === 'Z') { if (cur && cur.length) contours.push(cur); cur = null; }
    }
    if (cur && cur.length) contours.push(cur);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ct of contours) for (const [x, y] of ct) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    g = { contours, adv: gl.advanceWidth, bbox: contours.length ? { x0, y0, x1, y1 } : null };
  }
  F.glyphs.set(ch, g);
  return g;
}

// ---------------------------------------------------------------- seeded randomness
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rngFor = (seed, k) => mulberry(((seed | 0) * 2654435761) ^ Math.imul(k + 1, 40503) ^ 0x9e3779b9);

// ---------------------------------------------------------------- layout
let layoutCache = new WeakMap();
export function resetHandCache() { layoutCache = new WeakMap(); }

export const handLineHeight = (o) => o.lineH || o.size * (46 / 36);

/** Lay out `text` for object `o`. Coordinates are relative to (o.x, o.y) = left end of the first baseline. */
export function layoutHand(o, text = o.text) {
  let per = layoutCache.get(o);
  if (per && per.has(text)) return per.get(text);
  const F = fontFor(o);
  if (!F) return null;
  const seed = o.seed || 1;
  const jit = o.jitter ?? 1;
  const line = rngFor(seed, -1);
  const R = (r, a) => (r() * 2 - 1) * a * jit;
  const U = (r, a, b) => 1 + ((a + r() * (b - a)) - 1) * jit;
  const slope = R(line, 0.006), slant = R(line, 0.03);
  // Pieces of a line split by the letter eraser keep their original letter shapes and slope.
  const i0 = o.i0 || 0, xoff = o.xoff || 0;
  const glyphs = [];
  const k = o.sx || 1;
  let x = 0, y = 0, x0 = 0, lineNo = 0;
  let wsize = o.size, wy = 0;
  let minX = 0, maxX = 0, minY = -o.size * 0.7, maxY = o.size * 0.25;
  const upm = F.upm;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { lineNo++; y = lineNo * handLineHeight(o); x = 0; x0 = 0; glyphs.push({ i, ch, nl: true }); continue; }
    if (ch === ' ' || ch === '\t') {
      const r = rngFor(seed, (i + i0) * 3 + 1);
      x += o.size * (0.30 + r() * 0.25);
      glyphs.push({ i, ch, space: true, x });
      continue;
    }
    if (i === 0 || /\s/.test(text[i - 1])) {
      // A piece split off mid-word keeps the size/offset of the word it came from.
      const r = rngFor(seed, (i === 0 && o.w0 !== undefined ? o.w0 : i + i0) * 3 + 2);
      wsize = o.size * U(r, 0.95, 1.05);
      wy = R(r, 1.5);
    }
    const r = rngFor(seed, (i + i0) * 3);
    const gd = glyphData(F, ch);
    const s = (wsize / upm) * U(r, 0.93, 1.07);
    const sx = s * U(r, 0.92, 1.06), sy = s * U(r, 0.94, 1.06);
    const rot = R(r, 0.045), shear = slant + R(r, 0.06);
    const by = y + (x - x0 + (lineNo === 0 ? xoff : 0)) * slope + wy + R(r, 1.3);
    const waves = [0, 1, 2].map(() => [(1.5 + r() * 2.5) / upm, (1.5 + r() * 2.5) / upm, r() * 6.3, (0.015 + r() * 0.017) * upm * jit]);
    const inst = { i, ch, gd, x, by, sx, sy, rot, shear, waves, k };
    inst.map = (px, py) => {
      const W = inst.waves;
      const dx = W[0][3] * Math.sin(W[0][0] * py + W[0][1] * px + W[0][2]) + W[1][3] * Math.sin(W[1][0] * py + W[1][1] * px + W[1][2]);
      const dy = W[1][3] * Math.sin(W[1][0] * px + W[1][1] * py + W[1][2]) + W[2][3] * Math.sin(W[2][0] * px + W[2][1] * py + W[2][2]);
      px += dx; py += dy;
      const gx = px * inst.sx + py * inst.sy * inst.shear, gy = -py * inst.sy;
      const c = Math.cos(inst.rot), sn = Math.sin(inst.rot);
      return [(inst.x + gx * c - gy * sn) * k, inst.by + gx * sn + gy * c];
    };
    if (gd.contours.length) {
      const path = new Path2D();
      let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
      for (const ct of gd.contours) {
        ct.forEach(([px, py], j) => {
          const [X, Y] = inst.map(px, py);
          if (j === 0) path.moveTo(X, Y); else path.lineTo(X, Y);
          if (X < gx0) gx0 = X; if (X > gx1) gx1 = X; if (Y < gy0) gy0 = Y; if (Y > gy1) gy1 = Y;
        });
        path.closePath();
      }
      inst.path = path;
      inst.box = { x0: gx0, y0: gy0, x1: gx1, y1: gy1 };
      minX = Math.min(minX, gx0); maxX = Math.max(maxX, gx1); minY = Math.min(minY, gy0); maxY = Math.max(maxY, gy1);
    }
    glyphs.push(inst);
    // o.adv = average letter advance (0.86 in the notes engine; measured per document when rebuilding).
    x += gd.adv * sx * (0.80 + r() * 0.12 * jit + (1 - jit) * 0.06) * ((o.adv ?? 0.86) / 0.86) + R(r, 0.8);
  }
  maxX = Math.max(maxX, x * k);
  const res = { glyphs, width: x * k, box: { x0: minX, y0: minY, x1: maxX, y1: maxY } };
  if (!per) { per = new Map(); layoutCache.set(o, per); }
  if (per.size > 40) per.clear();
  per.set(text, res);
  return res;
}

/** Local bounding box {x0, y0, w, h} relative to (o.x, o.y). */
export function measureHand(o) {
  const L = layoutHand(o, o.text || ' ');
  if (!L) return { x0: 0, y0: -o.size, w: o.size, h: o.size * 1.3 };
  const b = L.box;
  return { x0: b.x0, y0: b.y0, w: Math.max(o.size * 0.4, b.x1 - b.x0), h: b.y1 - b.y0 };
}

/** Predicted natural width of `text` at size 1 (used to infer sizes when rebuilding pages). */
export function naturalWidth(font, weight, text, adv = 0.86) {
  const F = fontFor({ font, weight });
  if (!F) return null;
  let w = 0;
  const words = text.split(/\s+/).filter(Boolean);
  words.forEach((word, wi) => {
    for (const ch of word) w += (glyphData(F, ch).adv / F.upm) * adv;
    if (wi) w += 0.425;
  });
  return w;
}

/** Highest glyph top (as a fraction of the em) among the letters of `text`. */
export function glyphTop(font, weight, text) {
  const F = fontFor({ font, weight });
  if (!F) return 0.7;
  let top = 0;
  for (const ch of text) { const g = glyphData(F, ch); if (g.bbox) top = Math.max(top, g.bbox.y1 / F.upm); }
  return top || 0.7;
}

export function leftBearing(font, weight, ch) {
  const F = fontFor({ font, weight });
  if (!F) return 0;
  const g = glyphData(F, ch);
  return g.bbox ? g.bbox.x0 / F.upm : 0;
}

// ---------------------------------------------------------------- drawing
function fillGlyph(ctx, g) {
  ctx.fill(g.path, 'nonzero');
  ctx.stroke(g.path);
}

/**
 * Draw hand text. opts:
 *   text     - string to draw (default o.text)
 *   partial  - { index, progress, hideTo } letter at `index` is being written (0..1);
 *              letters after it (up to hideTo, default all) are hidden
 *   wipe     - { from, to, progress } letters in [from, to) are being erased (right to left)
 *   hideSet  - Set of letter indices not to draw (already erased)
 * Returns the pen tip position in page coordinates (or null).
 */
export function drawHand(ctx, o, opts = {}) {
  const text = opts.text ?? o.text;
  const L = layoutHand(o, text);
  if (!L) return null;
  let tip = null;
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rot) ctx.rotate(o.rot);
  ctx.globalAlpha = o.opacity ?? 1;
  ctx.fillStyle = ctx.strokeStyle = o.color;
  ctx.lineWidth = 0.9;
  ctx.lineJoin = 'round';
  const P = opts.partial, Wp = opts.wipe;
  for (const g of L.glyphs) {
    if (!g.path) continue;
    if (opts.hideSet && opts.hideSet.has(g.i)) continue;
    if (P && g.i > P.index && g.i < (P.hideTo ?? Infinity)) continue;
    if (P && g.i === P.index) { tip = drawGlyphPartial(ctx, o, g, P.progress); continue; }
    if (Wp && g.i >= Wp.from && g.i < Wp.to) {
      // Erase from the last letter backwards.
      const n = Wp.to - Wp.from;
      const pos = Wp.to - 1 - g.i; // 0 = erased first
      const q = Math.max(0, Math.min(1, Wp.progress * n - pos));
      if (q >= 1) continue;
      const b = g.box;
      ctx.save();
      ctx.beginPath();
      const cut = b.x1 - (b.x1 - b.x0 + 4) * q;
      ctx.rect(b.x0 - 4, b.y0 - 6, cut - b.x0 + 4, b.y1 - b.y0 + 12);
      ctx.clip();
      fillGlyph(ctx, g);
      ctx.restore();
      if (q > 0) tip = { x: cut, y: (b.y0 + b.y1) / 2, eraser: true };
      continue;
    }
    fillGlyph(ctx, g);
  }
  ctx.restore();
  if (tip) {
    const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
    return { x: o.x + tip.x * c - tip.y * s, y: o.y + tip.x * s + tip.y * c, eraser: !!tip.eraser };
  }
  return null;
}

/** Positions (page coords) where each letter starts and ends, for camera/pen planning. */
export function glyphCenters(o, text = o.text) {
  const L = layoutHand(o, text);
  if (!L) return [];
  return L.glyphs.filter((g) => g.box).map((g) => ({ i: g.i, x: o.x + (g.box.x0 + g.box.x1) / 2, y: o.y + (g.box.y0 + g.box.y1) / 2 }));
}

// ---------------------------------------------------------------- skeletons (pen paths)
export function zhangSuen(img, w, h) {
  const idx = (x, y) => y * w + x;
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!img[idx(x, y)]) continue;
          const p2 = img[idx(x, y - 1)], p3 = img[idx(x + 1, y - 1)], p4 = img[idx(x + 1, y)], p5 = img[idx(x + 1, y + 1)];
          const p6 = img[idx(x, y + 1)], p7 = img[idx(x - 1, y + 1)], p8 = img[idx(x - 1, y)], p9 = img[idx(x - 1, y - 1)];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (step === 0 ? (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0) : (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0)) del.push(idx(x, y));
        }
      }
      if (del.length) { changed = true; for (const d of del) img[d] = 0; }
    }
  }
  return img;
}

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Trace a 1-px skeleton into polylines. */
export function traceSkeleton(img, w, h) {
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && img[y * w + x];
  const seen = new Uint8Array(w * h);
  const deg = (x, y) => N8.reduce((s, [dx, dy]) => s + (on(x + dx, y + dy) ? 1 : 0), 0);
  const lines = [];
  const walk = (sx, sy) => {
    const pts = [[sx, sy]];
    seen[sy * w + sx] = 1;
    let x = sx, y = sy, pdx = 0, pdy = 0;
    for (;;) {
      let best = null, bestScore = -Infinity;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (!on(nx, ny) || seen[ny * w + nx]) continue;
        const score = dx * pdx + dy * pdy - (Math.abs(dx) + Math.abs(dy) === 2 ? 0.1 : 0);
        if (score > bestScore) { bestScore = score; best = [nx, ny, dx, dy]; }
      }
      if (!best) break;
      [x, y, pdx, pdy] = best;
      seen[y * w + x] = 1;
      pts.push([x, y]);
    }
    return pts;
  };
  // Start from endpoints, then junction-free loops.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y) && !seen[y * w + x] && deg(x, y) === 1) lines.push(walk(x, y));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y) && !seen[y * w + x]) lines.push(walk(x, y));
  return lines.filter((l) => l.length > 1 || lines.length === 1);
}

function skeletonFor(F, ch) {
  if (F.skel.has(ch)) return F.skel.get(ch);
  const gd = glyphData(F, ch);
  let out = [];
  if (gd.bbox) {
    const k = 110 / F.upm, pad = 4;
    const { x0, y0, x1, y1 } = gd.bbox;
    const w = Math.ceil((x1 - x0) * k) + pad * 2, h = Math.ceil((y1 - y0) * k) + pad * 2;
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const ct of gd.contours) {
      ct.forEach(([px, py], j) => { const X = pad + (px - x0) * k, Y = pad + (y1 - py) * k; j ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath();
    }
    ctx.fill('nonzero');
    const data = ctx.getImageData(0, 0, w, h).data;
    const img = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) img[i] = data[i * 4 + 3] > 110 ? 1 : 0;
    const lines = traceSkeleton(zhangSuen(img, w, h), w, h);
    out = lines.map((l) => {
      // Simplify by sampling every 2nd pixel, back to font units.
      const pts = l.filter((_, i) => i % 2 === 0 || i === l.length - 1).map(([X, Y]) => [x0 + (X - pad) / k, y1 - (Y - pad) / k]);
      const a = pts[0], b = pts[pts.length - 1];
      // Pen order: start at the end nearer the top-left.
      return a[0] * 0.5 - a[1] <= b[0] * 0.5 - b[1] ? pts : pts.reverse();
    });
    out.sort((A, B) => (A[0][0] * 0.6 - A[0][1]) - (B[0][0] * 0.6 - B[0][1]));
    const stroke = (110 / 1000) * F.upm; // rough nib width in font units
    out.nib = stroke;
  }
  F.skel.set(ch, out);
  return out;
}

/** Reveal a glyph along its skeleton up to `progress` (0..1). Returns the local pen tip. */
function drawGlyphPartial(ctx, o, g, progress) {
  const F = fontFor(o);
  const skel = skeletonFor(F, g.ch);
  if (!skel.length || progress >= 1) { fillGlyph(ctx, g); return null; }
  const mapped = skel.map((line) => line.map(([px, py]) => g.map(px, py)));
  let total = 0;
  const lens = mapped.map((l) => { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]); total += s; return s; });
  let remain = total * Math.max(0, progress);
  const nib = Math.max(2.5, o.size * 0.13);
  const clip = new Path2D();
  let tip = null;
  for (let li = 0; li < mapped.length && remain > 0; li++) {
    const l = mapped[li];
    clip.moveTo(l[0][0] + nib, l[0][1]);
    clip.arc(l[0][0], l[0][1], nib, 0, Math.PI * 2);
    tip = { x: l[0][0], y: l[0][1] };
    for (let i = 1; i < l.length && remain > 0; i++) {
      const a = l[i - 1], b = l[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6;
      const t = Math.min(1, remain / seg);
      const ex = a[0] + (b[0] - a[0]) * t, ey = a[1] + (b[1] - a[1]) * t;
      const nx = (-(b[1] - a[1]) / seg) * nib, ny = ((b[0] - a[0]) / seg) * nib;
      clip.moveTo(a[0] + nx, a[1] + ny);
      clip.lineTo(ex + nx, ey + ny);
      clip.lineTo(ex - nx, ey - ny);
      clip.lineTo(a[0] - nx, a[1] - ny);
      clip.closePath();
      clip.moveTo(ex + nib, ey);
      clip.arc(ex, ey, nib, 0, Math.PI * 2);
      remain -= seg * t;
      tip = { x: ex, y: ey };
    }
    void lens;
  }
  ctx.save();
  ctx.clip(clip, 'nonzero');
  fillGlyph(ctx, g);
  ctx.restore();
  return tip;
}
