// Shape recognition for "draw and hold to snap" plus clean shape generators.
import { bboxOfPoints, dist, distToSegment, pathLength, rdp, resample } from './geometry.js';

const STEP = 3; // spacing of generated points, in page px

export function linePath(a, b) {
  return resample([a, b], STEP);
}

export function polyPath(corners, closed) {
  const pts = closed ? [...corners, corners[0]] : corners;
  return resample(pts, STEP);
}

export function ellipsePath(cx, cy, rx, ry, rot = 0) {
  const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / STEP));
  const c = Math.cos(rot), s = Math.sin(rot);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(t) * rx, y = Math.sin(t) * ry;
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}

export function arrowPaths(a, b, size = 4) {
  const len = dist(a, b);
  const head = Math.max(10 + size * 2, Math.min(len * 0.28, 40 + size * 4));
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const spread = 0.5; // ~28 degrees
  const h1 = [b[0] - Math.cos(ang - spread) * head, b[1] - Math.sin(ang - spread) * head];
  const h2 = [b[0] - Math.cos(ang + spread) * head, b[1] - Math.sin(ang + spread) * head];
  return [linePath(a, b), resample([h1, b, h2], STEP)];
}

/** Snap an angle to horizontal/vertical when it is within `tol` radians. */
export function snapAngle(a, b, tol = (4 * Math.PI) / 180, step = Math.PI / 2) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) > tol) return b;
  const len = dist(a, b);
  return [a[0] + Math.cos(snapped) * len, a[1] + Math.sin(snapped) * len];
}

function maxDeviation(pts, poly, closed) {
  let worst = 0;
  const segs = closed ? [...poly, poly[0]] : poly;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 1; i < segs.length; i++) best = Math.min(best, distToSegment(p, segs[i - 1], segs[i]));
    worst = Math.max(worst, best);
  }
  return worst;
}

function interiorAngle(prev, p, next) {
  const a = Math.atan2(prev[1] - p[1], prev[0] - p[0]);
  const b = Math.atan2(next[1] - p[1], next[0] - p[0]);
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

function convexHull(points) {
  const p = points.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area oriented rectangle + mean distance of the path to its outline. */
export function fitRect(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of hull) {
      const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { area, ang, c, s, x0, y0, x1, y1 };
  }
  const { c, s, x0, y0, x1, y1 } = best;
  if (Math.min(x1 - x0, y1 - y0) < 4) return null;
  let err = 0;
  for (const q of pts) {
    const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c;
    err += Math.min(Math.abs(u - x0), Math.abs(u - x1), Math.abs(v - y0), Math.abs(v - y1));
  }
  const back = (u, v) => [u * c - v * s, u * s + v * c];
  return { err: err / pts.length, angle: best.ang, corners: [back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)] };
}

/**
 * Recognise a freehand path. Returns { kind, paths, params } or null.
 * kinds: line, arrow, polyline, rect, triangle, polygon, ellipse
 */
