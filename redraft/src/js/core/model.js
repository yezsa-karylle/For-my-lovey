// Document model + serialisable, invertible operations.
// Every edit goes through applyOp(), which makes undo/redo, autosave and the
// replay journal all share one source of truth. Objects are never mutated in
// place: an edit replaces them with new copies.
import { bboxOfPoints, applyMat, matScaleFactor, matRotation } from './geometry.js';

export const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function uid(prefix = 'o') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Black, blue, red first (keys 1-3), matching the notes' ink colours.
export const DEFAULT_SWATCHES = ['#212126', '#296bd9', '#e3453d', '#268c4d', '#737880', '#ffdb26', '#fa7366'];

export function defaultGrid(dpi = 200) {
  const sp = (dpi / 25.4) * 5; // 5 mm squares
  return { sx: sp, sy: sp, ox: 0, oy: 0, paper: '#fbfbf7', line: '#c5d3e0', lw: Math.max(1, dpi / 160) };
}

export function newLayer(name = 'Layer 1') {
  return { id: uid('l'), name, visible: true, opacity: 1, objects: [] };
}

export function newPage({ w, h, dpi = 200, bg = { kind: 'grid' }, grid } = {}) {
  return {
    id: uid('p'), w, h, dpi, bg,
    bgVisible: true, bgOpacity: 1,
    grid: grid || defaultGrid(dpi),
    layers: [newLayer('Layer 1')],
  };
}

/** A4 portrait grid page at the given dpi. */
export function newGridPage(dpi = 200, like) {
  const w = like ? like.w : Math.round(8.27 * dpi), h = like ? like.h : Math.round(11.69 * dpi);
  const d = like ? like.dpi : dpi;
  return newPage({ w, h, dpi: d, bg: { kind: 'grid' }, grid: like ? clone(like.grid) : defaultGrid(d) });
}

export function newProject(title = 'Untitled notes') {
  return {
    format: 'redraft', version: 1, id: uid('d'), title,
    createdAt: Date.now(),
    pages: [], swatches: DEFAULT_SWATCHES.slice(),
    initial: null, journal: [],
  };
}

export const findPage = (project, id) => project.pages.find((p) => p.id === id);
export const findLayer = (page, id) => page && page.layers.find((l) => l.id === id);

function mustPage(project, id) {
  const p = findPage(project, id);
  if (!p) throw new Error('Unknown page ' + id);
  return p;
}
function mustLayer(page, id) {
  const l = findLayer(page, id);
  if (!l) throw new Error('Unknown layer ' + id);
  return l;
}

// ---------------------------------------------------------------- op builders
export function opAddObjs(page, layer, objs) {
  const start = layer.objects.length;
  return { type: 'insObjs', page: page.id, layer: layer.id, objs: clone(objs), indices: objs.map((_, i) => start + i) };
}
export function opDelObjs(page, layer, ids) {
  const set = new Set(ids);
  const objs = [], indices = [];
  layer.objects.forEach((o, i) => { if (set.has(o.id)) { objs.push(clone(o)); indices.push(i); } });
  return { type: 'delObjs', page: page.id, layer: layer.id, objs, indices };
}
export function opSetObjs(page, layer, before, after) {
  return { type: 'setObjs', page: page.id, layer: layer.id, before: clone(before), after: clone(after) };
}
export const batch = (ops) => (ops.length === 1 ? ops[0] : { type: 'batch', ops });

// ---------------------------------------------------------------- apply / invert
export function applyOp(project, op) {
  switch (op.type) {
    case 'batch': op.ops.forEach((o) => applyOp(project, o)); break;
    case 'insObjs': {
      const layer = mustLayer(mustPage(project, op.page), op.layer);
      op.objs.forEach((o, i) => layer.objects.splice(Math.min(op.indices[i], layer.objects.length), 0, clone(o)));
      break;
    }
    case 'delObjs': {
      const layer = mustLayer(mustPage(project, op.page), op.layer);
      const ids = new Set(op.objs.map((o) => o.id));
      layer.objects = layer.objects.filter((o) => !ids.has(o.id));
      break;
    }
    case 'setObjs': {
      const layer = mustLayer(mustPage(project, op.page), op.layer);
      const map = new Map(op.after.map((o) => [o.id, o]));
      layer.objects = layer.objects.map((o) => (map.has(o.id) ? clone(map.get(o.id)) : o));
      break;
    }
    case 'insLayer': {
      const page = mustPage(project, op.page);
      page.layers.splice(op.index, 0, clone(op.layer));
      break;
    }
    case 'delLayer': {
      const page = mustPage(project, op.page);
      page.layers = page.layers.filter((l) => l.id !== op.layer.id);
      break;
    }
    case 'layerProps': {
      Object.assign(mustLayer(mustPage(project, op.page), op.layer), clone(op.after));
      break;
    }
    case 'moveLayer': {
      const page = mustPage(project, op.page);
      const [l] = page.layers.splice(op.from, 1);
      page.layers.splice(op.to, 0, l);
      break;
    }
    case 'insPage': project.pages.splice(op.index, 0, clone(op.pageData)); break;
    case 'delPage': project.pages = project.pages.filter((p) => p.id !== op.pageData.id); break;
    case 'movePage': {
      const [p] = project.pages.splice(op.from, 1);
      project.pages.splice(op.to, 0, p);
      break;
    }
    case 'pageProps': Object.assign(mustPage(project, op.page), clone(op.after)); break;
    default: throw new Error('Unknown op ' + op.type);
  }
  return project;
}

