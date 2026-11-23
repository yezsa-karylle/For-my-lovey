// Rebuild a scanned/rendered notes page as live, editable objects:
// grid-paper background, OCR'd text lines in the handwriting font (same size,
// colour and position), highlighter bars, dashed boxes, separators, underlines,
// and everything else traced into vector strokes.
import { uid, newLayer, clone } from '../core/model.js';
import { rdp, bboxOfPoints } from '../core/geometry.js';
import { detectGrid } from '../render/paper.js';
import { naturalWidth, glyphTop, layoutHand, loadHandFonts, traceSkeleton, zhangSuen } from '../render/hand.js';

// Palette of the notes engine (ink colours as drawn, highlight colours before alpha).
export const PALETTE = {
  ink: '#212126', red: '#e3453d', blue: '#296bd9', gray: '#737880', green: '#268c4d',
  pink: '#fa7366', yellow: '#ffdb26',
};
const KNOWN_SIZES = [22, 24, 28, 30, 32, 33, 34, 36, 37, 44];

const C_NONE = 0, C_DARK = 1, C_RED = 2, C_BLUE = 3, C_YEL = 4, C_PINK = 5, C_GREEN = 6;
const INK_CLASSES = [C_DARK, C_RED, C_BLUE, C_GREEN];
const CLASS_COLOR = { [C_DARK]: 'ink', [C_RED]: 'red', [C_BLUE]: 'blue', [C_GREEN]: 'green' };

function hue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function classifyPixel(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (lum > 165 && r > 225 && g > 175 && b < 200 && r - b > 50 && Math.abs(r - g) < 70) return C_YEL;
  if (lum > 160 && r > 225 && r - g > 25 && r - b > 25 && g > 105) return C_PINK;
  if (sat > 55 && lum < 170) {
    const h = hue(r, g, b);
    if (h < 25 || h > 330) return C_RED;
    if (h > 190 && h < 255) return C_BLUE;
    if (h > 90 && h < 170) return C_GREEN;
    if (h >= 30 && h <= 75 && lum < 150) return C_DARK; // dark ink seen through a yellow highlight
  }
  if (sat < 48 && lum < 150) return C_DARK;
  return C_NONE;
}

/** Looser classification used only to find thin lines/dashes (keeps anti-aliased edges). */
function classifySoft(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (lum > 225) return C_NONE;
  if (sat > 32) {
    const h = hue(r, g, b);
    if ((h < 25 || h > 330) && r - g > 35 && lum < 205 && !(r > 225 && g > 105 && lum > 160 && r - b > 25 && sat < 140)) return C_RED;
    if (h > 190 && h < 255 && lum < 200) return C_BLUE;
    if (h > 90 && h < 170 && lum < 200) return C_GREEN;
  }
  if (sat < 40 && lum < 172) return C_DARK;
  return C_NONE;
}

/** OR each pixel row with the next one, so 2-3px lines that are only half-strong per row still read as solid. */
function thicken(soft, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    out[i] = soft[i] || (y + 1 < H ? soft[i + W] : 0);
  }
  return out;
}

// ---------------------------------------------------------------- connected components
function labelComponents(mask, W, H, x0 = 0, y0 = 0, x1 = W, y1 = H) {
  const labels = new Int32Array(W * H);
  const comps = [];
  const stack = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (!mask[i] || labels[i]) continue;
      const id = comps.length + 1;
      const c = { id, x0: x, y0: y, x1: x, y1: y, area: 0, pix: [], votes: {} };
      labels[i] = id;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop();
        const jx = j % W, jy = (j - jx) / W;
        c.area++;
        c.pix.push(j);
        const m = mask[j];
        c.votes[m] = (c.votes[m] || 0) + 1;
        if (jx < c.x0) c.x0 = jx; if (jx > c.x1) c.x1 = jx; if (jy < c.y0) c.y0 = jy; if (jy > c.y1) c.y1 = jy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = jy + dy;
          if (ny < y0 || ny >= y1) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = jx + dx;
            if (nx < x0 || nx >= x1) continue;
            const k = ny * W + nx;
            if (mask[k] && !labels[k]) { labels[k] = id; stack.push(k); }
          }
        }
      }
      c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1;
      c.cx = (c.x0 + c.x1) / 2; c.cy = (c.y0 + c.y1) / 2;
      comps.push(c);
    }
  }
  return { labels, comps };
}

const majority = (votes, allowed) => {
  let best = null, n = -1;
  for (const [k, v] of Object.entries(votes)) if ((!allowed || allowed.includes(+k)) && v > n) { n = v; best = +k; }
  return best;
};

// ---------------------------------------------------------------- line / dash detection
function findHorizontalStructures(cls, W, H, skip) {
  const solid = [], dashes = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    const runs = [];
    while (x < W) {
      const c = cls[y * W + x];
      if (!INK_CLASSES.includes(c) || skip(x)) { x++; continue; }
      const s = x;
      const votes = {};
      while (x < W && INK_CLASSES.includes(cls[y * W + x]) && !skip(x)) { votes[cls[y * W + x]] = (votes[cls[y * W + x]] || 0) + 1; x++; }
      runs.push({ x0: s, x1: x - 1, len: x - s, c: majority(votes) });
    }
    for (const r of runs) if (r.len >= 46) solid.push({ ...r, y });
    // Dashed: >= 5 short runs of the same colour with regular spacing.
    let seq = [];
    const flush = () => {
      if (seq.length >= 6) {
        const lens = seq.map((r) => r.len), gaps = seq.slice(1).map((r, i) => r.x0 - seq[i].x1 - 1);
        const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
        const minN = seq[0].c === C_DARK ? 8 : 6;
        if (seq.length >= minN && sd(lens) < 3.2 && sd(gaps) < 3.2) dashes.push({ x0: seq[0].x0, x1: seq[seq.length - 1].x1, y, c: seq[0].c, n: seq.length });
      }
      seq = [];
    };
    for (const r of runs) {
      const ok = r.len >= 4 && r.len <= 17;
      const prev = seq[seq.length - 1];
      if (ok && prev && r.c === prev.c && r.x0 - prev.x1 - 1 >= 3 && r.x0 - prev.x1 - 1 <= 14) seq.push(r);
      else { flush(); if (ok) seq.push(r); }
    }
    flush();
  }
  // A real dashed line has empty paper just above and below it; letter bars don't.
  // (Box edges may have text close on the inside, so one clean side is enough.)
  const sideInk = (sg, rows) => {
    let n = 0, tot = 0;
    for (const yy of rows) {
      if (yy < 0 || yy >= H) continue;
      for (let xx = sg.x0; xx <= sg.x1; xx++) { tot++; if (INK_CLASSES.includes(cls[yy * W + xx])) n++; }
    }
    return tot ? n / tot : 1;
  };
  const isolated = (sg) => Math.min(sideInk(sg, [sg.y0 - 4, sg.y0 - 5]), sideInk(sg, [sg.y1 + 4, sg.y1 + 5])) < 0.06;
  return { solid: groupRows(solid, 0.6), dashed: groupRows(dashes, 0.7).filter(isolated) };
}