export function recognize(rawPts) {
  const pts = rawPts.map((p) => [p[0], p[1]]);
  if (pts.length < 2) return null;
  const box = bboxOfPoints(pts);
  const diag = Math.hypot(box.w, box.h);
  if (diag < 12) return null;
  const len = pathLength(pts);
  const start = pts[0], end = pts[pts.length - 1];

  // Straight line: endpoints span nearly the whole path.
  const chord = dist(start, end);
  if (chord > diag * 0.8 && (chord / len > 0.93 || maxDeviation(pts, [start, end], false) < Math.max(3, chord * 0.045))) {
    const b = snapAngle(start, end);
    return { kind: 'line', paths: [linePath(start, b)], params: { a: start, b } };
  }

  const closed = dist(start, end) < Math.max(0.22 * Math.max(box.w, box.h), 0.08 * len);
  const eps = Math.max(3, diag * 0.07);

  if (!closed) {
    const s = rdp(pts, eps);
    // Arrow: a long shaft followed by a short "head" scribble that doubles back near the tip.
    if (s.length >= 4) {
      const shaftLen = dist(s[0], s[1]);
      const tip = s[1];
      const rest = s.slice(2);
      const nearTip = rest.every((q) => dist(q, tip) < shaftLen * 0.5);
      const ux = (tip[0] - s[0][0]) / shaftLen, uy = (tip[1] - s[0][1]) / shaftLen;
      const back = (rest[0][0] - tip[0]) * ux + (rest[0][1] - tip[1]) * uy < 0;
      if (nearTip && back && shaftLen > diag * 0.55) {
        const b = snapAngle(s[0], tip);
        return { kind: 'arrow', paths: arrowPaths(s[0], b), params: { a: s[0], b } };
      }
    }
    if (s.length <= 5 && maxDeviation(pts, s, false) < eps * 1.2) {
      return { kind: 'polyline', paths: [polyPath(s, false)], params: { corners: s } };
    }
    return null;
  }

  // Closed shapes. Ellipse test first: radial distance should be ~constant.
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const rx = Math.max(1, box.w / 2), ry = Math.max(1, box.h / 2);
  let dev = 0;
  for (const p of pts) dev += Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1);
  dev /= pts.length;

  let s = rdp([...pts.slice(0, -1), start], eps);
  if (s.length > 1 && dist(s[0], s[s.length - 1]) < eps * 2) s = s.slice(0, -1);
  // Drop near-straight corners.
  let changed = true;
  while (changed && s.length > 3) {
    changed = false;
    for (let i = 0; i < s.length; i++) {
      const prev = s[(i - 1 + s.length) % s.length], next = s[(i + 1) % s.length];
      if (interiorAngle(prev, s[i], next) > (160 * Math.PI) / 180) { s.splice(i, 1); changed = true; break; }
    }
  }
  const polyFits = maxDeviation(pts, s, true) < eps * 1.15;

  // Rectangle: fit the minimum-area oriented box and check the path hugs its outline.
  const rect = fitRect(pts);
  if (dev >= 0.08 && rect && rect.err < Math.max(2.5, diag * 0.03)) {
    const off = Math.abs(rect.angle - Math.round(rect.angle / (Math.PI / 2)) * (Math.PI / 2));
    const corners = off < (12 * Math.PI) / 180
      ? [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]]
      : rect.corners;
    return { kind: 'rect', paths: [polyPath(corners, true)], params: { corners }, closed: true };
  }

  if (dev < 0.09 && !(polyFits && (s.length === 3 || s.length === 4))) {
    const e = { cx, cy, rx, ry };
    // Nearly round → circle.
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) e.rx = e.ry = (rx + ry) / 2;
    return { kind: 'ellipse', paths: [ellipsePath(e.cx, e.cy, e.rx, e.ry)], params: e, closed: true };
  }
  if (polyFits && s.length === 4) {
    // Axis-aligned if the first edge is within 12 degrees of horizontal/vertical.
    const ang = Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]);
    const off = Math.abs(ang - Math.round(ang / (Math.PI / 2)) * (Math.PI / 2));
    let corners;
    if (off < (12 * Math.PI) / 180) {
      corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
    } else {
      corners = s;
    }
    return { kind: 'rect', paths: [polyPath(corners, true)], params: { corners }, closed: true };
  }
  if (polyFits && s.length === 3) return { kind: 'triangle', paths: [polyPath(s, true)], params: { corners: s }, closed: true };
  if (polyFits && s.length <= 6) return { kind: 'polygon', paths: [polyPath(s, true)], params: { corners: s }, closed: true };
  if (dev < 0.16) return { kind: 'ellipse', paths: [ellipsePath(cx, cy, rx, ry)], params: { cx, cy, rx, ry }, closed: true };
  return null;
}

/**
 * After snapping, keep adjusting the shape while the button is held.
 * `anchor` is the pointer position when the snap happened, `p` the current one.
 */
export function adjustShape(shape, anchor, p, { shift = false, size = 4 } = {}) {
  const { kind, params } = shape;
  if (kind === 'line' || kind === 'arrow') {
    let b = [p[0], p[1]];
    if (shift) b = snapAngle(params.a, b, Math.PI, Math.PI / 12);
    else b = snapAngle(params.a, b);
    return kind === 'line' ? [linePath(params.a, b)] : arrowPaths(params.a, b, size);
  }
  let cx, cy;
  if (kind === 'ellipse') { cx = params.cx; cy = params.cy; } else {
    const c = params.corners;
    cx = c.reduce((s, q) => s + q[0], 0) / c.length;
    cy = c.reduce((s, q) => s + q[1], 0) / c.length;
  }
  const d0 = Math.max(1, dist(anchor, [cx, cy]));
  const k = Math.max(0.05, dist(p, [cx, cy]) / d0);
  if (kind === 'ellipse') return [ellipsePath(cx, cy, params.rx * k, params.ry * k)];
  if (kind === 'polyline') {
    return [polyPath(params.corners.map((q) => [cx + (q[0] - cx) * k, cy + (q[1] - cy) * k]), false)];
  }
  return [polyPath(params.corners.map((q) => [cx + (q[0] - cx) * k, cy + (q[1] - cy) * k]), true)];
}
