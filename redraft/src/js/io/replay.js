// Replay: re-draws a page the way a person writes it. Text is written letter by
// letter along each glyph's pen path, strokes grow point by point, erasing is a
// visible eraser sweep. Two sources:
//   - "history": the page's recorded journal (every letter, stroke, erase, undo)
//   - "auto": synthesises a natural writing order for the page as it is now
//     (column by column, top to bottom, with a few erase-and-rewrite slips)
// The timeline is seekable (scrubber) and renders frames for the player and MP4.
import { applyOp, clone, findLayer, opTargets } from '../core/model.js';
import { bboxOfPoints } from '../core/geometry.js';
import { drawObject, drawStroke, buildStrokePath, renderLayer, drawBackground, drawText, drawImageObj, ensureImages } from '../render/draw.js';
import { layoutHand } from '../render/hand.js';

const flatten = (op) => (op.type === 'batch' ? op.ops.flatMap(flatten) : [op]);
const boxOf = (o) => (o.type === 'image' ? { x: o.x, y: o.y, w: o.w, h: o.h } : o.type === 'text' ? { x: o.x, y: o.y - o.size, w: o.size * (o.text.length * 0.45 + 1), h: o.size * 1.4 } : bboxOfPoints(o.paths.flat(), o.size || 0));
const revealSeg = (layerId, o, ops) => ({ kind: 'reveal', layer: layerId, obj: o, dur: Math.min(5000, Math.max(900, Math.sqrt(o.w * o.h) * 9)), ops });

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- page history
/** The page's starting point (scan / freshly rebuilt page) and the edits made after it. */
export function pageHistory(project, pageId) {
  const current = project.pages.find((p) => p.id === pageId);
  if (!project.initial) return { base: clone(current), edits: [] };
  const proj = { pages: clone(project.initial.pages) };
  let base = proj.pages.find((p) => p.id === pageId);
  base = base ? clone(base) : null;
  let edits = [];
  for (const e of project.journal) {
    const touches = opTargets(e.op).some((t) => t.page === pageId);
    try { applyOp(proj, e.op); } catch { /* journal entries for other pages may not apply cleanly */ }
    if (!touches) continue;
    const created = flatten(e.op).some((o) => o.type === 'insPage' && o.pageData.id === pageId);
    const pg = proj.pages.find((p) => p.id === pageId);
    if ((e.rebuild || created) && pg) { base = clone(pg); edits = []; continue; }
    edits.push(e);
  }
  if (!base) return { base: clone(current), edits: [] };
  return { base, edits };
}

const emptyCopy = (page) => { const p = clone(page); p.layers.forEach((l) => { l.objects = []; }); return p; };

