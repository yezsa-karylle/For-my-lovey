// "Replay" export: re-runs the recorded edit journal from the original pages
// and encodes a fast-forward MP4 (WebCodecs + mp4-muxer), including strokes
// being drawn point by point, text being typed, erasing and undos.
import { applyOp, clone, findPage, findLayer, opTargets } from '../core/model.js';
import { drawObject, drawStroke, buildStrokePath, renderLayer, drawBackground, drawText } from '../render/draw.js';

const CODECS = [
  ['avc1.640034', 'avc'], ['avc1.4d0034', 'avc'], ['avc1.42003e', 'avc'],
  ['vp09.00.41.08', 'vp9'], ['av01.0.08M.08', 'av1'],
];

export async function pickCodec(width, height, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const [codec, mux] of CODECS) {
    const cfg = { codec, width, height, bitrate: 8_000_000, framerate: fps };
    if (mux === 'avc') cfg.avc = { format: 'avc' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return { cfg, mux };
    } catch { /* try next */ }
  }
  return null;
}

const flatten = (op) => (op.type === 'batch' ? op.ops.flatMap(flatten) : [op]);
const maxT = (obj) => Math.max(0, ...obj.paths.flat().map((p) => p[2] || 0));

/** Decide how each journal entry is shown and for how many frames. */
export function planReplay(journal, { speed = 8, fps = 30 } = {}) {
  const framesFor = (ms) => Math.max(2, Math.min(fps * 8, Math.ceil((ms / 1000 / speed) * fps)));
  return journal.map((e) => {
    const op = e.op;
    if (!e.undo && !e.redo) {
      const ins = flatten(op).filter((o) => o.type === 'insObjs');
      if (ins.length && ins.length === flatten(op).length && ins[0].objs.length === 1 && ins[0].objs[0].type === 'stroke') {
        const obj = ins[0].objs[0];
        const T = maxT(obj);
        if (T > 0 && !obj.shape) return { e, frames: framesFor(T), anim: { kind: 'stroke', obj, page: ins[0].page, layers: ins.map((o) => o.layer), T } };
      }
      if (e.anim && e.anim.length > 1 && (op.type === 'insObjs' || op.type === 'setObjs')) {
        const obj = op.type === 'insObjs' ? op.objs[0] : op.after[0];
        const T = e.anim[e.anim.length - 1][0];
        if (obj?.type === 'text' && T > 0) {
          return { e, frames: framesFor(T), anim: { kind: 'text', obj, page: op.page, layers: [op.layer], T, typing: e.anim, replaceId: op.type === 'setObjs' ? obj.id : null } };
        }
      }
    }
    return { e, frames: 3, anim: null };
  });
}

export function videoSize(page) {
  const portrait = page.h >= page.w;
  const boxW = portrait ? 1080 : 1920, boxH = portrait ? 1920 : 1080;
  const k = Math.min(boxW / page.w, boxH / page.h);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { W: even(page.w * k), H: even(page.h * k) };
}

