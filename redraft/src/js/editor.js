// The canvas editor: viewport, layer caches, rendering, input and tools.
import {
  Stabilizer, dist, bboxOfPoints, unionBox, boxesOverlap, pointInBox, pointInPolygon, distToSegment,
  projectOnLine, matTranslate, matScaleAbout, matRotateAbout, pathLength,
} from './core/geometry.js';
import { recognize, adjustShape, linePath, snapAngle } from './core/shapes.js';
import {
  uid, clone, findLayer, newLayer, opAddObjs, opDelObjs, opSetObjs, batch, objBBox, textCorners, transformObj, opTargets,
} from './core/model.js';
import { History } from './core/history.js';
import {
  drawObject, drawStroke, buildStrokePath, renderLayer, drawBackground, drawText, measureText, renderPageCanvas, textLayout, LINE_HEIGHT,
} from './render/draw.js';

export const PAINT_TOOLS = ['pen', 'pencil', 'marker', 'highlighter'];
export const TOOL_NAMES = {
  pen: 'Pen', pencil: 'Pencil', marker: 'Marker', highlighter: 'Highlighter', eraser: 'Eraser',
  cover: 'Cover & rewrite', text: 'Text', lasso: 'Lasso select', eyedropper: 'Eyedropper',
};
const SHAPE_NAMES = { line: 'Line', arrow: 'Arrow', polyline: 'Lines', rect: 'Rectangle', triangle: 'Triangle', polygon: 'Polygon', ellipse: 'Ellipse' };

export function defaultSettings() {
  return {
    stabilizer: 55,
    tools: {
      pen: { size: 4, opacity: 1, color: '#1b1b1f' },
      pencil: { size: 3.5, opacity: 0.9, color: '#2b2b2e' },
      marker: { size: 10, opacity: 1, color: '#1f4fd1' },
      highlighter: { size: 28, opacity: 1, color: '#ffd43b' },
      eraser: { size: 26, mode: 'brush', allLayers: false },
      cover: { size: 46, mode: 'brush' },
      text: { font: 'Caveat', size: 40, color: '#1b1b1f', weight: 400 },
      lasso: { allLayers: false },
    },
  };
}

export class Editor {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext('2d');
    this.listeners = {};
    this.settings = defaultSettings();
    this.tool = 'pen';
    this.prevTool = 'pen';
    this.view = { zoom: 1, x: 0, y: 0 };
    this.ruler = { on: false, x: 0, y: 0, angle: 0 };
    this.project = null;
    this.assets = new Map();
    this.bitmaps = new Map(); // assetId -> full-res ImageBitmap (LRU)
    this.thumbBgs = new Map(); // assetId -> small ImageBitmap
    this.caches = new Map();
    this.hidden = new Set();
    this.selection = null;
    this.clipboard = null;
    this.drag = null;
    this.live = null;
    this.pageIndex = 0;
    this.activeLayerId = null;
    this.pageVersions = new Map();
    this.hover = null;
    this.flash = null;
    this.spaceDown = false;
    this.workspaceColor = '#e8e8e4';
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;

