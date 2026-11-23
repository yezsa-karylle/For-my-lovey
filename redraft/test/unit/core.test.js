import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stabilizer, rdp, pointInPolygon, resample, matRotateAbout, applyMat, dist } from '../../src/js/core/geometry.js';
import { recognize, adjustShape } from '../../src/js/core/shapes.js';
import {
  newProject, newGridPage, newLayer, applyOp, invertOp, opAddObjs, opDelObjs, opSetObjs, batch, clone, transformObj, uid,
} from '../../src/js/core/model.js';
import { History } from '../../src/js/core/history.js';

// Deterministic pseudo-random jitter.
function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }

function jitterEnergy(pts) {
  // Sum of squared second differences: how "shaky" a line is.
  let e = 0;
  for (let i = 2; i < pts.length; i++) {
    const ax = pts[i][0] - 2 * pts[i - 1][0] + pts[i - 2][0];
    const ay = pts[i][1] - 2 * pts[i - 1][1] + pts[i - 2][1];
    e += ax * ax + ay * ay;
  }
  return e / pts.length;
}

test('stabilizer removes mouse jitter and still ends on the release point', () => {
  const r = rng(7);
  const raw = [];
  for (let i = 0; i <= 200; i++) raw.push([i * 2, 100 + Math.sin(i / 20) * 30 + r() * 6]);
  const st = new Stabilizer({ radius: 6, smoothing: 0.6, minStep: 0.5 });
  const out = st.start(raw[0]);
  for (const p of raw.slice(1)) { st.move(p); out.push(...st.tick()); }
  out.push(...st.finish(raw[raw.length - 1]));
  assert.ok(jitterEnergy(out) < jitterEnergy(raw) * 0.2, `smoothed ${jitterEnergy(out)} vs raw ${jitterEnergy(raw)}`);
  assert.deepEqual(out[out.length - 1], raw[raw.length - 1]);
});

test('stabilizer keeps catching up while the mouse is still', () => {
  const st = new Stabilizer({ radius: 0, smoothing: 0.8 });
  st.start([0, 0]);
  st.move([100, 0]);
  let last;
  for (let i = 0; i < 100; i++) { const e = st.tick(); if (e.length) last = e[e.length - 1]; }
  assert.ok(last[0] > 99);
});