/** Merge per-row runs that stack vertically into segments with thickness. */
function groupRows(runs, minOverlap) {
  const segs = [];
  for (const r of runs) {
    const s = segs.find((g) => g.y1 >= r.y - 1 && g.c === r.c &&
      Math.min(g.x1, r.x1) - Math.max(g.x0, r.x0) > minOverlap * Math.min(g.x1 - g.x0, r.x1 - r.x0));
    if (s) { s.x0 = Math.min(s.x0, r.x0); s.x1 = Math.max(s.x1, r.x1); s.y1 = r.y; s.rows++; }
    else segs.push({ x0: r.x0, x1: r.x1, y0: r.y, y1: r.y, c: r.c, rows: 1 });
  }
  return segs.filter((s) => s.y1 - s.y0 <= 7);
}

function transpose(cls, W, H) {
  const t = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[x * H + y] = cls[y * W + x];
  return t;
}

// ---------------------------------------------------------------- shape builders
function roundRectPath(x0, y0, x1, y1, r, step = 1.5) {
  const pts = [];
  const arc = (cx, cy, a0, a1) => { for (let a = a0; a <= a1 + 1e-6; a += 0.2) pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); };
  const line = (ax, ay, bx, by) => { const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step)); for (let i = 0; i <= n; i++) pts.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]); };
  arc(x0 + r, y0 + r, Math.PI, 1.5 * Math.PI); line(x0 + r, y0, x1 - r, y0);
  arc(x1 - r, y0 + r, 1.5 * Math.PI, 2 * Math.PI); line(x1, y0 + r, x1, y1 - r);
  arc(x1 - r, y1 - r, 0, 0.5 * Math.PI); line(x1 - r, y1, x0 + r, y1);
  arc(x0 + r, y1 - r, 0.5 * Math.PI, Math.PI); line(x0, y1 - r, x0, y0 + r);
  return pts;
}

/** Split a polyline into dashes of `on` length separated by `off`. */
export function dashPolyline(pts, on, off) {
  const out = [];
  let cur = [], state = true, left = on;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (seg > 1e-6) {
      const t = Math.min(seg, left);
      const p = [a[0] + ((b[0] - a[0]) * t) / seg, a[1] + ((b[1] - a[1]) * t) / seg];
      if (state) { if (!cur.length) cur.push([a[0], a[1], 0]); cur.push([p[0], p[1], 0]); }
      left -= t; seg -= t; a = p;
      if (left <= 1e-6) {
        if (state && cur.length > 1) out.push(cur);
        cur = []; state = !state; left = state ? on : off;
      }
    }
  }
  if (state && cur.length > 1) out.push(cur);
  return out;
}

const strokeObj = (props) => ({ id: uid('s'), type: 'stroke', tool: 'pen', opacity: 1, shape: 'trace', ...props });

// ---------------------------------------------------------------- OCR
let ocrWorker = null;
export async function getOcr(logger) {
  if (ocrWorker) return ocrWorker;
  const T = window.Tesseract;
  if (!T) throw new Error('OCR engine not available');
  const abs = (p) => new URL(p, document.baseURI).href;
  ocrWorker = await T.createWorker('eng', 1, {
    workerPath: abs('../node_modules/tesseract.js/dist/worker.min.js'),
    corePath: abs('../node_modules/tesseract.js-core'),
    langPath: abs(`../node_modules/@tesseract.js-data/eng/${window.__ocrLang || '4.0.0_best_int'}`),
    cacheMethod: 'none',
    gzip: true,
    workerBlobURL: false,
    logger: logger || (() => {}),
  });
  return ocrWorker;
}

async function ocrImage(canvas, psm) {
  const w = await getOcr();
  await w.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '0', tessedit_char_blacklist: '|~{}[]_\\@#$^`¢§«»©®°±' });
  const { data } = await w.recognize(canvas);
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words) words.push(wd);
  if (!words.length && data.words) words.push(...data.words);
  return { words, text: data.text, confidence: data.confidence };
}

// ---------------------------------------------------------------- vocabulary correction
// The handwriting font has systematic look-alikes (a/o, u/w, rn/m...). Low-confidence
// words are snapped to words read confidently elsewhere in the notes.
const CONFUSE = { 'a|o': 0.3, 'u|w': 0.35, 'n|r': 0.5, 'e|c': 0.4, 'l|i': 0.3, 'i|t': 0.5, 'h|b': 0.5, 'n|h': 0.5, 'a|d': 0.5, 'f|t': 0.5, 'y|v': 0.5, 'm|n': 0.5, 's|5': 0.4 };
const subCost = (a, b) => (a === b ? 0 : CONFUSE[a < b ? a + '|' + b : b + '|' + a] ?? 1);
function wDist(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + subCost(a[i - 1], b[j - 1]));
      if (i > 1 && j > 1 && a.slice(i - 2, i) === 'rn' && b[j - 1] === 'm') cur[j] = Math.min(cur[j], prev[j - 1]);
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length];
}
const COMMON = 'the and of to a in is for on that with as by be are this it from or at an not can more also all its their they your our has have'.split(' ');
export const vocab = new Map(COMMON.map((w) => [w, 5]));
export function learnWords(words) {
  for (const w of words) if (w.conf >= 88) for (const t of w.text.toLowerCase().match(/[a-z]{3,}/g) || []) vocab.set(t, (vocab.get(t) || 0) + 1);
}
export function correctWord(text, conf) {
  if (conf >= 80) return text;
  return text.replace(/[A-Za-z]{3,}/g, (wd) => {
    const low = wd.toLowerCase();
    if ((vocab.get(low) || 0) >= 1) return wd;
    let best = null, bd = Infinity;
    for (const [v, n] of vocab) {
      if (n < 2 || Math.abs(v.length - low.length) > 2) continue;
      const d = wDist(low, v);
      if (d < bd || (d === bd && n > (vocab.get(best) || 0))) { bd = d; best = v; }
    }
    if (!best || bd > Math.min(1.2, low.length * 0.2)) return wd;
    // Keep the original capitalisation pattern.
    if (wd === wd.toUpperCase()) return best.toUpperCase();
    if (wd[0] === wd[0].toUpperCase()) return best[0].toUpperCase() + best.slice(1);
    return best;
  });
}