export async function exportReplay(editor, { speed = 8, fps = 30, onProgress = () => {}, isCancelled = () => false } = {}) {
  const project = editor.project;
  if (!project.initial || !project.initial.pages.length) throw new Error('This project has no recorded starting point to replay from.');
  if (!project.journal.length) throw new Error('Nothing to replay yet: draw or type something first.');
  const proj = { pages: clone(project.initial.pages) };
  const plan = planReplay(project.journal, { speed, fps });
  const { W, H } = videoSize(proj.pages[0]);
  const codec = await pickCodec(W, H, fps);
  if (!codec) throw new Error('No video encoder is available on this computer.');

  const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: codec.mux, width: W, height: H, frameRate: fps }, fastStart: 'in-memory' });
  let encodeError = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (err) => { encodeError = err; } });
  encoder.configure(codec.cfg);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const intro = Math.round(fps * 0.6), outro = fps * 2;
  const totalFrames = intro + outro + plan.reduce((s, p) => s + p.frames, 0);
  let frameNo = 0;

  // ---- display state
  let disp = null; // { page, k, ox, oy, caches: Map, bmp }
  const tmp = new OffscreenCanvas(W, H);
  const tctx = tmp.getContext('2d');

  async function show(pageId) {
    const page = findPage(proj, pageId) || proj.pages[0];
    if (!page) { disp = null; return; }
    if (disp && disp.page.id === page.id) { disp.page = page; return; }
    const k = Math.min(W / page.w, H / page.h);
    disp = { page, k, ox: (W - page.w * k) / 2, oy: (H - page.h * k) / 2, caches: new Map(), bmp: await editor.ensureBitmap(page) };
  }
  function layerCache(layer, exclude) {
    let c = disp.caches.get(layer.id);
    if (!c || exclude) {
      c = new OffscreenCanvas(Math.max(1, Math.round(disp.page.w * disp.k)), Math.max(1, Math.round(disp.page.h * disp.k)));
      const lc = c.getContext('2d');
      lc.setTransform(disp.k, 0, 0, disp.k, 0, 0);
      renderLayer(lc, layer, { grid: disp.page.grid }, exclude);
      disp.caches.set(layer.id, c);
    }
    return c;
  }
  function drawFrame(anim, ms) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(0, 0, W, H);
    if (!disp) return;
    const { page, k, ox, oy } = disp;
    ctx.setTransform(k, 0, 0, k, ox, oy);
    drawBackground(ctx, page, disp.bmp);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const env = { grid: page.grid };
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      let src = layerCache(layer);
      if (anim && anim.page === page.id && anim.layers.includes(layer.id)) {
        tmp.width = src.width; tmp.height = src.height;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.drawImage(src, 0, 0);
        tctx.setTransform(k, 0, 0, k, 0, 0);
        if (anim.kind === 'stroke') {
          const partial = { ...anim.obj, paths: anim.obj.paths.map((p) => p.filter((q) => (q[2] || 0) <= ms)).filter((p) => p.length) };
          if (partial.paths.length) drawStroke(tctx, partial, env, buildStrokePath(partial));
        } else {
          let text = anim.typing[0][1];
          for (const [t, s] of anim.typing) { if (t <= ms) text = s; else break; }
          drawText(tctx, anim.obj, text);
        }
        src = tmp;
      }
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(src, ox, oy);
      ctx.globalAlpha = 1;
    }
  }
  async function emit() {
    if (encodeError) throw encodeError;
    const frame = new VideoFrame(canvas, { timestamp: Math.round((frameNo * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: frameNo % (fps * 2) === 0 });
    frame.close();
    frameNo++;
    if (encoder.encodeQueueSize > 6) await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
    if (frameNo % 15 === 0) {
      onProgress(frameNo, totalFrames);
      await new Promise((r) => setTimeout(r, 0));
      if (isCancelled()) throw new Error('cancelled');
    }
  }

  await show(proj.pages[0].id);
  drawFrame(null, 0);
  for (let i = 0; i < intro; i++) await emit();

  for (const step of plan) {
    const { e, anim } = step;
    if (anim) {
      await show(anim.page);
      if (anim.replaceId && disp) {
        const layer = findLayer(disp.page, anim.layers[0]);
        if (layer) layerCache(layer, new Set([anim.replaceId]));
      }
      for (let f = 1; f <= step.frames; f++) {
        drawFrame(anim, (anim.T * f) / step.frames);
        await emit();
      }
    }
    // Apply the op to the replay document and refresh what changed.
    applyOp(proj, e.op);
    const targets = opTargets(e.op);
    const first = targets.find((t) => t.page && findPage(proj, t.page));
    if (first && (!disp || first.page !== disp.page.id)) await show(first.page);
    else if (disp && !findPage(proj, disp.page.id)) await show(proj.pages[0]?.id);
    else if (disp) disp.page = findPage(proj, disp.page.id);
    if (disp) {
      for (const o of flatten(e.op)) {
        const pid = o.page || o.pageData?.id;
        if (pid !== disp.page.id) continue;
        if (o.type === 'insObjs') {
          const layer = findLayer(disp.page, o.layer);
          const c = disp.caches.get(o.layer);
          const n = layer ? layer.objects.length : 0;
          if (c && o.indices.every((ix, j) => ix === n - o.objs.length + j)) {
            const lc = c.getContext('2d');
            lc.setTransform(disp.k, 0, 0, disp.k, 0, 0);
            layer.objects.slice(n - o.objs.length).forEach((ob) => drawObject(lc, ob, { grid: disp.page.grid }));
          } else disp.caches.delete(o.layer);
        } else if (o.type === 'delObjs' || o.type === 'setObjs') disp.caches.delete(o.layer);
        else if (o.type === 'insLayer' || o.type === 'delLayer') disp.caches.delete(o.layer.id);
        else if (o.type === 'pageProps' && o.after.grid) disp.caches.clear();
      }
    }
    if (!anim) {
      drawFrame(null, 0);
      for (let f = 0; f < step.frames; f++) await emit();
    }
  }
  drawFrame(null, 0);
  for (let i = 0; i < outro; i++) await emit();

  await encoder.flush();
  encoder.close();
  muxer.finalize();
  onProgress(totalFrames, totalFrames);
  return { bytes: new Uint8Array(muxer.target.buffer), codec: codec.mux, frames: frameNo, width: W, height: H, seconds: frameNo / fps };
}