test('rdp, resample, polygon tests', () => {
  const line = [[0, 0], [5, 0.2], [10, -0.1], [20, 0]];
  assert.equal(rdp(line, 1).length, 2);
  const rs = resample([[0, 0], [10, 0]], 3);
  assert.deepEqual(rs.map((p) => Math.round(p[0])), [0, 3, 6, 9, 10]);
  assert.ok(pointInPolygon([5, 5], [[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.ok(!pointInPolygon([15, 5], [[0, 0], [10, 0], [10, 10], [0, 10]]));
  const p = applyMat(matRotateAbout(Math.PI / 2, 0, 0), [1, 0]);
  assert.ok(dist(p, [0, 1]) < 1e-9);
});

function wobble(pts, amt = 2, seed = 3) {
  const r = rng(seed);
  return resample(pts, 2).map((p) => [p[0] + r() * amt, p[1] + r() * amt]);
}

test('recognises a shaky line and straightens it to horizontal', () => {
  const s = recognize(wobble([[10, 100], [300, 104]]));
  assert.equal(s.kind, 'line');
  const path = s.paths[0];
  assert.ok(Math.abs(path[0][1] - path[path.length - 1][1]) < 0.01, 'snapped to horizontal');
});

test('recognises rectangle, triangle, circle, arrow', () => {
  const rect = recognize(wobble([[0, 0], [200, 0], [200, 120], [0, 120], [2, 3]]));
  assert.equal(rect.kind, 'rect');
  const tri = recognize(wobble([[100, 0], [200, 170], [0, 170], [99, 3]]));
  assert.equal(tri.kind, 'triangle');
  const circle = [];
  for (let i = 0; i <= 64; i++) circle.push([100 + Math.cos(i / 64 * 6.283) * 80, 100 + Math.sin(i / 64 * 6.283) * 78]);
  const c = recognize(wobble(circle, 3));
  assert.equal(c.kind, 'ellipse');
  assert.equal(c.params.rx, c.params.ry, 'near-round snaps to circle');
  const arrow = recognize(wobble([[0, 0], [300, 0], [270, -25], [300, 0], [270, 25]], 1));
  assert.equal(arrow.kind, 'arrow');
  assert.equal(arrow.paths.length, 2);
});

test('does not snap a scribble', () => {
  const r = rng(11);
  const pts = [];
  for (let i = 0; i < 80; i++) pts.push([i * 4 + r() * 40, 100 + Math.sin(i / 3) * 40 + r() * 30]);
  assert.equal(recognize(pts), null);
});

test('adjustShape stretches a snapped line to the cursor', () => {
  const s = recognize(wobble([[0, 0], [100, 0]]));
  const paths = adjustShape(s, [100, 0], [200, 0]);
  const first = paths[0][0], last = paths[0][paths[0].length - 1];
  assert.ok(Math.abs(last[0] - 200) < 2, 'reaches the cursor');
  assert.ok(Math.abs(last[1] - first[1]) < 0.01, 'stays horizontal');
});

function sampleProject() {
  const pr = newProject('t');
  pr.pages.push(newGridPage(100));
  return pr;
}

test('every op type round-trips through invert', () => {
  const pr = sampleProject();
  const page = pr.pages[0];
  const layer = page.layers[0];
  const stroke = { id: uid(), type: 'stroke', tool: 'pen', color: '#000', size: 3, opacity: 1, paths: [[[0, 0, 0], [10, 10, 16]]] };
  const ops = [];
  const run = (op) => { const before = clone(pr); applyOp(pr, op); ops.push([op, before]); };
  run(opAddObjs(page, layer, [stroke]));
  run(opSetObjs(page, pr.pages[0].layers[0], [stroke], [{ ...stroke, color: '#f00' }]));
  run({ type: 'insLayer', page: page.id, layer: newLayer('B'), index: 1 });
  run({ type: 'layerProps', page: page.id, layer: layer.id, before: { opacity: 1 }, after: { opacity: 0.5 } });
  run({ type: 'moveLayer', page: page.id, from: 0, to: 1 });
  run({ type: 'insPage', pageData: newGridPage(100), index: 1 });
  run({ type: 'movePage', from: 0, to: 1 });
  run({ type: 'pageProps', page: page.id, before: { bgVisible: true }, after: { bgVisible: false } });
  run(opDelObjs(pr.pages[1], pr.pages[1].layers[1], [stroke.id]));
  run({ type: 'delPage', pageData: clone(pr.pages[0]), index: 0 });
  for (const [op, before] of ops.reverse()) {
    applyOp(pr, invertOp(op));
    assert.deepEqual(pr.pages, before.pages, 'invert of ' + op.type);
  }
});

test('history undo/redo and journal', () => {
  const pr = sampleProject();
  const page = pr.pages[0], layer = page.layers[0];
  const h = new History(pr);
  const a = { id: 'a', type: 'text', x: 1, y: 2, text: 'hi', font: 'Caveat', size: 20, color: '#000', opacity: 1 };
  h.do(opAddObjs(page, layer, [a]));
  h.do(batch([opSetObjs(page, layer, [a], [{ ...a, text: 'hello' }])]));
  assert.equal(pr.pages[0].layers[0].objects[0].text, 'hello');
  h.undo();
  assert.equal(pr.pages[0].layers[0].objects[0].text, 'hi');
  h.undo();
  assert.equal(pr.pages[0].layers[0].objects.length, 0);
  assert.equal(h.undo(), null);
  h.redo(); h.redo();
  assert.equal(pr.pages[0].layers[0].objects[0].text, 'hello');
  assert.equal(pr.journal.length, 6);
  // Replaying the journal from the initial state reproduces the document.
  const replay = { pages: [clone(sampleProject().pages[0])] };
  replay.pages[0].id = page.id; replay.pages[0].layers[0].id = layer.id;
  for (const e of pr.journal) applyOp(replay, e.op);
  assert.deepEqual(replay.pages[0].layers[0].objects, pr.pages[0].layers[0].objects);
});

test('transformObj scales strokes and text', () => {
  const s = { type: 'stroke', size: 2, paths: [[[1, 1, 5]]] };
  const t = transformObj(s, [2, 0, 0, 2, 10, 0]);
  assert.deepEqual(t.paths[0][0], [12, 2, 5]);
  assert.equal(t.size, 4);
  const tx = transformObj({ type: 'text', x: 0, y: 0, size: 10, w: 0 }, [3, 0, 0, 3, 0, 0]);
  assert.equal(tx.size, 30);
});