/**
 * Fix letter case the recogniser gets wrong in this handwriting: s/c/o/v/w/x/z look
 * the same in both cases, so "denSity", "SoCial", "ACCess" and a stray "Structure"
 * mid-sentence are lowered. ALL-CAPS words and Title Case lines are left alone.
 */
export function fixCase(t) {
  const words = t.split(' ');
  const long = words.filter((w) => /^[A-Za-z]{3,}/.test(w));
  const title = long.length >= 2 && long.filter((w) => /^[A-Z]/.test(w)).length / long.length >= 0.6;
  return words.map((w, i) => {
    const m = /^([^A-Za-z]*)([A-Za-z]+)(.*)$/.exec(w);
    if (!m) return w;
    let [, pre, core, post] = m;
    if (core.length >= 2 && core === core.toUpperCase()) return w; // acronym / caps title
    if (/[a-z]/.test(core.slice(1))) core = core[0] + core.slice(1).toLowerCase();
    const prev = words[i - 1] || '';
    const sentenceStart = i === 0 || /[.!?:]$/.test(prev) || /^\d+\.$/.test(prev) || /^[-*=]+$/.test(prev);
    if (!title && !sentenceStart && /^[CSOVWXZ][a-z]/.test(core)) core = core[0].toLowerCase() + core.slice(1);
    return pre + core + post;
  }).join(' ');
}

export function cleanOcrText(t) {
  return t
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/-\s?[)>]/g, '->').replace(/<\s?-/g, '<-')
    .replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- main
/**
 * Analyse a page raster. `source` is a canvas/bitmap of the page at page resolution.
 * Returns { grid, divider, layers: { highlights, lines, text }, stats }.
 */
