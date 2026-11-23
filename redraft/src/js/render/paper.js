// Grid-paper drawing (for blank pages and the "cover & rewrite" tool) and
// automatic grid detection on scans so the cover texture lines up.

/** Paint paper + grid lines inside rect {x,y,w,h} (page coordinates). */
export function drawGrid(ctx, grid, rect) {
  ctx.save();
  ctx.fillStyle = grid.paper;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = grid.line;
  ctx.lineWidth = grid.lw;
  ctx.beginPath();
  const sx = Math.max(2, grid.sx), sy = Math.max(2, grid.sy);
  let x = grid.ox + Math.ceil((rect.x - grid.ox) / sx) * sx;
  for (; x <= rect.x + rect.w; x += sx) { ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h); }
  let y = grid.oy + Math.ceil((rect.y - grid.oy) / sy) * sy;
  for (; y <= rect.y + rect.h; y += sy) { ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.w, y); }
  ctx.stroke();
  ctx.restore();
}

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function smooth(a) {
  // Two passes of a [1,2,1] blur so a fractional period still gives one clear peak.
  let v = a;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Array(v.length);
    for (let i = 0; i < v.length; i++) o[i] = ((v[i - 1] ?? v[i]) + 2 * v[i] + (v[i + 1] ?? v[i])) / 4;
    v = o;
  }
  return v;
}

function periodOf(raw, minLag, maxLag) {
  const profile = smooth(raw);
  const n = profile.length;
  const mean = profile.reduce((a, b) => a + b, 0) / n;
  // High-pass: subtract a moving average so slow changes (shading, ink blocks) don't dominate.
  const win = Math.max(3, Math.round(maxLag / 2));
  const v = profile.map((x, i) => {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j += 2) { s += profile[j]; k++; }
    return x - (k ? s / k : mean);
  });
  const ac = [];
  let best = -Infinity;
  for (let lag = minLag; lag <= Math.min(maxLag, n / 3); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += v[i] * v[i + lag];
    s /= n - lag;
    ac[lag] = s;
    if (s > best) best = s;
  }
  if (!(best > 0)) return null;
  // Smallest lag that is a local peak close to the best (avoids picking 2x the period).
  for (let lag = minLag + 1; lag < ac.length - 1; lag++) {
    if (ac[lag] >= best * 0.65 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      // Sub-pixel refinement with a parabola through the peak.
      const a = ac[lag - 1], b = ac[lag], c = ac[lag + 1];
      const d = a - 2 * b + c;
      const off = d !== 0 ? (0.5 * (a - c)) / d : 0;
      return lag + Math.max(-0.5, Math.min(0.5, off));
    }
  }
  return null;
}

function phaseOf(profile, period) {
  let best = -Infinity, bestO = 0;
  for (let o = 0; o < period; o += 0.25) {
    let s = 0, k = 0;
    for (let x = o; x < profile.length; x += period) { s += profile[Math.round(x)] || 0; k++; }
    s /= k || 1;
    if (s > best) { best = s; bestO = o; }
  }
  return bestO;
}

/**
 * Estimate grid spacing, offset, paper colour and line colour from a scan.
 * `source` is any CanvasImageSource with width/height in page pixels.
 */
export function detectGrid(source, pageW, pageH) {
  const scale = Math.min(1, 1400 / Math.max(pageW, pageH));
  const w = Math.round(pageW * scale), h = Math.round(pageH * scale);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];

  // Paper = average colour of the brightest ~35% of pixels.
  const sorted = Array.from(lum).sort((a, b) => a - b);
  const paperL = sorted[Math.floor(sorted.length * 0.8)];
  const cut = sorted[Math.floor(sorted.length * 0.65)];
  let pr = 0, pg = 0, pb = 0, pn = 0;
  for (let i = 0; i < w * h; i++) if (lum[i] >= cut) { pr += data[i * 4]; pg += data[i * 4 + 1]; pb += data[i * 4 + 2]; pn++; }
  const paper = hex(pr / pn, pg / pn, pb / pn);

  // Darkness profiles, clipped so heavy ink does not dominate faint grid lines.
  const colP = new Float32Array(w), rowP = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.max(0, Math.min(45, paperL - lum[y * w + x]));
      colP[x] += d; rowP[y] += d;
    }
  }
  const minLag = Math.max(4, Math.round(w / 120)), maxLag = Math.round(w / 6);
  const px = periodOf(Array.from(colP), minLag, maxLag);
  const py = periodOf(Array.from(rowP), minLag, maxLag);
  if (!px && !py) return { paper, found: false };
  const sx = px || py, sy = py || px;
  const ox = phaseOf(smooth(Array.from(colP)), sx), oy = phaseOf(smooth(Array.from(rowP)), sy);

  // Line colour: pixels on detected grid columns that are mid-dark (not ink, not paper).
  let lr = 0, lg = 0, lb = 0, ln = 0;
  for (let x = ox; x < w; x += sx) {
    const xi = Math.round(x);
    for (let y = 0; y < h; y += 2) {
      const i = y * w + xi, L = lum[i];
      if (L < paperL - 8 && L > paperL - 90) { lr += data[i * 4]; lg += data[i * 4 + 1]; lb += data[i * 4 + 2]; ln++; }
    }
  }
  const line = ln > 20 ? hex(lr / ln, lg / ln, lb / ln) : '#c5d3e0';
  return {
    found: true, paper, line,
    sx: sx / scale, sy: sy / scale, ox: ox / scale, oy: oy / scale,
    lw: Math.max(1, 1.2 / scale),
  };
}