    new ResizeObserver(() => this.resize()).observe(stage);
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.requestRender(); });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  // ------------------------------------------------------------ events
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, data) { (this.listeners[evt] || []).forEach((fn) => fn(data)); }
  toast(msg) { this.emit('toast', msg); }

  // ------------------------------------------------------------ document
  load(project, assets, bitmaps = new Map()) {
    this.closeTextEditor(false);
    this.project = project;
    this.assets = assets;
    this.bitmaps = bitmaps;
    this.thumbBgs = new Map();
    this.history = new History(project, (op, kind) => this.onHistory(op, kind));
    this.selection = null;
    this.pageVersions = new Map();
    this.setPage(0, true);
    this.emit('doc', { kind: 'load' });
  }

  get page() { return this.project ? this.project.pages[this.pageIndex] : null; }
  get layer() { return findLayer(this.page, this.activeLayerId); }
  get toolSettings() { return this.settings.tools[this.tool === 'eyedropper' ? this.prevTool : this.tool] || {}; }

  setPage(i, fit = false) {
    if (!this.project || !this.project.pages.length) return;
    this.closeTextEditor();
    i = Math.max(0, Math.min(this.project.pages.length - 1, i));
    const changed = i !== this.pageIndex || fit;
    this.pageIndex = i;
    this.caches.clear();
    this.hidden.clear();
    this.selection = null;
    const page = this.page;
    if (!findLayer(page, this.activeLayerId)) this.activeLayerId = page.layers[page.layers.length - 1]?.id || null;
    this.ensureBitmap(page).then(() => this.requestRender());
    if (changed) this.fit();
    this.emit('page', i);
    this.emit('layers');
    this.emit('selection');
    this.requestRender();
  }

  setActiveLayer(id) {
    this.activeLayerId = id;
    this.clearSelection();
    this.emit('layers');
  }

  pageVersion(id) { return this.pageVersions.get(id) || 0; }

  commit(op, meta) {
    this.history.do(op, meta);
  }

  onHistory(op, kind) {
    const page = this.page;
    let structural = false;
    for (const t of opTargets(op)) {
      if (t.structural) structural = true;
      if (t.page) this.pageVersions.set(t.page, this.pageVersion(t.page) + 1);
      if (!page || t.page !== page.id || t.propsOnly) continue;
      if (t.layer) {
        if (kind === 'do' && this._incremental(op, t.layer)) continue;
        this.invalidate(t.layer);
      } else this.caches.clear();
    }
    if (structural) {
      const idx = page ? this.project.pages.findIndex((p) => p.id === page.id) : -1;
      if (idx >= 0) this.pageIndex = idx;
      else this.setPage(Math.min(this.pageIndex, this.project.pages.length - 1), true);
      this.emit('pages');
    }
    if (this.page && !findLayer(this.page, this.activeLayerId)) this.activeLayerId = this.page.layers[this.page.layers.length - 1]?.id;
    if (kind !== 'do' && this.selection) this.clearSelection();
    this.emit('doc', { kind, op });
    this.emit('layers');
    this.requestRender();
  }

  /** Fast path: a single append to a layer can be drawn onto the existing caches. */
  _incremental(op, layerId) {
    if (op.type !== 'insObjs' || op.layer !== layerId) return false;
    const c = this.caches.get(layerId);
    const layer = findLayer(this.page, layerId);
    if (!c || !c.valid || !layer) return false;
    const n = layer.objects.length;
    if (!op.indices.every((ix, k) => ix === n - op.objs.length + k)) return false;
    const objs = layer.objects.slice(n - op.objs.length);
    const env = { grid: this.page.grid };
    const pc = c.page.getContext('2d');
    objs.forEach((o) => drawObject(pc, o, env));
    if (c.view && c.viewKey === this.viewKey()) {
      const vc = c.view.getContext('2d');
      vc.setTransform(this.dpr * this.view.zoom, 0, 0, this.dpr * this.view.zoom, this.dpr * this.view.x, this.dpr * this.view.y);
      objs.forEach((o) => drawObject(vc, o, env));
    }
    return true;
  }

  undo() { if (this.drag) return; this.closeTextEditor(); if (!this.history?.undo()) this.toast('Nothing to undo'); }
  redo() { if (this.drag) return; this.closeTextEditor(); if (!this.history?.redo()) this.toast('Nothing to redo'); }

  // ------------------------------------------------------------ bitmaps
  async ensureBitmap(page) {
    if (!page || page.bg.kind !== 'image') return null;
    const id = page.bg.asset;
    if (this.bitmaps.has(id)) {
      const b = this.bitmaps.get(id);
      this.bitmaps.delete(id); this.bitmaps.set(id, b); // LRU touch
      return b;
    }
    const a = this.assets.get(id);
    if (!a) return null;
    const bmp = await createImageBitmap(new Blob([a.bytes], { type: a.mime }));
    this.bitmaps.set(id, bmp);
    while (this.bitmaps.size > 5) {
      const [k, v] = this.bitmaps.entries().next().value;
      if (k === this.page?.bg.asset) { this.bitmaps.delete(k); this.bitmaps.set(k, v); continue; }
      v.close?.(); this.bitmaps.delete(k);
    }
    return bmp;
  }

  async thumbBg(page) {
    if (page.bg.kind !== 'image') return null;
    const id = page.bg.asset;
    if (!this.thumbBgs.has(id)) {
      const a = this.assets.get(id);
      if (!a) return null;
      this.thumbBgs.set(id, await createImageBitmap(new Blob([a.bytes], { type: a.mime }), { resizeWidth: 320, resizeQuality: 'medium' }));
    }
    return this.thumbBgs.get(id);
  }

  async renderThumb(page, width = 240) {
    const bmp = (page.bg.kind === 'image' && this.bitmaps.get(page.bg.asset)) || (await this.thumbBg(page));
    return renderPageCanvas(page, bmp, width / page.w);
  }

  // ------------------------------------------------------------ viewport
  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.stage.getBoundingClientRect();
    this.cw = r.width; this.ch = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    if (!this._fitted && this.page) this.fit();
    this.viewChanged();
  }

  fit() {
    const page = this.page;
    if (!page || !this.cw) return;
    const pad = 40;
    const z = Math.min((this.cw - pad * 2) / page.w, (this.ch - pad * 2) / page.h);
    this.view.zoom = Math.max(0.02, z);
    this.view.x = (this.cw - page.w * this.view.zoom) / 2;
    this.view.y = Math.max(pad, (this.ch - page.h * this.view.zoom) / 2);
    this._fitted = true;
    this.viewChanged();
  }

  fitWidth() {
    const page = this.page;
    if (!page) return;
    this.view.zoom = (this.cw - 80) / page.w;
    this.view.x = 40; this.view.y = 40;
    this.viewChanged();
  }

  zoomAt(factor, sx = this.cw / 2, sy = this.ch / 2) {
    const z0 = this.view.zoom;
    const z = Math.max(0.03, Math.min(12, z0 * factor));
    this.view.x = sx - ((sx - this.view.x) * z) / z0;
    this.view.y = sy - ((sy - this.view.y) * z) / z0;
    this.view.zoom = z;
    this.viewChanged();
  }

  setZoom(z) { this.zoomAt(z / this.view.zoom); }

  panBy(dx, dy) {
    this.view.x += dx; this.view.y += dy;
    this.viewChanged();
  }

  viewChanged() {
    this.positionTextEditor();
    clearTimeout(this._viewTimer);
    this._viewTimer = setTimeout(() => { this.buildViewCaches(); this.requestRender(); }, 140);
    this.emit('view', this.view);
    this.requestRender();
  }

  viewKey() { return `${this.view.zoom.toFixed(5)},${this.view.x.toFixed(2)},${this.view.y.toFixed(2)},${this.canvas.width},${this.canvas.height}`; }
  toPage(sx, sy) { return [(sx - this.view.x) / this.view.zoom, (sy - this.view.y) / this.view.zoom]; }
  toScreen(p) { return [p[0] * this.view.zoom + this.view.x, p[1] * this.view.zoom + this.view.y]; }
  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ------------------------------------------------------------ caches
  invalidate(layerId) {
    const c = this.caches.get(layerId);
    if (c) { c.valid = false; c.viewKey = null; }
  }
  invalidateAll() { this.caches.forEach((c) => { c.valid = false; c.viewKey = null; }); }

  ensureCaches() {
    const page = this.page;
    const env = { grid: page.grid };
    let rebuilt = false;
    for (const layer of page.layers) {
      let c = this.caches.get(layer.id);
      if (!c) { c = { page: new OffscreenCanvas(page.w, page.h), valid: false, view: null, viewKey: null }; this.caches.set(layer.id, c); }
      if (!c.valid) {
        const ctx = c.page.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, page.w, page.h);
        renderLayer(ctx, layer, env, this.hidden);
        c.valid = true;
        rebuilt = true;
      }
    }
    for (const id of [...this.caches.keys()]) if (!findLayer(page, id)) this.caches.delete(id);
    if (rebuilt) { clearTimeout(this._viewTimer); this._viewTimer = setTimeout(() => { this.buildViewCaches(); this.requestRender(); }, 60); }
  }

  needsViewCache() { return this.view.zoom * this.dpr > 1.05; }

  /** Crisp, screen-resolution copies of each layer when zoomed in past 100%. */
  buildViewCaches() {
    const page = this.page;
    if (!page || !this.needsViewCache() || this.drag) return;
    const key = this.viewKey();
    const W = this.canvas.width, H = this.canvas.height;
    const env = { grid: page.grid };
    for (const layer of page.layers) {
      const c = this.caches.get(layer.id);
      if (!c || !c.valid || c.viewKey === key || !layer.visible) continue;
      if (!c.view || c.view.width !== W || c.view.height !== H) c.view = new OffscreenCanvas(W, H);
      const ctx = c.view.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(this.dpr * this.view.zoom, 0, 0, this.dpr * this.view.zoom, this.dpr * this.view.x, this.dpr * this.view.y);
      renderLayer(ctx, layer, env, this.hidden);
      c.viewKey = key;
    }
  }

  // ------------------------------------------------------------ rendering
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    const { ctx, dpr } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.workspaceColor;
    ctx.fillRect(0, 0, W, H);
    const page = this.page;
    if (!page) return;
    const { zoom, x, y } = this.view;
    const vt = [dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y];

    ctx.setTransform(...vt);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 18 * dpr;
    ctx.shadowOffsetY = 3 * dpr;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.w, page.h);
    ctx.restore();
    const bmp = page.bg.kind === 'image' ? this.bitmaps.get(page.bg.asset) : null;
    drawBackground(ctx, page, bmp);

    this.ensureCaches();
    const key = this.viewKey();
    const env = { grid: page.grid };
    const liveIds = this.live ? this.live.layerIds : [];
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      const c = this.caches.get(layer.id);
      const useView = this.needsViewCache() && c.view && c.viewKey === key;
      let src = useView ? c.view : c.page;
      if (liveIds.includes(layer.id)) {
        const tmp = this._tmp(src.width, src.height);
        const t = tmp.getContext('2d');
        t.setTransform(1, 0, 0, 1, 0, 0);
        t.globalCompositeOperation = 'copy';
        t.drawImage(src, 0, 0);
        t.globalCompositeOperation = 'source-over';
        if (useView) t.setTransform(...vt);
        drawStroke(t, this.live.obj, env, this.live.path);
        src = tmp;
      }
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      if (useView) ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(src, 0, 0);
      ctx.restore();
    }
    this.renderOverlays(vt);
  }

  _tmp(w, h) {
    if (!this.tmpCanvas || this.tmpCanvas.width !== w || this.tmpCanvas.height !== h) this.tmpCanvas = new OffscreenCanvas(w, h);
    return this.tmpCanvas;
  }

  renderOverlays(vt) {
    const { ctx, dpr } = this;
    const page = this.page;
    const env = { grid: page.grid };
    const d = this.drag;

    // Objects being moved/scaled/rotated are drawn "lifted" with the live transform.
    if (d && (d.kind === 'xform' || d.kind === 'textMove') && d.M) {
      ctx.save();
      ctx.setTransform(...vt);
      ctx.transform(...d.M);
      for (const o of d.objs) drawObject(ctx, o, env);
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const accent = this.accent || '#3b6cf6';

    if (d && d.kind === 'lasso' && d.pts.length > 1) {
      ctx.save();
      ctx.beginPath();
      d.pts.forEach((p, i) => { const s = this.toScreen(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,108,246,0.08)';
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -(performance.now() / 40) % 9;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.restore();
      this.requestRender();
    }

    if (this.selection && !(d && d.kind === 'xform')) this.drawSelectionBox(ctx, accent);

    if (this.ruler.on) this.drawRuler(ctx, accent);

    // Brush cursor.
    if (this.hover && !this.spaceDown && !(d && d.kind === 'pan')) {
      const t = this.tool;
      const s = this.settings.tools[t];
      if (s && s.size && (PAINT_TOOLS.includes(t) || t === 'eraser' || (t === 'cover' && s.mode === 'brush'))) {
        const r = Math.max(1.5, (s.size * this.view.zoom) / 2);
        ctx.save();
        ctx.beginPath();
        ctx.arc(this.hover[0], this.hover[1], r, 0, Math.PI * 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(this.hover[0], this.hover[1], r + 1, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();
        ctx.restore();
      }
    }

    if (this.flash && performance.now() < this.flash.until) {
      const { text, at } = this.flash;
      ctx.save();
      ctx.font = '600 12px system-ui, "Segoe UI", sans-serif';
      const w = ctx.measureText(text).width + 18;
      const x = at[0] + 14, y = at[1] - 30;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(x, y, w, 22, 11);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 9, y + 15);
      ctx.restore();
      this.requestRender();
    }
  }

  // ------------------------------------------------------------ selection box
  selectionScreenBox() {
    const b = this.selection.box;
    const a = this.toScreen([b.x, b.y]), c = this.toScreen([b.x + b.w, b.y + b.h]);
    return { x: a[0] - 6, y: a[1] - 6, w: c[0] - a[0] + 12, h: c[1] - a[1] + 12 };
  }

  selectionHandles() {
    const s = this.selectionScreenBox();
    return {
      nw: [s.x, s.y], ne: [s.x + s.w, s.y], se: [s.x + s.w, s.y + s.h], sw: [s.x, s.y + s.h],
      rot: [s.x + s.w / 2, s.y - 26],
    };
  }

  drawSelectionBox(ctx, accent) {
    const s = this.selectionScreenBox();
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.setLineDash([]);
    const h = this.selectionHandles();
    ctx.beginPath();
    ctx.moveTo(s.x + s.w / 2, s.y);
    ctx.lineTo(h.rot[0], h.rot[1]);
    ctx.stroke();
    for (const [k, p] of Object.entries(h)) {
      ctx.beginPath();
      if (k === 'rot') ctx.arc(p[0], p[1], 6, 0, Math.PI * 2);
      else ctx.rect(p[0] - 5, p[1] - 5, 10, 10);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ ruler
  rulerThickness() { return 60 / this.view.zoom; }
  rulerAxis() {
    const a = this.ruler.angle;
    return { c: [this.ruler.x, this.ruler.y], u: [Math.cos(a), Math.sin(a)], n: [-Math.sin(a), Math.cos(a)] };
  }
  /** Signed perpendicular distance and along-axis position of p relative to the ruler. */
  rulerLocal(p) {
    const { c, u, n } = this.rulerAxis();
    const dx = p[0] - c[0], dy = p[1] - c[1];
    return { along: dx * u[0] + dy * u[1], perp: dx * n[0] + dy * n[1] };
  }

  toggleRuler() {
    const page = this.page;
    if (!page) return;
    this.ruler.on = !this.ruler.on;
    if (this.ruler.on) {
      const c = this.toPage(this.cw / 2, this.ch / 2);
      this.ruler.x = c[0]; this.ruler.y = c[1];
    }
    this.emit('ruler', this.ruler.on);
    this.toast(this.ruler.on ? 'Ruler on: drag to move, drag the round knobs to rotate. Draw along an edge for straight lines.' : 'Ruler off');
    this.requestRender();
  }

  hitRuler(sp) {
    if (!this.ruler.on) return null;
    const p = this.toPage(sp[0], sp[1]);
    const { along, perp } = this.rulerLocal(p);
    const half = this.rulerThickness() / 2;
    const knob = 150 / this.view.zoom;
    for (const sgn of [-1, 1]) {
      const { c, u } = this.rulerAxis();
      const kp = this.toScreen([c[0] + u[0] * knob * sgn, c[1] + u[1] * knob * sgn]);
      if (dist(kp, sp) < 14) return 'rotate';
    }
    if (Math.abs(perp) < half - 3 / this.view.zoom) return 'move';
    void along;
    return null;
  }

  /** If p starts near a ruler edge, return the line strokes should stick to. */
  rulerEdgeFor(p, size) {
    if (!this.ruler.on) return null;
    const { perp } = this.rulerLocal(p);
    const half = this.rulerThickness() / 2;
    const reach = 34 / this.view.zoom;
    if (Math.abs(perp) < half - 3 / this.view.zoom || Math.abs(perp) > half + reach) return null;
    const { c, u, n } = this.rulerAxis();
    const off = Math.sign(perp) * (half + size / 2);
    return { a: [c[0] + n[0] * off, c[1] + n[1] * off], u };
  }

  drawRuler(ctx, accent) {
    const { c, u, n } = this.rulerAxis();
    const z = this.view.zoom;
    const half = this.rulerThickness() / 2;
    const L = 6000 / z;
    const sc = this.toScreen(c);
    ctx.save();
    ctx.translate(sc[0], sc[1]);
    ctx.rotate(this.ruler.angle);
    const hs = half * z;
    ctx.fillStyle = 'rgba(245,247,250,0.72)';
    ctx.strokeStyle = 'rgba(40,50,70,0.55)';
    ctx.lineWidth = 1;
    ctx.fillRect(-L, -hs, L * 2, hs * 2);
    ctx.beginPath();
    ctx.moveTo(-L, -hs); ctx.lineTo(L, -hs); ctx.moveTo(-L, hs); ctx.lineTo(L, hs);
    ctx.stroke();
    // Millimetre ticks along both edges.
    const mm = (this.page.dpi / 25.4) * z;
    if (mm > 2.5) {
      ctx.beginPath();
      const span = Math.ceil(Math.max(this.cw, this.ch) / mm) + 2;
      for (let i = -span; i <= span; i++) {
        const tx = i * mm;
        const len = i % 10 === 0 ? 14 : i % 5 === 0 ? 9 : 5;
        ctx.moveTo(tx, -hs); ctx.lineTo(tx, -hs + len);
        ctx.moveTo(tx, hs); ctx.lineTo(tx, hs - len);
      }
      ctx.strokeStyle = 'rgba(40,50,70,0.6)';
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(30,35,45,0.85)';
    ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    let deg = Math.round(((-this.ruler.angle * 180) / Math.PI) % 360);
    if (deg < 0) deg += 360;
    ctx.fillText(deg + '°', 0, 4);
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sgn * 150, 0, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sgn * 150, 0, 4, -1, 2);
      ctx.stroke();
    }
    ctx.restore();
    void n;
  }

  // ------------------------------------------------------------ tools
  setTool(t) {
    if (t === this.tool && t === 'eraser') {
      const s = this.settings.tools.eraser;
      s.mode = s.mode === 'brush' ? 'stroke' : 'brush';
      this.toast(s.mode === 'brush' ? 'Eraser: brush (rubs out pixels)' : 'Eraser: stroke (removes whole strokes)');
    } else if (t === this.tool && t === 'cover') {
      const s = this.settings.tools.cover;
      s.mode = s.mode === 'brush' ? 'box' : 'brush';
      this.toast(s.mode === 'brush' ? 'Cover: brush' : 'Cover: box (drag a rectangle)');
    }
    if (t !== this.tool) {
      this.closeTextEditor();
      if (t !== 'lasso' && t !== 'eyedropper') this.clearSelection();
      if (this.tool !== 'eyedropper') this.prevTool = this.tool;
      this.tool = t;
    }
    this.updateCursor();
    this.emit('tool', this.tool);
    this.requestRender();
  }

  updateCursor() {
    const t = this.tool;
    let c = 'crosshair';
    if (this.spaceDown) c = this.drag?.kind === 'pan' ? 'grabbing' : 'grab';
    else if (t === 'text') c = 'text';
    else if (t === 'lasso') c = 'default';
    else if (t === 'eyedropper') c = 'copy';
    else if (PAINT_TOOLS.includes(t) || t === 'eraser' || t === 'cover') c = 'none';
    if (t === 'cover' && this.settings.tools.cover.mode === 'box') c = 'crosshair';
    this.canvas.style.cursor = c;
  }

  setSpace(down) {
    this.spaceDown = down;
    this.updateCursor();
    this.requestRender();
  }

  /** Change a setting of the current tool (size, opacity, color...). */
  setToolSetting(key, value) {
    const t = this.tool === 'eyedropper' ? this.prevTool : this.tool;
    const s = this.settings.tools[t];
    if (!s) return;
    s[key] = value;
    if (key === 'color' || key === 'font' || key === 'weight') this.applyToSelection({ [key]: value });
    if (this.textEditor) this.updateTextDraft({ [key]: value });
    this.emit('settings');
    this.requestRender();
  }

  currentColor() {
    const t = this.tool === 'eyedropper' || this.tool === 'lasso' || this.tool === 'eraser' || this.tool === 'cover' ? this.prevTool : this.tool;
    return (this.settings.tools[t] || this.settings.tools.pen).color || '#000000';
  }

  setColor(color) {
    let t = this.tool;
    if (!this.settings.tools[t]?.color) t = PAINT_TOOLS.includes(this.prevTool) || this.prevTool === 'text' ? this.prevTool : 'pen';
    this.settings.tools[t].color = color;
    this.applyToSelection({ color });
    if (this.textEditor) this.updateTextDraft({ color });
    this.emit('settings');
  }

  // ------------------------------------------------------------ pointer input
  onPointerDown(e) {
    if (!this.page || this.drag) return;
    const sp = this.eventPoint(e);
    if (this.textEditor) { this.closeTextEditor(); if (this.tool === 'text') return; }
    this.canvas.setPointerCapture(e.pointerId);
    this.hover = sp;

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.drag = { kind: 'pan', last: sp };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const p = this.toPage(sp[0], sp[1]);

    const rh = this.hitRuler(sp);
    if (rh) {
      const loc = this.rulerLocal(p);
      this.drag = { kind: rh === 'move' ? 'rulerMove' : 'rulerRotate', start: p, orig: { ...this.ruler }, along: loc.along };
      return;
    }

    const t = this.tool;
    if (t === 'eyedropper' || (e.altKey && (PAINT_TOOLS.includes(t) || t === 'text' || t === 'cover'))) {
      this.pickColor(sp, t === 'cover');
      if (t === 'eyedropper') this.setTool(this.prevTool);
      return;
    }
    if (PAINT_TOOLS.includes(t) || (t === 'eraser' && this.settings.tools.eraser.mode === 'brush') || (t === 'cover' && this.settings.tools.cover.mode === 'brush')) {
      this.startStroke(p, sp, e);
    } else if (t === 'eraser') {
      this.startStrokeErase(p);
    } else if (t === 'cover') {
      this.startCoverBox(p);
    } else if (t === 'lasso') {
      this.startLasso(p, sp, e);
    } else if (t === 'text') {
      this.startText(p);
    }
    this.requestRender();
  }

  onPointerMove(e) {
    const sp = this.eventPoint(e);
    this.hover = sp;
    const d = this.drag;
    if (!d) { this.requestRender(); return; }
    const p = this.toPage(sp[0], sp[1]);
    switch (d.kind) {
      case 'pan':
        this.panBy(sp[0] - d.last[0], sp[1] - d.last[1]);
        d.last = sp;
        break;
      case 'rulerMove':
        this.ruler.x = d.orig.x + p[0] - d.start[0];
        this.ruler.y = d.orig.y + p[1] - d.start[1];
        break;
      case 'rulerRotate': {
        const c = [this.ruler.x, this.ruler.y];
        let a = Math.atan2(p[1] - c[1], p[0] - c[0]);
        if (d.along < 0) a += Math.PI;
        const step = e.shiftKey ? Math.PI / 12 : Math.PI / 4;
        const snapped = Math.round(a / step) * step;
        if (e.shiftKey || Math.abs(a - snapped) < (3 * Math.PI) / 180) a = snapped;
        this.ruler.angle = a;
        break;
      }
      case 'stroke': this.moveStroke(e, p, sp); break;
      case 'strokeErase': this.moveStrokeErase(p); break;
      case 'coverBox': this.moveCoverBox(p, e); break;
      case 'lasso':
        if (dist(p, d.pts[d.pts.length - 1]) > 2 / this.view.zoom) d.pts.push(p);
        break;
      case 'xform': this.moveXform(p, e); break;
      case 'textMove': this.moveTextDrag(p); break;
    }
    this.requestRender();
  }

  onPointerUp(e) {
    const d = this.drag;
    if (!d) return;
    const p = this.toPage(...this.eventPoint(e));
    try {
      switch (d.kind) {
        case 'stroke': this.endStroke(p); break;
        case 'strokeErase': this.endStrokeErase(); break;
        case 'coverBox': this.endCoverBox(); break;
        case 'lasso': this.endLasso(d); break;
        case 'xform': this.endXform(); break;
        case 'textMove': this.endTextDrag(p); break;
      }
    } finally {
      this.drag = null;
      this.live = null;
      this.updateCursor();
      this.requestRender();
      if (this.needsViewCache()) { clearTimeout(this._viewTimer); this._viewTimer = setTimeout(() => { this.buildViewCaches(); this.requestRender(); }, 30); }
    }
  }

  onWheel(e) {
    e.preventDefault();
    if (!this.page) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    if (e.ctrlKey || e.metaKey) {
      const sp = this.eventPoint(e);
      this.zoomAt(Math.exp(-dy * 0.0022), sp[0], sp[1]);
    } else if (e.shiftKey && !dx) {
      this.panBy(-dy, 0);
    } else {
      this.panBy(-dx, -dy);
    }
  }

  onDoubleClick(e) {
    if (this.tool !== 'lasso' || !this.page) return;
    const p = this.toPage(...this.eventPoint(e));
    const hit = this.hitObject(p, true);
    if (hit && hit.obj.type === 'text') this.openTextEditor(hit.obj, hit.layerId);
  }

  // ------------------------------------------------------------ strokes
  stabilizerFor() {
    const k = this.settings.stabilizer / 100;
    const z = this.view.zoom;
    return new Stabilizer({ radius: (k * 22) / z, smoothing: k * 0.82, minStep: 0.6 / z });
  }

  startStroke(p, sp, e) {
    const layer = this.layer;
    const t = this.tool;
    const s = this.settings.tools[t];
    const layerIds = t === 'eraser' && s.allLayers ? this.page.layers.filter((l) => l.visible).map((l) => l.id) : [layer.id];
    if (!layer.visible && !(t === 'eraser' && s.allLayers)) { this.toast('This layer is hidden. Show it to draw on it.'); return; }
    const obj = {
      id: uid('s'), type: 'stroke', tool: t,
      color: t === 'eraser' || t === 'cover' ? '#000000' : s.color,
      size: s.size, opacity: t === 'eraser' || t === 'cover' ? 1 : s.opacity,
      paths: [[[p[0], p[1], 0]]],
    };
    const stab = this.stabilizerFor();
    stab.start(p);
    const now = performance.now();
    this.drag = {
      kind: 'stroke', obj, stab, t0: now, lastEvt: now, lastTick: now,
      stillSince: now, stillAt: sp, start: p, shift: e.shiftKey, raw: [p],
      ruler: this.rulerEdgeFor(p, s.size), snapped: null,
    };
    if (this.drag.ruler) obj.paths[0][0] = this._rulerProject(p, this.drag.ruler, 0);
    this.live = { obj, layerIds, path: buildStrokePath(obj) };
    this._strokeLoop();
  }

  _rulerProject(p, r, t) { const q = projectOnLine(p, r.a, r.u); return [q[0], q[1], t]; }

  _pushPts(pts) {
    const d = this.drag;
    const t = Math.round(performance.now() - d.t0);
    const path = d.obj.paths[0];
    for (const q of pts) path.push(d.ruler ? this._rulerProject(q, d.ruler, t) : [q[0], q[1], t]);
  }

  _strokeLoop() {
    const step = () => {
      const d = this.drag;
      if (!d || d.kind !== 'stroke') return;
      const now = performance.now();
      if (!d.snapped && !d.shift && now - d.lastEvt > 12) {
        this._pushPts(d.stab.tick(now - d.lastTick));
        d.lastTick = now;
        this._refreshLive();
      }
      // Draw-and-hold: snap to a clean shape.
      if (!d.snapped && !d.shift && d.obj.tool !== 'eraser' && now - d.stillSince > 480) this.trySnap();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _refreshLive() {
    if (!this.live) return;
    this.live.path = buildStrokePath(this.live.obj);
    this.requestRender();
  }

  moveStroke(e, p, sp) {
    const d = this.drag;
    if (dist(sp, d.stillAt) > 4) { d.stillSince = performance.now(); d.stillAt = sp; }
    if (d.snapped) {
      d.obj.paths = adjustShape(d.snapped, d.snapAnchor, p, { shift: e.shiftKey, size: d.obj.size }).map((pa) => pa.map((q) => [q[0], q[1], d.snapT]));
      this._refreshLive();
      return;
    }
    if (d.shift) {
      const b = snapAngle(d.start, p, Math.PI, Math.PI / 12);
      const t = Math.round(performance.now() - d.t0);
      d.obj.paths = [linePath(d.start, dist(d.start, b) > 0.5 ? b : p).map((q) => [q[0], q[1], t])];
      d.obj.shape = 'line';
      this._refreshLive();
      return;
    }
    const evts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evts.length ? evts : [e]) {
      const q = this.toPage(...this.eventPoint(ev));
      d.raw.push(q);
      const now = ev.timeStamp || performance.now();
      d.stab.move(q);
      this._pushPts(d.stab.tick(Math.max(1, now - d.lastTick)));
      d.lastTick = now;
    }
    d.lastEvt = performance.now();
    d.lastTick = d.lastEvt;
    this._refreshLive();
  }

  trySnap() {
    const d = this.drag;
    const pts = d.raw;
    if (pts.length < 4 || pathLength(pts) < 18 / this.view.zoom) { d.stillSince = Infinity; return; }
    // Recognise from the raw pointer path: the stabilizer would round off corners and arrowheads.
    const shape = recognize(pts);
    d.stillSince = Infinity; // only try once per stillness
    if (!shape) return;
    d.snapped = shape;
    d.snapAnchor = this.toPage(...d.stillAt);
    d.snapT = Math.round(performance.now() - d.t0);
    d.obj.paths = shape.paths.map((pa) => pa.map((q) => [q[0], q[1], d.snapT]));
    d.obj.shape = shape.kind;
    if (d.obj.tool === 'cover' && shape.closed) d.obj.fill = true;
    this.flash = { text: SHAPE_NAMES[shape.kind] || 'Shape', at: d.stillAt, until: performance.now() + 900 };
    this._refreshLive();
  }

  endStroke(p) {
    const d = this.drag;
    const obj = d.obj;
    if (!d.snapped && !d.shift) this._pushPts(d.stab.finish(p));
    if (obj.paths[0].length === 1) { const q = obj.paths[0][0]; obj.paths[0].push([q[0] + 0.01, q[1], q[2]]); }
    const dur = obj.paths[0][obj.paths[0].length - 1][2] || 0;
    const page = this.page;
    const ops = this.live.layerIds.map((lid, i) => opAddObjs(page, findLayer(page, lid), [i ? { ...obj, id: uid('s') } : obj]));
    this.live = null;
    this.commit(batch(ops), { dur });
  }

  // ------------------------------------------------------------ stroke eraser
  startStrokeErase(p) {
    const s = this.settings.tools.eraser;
    const layers = s.allLayers ? this.page.layers.filter((l) => l.visible) : [this.layer];
    this.drag = { kind: 'strokeErase', last: p, layers, hits: new Map() };
    this.moveStrokeErase(p);
  }

  moveStrokeErase(p) {
    const d = this.drag;
    const r = this.settings.tools.eraser.size / 2;
    for (const layer of d.layers) {
      let changed = false;
      for (const o of layer.objects) {
        if (this.hidden.has(o.id)) continue;
        if (this.objHitsSegment(o, d.last, p, r)) {
          if (!d.hits.has(layer.id)) d.hits.set(layer.id, []);
          d.hits.get(layer.id).push(o.id);
          this.hidden.add(o.id);
          changed = true;
        }
      }
      if (changed) this.invalidate(layer.id);
    }
    d.last = p;
  }

  endStrokeErase() {
    const d = this.drag;
    const ops = [];
    for (const [lid, ids] of d.hits) {
      ids.forEach((id) => this.hidden.delete(id));
      ops.push(opDelObjs(this.page, findLayer(this.page, lid), ids));
    }
    if (ops.length) this.commit(batch(ops));
  }

  objHitsSegment(o, a, b, r) {
    const box = objBBox(o, measureText);
    const seg = bboxOfPoints([a, b], r);
    if (!box || !boxesOverlap(box, seg)) return false;
    if (o.type === 'text') {
      const poly = textCorners(o, measureText);
      if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
      return poly.some((q, i) => distToSegment(q, a, b) < r || distToSegment(a, q, poly[(i + 1) % 4]) < r);
    }
    const rr = r + o.size / 2;
    for (const path of o.paths) {
      if (o.fill && (pointInPolygon(a, path) || pointInPolygon(b, path))) return true;
      for (let i = 0; i < path.length; i++) {
        if (distToSegment(path[i], a, b) < rr) return true;
        if (i && dist(path[i], path[i - 1]) > rr && distToSegment(a, path[i - 1], path[i]) < rr) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ cover box
  startCoverBox(p) {
    if (!this.layer.visible) { this.toast('This layer is hidden.'); return; }
    const obj = { id: uid('s'), type: 'stroke', tool: 'cover', color: '#000000', size: 0, opacity: 1, fill: true, shape: 'rect', paths: [[[p[0], p[1], 0]]] };
    this.drag = { kind: 'coverBox', start: p, obj, t0: performance.now() };
    this.live = { obj, layerIds: [this.layer.id], path: buildStrokePath(obj) };
  }

  moveCoverBox(p) {
    const d = this.drag;
    const a = d.start;
    const t = Math.round(performance.now() - d.t0);
    d.obj.paths = [[[a[0], a[1], t], [p[0], a[1], t], [p[0], p[1], t], [a[0], p[1], t]]];
    this.live.path = buildStrokePath(d.obj);
  }

  endCoverBox() {
    const d = this.drag;
    const b = bboxOfPoints(d.obj.paths[0]);
    if (!b || b.w < 2 || b.h < 2) return;
    this.live = null;
    this.commit(opAddObjs(this.page, this.layer, [d.obj]), { dur: 0 });
  }

  // ------------------------------------------------------------ lasso & selection
  startLasso(p, sp, e) {
    if (this.selection) {
      const h = this.hitSelectionHandle(sp);
      if (h) { this.startXform(h, p); return; }
      if (e.shiftKey === false) this.clearSelection();
    }
    this.drag = { kind: 'lasso', pts: [p], sp };
  }

  hitSelectionHandle(sp) {
    const h = this.selectionHandles();
    for (const [k, p] of Object.entries(h)) if (dist(p, sp) < 10) return k;
    const s = this.selectionScreenBox();
    if (pointInBox(sp, s)) return 'move';
    return null;
  }

  selectableLayers() {
    return this.settings.tools.lasso.allLayers ? this.page.layers.filter((l) => l.visible) : [this.layer].filter((l) => l && l.visible);
  }

  endLasso(d) {
    const tiny = d.pts.length < 4 || pathLength(d.pts) < 8 / this.view.zoom;
    const items = [];
    if (tiny) {
      const hit = this.hitObject(d.pts[0], true);
      if (hit) items.push({ layerId: hit.layerId, id: hit.obj.id });
    } else {
      for (const layer of this.selectableLayers()) {
        for (const o of layer.objects) {
          let pts;
          if (o.type === 'text') {
            const c = textCorners(o, measureText);
            pts = [...c, [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2]];
          } else {
            const all = o.paths.flat();
            const step = Math.max(1, Math.floor(all.length / 60));
            pts = all.filter((_, i) => i % step === 0);
          }
          const inside = pts.filter((q) => pointInPolygon(q, d.pts)).length;
          if (inside / pts.length >= 0.5) items.push({ layerId: layer.id, id: o.id });
        }
      }
    }
    this.setSelection(items);
  }

  setSelection(items) {
    if (!items.length) { this.clearSelection(); return; }
    this.selection = { items };
    this.updateSelectionBox();
    this.emit('selection');
  }

  selectedObjects() {
    if (!this.selection) return [];
    const out = [];
    for (const it of this.selection.items) {
      const layer = findLayer(this.page, it.layerId);
      const o = layer && layer.objects.find((x) => x.id === it.id);
      if (o) out.push({ layer, obj: o });
    }
    return out;
  }

  updateSelectionBox() {
    let box = null;
    const sel = this.selectedObjects();
    for (const { obj } of sel) box = unionBox(box, objBBox(obj, measureText));
    if (!box) { this.clearSelection(); return; }
    this.selection.items = sel.map(({ layer, obj }) => ({ layerId: layer.id, id: obj.id }));
    this.selection.box = box;
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.emit('selection');
    this.requestRender();
  }

  selectAll() {
    if (!this.page) return;
    if (this.tool !== 'lasso') this.setTool('lasso');
    const items = [];
    for (const layer of this.selectableLayers()) for (const o of layer.objects) items.push({ layerId: layer.id, id: o.id });
    this.setSelection(items);
    this.requestRender();
  }

  startXform(mode, p) {
    const sel = this.selectedObjects();
    const box = this.selection.box;
    this.drag = { kind: 'xform', mode, start: p, box, sel, objs: sel.map((s) => s.obj), M: null };
    sel.forEach(({ obj }) => this.hidden.add(obj.id));
    new Set(sel.map((s) => s.layer.id)).forEach((id) => this.invalidate(id));
  }

  moveXform(p, e) {
    const d = this.drag;
    const b = d.box;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (d.mode === 'move') {
      d.M = matTranslate(p[0] - d.start[0], p[1] - d.start[1]);
    } else if (d.mode === 'rot') {
      let a = Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(d.start[1] - cy, d.start[0] - cx);
      const step = Math.PI / 12;
      if (e.shiftKey) a = Math.round(a / step) * step;
      d.M = matRotateAbout(a, cx, cy);
    } else {
      const anchor = { nw: [b.x + b.w, b.y + b.h], ne: [b.x, b.y + b.h], se: [b.x, b.y], sw: [b.x + b.w, b.y] }[d.mode];
      const s = Math.max(0.05, dist(p, anchor) / Math.max(1e-6, dist(d.start, anchor)));
      d.M = matScaleAbout(s, anchor[0], anchor[1]);
    }
  }

  endXform() {
    const d = this.drag;
    d.sel.forEach(({ obj }) => this.hidden.delete(obj.id));
    new Set(d.sel.map((s) => s.layer.id)).forEach((id) => this.invalidate(id));
    if (!d.M) return;
    this.commitTransform(d.sel, d.M);
  }

  commitTransform(sel, M) {
    const byLayer = new Map();
    for (const { layer, obj } of sel) {
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer).push(obj);
    }
    const ops = [...byLayer].map(([layer, objs]) => opSetObjs(this.page, layer, objs, objs.map((o) => transformObj(o, M))));
    const keep = this.selection;
    this.commit(batch(ops));
    if (keep) { this.selection = keep; this.updateSelectionBox(); this.emit('selection'); }
  }

  nudge(dx, dy) {
    if (!this.selection) return;
    this.commitTransform(this.selectedObjects(), matTranslate(dx / this.view.zoom, dy / this.view.zoom));
  }

  deleteSelection() {
    const sel = this.selectedObjects();
    if (!sel.length) return;
    const byLayer = new Map();
    sel.forEach(({ layer, obj }) => { if (!byLayer.has(layer)) byLayer.set(layer, []); byLayer.get(layer).push(obj.id); });
    this.selection = null;
    this.commit(batch([...byLayer].map(([layer, ids]) => opDelObjs(this.page, layer, ids))));
    this.emit('selection');
  }

  copySelection(cut = false) {
    const sel = this.selectedObjects();
    if (!sel.length) return false;
    this.clipboard = sel.map((s) => clone(s.obj));
    if (cut) this.deleteSelection();
    this.toast(cut ? `Cut ${sel.length} item(s)` : `Copied ${sel.length} item(s)`);
    return true;
  }

  paste(offset = 24) {
    if (!this.clipboard || !this.page) return;
    const layer = this.layer;
    const objs = this.clipboard.map((o) => transformObj({ ...clone(o), id: uid(o.type === 'text' ? 't' : 's') }, matTranslate(offset, offset)));
    this.clipboard = objs.map(clone);
    if (this.tool !== 'lasso') this.setTool('lasso');
    this.commit(opAddObjs(this.page, layer, objs));
    this.setSelection(objs.map((o) => ({ layerId: layer.id, id: o.id })));
  }

  duplicateSelection() {
    if (this.copySelection()) this.paste();
  }

  /** Recolour / restyle the selected objects. */
  applyToSelection(props) {
    if (!this.selection || this.tool !== 'lasso') return;
    const sel = this.selectedObjects().filter(({ obj }) => {
      if (obj.type === 'text') return true;
      return 'color' in props && obj.type === 'stroke' && obj.tool !== 'eraser' && obj.tool !== 'cover';
    });
    if (!sel.length) return;
    const byLayer = new Map();
    for (const { layer, obj } of sel) {
      const p = obj.type === 'text' ? props : { color: props.color };
      if (Object.keys(p).every((k) => p[k] === undefined || obj[k] === p[k])) continue;
      if (!byLayer.has(layer)) byLayer.set(layer, [[], []]);
      byLayer.get(layer)[0].push(obj);
      byLayer.get(layer)[1].push({ ...obj, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) });
    }
    if (!byLayer.size) return;
    const keep = this.selection;
    this.commit(batch([...byLayer].map(([layer, [b, a]]) => opSetObjs(this.page, layer, b, a))));
    this.selection = keep;
    this.updateSelectionBox();
  }

  scaleSelectedText(factor) {
    const sel = this.selectedObjects().filter((s) => s.obj.type === 'text');
    if (!sel.length) return;
    const byLayer = new Map();
    for (const { layer, obj } of sel) {
      if (!byLayer.has(layer)) byLayer.set(layer, [[], []]);
      byLayer.get(layer)[0].push(obj);
      byLayer.get(layer)[1].push({ ...obj, size: Math.max(6, obj.size * factor), w: obj.w ? obj.w * factor : 0 });
    }
    const keep = this.selection;
    this.commit(batch([...byLayer].map(([layer, [b, a]]) => opSetObjs(this.page, layer, b, a))));
    this.selection = keep;
    this.updateSelectionBox();
  }

  /** Topmost object under p (active layer first). */
  hitObject(p, anyLayer = false) {
    const layers = anyLayer ? [this.layer, ...[...this.page.layers].reverse().filter((l) => l !== this.layer)] : [this.layer];
    const tol = 6 / this.view.zoom;
    for (const layer of layers) {
      if (!layer || !layer.visible) continue;
      for (let i = layer.objects.length - 1; i >= 0; i--) {
        const o = layer.objects[i];
        if (o.type === 'stroke' && o.tool === 'eraser') continue;
        if (o.type === 'text') {
          if (pointInPolygon(p, textCorners(o, measureText))) return { layerId: layer.id, obj: o };
        } else if (this.objHitsSegment(o, p, p, tol)) return { layerId: layer.id, obj: o };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ eyedropper
  pickColor(sp, forPaper = false) {
    const px = this.ctx.getImageData(Math.round(sp[0] * this.dpr), Math.round(sp[1] * this.dpr), 1, 1).data;
    const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (forPaper) {
      this.setGrid({ paper: hex });
      this.toast('Cover paper colour set to ' + hex);
    } else {
      this.setColor(hex);
      this.toast('Picked ' + hex);
    }
    this.emit('settings');
  }

  setGrid(props) {
    const page = this.page;
    if (!page) return;
    const before = {}, after = {};
    before.grid = clone(page.grid);
    after.grid = { ...page.grid, ...props };
    this.commit({ type: 'pageProps', page: page.id, before, after });
    this.invalidateAll();
    this.requestRender();
  }

  // ------------------------------------------------------------ text
  startText(p) {
    const hit = this.hitObject(p, true);
    if (hit && hit.obj.type === 'text') {
      this.drag = { kind: 'textMove', start: p, hit, objs: [hit.obj], M: null, moved: false };
      return;
    }
    if (!this.layer.visible) { this.toast('This layer is hidden.'); return; }
    const s = this.settings.tools.text;
    this.openTextEditor(null, this.layer.id, [p[0], p[1] - s.size * 0.62]);
  }

  moveTextDrag(p) {
    const d = this.drag;
    if (!d.moved && dist(p, d.start) * this.view.zoom < 3) return;
    if (!d.moved) { d.moved = true; this.hidden.add(d.hit.obj.id); this.invalidate(d.hit.layerId); }
    d.M = matTranslate(p[0] - d.start[0], p[1] - d.start[1]);
  }

  endTextDrag() {
    const d = this.drag;
    if (!d.moved) { this.drag = null; this.openTextEditor(d.hit.obj, d.hit.layerId); return; }
    this.hidden.delete(d.hit.obj.id);
    this.invalidate(d.hit.layerId);
    const layer = findLayer(this.page, d.hit.layerId);
    this.commit(opSetObjs(this.page, layer, [d.hit.obj], [transformObj(d.hit.obj, d.M)]));
  }

  openTextEditor(obj, layerId, at) {
    this.closeTextEditor();
    const s = this.settings.tools.text;
    const draft = obj ? { ...obj } : {
      id: uid('t'), type: 'text', x: at[0], y: at[1], text: '', font: s.font, size: s.size, weight: s.weight,
      color: s.color, opacity: 1, w: 0, rot: 0,
    };
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.spellcheck = false;
    ta.value = draft.text;
    this.stage.appendChild(ta);
    const t0 = performance.now();
    this.textEditor = { ta, draft, orig: obj, layerId, typing: [[0, draft.text]], t0 };
    if (obj) { this.hidden.add(obj.id); this.invalidate(layerId); }
    ta.addEventListener('input', () => {
      this.textEditor.draft.text = ta.value;
      this.textEditor.typing.push([Math.round(performance.now() - t0), ta.value]);
      this.positionTextEditor();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.closeTextEditor(); }
    });
    ta.addEventListener('blur', (e) => {
      if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-keeps-text]')) return;
      setTimeout(() => { if (this.textEditor && this.textEditor.ta === ta && document.activeElement !== ta && !document.activeElement?.closest?.('[data-keeps-text]')) this.closeTextEditor(); }, 0);
    });
    this.positionTextEditor();
    if (obj) { this.settings.tools.text.font = obj.font; this.settings.tools.text.size = Math.round(obj.size); this.settings.tools.text.color = obj.color; this.emit('settings'); }
    const focus = () => { if (this.textEditor?.ta === ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } };
    focus();
    requestAnimationFrame(focus);
    setTimeout(focus, 0);
    this.emit('textedit', true);
    this.requestRender();
  }

  updateTextDraft(props) {
    const te = this.textEditor;
    if (!te) return;
    if ('size' in props) props.size = Math.max(4, +props.size);
    Object.assign(te.draft, Object.fromEntries(Object.entries(props).filter(([k]) => ['font', 'size', 'color', 'weight'].includes(k))));
    this.positionTextEditor();
  }

  refocusText() { if (this.textEditor) this.textEditor.ta.focus(); }

  positionTextEditor() {
    const te = this.textEditor;
    if (!te) return;
    const { ta, draft } = te;
    const z = this.view.zoom;
    const sp = this.toScreen([draft.x, draft.y]);
    const L = textLayout({ ...draft, text: draft.text || ' ' });
    Object.assign(ta.style, {
      left: sp[0] + 'px', top: sp[1] + 'px',
      fontFamily: `"${draft.font}", "Segoe Print", cursive`,
      fontWeight: draft.weight || 400,
      fontSize: draft.size * z + 'px',
      lineHeight: String(LINE_HEIGHT),
      color: draft.color,
      width: Math.max(L.w + draft.size * 0.8, draft.size * 2) * z + 'px',
      height: L.h * z + 2 + 'px',
      transform: draft.rot ? `rotate(${draft.rot}rad)` : '',
    });
  }

  closeTextEditor(commit = true) {
    const te = this.textEditor;
    if (!te) return;
    this.textEditor = null;
    te.ta.remove();
    if (te.orig) { this.hidden.delete(te.orig.id); this.invalidate(te.layerId); }
    this.emit('textedit', false);
    this.requestRender();
    if (!commit || !this.page) return;
    const layer = findLayer(this.page, te.layerId);
    if (!layer) return;
    const text = te.draft.text.replace(/\s+$/, '');
    const draft = { ...te.draft, text };
    const anim = te.typing.length > 1 ? te.typing : undefined;
    if (te.orig) {
      if (!text.trim()) this.commit(opDelObjs(this.page, layer, [te.orig.id]));
      else if (JSON.stringify(draft) !== JSON.stringify(te.orig)) this.commit(opSetObjs(this.page, layer, [te.orig], [draft]), { anim });
    } else if (text.trim()) {
      this.commit(opAddObjs(this.page, layer, [draft]), { anim });
    }
  }

  // ------------------------------------------------------------ layers
  addLayer() {
    const page = this.page;
    const idx = page.layers.findIndex((l) => l.id === this.activeLayerId) + 1;
    const layer = newLayer('Layer ' + (page.layers.length + 1));
    this.commit({ type: 'insLayer', page: page.id, layer, index: idx });
    this.setActiveLayer(layer.id);
  }

  deleteLayer(id = this.activeLayerId) {
    const page = this.page;
    if (page.layers.length <= 1) {
      const layer = page.layers[0];
      if (layer.objects.length) this.commit(opDelObjs(page, layer, layer.objects.map((o) => o.id)));
      this.toast('Cleared the last layer (a page always keeps one layer)');
      return;
    }
    const index = page.layers.findIndex((l) => l.id === id);
    this.commit({ type: 'delLayer', page: page.id, layer: clone(page.layers[index]), index });
    this.activeLayerId = page.layers[Math.max(0, index - 1)].id;
    this.emit('layers');
  }

  moveLayer(id, dir) {
    const page = this.page;
    const from = page.layers.findIndex((l) => l.id === id);
    const to = from + dir;
    if (to < 0 || to >= page.layers.length) return;
    this.commit({ type: 'moveLayer', page: page.id, from, to });
  }

  moveLayerTo(id, to) {
    const page = this.page;
    const from = page.layers.findIndex((l) => l.id === id);
    if (from < 0 || to === from || to < 0 || to >= page.layers.length) return;
    this.commit({ type: 'moveLayer', page: page.id, from, to });
  }

  setLayerProps(id, after) {
    const layer = findLayer(this.page, id);
    const before = Object.fromEntries(Object.keys(after).map((k) => [k, layer[k]]));
    if (Object.keys(after).every((k) => before[k] === after[k])) return;
    this.commit({ type: 'layerProps', page: this.page.id, layer: id, before, after });
  }

  /** Live preview for sliders; commit with setLayerProps on release. */
  previewLayerOpacity(id, v) {
    const layer = findLayer(this.page, id);
    if (!layer) return;
    if (this._opPreview?.id !== id) this._opPreview = { id, orig: layer.opacity };
    layer.opacity = v;
    this.requestRender();
  }
  commitLayerOpacity(id, v) {
    const layer = findLayer(this.page, id);
    const orig = this._opPreview?.id === id ? this._opPreview.orig : layer.opacity;
    this._opPreview = null;
    layer.opacity = orig;
    this.setLayerProps(id, { opacity: v });
  }

  setPageProps(after) {
    const page = this.page;
    const before = Object.fromEntries(Object.keys(after).map((k) => [k, clone(page[k])]));
    this.commit({ type: 'pageProps', page: page.id, before, after });
    this.requestRender();
  }

}