export async function analyzePage(source, pageW, pageH, { onProgress = () => {}, textItems = null } = {}) {
  await loadHandFonts();
  const W = pageW, H = pageH;
  const cv = new OffscreenCanvas(W, H);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(source, 0, 0, W, H);
  const data = cx.getImageData(0, 0, W, H).data;
  const lumAt = (i) => 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  onProgress('Reading colours');

  // Grid.
  const gd = detectGrid(source, W, H);
  const snap = (v) => (Math.abs(v - Math.round(v)) < 0.3 ? Math.round(v) : v);
  const grid = {
    sx: gd.found ? snap(gd.sx) : W / 37, sy: gd.found ? snap(gd.sy) : W / 37,
    ox: gd.found ? gd.ox : 0, oy: gd.found ? gd.oy : 0,
    paper: gd.paper, line: gd.found ? gd.line : '#c4c6ca', lw: 1.2,
  };
  // Refine line positions at full resolution: the darkest phase along mostly-paper pixels.
  if (gd.found) {
    const refine = (horiz) => {
      const sp = horiz ? grid.sx : grid.sy;
      let best = Infinity, bestO = 0;
      for (let o = 0; o < sp; o += 0.5) {
        let sum = 0, n = 0;
        for (let k = 0; ; k++) {
          const p = Math.round(o + k * sp);
          if (p >= (horiz ? W : H)) break;
          for (let q = 0; q < (horiz ? H : W); q += 9) {
            const i = horiz ? q * W + p : p * W + q;
            const L = lumAt(i);
            if (L < 140) continue; // skip ink
            sum += L; n++;
          }
        }
        if (n && sum / n < best) { best = sum / n; bestO = o; }
      }
      return Math.round(bestO) + 0.5;
    };
    grid.ox = refine(true);
    grid.oy = refine(false);
  }
  grid.ox = ((grid.ox % grid.sx) + grid.sx) % grid.sx;
  grid.oy = ((grid.oy % grid.sy) + grid.sy) % grid.sy;
  if (grid.ox < 1.2 || grid.ox > grid.sx - 1.2) grid.ox = 0.5;
  if (grid.oy < 1.2 || grid.oy > grid.sy - 1.2) grid.oy = 0.5;

  // Centre divider: a thick mid-gray band spanning (nearly) the full height.
  let divider = null;
  {
    const cols = [];
    for (let x = Math.round(W * 0.3); x < W * 0.7; x++) {
      let n = 0;
      for (let y = 0; y < H; y += 4) {
        const i = y * W + x, L = lumAt(i);
        const sat = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) - Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        if (L > 110 && L < 185 && sat < 20) n++;
      }
      if (n > (H / 4) * 0.85) cols.push(x);
    }
    if (cols.length >= 3 && cols[cols.length - 1] - cols[0] < 30) {
      const a = cols[0], b = cols[cols.length - 1];
      let r = 0, g = 0, bl = 0, n = 0;
      for (let y = 0; y < H; y += 7) for (let x = a + 1; x < b; x++) { const i = (y * W + x) * 4; r += data[i]; g += data[i + 1]; bl += data[i + 2]; n++; }
      const hx = (v) => Math.round(v / n).toString(16).padStart(2, '0');
      divider = { x: (a + b + 1) / 2, w: b - a + 1.2, color: '#' + hx(r) + hx(g) + hx(bl) };
    }
  }
  const inDivider = divider ? (x) => Math.abs(x + 0.5 - divider.x) <= divider.w / 2 + 2 : () => false;

  // Pixel classes.
  const cls = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    if (inDivider(x)) continue;
    cls[i] = classifyPixel(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }

  // ---- highlighter bars
  onProgress('Finding highlights');
  const hlMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (cls[i] === C_YEL || cls[i] === C_PINK) hlMask[i] = cls[i];
  const highlights = [];
  // Letters written over a highlight cut it into pieces: merge pieces on the same row.
  const hcomps = labelComponents(hlMask, W, H).comps.filter((c) => c.area > 20).sort((a, b) => a.x0 - b.x0);
  hcomps.forEach((c) => { c.kind = majority(c.votes); });
  const merged = [];
  for (const c of hcomps) {
    const m = merged.find((g) => g.kind === c.kind && c.x0 - g.x1 <= 30 && Math.min(g.y1, c.y1) - Math.max(g.y0, c.y0) > 0.5 * Math.min(g.h, c.h));
    if (m) {
      m.x0 = Math.min(m.x0, c.x0); m.x1 = Math.max(m.x1, c.x1); m.y0 = Math.min(m.y0, c.y0); m.y1 = Math.max(m.y1, c.y1);
      m.h = m.y1 - m.y0 + 1; m.w = m.x1 - m.x0 + 1; m.area += c.area; m.pix = m.pix.concat(c.pix);
      for (const [k, v] of Object.entries(c.votes)) m.votes[k] = (m.votes[k] || 0) + v;
    } else merged.push({ ...c });
  }
  // Absorb small mis-coloured fragments into the highlight they touch.
  for (const c of merged) {
    if (c.dead) continue;
    for (const d of merged) {
      if (d === c || d.dead || d.area > c.area * 0.35) continue;
      const touch = d.x0 <= c.x1 + 12 && d.x1 >= c.x0 - 12 && Math.min(c.y1, d.y1) - Math.max(c.y0, d.y0) > 0.4 * Math.min(c.h, d.h);
      if (touch) { d.dead = true; c.x0 = Math.min(c.x0, d.x0); c.x1 = Math.max(c.x1, d.x1); c.w = c.x1 - c.x0 + 1; }
    }
  }
  for (const c of merged) {
    if (c.dead || c.area < 160 || c.h < 8 || c.w < 24) continue;
    const kind = majority(c.votes) === C_YEL ? 'yellow' : 'pink';
    // Alpha from the most saturated pixels (multiply blend over white paper).
    const ch = kind === 'yellow' ? 2 : 1;
    const base = kind === 'yellow' ? 38 / 255 : 115 / 255;
    const vals = c.pix.map((j) => data[j * 4 + ch] / 255).sort((a, b) => a - b);
    const v = vals[Math.floor(vals.length * 0.3)];
    const alpha = Math.max(0.3, Math.min(0.95, (1 - v) / (1 - base)));
    // Robust vertical extent (ignore letters poking through).
    const ys = c.pix.map((j) => Math.floor(j / W)).sort((a, b) => a - b);
    const ya = ys[Math.floor(ys.length * 0.04)], yb = ys[Math.floor(ys.length * 0.96)];
    const h = Math.max(8, yb - ya + 1), cy = (ya + yb) / 2;
    highlights.push(strokeObj({
      tool: 'highlighter', shape: 'line', color: PALETTE[kind], size: h, alpha, opacity: 1,
      paths: [[[c.x0 + h / 2, cy, 0], [(c.x0 + c.x1) / 2, cy, 0], [c.x1 - h / 2 + 1, cy, 0]]],
    }));
  }

  // ---- dashed boxes, separators, underlines
  onProgress('Finding boxes and lines');
  const soft = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (!inDivider(i % W)) soft[i] = classifySoft(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const hs = findHorizontalStructures(thicken(soft, W, H), W, H, inDivider);
  const vt = findHorizontalStructures(thicken(transpose(soft, W, H), H, W), H, W, () => false);
  const vDashed = vt.dashed.map((s) => ({ y0: s.x0, y1: s.x1, x0: s.y0, x1: s.y1, c: s.c }));
  const lines = [];
  const erase = []; // rectangles of pixels to drop before reading text
  const usedV = new Set(), usedVD = new Set();
  const mergeCollinear = (segs, horiz) => {
    const out = [];
    const key = horiz ? (s) => (s.y0 + s.y1) / 2 : (s) => (s.x0 + s.x1) / 2;
    const lo = horiz ? 'x0' : 'y0', hi = horiz ? 'x1' : 'y1';
    for (const sg of [...segs].sort((a, b) => a[lo] - b[lo])) {
      const m = out.find((o) => o.c === sg.c && Math.abs(key(o) - key(sg)) <= 3 && sg[lo] - o[hi] <= 60);
      if (m) { m[hi] = Math.max(m[hi], sg[hi]); m.x0 = Math.min(m.x0, sg.x0); m.y0 = Math.min(m.y0, sg.y0); m.x1 = Math.max(m.x1, sg.x1); m.y1 = Math.max(m.y1, sg.y1); }
      else out.push({ ...sg });
    }
    return out;
  };
  if (typeof window !== 'undefined' && window.__rebuildDebug) window.__dbgStructs = { vRaw: vt.dashed.slice(0, 20), hRaw: hs.dashed.slice(0, 20) };
  hs.dashed = mergeCollinear(hs.dashed, true);
  vDashed.splice(0, vDashed.length, ...mergeCollinear(vDashed, false));
  const hD = hs.dashed.filter((s) => s.x1 - s.x0 >= 150).sort((a, b) => a.y0 - b.y0);
  const usedH = new Set();
  const addBox = (x0, y0, x1, y1, c, th) => {
    const r = 8;
    lines.push(strokeObj({ color: PALETTE[CLASS_COLOR[c] || 'red'], size: th + 0.4, paths: dashPolyline(roundRectPath(x0, y0, x1, y1, r), 9 + th, 8 - th * 0.5), box: { x0, y0, x1, y1, r }, kind: 'dashbox' }));
    erase.push({ x0: x0 - 7, y0: y0 - 7, x1: x1 + 7, y1: y0 + 6 }, { x0: x0 - 7, y0: y1 - 6, x1: x1 + 7, y1: y1 + 7 });
    erase.push({ x0: x0 - 7, y0: y0 - 7, x1: x0 + 6, y1: y1 + 7 }, { x0: x1 - 6, y0: y0 - 7, x1: x1 + 7, y1: y1 + 7 });
  };
  // Boxes from their two vertical dashed sides (long and clean even when text touches the top edge).
  const vLong = vDashed.filter((v) => v.y1 - v.y0 >= 90);
  for (let a = 0; a < vLong.length; a++) {
    for (let b = 0; b < vLong.length; b++) {
      const L = vLong[a], R = vLong[b];
      if (a === b || usedV.has(a) || usedV.has(b) || L.c !== R.c || R.x0 - L.x1 < 80) continue;
      if (Math.abs(L.y0 - R.y0) > 30 || Math.abs(L.y1 - R.y1) > 30) continue;
      const x0 = (L.x0 + L.x1) / 2 + 0.5, x1 = (R.x0 + R.x1) / 2 + 0.5;
      // The horizontal edges sit about one corner radius beyond the vertical dashes.
      const near = (y) => hD.findIndex((h, k) => !usedH.has(k) && h.c === L.c && Math.abs((h.y0 + h.y1) / 2 - y) < 16 && h.x0 < x1 && h.x1 > x0);
      const ti = near(Math.min(L.y0, R.y0) - 8), bi = near(Math.max(L.y1, R.y1) + 8);
      const y0 = ti >= 0 ? (hD[ti].y0 + hD[ti].y1) / 2 : Math.min(L.y0, R.y0) - 8;
      const y1 = bi >= 0 ? (hD[bi].y0 + hD[bi].y1) / 2 : Math.max(L.y1, R.y1) + 8;
      hD.forEach((h, k) => { const hy = (h.y0 + h.y1) / 2; if (h.c === L.c && h.x0 >= x0 - 20 && h.x1 <= x1 + 20 && (Math.abs(hy - y0) < 8 || Math.abs(hy - y1) < 8)) usedH.add(k); });
      usedV.add(a); usedV.add(b);
      addBox(x0, y0, x1, y1, L.c, Math.max(1.8, Math.min(4, (L.x1 - L.x0 + R.x1 - R.x0) / 2)));
    }
  }
  const inBox = (sg) => lines.some((o) => o.box && sg.x0 >= o.box.x0 - 12 && sg.x1 <= o.box.x1 + 12 && sg.y0 >= o.box.y0 - 12 && sg.y1 <= o.box.y1 + 12);
  for (let i = 0; i < hD.length; i++) {
    if (usedH.has(i)) continue;
    const top = hD[i];
    if (inBox(top)) { usedH.add(i); continue; }
    // Matching bottom edge with similar extent.
    let bi = -1;
    for (let j = i + 1; j < hD.length; j++) {
      const b = hD[j];
      if (usedH.has(j) || b.c !== top.c || inBox(b)) continue;
      if (Math.abs(b.x0 - top.x0) < 24 && Math.abs(b.x1 - top.x1) < 24 && b.y0 - top.y1 > 30) { bi = j; break; }
    }
    if (bi >= 0) {
      const bot = hD[bi];
      const left = vDashed.findIndex((v, k) => !usedVD.has(k) && v.c === top.c && Math.abs(v.x0 - top.x0) < 26 && v.y0 > top.y0 - 20 && v.y1 < bot.y1 + 20);
      const right = vDashed.findIndex((v, k) => !usedVD.has(k) && v.c === top.c && Math.abs(v.x1 - top.x1) < 26 && v.y0 > top.y0 - 20 && v.y1 < bot.y1 + 20);
      if (left >= 0) usedVD.add(left);
      if (right >= 0) usedVD.add(right);
      const r = 8;
      const x0 = left >= 0 ? (vDashed[left].x0 + vDashed[left].x1) / 2 : top.x0 - r;
      const x1 = right >= 0 ? (vDashed[right].x0 + vDashed[right].x1) / 2 : top.x1 + r;
      const y0 = (top.y0 + top.y1) / 2, y1 = (bot.y0 + bot.y1) / 2;
      const th = Math.max(1.8, Math.min(4, (top.y1 - top.y0 + bot.y1 - bot.y0) / 2));
      lines.push(strokeObj({ color: PALETTE[CLASS_COLOR[top.c] || 'red'], size: th + 0.4, paths: dashPolyline(roundRectPath(x0, y0, x1, y1, r), 9 + th, 8 - th * 0.5), box: { x0, y0, x1, y1, r }, kind: 'dashbox' }));
      erase.push({ x0: x0 - 6, y0: y0 - 6, x1: x1 + 6, y1: y0 + 6 }, { x0: x0 - 6, y0: y1 - 6, x1: x1 + 6, y1: y1 + 6 });
      erase.push({ x0: x0 - 6, y0: y0 - 6, x1: x0 + 6, y1: y1 + 6 }, { x0: x1 - 6, y0: y0 - 6, x1: x1 + 6, y1: y1 + 6 });
      usedH.add(i); usedH.add(bi);
    } else if (top.x1 - top.x0 >= 160) {
      // Dashed separator.
      const y = (top.y0 + top.y1) / 2 + 0.5, th = Math.max(1.8, top.y1 - top.y0);
      lines.push(strokeObj({ color: PALETTE[CLASS_COLOR[top.c] || 'red'], size: th + 0.4, paths: dashPolyline([[top.x0, y], [top.x1, y]], 10 + th, 8 - th * 0.5), kind: 'dashline' }));
      erase.push({ x0: top.x0 - 3, y0: top.y0 - 3, x1: top.x1 + 3, y1: top.y1 + 3 });
      usedH.add(i);
    }
  }
  const inHighlight = (sg) => highlights.some((o) => {
    const b = bboxOfPoints(o.paths[0], o.size / 2 + 3);
    return sg.x0 >= b.x - 4 && sg.x1 <= b.x + b.w + 4 && sg.y0 >= b.y && sg.y1 <= b.y + b.h;
  });
  for (const s of hs.solid) {
    if (s.x1 - s.x0 < 46 || inHighlight(s)) continue;
    const y = (s.y0 + s.y1) / 2 + 0.5, th = Math.max(1.6, s.y1 - s.y0);
    lines.push(strokeObj({ color: PALETTE[CLASS_COLOR[s.c] || 'ink'], size: th + 0.3, paths: [[[s.x0 + th / 2, y, 0], [s.x1 - th / 2, y, 0]]], kind: 'line' }));
    erase.push({ x0: s.x0 - 1, y0: s.y0 - 1, x1: s.x1 + 1, y1: s.y1 + 1 });
  }

  // ---- ink components
  onProgress('Separating letters from drawings');
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (INK_CLASSES.includes(cls[i])) ink[i] = cls[i];
  for (const e of erase) {
    for (let y = Math.max(0, Math.floor(e.y0)); y <= Math.min(H - 1, Math.ceil(e.y1)); y++) {
      for (let x = Math.max(0, Math.floor(e.x0)); x <= Math.min(W - 1, Math.ceil(e.x1)); x++) ink[y * W + x] = 0;
    }
  }
  const { comps } = labelComponents(ink, W, H);
  const sy = grid.sy;
  const glyphs = [], sketches = [];
  for (const c of comps) {
    c.cls = majority(c.votes, INK_CLASSES);
    if (c.area < 3) continue;
    if (c.h > sy * 1.35 || c.w > sy * 2.8) sketches.push(c); else glyphs.push(c);
  }

  // Baseline offset within a grid row = most common bottom of mid-sized glyphs.
  const hist = new Array(Math.ceil(sy) + 1).fill(0);
  for (const c of glyphs) if (c.h > sy * 0.22 && c.h < sy * 0.55) hist[Math.round(((c.y1 + 1 - grid.oy) % sy + sy) % sy)]++;
  const m = hist.indexOf(Math.max(...hist));
  const baseOf = (row) => grid.oy + row * sy + m;
  const rowOf = (c) => Math.round((c.cy + sy * 0.3 - grid.oy - m) / sy);

  // ---- group letters into runs (same row, same side of the divider, same colour, small gaps)
  const midX = divider ? divider.x : W / 2;
  const byRow = new Map();
  for (const c of glyphs) {
    const key = rowOf(c) * 2 + (c.cx < midX ? 0 : 1);
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(c);
  }
  const runs = [];
  const gapT = sy * 0.72;
  for (const [key, list] of byRow) {
    list.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const c of list) {
      const small = c.area < 90;
      const gap = c.x0 - cur?.x1;
      if (cur && gap <= gapT && (small || cur.cls === c.cls || cur.smallOnly || gap <= 6)) {
        cur.comps.push(c); cur.x1 = Math.max(cur.x1, c.x1); cur.y0 = Math.min(cur.y0, c.y0); cur.y1 = Math.max(cur.y1, c.y1);
        if (!small && cur.smallOnly) { cur.cls = c.cls; cur.smallOnly = false; }
      } else {
        cur = { row: Math.floor(key / 2), side: key % 2, comps: [c], x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, cls: c.cls, smallOnly: small };
        runs.push(cur);
      }
    }
  }

  // ---- OCR: one pass per column on a clean black-on-white image, then per-run retries.
  const SCALE = 3;
  const OCR_PSM_LINES = (typeof window !== 'undefined' && window.__ocrMode) || 'column';
  // Clean OCR image: only the run's letters, using the scan's own grey levels
  // (anti-aliasing helps the recogniser), grid/highlights/other ink removed.
  const clean = (x0, y0, x1, y1, items) => {
    const w0 = x1 - x0, h0 = y1 - y0;
    const small = new OffscreenCanvas(w0, h0);
    const sg = small.getContext('2d');
    const img = sg.createImageData(w0, h0);
    img.data.fill(255);
    const keep = new Uint8Array(w0 * h0);
    for (const it of items) for (const comp of it.comps) for (const j of comp.pix) {
      const px = j % W, py = (j - px) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx - x0, qy = py + dy - y0;
        if (qx >= 0 && qy >= 0 && qx < w0 && qy < h0) keep[qy * w0 + qx] = Math.max(keep[qy * w0 + qx], dx || dy ? 1 : 2);
      }
    }
    for (let i = 0; i < w0 * h0; i++) {
      if (!keep[i]) continue;
      const gx = (i % w0) + x0, gy = Math.floor(i / w0) + y0, gi = gy * W + gx;
      if (keep[i] === 1 && (cls[gi] === C_YEL || cls[gi] === C_PINK)) continue;
      const r = data[gi * 4], g = data[gi * 4 + 1], b = data[gi * 4 + 2];
      // Darkness relative to paper, colour-blind (red/blue ink count as dark).
      const dark = Math.max(0, 255 - Math.min(r, g, b) * 0.55 - (0.299 * r + 0.587 * g + 0.114 * b) * 0.45);
      let v = 255 - Math.min(255, dark * (keep[i] === 2 ? 1.6 : 1.1));
      if (keep[i] === 1 && v > 170) v = 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    }
    sg.putImageData(img, 0, 0);
    const c = document.createElement('canvas');
    // iOS Safari refuses canvases above ~16.7 million pixels.
    const k = Math.min(SCALE, Math.sqrt(16e6 / (w0 * h0)));
    c.width = Math.ceil(w0 * k); c.height = Math.ceil(h0 * k);
    c.ocrScale = k;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, c.width, c.height);
    return c;
  };

  if (textItems) {
    // PDF with real text: use it directly.
    for (const r of runs) r.words = [];
    for (const t of textItems) {
      const run = runs.find((r) => t.x + 2 >= r.x0 - 6 && t.x + 2 <= r.x1 + 6 && Math.abs(t.base - baseOf(r.row)) < sy * 0.6);
      if (run) run.words.push({ text: t.str, conf: 100, x0: t.x });
    }
  } else {
    for (const r of runs) r.words = [];
    for (const side of OCR_PSM_LINES === 'column' ? [0, 1] : []) {
      const items = runs.filter((r) => r.side === side);
      if (!items.length) continue;
      onProgress(`Reading text (column ${side + 1})`);
      const x0 = side === 0 ? 0 : Math.ceil(midX + (divider ? divider.w / 2 : 0));
      const x1 = side === 0 ? Math.floor(midX - (divider ? divider.w / 2 : 0)) : W;
      const img = clean(x0, 0, x1, H, items);
      const res = await ocrImage(img, 4);
      const S = img.ocrScale || SCALE;
      for (const r of items) r.words = [];
      for (const wd of res.words) {
        const t = wd.text.trim();
        if (!t) continue;
        const bx0 = wd.bbox.x0 / S + x0, bx1 = wd.bbox.x1 / S + x0, by0 = wd.bbox.y0 / S, by1 = wd.bbox.y1 / S;
        const cxw = (bx0 + bx1) / 2, cyw = (by0 + by1) / 2;
        let best = null, bestD = Infinity;
        for (const r of items) {
          if (cxw < r.x0 - 4 || cxw > r.x1 + 4) continue;
          const d = Math.abs(cyw - (r.y0 + r.y1) / 2);
          if (d < bestD && d < sy * 0.6) { bestD = d; best = r; }
        }
        if (best) best.words.push({ text: t, conf: wd.confidence, x0: bx0, x1: bx1 });
      }
    }
    // Retry runs that came back empty or only partly covered, one line at a time.
    const retry = OCR_PSM_LINES === 'line' ? runs.filter((r) => r.x1 - r.x0 > 6) : runs.filter((r) => {
      const cov = r.words.reduce((s, w) => s + (w.x1 - w.x0), 0) / Math.max(1, r.x1 - r.x0);
      return r.x1 - r.x0 > 8 && (!r.words.length || cov < 0.55 || r.words.some((w) => w.conf < 45));
    });
    for (const [k, r] of retry.entries()) {
      onProgress(OCR_PSM_LINES === 'line' ? `Reading line ${k + 1} of ${retry.length}` : `Re-reading unclear lines (${k + 1}/${retry.length})`);
      const pad = 10;
      const cx0 = Math.max(0, r.x0 - pad), cy0 = Math.max(0, r.y0 - pad);
      const img = clean(cx0, cy0, Math.min(W, r.x1 + pad), Math.min(H, r.y1 + pad), [r]);
      const res = await ocrImage(img, 7);
      const t = cleanOcrText(res.text || '');
      const boxedWords = res.words.filter((w) => w.text.trim()).map((w) => ({ text: w.text.trim(), conf: w.confidence, x0: w.bbox.x0 / (img.ocrScale || SCALE) + cx0, x1: w.bbox.x1 / (img.ocrScale || SCALE) + cx0 }));
      if (t && res.confidence >= Math.max(30, ...r.words.map((w) => w.conf), 0) - 5) {
        r.words = boxedWords.length ? boxedWords : [{ text: t, conf: res.confidence, x0: r.x0, x1: r.x1 }];
      }
    }
  }

  // ---- build text objects
  onProgress('Matching handwriting');
  const textObjs = [];
  const leftovers = [];
  const darkLevel = (r) => {
    const v = [];
    for (const c of r.comps) for (const j of c.pix) if (ink[j] === C_DARK) v.push(lumAt(j));
    v.sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length * 0.2)] : 0;
  };
  const strokeWidth = (r) => {
    let area = 0, perim = 0;
    for (const c of r.comps) {
      area += c.area;
      const set = new Set(c.pix);
      for (const j of c.pix) if (!set.has(j - 1) || !set.has(j + 1) || !set.has(j - W) || !set.has(j + W)) perim++;
    }
    return perim ? (2 * area) / perim : 2;
  };
  const widths = runs.map(strokeWidth);
  const medW = widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)] || 2;
  learnWords(runs.flatMap((r) => r.words));
  runs.forEach((r, ri) => {
    const text = fixCase(cleanOcrText(r.words.sort((a, b) => a.x0 - b.x0).map((w) => correctWord(w.text, w.conf)).join(' ')));
    const conf = r.words.length ? r.words.reduce((s, w) => s + w.conf, 0) / r.words.length : 0;
    if (!text || !/[A-Za-z0-9]/.test(text) || conf < 8) { leftovers.push(...r.comps); return; }
    let color = PALETTE[CLASS_COLOR[r.cls] || 'ink'];
    if (r.cls === C_DARK && darkLevel(r) > 85) color = PALETTE.gray;
    const weight = /^TOPIC\b/i.test(text) || widths[ri] > medW * 1.35 ? 400 : 300;
    const nw = naturalWidth('Gaegu', weight, text) || text.length * 0.4;
    const inkW = r.x1 - r.x0 + 1;
    // Baseline: the grid row if the letters sit on it, otherwise measured.
    const bottoms = r.comps.filter((c) => c.h > sy * 0.2).map((c) => c.y1 + 1).sort((a, b) => a - b);
    const measured = bottoms.length ? bottoms[Math.floor(bottoms.length * 0.35)] : r.y1;
    const rowBase = baseOf(r.row);
    const y = Math.abs(measured - rowBase) <= 7 ? rowBase : measured;
    // Size from two independent cues: line width (needs correct OCR) and letter height (needs none).
    // Width of just the words the OCR recognised (characters it missed don't skew the ratio).
    const boxed = r.words.filter((w) => w.x1 > w.x0 && w.x1 - w.x0 < inkW + 2);
    const span = boxed.length >= 1 && boxed.length === r.words.length ? boxed[boxed.length - 1].x1 - boxed[0].x0 + 1 : inkW;
    const spanText = boxed.length >= 1 && boxed.length === r.words.length ? cleanOcrText(boxed.map((w) => w.text).join(' ')) : text;
    const sizeW = span / Math.max(0.2, (naturalWidth('Gaegu', weight, spanText) || nw) - 0.06);
    const tops = r.comps.filter((c) => c.area >= 12).map((c) => c.y0).sort((a, b) => a - b);
    const topY = tops.length ? tops[Math.min(tops.length - 1, Math.floor(tops.length * 0.08))] : r.y0;
    // Jitter (tilt, wobble, per-letter scale) lifts the highest letter ~14% above the font's nominal top.
    const sizeH = (y - topY) / (glyphTop('Gaegu', weight, text) * 1.14);
    // Per-word estimate: robust to punctuation the OCR dropped or a garbled word.
    const per = r.words
      .filter((w) => w.conf >= 70 && w.x1 > w.x0 && /^[A-Za-z]{3,}[.,;:]?$/.test(w.text))
      .map((w) => (w.x1 - w.x0 - 2) / Math.max(0.3, (naturalWidth('Gaegu', weight, w.text.replace(/[.,;:]$/, '')) || 1) - 0.06)) // OCR boxes carry ~3px padding
      .sort((a, b) => a - b);
    // Median of the whole-line estimate and each confidently read word: one misread
    // character (an extra "(" or a dropped ":") can't drag the size far.
    const cands = [sizeW, ...per].sort((a, b) => a - b);
    let size = cands.length % 2 ? cands[(cands.length - 1) / 2] : (cands[cands.length / 2 - 1] + cands[cands.length / 2]) / 2;
    if (Math.abs(size - sizeH) / sizeH > 0.45) size = sizeH; // OCR text is clearly off: trust letter height
    const near = KNOWN_SIZES.reduce((b, s) => (Math.abs(s - size) < Math.abs(b - size) ? s : b), KNOWN_SIZES[0]);
    if (Math.abs(near - size) / size < 0.09) size = near;
    size = Math.max(10, Math.min(90, Math.round(size)));
    if (typeof window !== 'undefined' && window.__rebuildDebug) r.sizeDbg = { sizeW: +sizeW.toFixed(1), sizeH: +sizeH.toFixed(1), per: per.map((v) => +v.toFixed(1)), span, inkW, spanText, topY, y, gt: glyphTop('Gaegu', weight, text) };
    const obj = { id: uid('t'), type: 'text', hand: true, font: 'Gaegu', weight, size, color, opacity: 1, w: 0, rot: 0, jitter: 1, seed: (Math.random() * 2 ** 31) | 0, sx: 1, x: 0, y, text, conf: Math.round(conf) };
    const L = layoutHand(obj);
    if (L) {
      const lw = L.box.x1 - L.box.x0;
      obj.sx = Math.max(0.8, Math.min(1.25, inkW / Math.max(1, lw)));
      obj.x = r.x0 - L.box.x0 * obj.sx;
    } else obj.x = r.x0;
    textObjs.push(obj);
  });

  // ---- vectorise drawings (and anything that was not text)
  onProgress('Tracing sketches');
  const sketchObjs = [];
  for (const c of [...sketches, ...leftovers]) {
    if (c.area < 6) continue;
    const pad = 2, w = c.w + pad * 2, h = c.h + pad * 2;
    const img = new Uint8Array(w * h);
    for (const j of c.pix) { const px = j % W, py = (j - px) / W; img[(py - c.y0 + pad) * w + (px - c.x0 + pad)] = 1; }
    const skel = zhangSuen(img, w, h);
    let len = 0;
    for (let i = 0; i < w * h; i++) len += skel[i];
    const thick = Math.max(1.4, Math.min(7, c.area / Math.max(1, len)));
    const polys = traceSkeleton(skel, w, h)
      .map((l) => rdp(l.map(([x, y]) => [x + c.x0 - pad + 0.5, y + c.y0 - pad + 0.5]), 0.7))
      .filter((l, _, all) => all.length === 1 || l.length > 2 || Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) > 3);
    if (!polys.length) continue;
    sketchObjs.push(strokeObj({ color: PALETTE[CLASS_COLOR[c.cls] || 'ink'], size: thick + 0.3, paths: polys.map((l) => (l.length === 1 ? [[...l[0], 0], [l[0][0] + 0.3, l[0][1], 0]] : l.map((p) => [p[0], p[1], 0]))), kind: 'sketch' }));
  }

  const debug = (typeof window !== 'undefined' && window.__rebuildDebug)
    ? runs.map((r) => ({ x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, row: r.row, cls: r.cls, n: r.comps.length, words: r.words.map((w) => `${w.text}(${Math.round(w.conf)})[${Math.round(w.x0)}-${Math.round(w.x1)}]`).join(' '), size: r.sizeDbg }))
    : undefined;
  return {
    debug,
    grid, divider,
    layers: { highlights, lines: [...lines, ...sketchObjs], text: textObjs },
    stats: { runs: runs.length, text: textObjs.length, highlights: highlights.length, lines: lines.length, sketches: sketchObjs.length, baseline: m },
  };
}

