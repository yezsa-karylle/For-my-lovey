// Pure geometry helpers. No DOM access, so these run in Node unit tests too.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

export function bboxOfPoints(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  if (x0 === Infinity) return null;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

export function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function boxesOverlap(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function pointInBox(p, b, pad = 0) {
  return p[0] >= b.x - pad && p[0] <= b.x + b.w + pad && p[1] >= b.y - pad && p[1] <= b.y + b.h + pad;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/** Project p onto the infinite line through a with unit direction u. */
export function projectOnLine(p, a, u) {
  const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
  return [a[0] + u[0] * t, a[1] + u[1] * t];
}

// ---- 2D affine matrices as [a, b, c, d, e, f]  (x' = a*x + c*y + e, y' = b*x + d*y + f)
export const IDENTITY = [1, 0, 0, 1, 0, 0];
export function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const matTranslate = (tx, ty) => [1, 0, 0, 1, tx, ty];
export const matScaleAbout = (s, cx, cy, sy = s) => [s, 0, 0, sy, cx - s * cx, cy - sy * cy];
export function matRotateAbout(a, cx, cy) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
export const applyMat = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const matScaleFactor = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
export const matRotation = (m) => Math.atan2(m[1], m[0]);

/**
 * Mouse stabilizer: a "lazy string" (the brush only moves once the cursor is
 * `radius` away) followed by exponential smoothing. Call tick() every frame
 * while the button is held so the line keeps catching up even when the mouse
 * stops sending events.
 */
export class Stabilizer {
  constructor({ radius = 0, smoothing = 0, minStep = 0.5 } = {}) {
    this.radius = radius;
    this.smoothing = Math.max(0, Math.min(0.95, smoothing));
    this.minStep = minStep;
  }
  start(p) {
    this.target = [p[0], p[1]];
    this.lazy = [p[0], p[1]];
    this.s = [p[0], p[1]];
    this.last = [p[0], p[1]];
    return [[p[0], p[1]]];
  }
  /** Update the cursor position (does not emit). */
  move(p) { this.target = [p[0], p[1]]; }
  /** Advance by dt milliseconds; returns newly emitted points. Time-based so the feel
   *  does not depend on the mouse's polling rate. */
  tick(dt = 16.67) {
    const { target, lazy } = this;
    const dx = target[0] - lazy[0], dy = target[1] - lazy[1];
    const d = Math.hypot(dx, dy);
    if (d > this.radius) {
      const k = (d - this.radius) / d;
      lazy[0] += dx * k;
      lazy[1] += dy * k;
    }
    const a = 1 - Math.pow(this.smoothing, Math.max(0.05, Math.min(4, dt / 16.67)));
    this.s[0] += (lazy[0] - this.s[0]) * a;
    this.s[1] += (lazy[1] - this.s[1]) * a;
    return this._emit();
  }
  _emit() {
    if (dist(this.s, this.last) >= this.minStep) {
      this.last = [this.s[0], this.s[1]];
      return [[this.s[0], this.s[1]]];
    }
    return [];
  }
  /** Ease the line into the final cursor position so the stroke ends where you let go. */
  finish(p) {
    const out = [];
    this.target = [p[0], p[1]];
    for (let i = 0; i < 60; i++) {
      this.lazy[0] += (p[0] - this.lazy[0]) * 0.5;
      this.lazy[1] += (p[1] - this.lazy[1]) * 0.5;
      const a = Math.max(0.35, 1 - this.smoothing);
      this.s[0] += (this.lazy[0] - this.s[0]) * a;
      this.s[1] += (this.lazy[1] - this.s[1]) * a;
      out.push(...this._emit());
      if (dist(this.s, p) < this.minStep) break;
    }
    if (dist(this.last, p) > 0.01) { out.push([p[0], p[1]]); this.last = [p[0], p[1]]; }
    return out;
  }
}

/** Resample a polyline at a fixed spacing (keeps the endpoints). */
export function resample(pts, spacing) {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const out = [[pts[0][0], pts[0][1]]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = dist(a, b);
    let t = spacing - carry;
    while (t <= seg) {
      out.push([a[0] + ((b[0] - a[0]) * t) / seg, a[1] + ((b[1] - a[1]) * t) / seg]);
      t += spacing;
    }
    carry = seg - (t - spacing);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > 0.01) out.push([last[0], last[1]]);
  return out;
}