export function invertOp(op) {
  switch (op.type) {
    case 'batch': return { type: 'batch', ops: op.ops.map(invertOp).reverse() };
    case 'insObjs': return { ...op, type: 'delObjs' };
    case 'delObjs': return { ...op, type: 'insObjs' };
    case 'setObjs': return { ...op, before: op.after, after: op.before };
    case 'insLayer': return { ...op, type: 'delLayer' };
    case 'delLayer': return { ...op, type: 'insLayer' };
    case 'layerProps': return { ...op, before: op.after, after: op.before };
    case 'moveLayer': return { ...op, from: op.to, to: op.from };
    case 'insPage': return { ...op, type: 'delPage' };
    case 'delPage': return { ...op, type: 'insPage' };
    case 'movePage': return { ...op, from: op.to, to: op.from };
    case 'pageProps': return { ...op, before: op.after, after: op.before };
    default: throw new Error('Unknown op ' + op.type);
  }
}

/** Which pages/layers does an op touch? Returns [{page, layer|null}] (layer null = whole page). */
export function opTargets(op, out = []) {
  if (op.type === 'batch') { op.ops.forEach((o) => opTargets(o, out)); return out; }
  if (op.type === 'insPage' || op.type === 'delPage') out.push({ page: op.pageData.id, layer: null, structural: true });
  else if (op.type === 'movePage') out.push({ page: null, layer: null, structural: true });
  else if (op.type === 'layerProps' || op.type === 'moveLayer') out.push({ page: op.page, layer: null, propsOnly: true });
  else if (op.type === 'insLayer' || op.type === 'delLayer') out.push({ page: op.page, layer: op.layer.id });
  else if (op.type === 'pageProps') out.push({ page: op.page, layer: null, propsOnly: !('grid' in op.after) });
  else out.push({ page: op.page, layer: op.layer });
  return out;
}

// ---------------------------------------------------------------- object helpers
export function objPoints(o) {
  if (o.type === 'stroke') return o.paths.flat();
  return [];
}

/** Bounding box in page coordinates. `measure(obj)` returns {w,h} for text. */
export function objBBox(o, measure) {
  if (o.type === 'stroke') return bboxOfPoints(o.paths.flat(), o.size / 2 + 1);
  if (o.type === 'text') {
    const corners = textCorners(o, measure);
    return bboxOfPoints(corners);
  }
  return null;
}

export function textCorners(o, measure) {
  const { w, h, x0 = 0, y0 = 0 } = measure(o);
  const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
  return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]].map(([x, y]) => [o.x + x * c - y * s, o.y + x * s + y * c]);
}

/** Return a transformed copy of an object (matrix in page coords). */
export function transformObj(o, m) {
  const k = matScaleFactor(m);
  if (o.type === 'stroke') {
    return {
      ...o,
      size: o.size * k,
      paths: o.paths.map((path) => path.map((p) => { const q = applyMat(m, p); return p.length > 2 ? [q[0], q[1], ...p.slice(2)] : q; })),
    };
  }
  if (o.type === 'text') {
    const q = applyMat(m, [o.x, o.y]);
    return { ...o, x: q[0], y: q[1], size: o.size * k, w: o.w ? o.w * k : 0, rot: (o.rot || 0) + matRotation(m) };
  }
  return o;
}

export function translateObj(o, dx, dy) {
  return transformObj(o, [1, 0, 0, 1, dx, dy]);
}