/** Build the op that turns a scan page into a rebuilt, editable page (undoable). */
export function rebuildOp(page, result) {
  const ops = [];
  const after = {
    bg: { kind: 'grid', divider: result.divider || null },
    grid: { ...page.grid, ...result.grid },
    ref: page.bg.kind === 'image' ? { asset: page.bg.asset } : page.ref || null,
    refVisible: false, refOpacity: 0.5, bgVisible: true, rebuilt: true, baseOffset: result.stats.baseline,
  };
  const before = Object.fromEntries(Object.keys(after).map((k) => [k, clone(page[k] ?? null)]));
  ops.push({ type: 'pageProps', page: page.id, before, after });
  // Remove empty layers; keep anything the user already drew.
  page.layers.forEach((l, i) => { if (!l.objects.length) ops.push({ type: 'delLayer', page: page.id, layer: clone(l), index: i }); });
  const mk = (name, objs, extra = {}) => ({ ...newLayer(name), objects: objs, ...extra });
  ops.push({ type: 'insLayer', page: page.id, layer: mk('Highlights', result.layers.highlights, { blend: 'multiply' }), index: 0 });
  ops.push({ type: 'insLayer', page: page.id, layer: mk('Lines & sketches', result.layers.lines), index: 1 });
  ops.push({ type: 'insLayer', page: page.id, layer: mk('Text', result.layers.text), index: 2 });
  return { type: 'batch', ops };
}