// ---------------------------------------------------------------- pacing
const PEN_SPEED = 480; // page px per second at 1x for pen strokes (200 dpi ≈ 6 cm/s)
function letterMs(ch, rnd, size) {
  if (ch === ' ') return 90 + rnd() * 60;
  if (/[.,:;'"!\-]/.test(ch)) return 110 + rnd() * 60;
  return (150 + rnd() * 110) * Math.sqrt(Math.max(0.5, size / 36));
}
function strokeLen(obj) {
  let L = 0;
  for (const p of obj.paths) for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
}

/** Turn text snapshots into timed add/delete/hold actions (pen pace). */
export function textActions(snaps, rnd, size, { keepGaps = false } = {}) {
  const acts = [];
  let t = 0;
  for (let k = 1; k < snaps.length; k++) {
    const [tk, cur] = snaps[k], [tp, prev] = snaps[k - 1];
    let p = 0;
    while (p < prev.length && p < cur.length && prev[p] === cur[p]) p++;
    let q = 0;
    while (q < prev.length - p && q < cur.length - p && prev[prev.length - 1 - q] === cur[cur.length - 1 - q]) q++;
    if (keepGaps && k > 1) {
      const gap = Math.min(900, Math.max(0, tk - tp - 400));
      if (gap > 60) { acts.push({ type: 'hold', t0: t, dur: gap, text: prev }); t += gap; }
    }
    const removed = prev.length - p - q, added = cur.length - p - q;
    if (removed > 0) {
      const dur = Math.max(160, removed * 85);
      acts.push({ type: 'del', t0: t, dur, before: prev, after: cur, p, q, n: removed });
      t += dur;
    }
    if (added > 0) {
      const per = [];
      for (let i = 0; i < added; i++) per.push(letterMs(cur[p + i], rnd, size));
      const dur = per.reduce((s, v) => s + v, 0);
      acts.push({ type: 'add', t0: t, dur, text: cur, p, q, n: added, per });
      t += dur;
    }
  }
  return { acts, dur: t };
}

// ---------------------------------------------------------------- timeline building
class Builder {
  constructor() { this.segs = []; this.t = 0; }
  add(seg) { seg.t0 = this.t; this.t += seg.dur; this.segs.push(seg); return seg; }
  pause(ms) { if (ms > 0) this.add({ kind: 'pause', dur: ms, ops: [] }); }
}

function readingOrder(page) {
  const divX = page.bg?.divider?.x ?? page.w / 2;
  const sy = page.grid?.sy || 46;
  const texts = [], others = [];
  for (const layer of page.layers) for (const o of layer.objects) (o.type === 'text' ? texts : others).push({ layer, o });
  const keyOf = (x, y) => (x < divX ? 0 : 1) * 1e7 + Math.round(y / (sy * 0.5)) * 1e4 + x;
  for (const t of texts) { t.key = keyOf(t.o.x, t.o.y); t.after = []; }
  texts.sort((a, b) => a.key - b.key);
  const free = [];
  for (const it of others) {
    const o = it.o;
    const b = boxOf(o);
    if (!b) continue;
    let anchor = null;
    if (o.tool === 'highlighter' || o.kind === 'line') {
      // Highlights and underlines follow the words they mark.
      let best = 0;
      for (const t of texts) {
        if (Math.abs(t.o.y - (b.y + b.h / 2)) > sy * 0.6) continue;
        const L = layoutHand(t.o);
        const tx0 = t.o.x + (L ? L.box.x0 : 0), tx1 = t.o.x + (L ? L.box.x1 : t.o.size * t.o.text.length * 0.4);
        const ov = Math.min(tx1, b.x + b.w) - Math.max(tx0, b.x);
        if (ov > best) { best = ov; anchor = t; }
      }
    } else if (o.kind === 'dashbox') {
      // Boxes are drawn after the text inside them.
      const inside = texts.filter((t) => t.o.x >= b.x - 10 && t.o.x <= b.x + b.w && t.o.y >= b.y && t.o.y <= b.y + b.h);
      if (inside.length) anchor = inside[inside.length - 1];
    }
    if (anchor) anchor.after.push(it);
    else free.push({ ...it, key: keyOf(b.x, b.y + b.h * 0.8) });
  }
  const all = [...texts, ...free].sort((a, b) => a.key - b.key);
  const out = [];
  for (const it of all) { out.push(it); if (it.after) out.push(...it.after); }
  return out;
}

function strokeSeg(layerId, obj, { byTime = false, T = 0, speed = PEN_SPEED, ops, hide } = {}) {
  const len = strokeLen(obj);
  const dur = byTime && T > 0 ? Math.max(120, T) : Math.max(140, (len / speed) * 1000 + (obj.paths.length - 1) * 70);
  return { kind: 'stroke', layer: layerId, obj, byTime: byTime && T > 0, T, len, dur, ops, hide };
}

function autoSegments(B, page, rnd, { typos = 3 } = {}) {
  const items = readingOrder(page);
  const textItems = items.filter((i) => i.o.type === 'text');
  // Pick a few words to misspell and fix ("natural erase-and-rewrite moments").
  const slips = new Map();
  const cands = textItems.filter((t, i) => i > 2 && /[A-Za-z]{6,}/.test(t.o.text));
  for (let k = 0; k < Math.min(typos, cands.length); k++) {
    const t = cands[Math.floor(((k + 0.3 + rnd() * 0.4) / Math.min(typos, cands.length)) * cands.length) % cands.length];
    if (slips.has(t.o.id)) continue;
    const m = /[A-Za-z]{6,}/.exec(t.o.text);
    const j = 2 + Math.floor(rnd() * Math.max(1, m[0].length - 4));
    slips.set(t.o.id, { at: m.index + j });
  }
  let last = null;
  const divX = page.bg?.divider?.x ?? page.w / 2;
  for (const it of items) {
    const { layer, o } = it;
    if (last) {
      const col = (x) => (x < divX ? 0 : 1);
      const lx = boxOf(last).x;
      const ox = boxOf(o).x;
      B.pause(col(lx) !== col(ox) ? 700 : o.type === 'text' && last.type === 'text' && Math.abs(o.y - last.y) > 5 ? 260 + rnd() * 200 : 140 + rnd() * 120);
    }
    const ops = [{ type: 'insObjs', page: page.id, layer: layer.id, objs: [o], indices: [Infinity] }];
    if (o.type === 'text') {
      const full = o.text;
      const snaps = [[0, '']];
      const slip = slips.get(o.id);
      if (slip && slip.at + 2 <= full.length) {
        const s1 = full.slice(0, slip.at);
        const wrong = s1 + full[slip.at + 1] + full[slip.at];
        snaps.push([0, s1], [0, wrong], [0, s1], [0, full]);
      } else snaps.push([0, full]);
      const { acts, dur } = textActions(snaps, rnd, o.size);
      // Pause after the slip is noticed, before erasing.
      let shift = 0;
      for (let i = 0; i < acts.length; i++) {
        acts[i].t0 += shift;
        if (acts[i].type === 'del') { const hold = { type: 'hold', t0: acts[i].t0, dur: 450, text: acts[i].before }; acts.splice(i, 0, hold); shift += 450; acts[i + 1].t0 += 450; i++; }
      }
      B.add({ kind: 'text', layer: layer.id, obj: o, acts, dur: dur + shift, ops });
    } else if (o.type === 'image') {
      B.add(revealSeg(layer.id, o, ops));
    } else if (o.type === 'stroke') {
      const speed = o.tool === 'highlighter' ? 950 : o.kind === 'dashbox' || o.kind === 'dashline' ? 700 : PEN_SPEED;
      B.add(strokeSeg(layer.id, o, { speed, ops }));
    }
    last = o;
  }
}

function journalSegments(B, entries, page, rnd) {
  let prevT = null;
  for (const e of entries) {
    if (prevT !== null) B.pause(Math.min(1000, Math.max(150, e.t - prevT - 1500)));
    prevT = e.t;
    const ops = flatten(e.op).filter((o) => o.page === page.id);
    if (!ops.length) continue;
    const opE = ops.length === 1 ? ops[0] : { type: 'batch', ops };
    if (e.letterErase && !e.undo && !e.redo) {
      // Letter eraser: rub out just those letters, then the line continues as its pieces.
      for (const it of e.letterErase) {
        const ops1 = [{ type: 'delObjs', page: page.id, layer: it.layer, objs: [it.obj], indices: [0] }];
        if (it.pieces.length) ops1.push({ type: 'insObjs', page: page.id, layer: it.layer, objs: it.pieces, indices: it.pieces.map(() => Infinity) });
        const dur = Math.max(260, it.erased.length * 110);
        B.add({ kind: 'text', layer: it.layer, obj: it.obj, acts: [{ type: 'erase', t0: 0, dur, text: it.obj.text, idx: it.erased }], dur, ops: ops1, hide: [it.obj.id] });
      }
      const gone = new Set(e.letterErase.map((it) => it.obj.id));
      const rest = ops.filter((o) => o.type === 'delObjs' && !o.objs.some((x) => gone.has(x.id)));
      if (rest.length) {
        const objs = rest.flatMap((d) => d.objs.map((o) => ({ layer: d.layer, o })));
        B.add({ kind: 'wipe', objs, dur: Math.min(1600, 450 + objs.length * 90), ops: rest, hide: objs.map((x) => x.o.id) });
      }
      continue;
    }
    const ins = ops.filter((o) => o.type === 'insObjs');
    const dels = ops.filter((o) => o.type === 'delObjs');
    const sets = ops.filter((o) => o.type === 'setObjs');
    if (ins.length && ins.length === ops.length && ins[0].objs.length === 1) {
      const o = ins[0].objs[0];
      if (o.type === 'stroke') {
        const T = Math.max(0, ...o.paths.flat().map((p) => p[2] || 0));
        B.add(strokeSeg(ins[0].layer, o, { byTime: !e.undo && !e.redo && !o.shape, T, ops: [opE] }));
        continue;
      }
      if (o.type === 'text') {
        const snaps = e.anim && e.anim.length > 1 ? e.anim : [[0, ''], [0, o.text]];
        const { acts, dur } = textActions(snaps[0][1] ? [[0, ''], ...snaps] : snaps, rnd, o.size, { keepGaps: true });
        B.add({ kind: 'text', layer: ins[0].layer, obj: o, acts, dur, ops: [opE] });
        continue;
      }
    }
    if (sets.length === 1 && sets.length === ops.length && sets[0].after.length === 1 && sets[0].after[0].type === 'text' && sets[0].before[0].text !== sets[0].after[0].text) {
      const before = sets[0].before[0], after = sets[0].after[0];
      const snaps = e.anim && e.anim.length > 1 ? e.anim : [[0, before.text], [0, after.text]];
      if (snaps[0][1] !== before.text) snaps.unshift([0, before.text]);
      const { acts, dur } = textActions(snaps, rnd, after.size, { keepGaps: true });
      B.add({ kind: 'text', layer: sets[0].layer, obj: after, acts, dur, ops: [opE], hide: [after.id] });
      continue;
    }
    if (dels.length && dels.length === ops.length) {
      const objs = dels.flatMap((d) => d.objs.map((o) => ({ layer: d.layer, o })));
      B.add({ kind: 'wipe', objs, dur: Math.min(1600, 450 + objs.length * 90), ops: [opE], hide: objs.map((x) => x.o.id) });
      continue;
    }
    if (ins.length && ins.length === ops.length) {
      // Several objects at once (paste, undo of a delete): redraw them quickly one by one.
      ins.forEach((op) => op.objs.forEach((o) => {
        const one = [{ type: 'insObjs', page: page.id, layer: op.layer, objs: [o], indices: [Infinity] }];
        if (o.type === 'stroke') B.add(strokeSeg(op.layer, o, { speed: PEN_SPEED * 2.5, ops: one }));
        else if (o.type === 'text') {
          const { acts, dur } = textActions([[0, ''], [0, o.text]], rnd, o.size);
          acts.forEach((a) => { a.dur /= 2.5; a.t0 /= 2.5; if (a.per) a.per = a.per.map((v) => v / 2.5); });
          B.add({ kind: 'text', layer: op.layer, obj: o, acts, dur: dur / 2.5, ops: one });
        } else if (o.type === 'image') B.add(revealSeg(op.layer, o, one));
        else B.add({ kind: 'pause', dur: 60, ops: one });
      }));
      continue;
    }
    if (sets.length && sets.length === ops.length) {
      B.add({ kind: 'fade', sets, dur: 420, ops: [opE], hide: sets.flatMap((s) => s.before.map((o) => o.id)) });
      continue;
    }
    B.add({ kind: 'pause', dur: 180, ops: [opE] });
  }
}

// ---------------------------------------------------------------- engine
export class ReplayEngine {
  /**
   * mode: 'auto'    — write the page as it is now, in reading order
   *       'history' — write the starting page, then play back every recorded edit
   */
  constructor(editor, pageId, { mode = 'auto', seed = 11 } = {}) {
    this.editor = editor;
    const project = editor.project;
    const page = project.pages.find((p) => p.id === pageId);
    const { base, edits } = pageHistory(project, pageId);
    this.editCount = edits.length;
    this.mode = mode;
    const rnd = mulberry(seed);
    const B = new Builder();
    const source = mode === 'history' ? base : page;
    this.start = emptyCopy(source);
    B.pause(500);
    autoSegments(B, source, rnd);
    if (mode === 'history' && edits.length) { B.pause(800); journalSegments(B, edits, base, rnd); }
    B.pause(1500);
    this.segs = B.segs;
    this.duration = B.t;
    this.page0 = page;
    // Checkpoints for fast seeking backwards.
    this.checkpoints = [];
    const st = { pages: [clone(this.start)] };
    this.segs.forEach((s, i) => {
      if (i % 40 === 0) this.checkpoints.push({ i, page: clone(st.pages[0]) });
      for (const op of s.ops) this._apply(st, op);
    });
    this.finalPage = st.pages[0];
  }

  _apply(st, op) {
    // insObjs with Infinity indices = append.
    const fix = (o) => {
      if (o.type === 'batch') return { ...o, ops: o.ops.map(fix) };
      if (o.type === 'insObjs' && o.indices.some((x) => x === Infinity)) {
        const layer = findLayer(st.pages[0], o.layer);
        const n = layer ? layer.objects.length : 0;
        return { ...o, indices: o.objs.map((_, k) => n + k) };
      }
      return o;
    };
    try { applyOp(st, fix(op)); } catch (e) { /* ignore ops for other pages */ }
  }

  segIndexAt(t) {
    let lo = 0, hi = this.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segs[mid].t0 <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
}

// ---------------------------------------------------------------- renderer
export class ReplayRenderer {
  constructor(engine, editor) {
    this.engine = engine;
    this.editor = editor;
    this.state = { pages: [clone(engine.start)] };
    this.applied = 0; // number of segments whose ops are applied
    this.caches = new Map();
    this.scale = 0;
    this.cam = null;
    this.tip = null;
  }

  get page() { return this.state.pages[0]; }

  async prepare() {
    this.bmp = await this.editor.ensureBitmap(this.page);
    await ensureImages([...this.engine.finalPage.layers.flatMap((l) => l.objects), ...this.engine.segs.filter((s) => s.obj).map((s) => s.obj)]);
    if (this.page.ref) this.refBmp = null;
  }

  _goto(idx) {
    const E = this.engine;
    if (idx < this.applied) {
      const cp = [...E.checkpoints].reverse().find((c) => c.i <= idx) || { i: 0, page: E.start };
      this.state = { pages: [clone(cp.page)] };
      this.applied = cp.i;
      this.caches.clear();
    }
    while (this.applied < idx) {
      const seg = E.segs[this.applied];
      for (const op of seg.ops) this._applyOp(op);
      this.applied++;
    }
  }

  _applyOp(op) {
    const before = new Map(this.page.layers.map((l) => [l.id, l.objects.length]));
    this.engine._apply(this.state, op);
    for (const o of flatten(op)) {
      if (o.type === 'insObjs') {
        const layer = findLayer(this.page, o.layer);
        const c = this.caches.get(o.layer);
        if (c && layer && !c.excl && before.get(o.layer) === layer.objects.length - o.objs.length && o.indices.every((ix, k) => ix === Infinity || ix === before.get(o.layer) + k)) {
          const g = c.canvas.getContext('2d');
          g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
          layer.objects.slice(before.get(o.layer)).forEach((ob) => drawObject(g, ob, { grid: this.page.grid }));
        } else this.caches.delete(o.layer);
      } else if (o.layer) this.caches.delete(typeof o.layer === 'string' ? o.layer : o.layer.id);
      else this.caches.clear();
    }
  }

  _cache(layer, hide) {
    const excl = hide ? layer.objects.filter((o) => hide.has(o.id)).map((o) => o.id).join(',') : '';
    let c = this.caches.get(layer.id);
    if (c && c.excl === excl && c.scale === this.scale) return c.canvas;
    const W = Math.max(1, Math.ceil(this.page.w * this.scale)), H = Math.max(1, Math.ceil(this.page.h * this.scale));
    const canvas = c && c.canvas.width === W && c.canvas.height === H ? c.canvas : new OffscreenCanvas(W, H);
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    renderLayer(g, layer, { grid: this.page.grid }, hide && excl ? hide : null);
    this.caches.set(layer.id, { canvas, excl, scale: this.scale });
    return canvas;
  }

  /** Draw the in-progress part of a segment onto a layer context (page coords). Returns pen tip. */
  _drawSeg(g, seg, local, layerId) {
    const env = { grid: this.page.grid };
    const f = Math.max(0, Math.min(1, local / seg.dur));
    if (seg.kind === 'stroke' && seg.layer === layerId) {
      const o = seg.obj;
      let paths;
      if (seg.byTime) {
        const cut = f * seg.T;
        paths = o.paths.map((p) => p.filter((q) => (q[2] || 0) <= cut)).filter((p) => p.length);
      } else {
        let budget = f * seg.len;
        paths = [];
        for (const p of o.paths) {
          if (budget <= 0) break;
          const out = [p[0]];
          for (let i = 1; i < p.length && budget > 0; i++) {
            const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
            if (d <= budget) { out.push(p[i]); budget -= d; } else {
              const t = budget / d;
              out.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t, 0]);
              budget = 0;
            }
          }
          paths.push(out.length > 1 ? out : [out[0], [out[0][0] + 0.01, out[0][1], 0]]);
        }
      }
      if (!paths.length) return null;
      const partial = { ...o, paths };
      drawStroke(g, partial, env, buildStrokePath(partial));
      const lp = paths[paths.length - 1], q = lp[lp.length - 1];
      return { x: q[0], y: q[1], eraser: o.tool === 'eraser' };
    }
    if (seg.kind === 'text' && seg.layer === layerId) {
      const acts = seg.acts;
      let a = acts[0];
      for (const x of acts) if (x.t0 <= local) a = x;
      if (!a) return null;
      const lt = Math.max(0, Math.min(a.dur, local - a.t0));
      if (a.type === 'hold') { drawText(g, seg.obj, a.text); return null; }
      if (a.type === 'erase') {
        const n = a.idx.length, f = (lt / a.dur) * n, k = Math.min(n - 1, Math.floor(f));
        const cur = a.idx[k];
        return drawText(g, seg.obj, a.text, { hideSet: new Set(a.idx.slice(0, k)), wipe: { from: cur, to: cur + 1, progress: Math.min(1, f - k) } });
      }
      if (a.type === 'del') {
        return drawText(g, seg.obj, a.before, { wipe: { from: a.p, to: a.before.length - a.q, progress: lt / a.dur } });
      }
      // add: find the letter being written
      let acc = 0, k = 0;
      while (k < a.per.length - 1 && acc + a.per[k] <= lt) { acc += a.per[k]; k++; }
      const prog = Math.min(1, (lt - acc) / a.per[k]);
      if (lt >= a.dur) { drawText(g, seg.obj, a.text); return null; }
      return drawText(g, seg.obj, a.text, { partial: { index: a.p + k, progress: prog, hideTo: a.text.length - a.q } });
    }
    if (seg.kind === 'wipe') {
      const mine = seg.objs.filter((x) => x.layer === layerId);
      if (!mine.length) return null;
      const box = seg.box || (seg.box = seg.objs.reduce((b, x) => {
        const bb = boxOf(x.o);
        if (!b) return bb;
        const x0 = Math.min(b.x, bb.x), y0 = Math.min(b.y, bb.y);
        return { x: x0, y: y0, w: Math.max(b.x + b.w, bb.x + bb.w) - x0, h: Math.max(b.y + b.h, bb.y + bb.h) - y0 };
      }, null));
      const cut = box.x + box.w * f;
      g.save();
      g.beginPath();
      g.rect(cut, box.y - 50, box.w + 100, box.h + 100);
      g.clip();
      mine.forEach((x) => drawObject(g, x.o, env));
      g.restore();
      return { x: cut, y: box.y + box.h * (0.5 + 0.35 * Math.sin(f * Math.PI * 7)), eraser: true };
    }
    if (seg.kind === 'reveal' && seg.layer === layerId) {
      // Diagram drawn in: revealed left to right with the pen moving up and down across it.
      const o = seg.obj;
      drawImageObj(g, o, { x: 0, y: 0, w: o.w * f, h: o.h });
      return { x: o.x + o.w * f, y: o.y + o.h * (0.5 + 0.42 * Math.sin(f * Math.PI * 9)) };
    }
    if (seg.kind === 'fade') {
      for (const s of seg.sets) {
        if (s.layer !== layerId) continue;
        g.save(); g.globalAlpha = 1 - f; s.before.forEach((o) => drawObject(g, o, env)); g.restore();
        g.save(); g.globalAlpha = f; s.after.forEach((o) => drawObject(g, o, env)); g.restore();
      }
    }
    return null;
  }

  /**
   * Render the frame at time t (ms). cam: { mode: 'page' | 'follow' }.
   * Returns the pen tip in page coordinates (or null).
   */
  render(ctx, W, H, t, cam = { mode: 'page' }) {
    const E = this.engine;
    t = Math.max(0, Math.min(E.duration, t));
    const idx = E.segIndexAt(t);
    this._goto(idx);
    const seg = E.segs[idx];
    const local = t - seg.t0;
    const page = this.page;

    // Camera.
    const s = cam.mode === 'follow' ? (W / page.w) * 0.96 : Math.min(W / page.w, H / page.h) * 0.97;
    if (Math.abs(s - this.scale) > 1e-6) { this.scale = s; this.caches.clear(); }
    let ox = (W - page.w * s) / 2, oy = (H - page.h * s) / 2;
    if (cam.mode === 'follow' && page.h * s > H) {
      const target = this.tip ? this.tip.y : 0;
      const want = Math.max(H - page.h * s, Math.min(0, H * 0.45 - target * s));
      if (this.camY === undefined || cam.jump) this.camY = want;
      else this.camY += (want - this.camY) * Math.min(1, cam.ease ?? 0.08);
      oy = this.camY;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = cam.background || '#2a2a2e';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, ox, oy);
    drawBackground(ctx, page, this.bmp);

    const hide = seg.hide ? new Set(seg.hide) : null;
    let tip = null;
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      let src = this._cache(layer, hide);
      const active = (seg.kind === 'stroke' || seg.kind === 'text' || seg.kind === 'reveal') ? seg.layer === layer.id
        : seg.kind === 'wipe' ? seg.objs.some((x) => x.layer === layer.id)
          : seg.kind === 'fade' ? seg.sets.some((x) => x.layer === layer.id) : false;
      // Only an eraser stroke has to be composited inside its layer; everything else
      // can be drawn straight onto the frame on top of the layer (much faster).
      const needsTmp = active && seg.kind === 'stroke' && seg.obj.tool === 'eraser';
      if (needsTmp) {
        const tmp = this._tmp(src.width, src.height);
        const g = tmp.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = 'copy';
        g.drawImage(src, 0, 0);
        g.globalCompositeOperation = 'source-over';
        g.setTransform(s, 0, 0, s, 0, 0);
        tip = this._drawSeg(g, seg, local, layer.id) || tip;
        src = tmp;
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blend || 'source-over';
      // Skip the part of the layer outside the frame.
      const sx0 = Math.max(0, -ox), sy0 = Math.max(0, -oy);
      const sw = Math.min(src.width - sx0, W - Math.max(0, ox)), sh = Math.min(src.height - sy0, H - Math.max(0, oy));
      if (sw > 0 && sh > 0) ctx.drawImage(src, sx0, sy0, sw, sh, Math.max(0, ox), Math.max(0, oy), sw, sh);
      if (active && !needsTmp) {
        ctx.setTransform(s, 0, 0, s, ox, oy);
        tip = this._drawSeg(ctx, seg, local, layer.id) || tip;
      }
      ctx.restore();
    }
    if (tip) this.tip = tip;
    if (tip && cam.pen !== false) drawTool(ctx, ox + tip.x * s, oy + tip.y * s, tip.eraser, Math.max(0.7, s * 1.2));
    return tip;
  }

  _tmp(w, h) {
    if (!this.tmp || this.tmp.width !== w || this.tmp.height !== h) this.tmp = new OffscreenCanvas(w, h);
    return this.tmp;
  }
}

/** A small pen (or eraser) drawn at the writing point. */
export function drawTool(ctx, x, y, eraser, k = 1) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.rotate(-Math.PI / 4.2);
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 6;
  if (eraser) {
    ctx.fillStyle = '#f3a6b5';
    ctx.beginPath(); ctx.roundRect(-4, -12, 46, 24, 5); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#3d5a9e';
    ctx.fillRect(20, -12, 26, 24);
  } else {
    ctx.fillStyle = '#2d2d33';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(14, -5); ctx.lineTo(14, 5); ctx.closePath(); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#e9e9ee';
    ctx.beginPath(); ctx.roundRect(14, -6, 70, 12, 3); ctx.fill();
    ctx.fillStyle = '#5a6bd8';
    ctx.fillRect(60, -6, 24, 12);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- video export
// MP4 (H.264) when the browser can encode it (Electron, Chrome, Safari 16.4+),
// otherwise WebM (VP9/VP8) via WebCodecs, otherwise real-time MediaRecorder.
const ENCODERS = [
  ['avc1.640034', 'avc', 'mp4'], ['avc1.4d0034', 'avc', 'mp4'], ['avc1.42003e', 'avc', 'mp4'], ['avc1.42002a', 'avc', 'mp4'],
  ['vp09.00.41.08', 'V_VP9', 'webm'], ['vp8', 'V_VP8', 'webm'],
];

export async function pickCodec(width, height, fps) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const [codec, mux, container] of ENCODERS) {
    if (container === 'mp4' && !window.Mp4Muxer) continue;
    if (container === 'webm' && !window.WebMMuxer) continue;
    const cfg = { codec, width, height, bitrate: 10_000_000, framerate: fps };
    if (mux === 'avc') cfg.avc = { format: 'avc' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { cfg, mux, container }; } catch { /* next */ }
  }
  return null;
}

function recorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

/**
 * Encode replays of the given pages into one video.
 * format: 'landscape' (1920x1080, camera follows the pen) or 'portrait' (1080x1920, whole page).
 * Returns { bytes, container: 'mp4' | 'webm', ... }.
 */
export async function exportReplayVideo(editor, pageIds, { mode = 'auto', speed = 8, fps = 30, format = 'landscape', onProgress = () => {}, isCancelled = () => false, forceRecorder = false } = {}) {
  const W = format === 'portrait' ? 1080 : 1920, H = format === 'portrait' ? 1920 : 1080;
  const codec = forceRecorder ? null : await pickCodec(W, H, fps);
  const engines = pageIds.map((id) => new ReplayEngine(editor, id, { mode: mode === 'history' ? 'history' : 'auto' }));
  const frameMs = (1000 / fps) * speed;
  const total = engines.reduce((s, e) => s + Math.ceil(e.duration / frameMs) + 1, 0);
  const cam = { mode: format === 'portrait' ? 'page' : 'follow', ease: Math.min(1, 0.06 * Math.sqrt(speed)) };

  async function* frames(ctx) {
    for (const E of engines) {
      const R = new ReplayRenderer(E, editor);
      await R.prepare();
      cam.jump = true;
      for (let t = 0; t <= E.duration + frameMs; t += frameMs) {
        R.render(ctx, W, H, t, cam);
        cam.jump = false;
        yield;
      }
    }
  }

  if (codec) {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    let muxer;
    if (codec.container === 'mp4') {
      const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
      muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: codec.mux, width: W, height: H, frameRate: fps }, fastStart: 'in-memory' });
    } else {
      const { Muxer, ArrayBufferTarget } = window.WebMMuxer;
      muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: codec.mux, width: W, height: H, frameRate: fps } });
    }
    let err = null;
    const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { err = e; } });
    encoder.configure(codec.cfg);
    let n = 0;
    for await (const _ of frames(ctx)) {
      if (err) throw err;
      const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: n % (fps * 2) === 0 });
      frame.close();
      n++;
      if (encoder.encodeQueueSize > 6) await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
      if (n % 10 === 0) {
        onProgress(n, total);
        await new Promise((r) => setTimeout(r, 0));
        if (isCancelled()) { encoder.close(); throw new Error('cancelled'); }
      }
    }
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    onProgress(total, total);
    return { bytes: new Uint8Array(muxer.target.buffer), container: codec.container, codec: codec.mux, frames: n, width: W, height: H, seconds: n / fps };
  }

  // Fallback: record a canvas in real time (the video plays at the chosen speed).
  const mime = recorderMime();
  if (!mime) throw new Error('This browser cannot record video.');
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(1000);
  let n = 0;
  const t0 = performance.now();
  for await (const _ of frames(ctx)) {
    n++;
    const due = t0 + (n * 1000) / fps;
    await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
    if (n % 10 === 0) { onProgress(n, total); if (isCancelled()) { rec.stop(); throw new Error('cancelled'); } }
  }
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: mime });
  onProgress(total, total);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), container: mime.includes('mp4') ? 'mp4' : 'webm', codec: mime, frames: n, width: W, height: H, seconds: n / fps };
}

export const exportReplayMp4 = exportReplayVideo;
