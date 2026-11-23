// Replay player: watch a page being written, scrub the timeline, change speed, export MP4.
import { ReplayEngine, ReplayRenderer } from '../io/replay.js';
import { h, esc } from './dialogs.js';
import { icon } from './icons.js';

const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let open = null;
export const playerOpen = () => !!open;

export async function openPlayer(editor, app, { pageId = editor.page.id } = {}) {
  if (open) open.close();
  const pageNo = editor.project.pages.findIndex((p) => p.id === pageId) + 1;
  const el = h(`<div class="player">
    <div class="player-top">
      <b>Replay · page ${pageNo}</b>
      <div class="seg" data-mode style="flex:0 0 auto">
        <button data-v="auto">Write the page</button><button data-v="history">My edits</button>
      </div>
      <div class="seg" data-cam style="flex:0 0 auto">
        <button data-v="page" class="on">Whole page</button><button data-v="follow">Follow the pen</button>
      </div>
      <span class="grow"></span>
      <button class="btn primary" data-export>${icon('download')}Export MP4</button>
      <button class="btn icon" data-close data-tip="Close|Esc">✕</button>
    </div>
    <div class="player-stage"><canvas></canvas></div>
    <div class="player-bar">
      <button class="btn icon play" data-play data-tip="Play / pause|Space"></button>
      <span class="time" data-time>0:00 / 0:00</span>
      <input type="range" data-scrub min="0" max="1000" value="0" step="1">
      <div class="seg" data-speed style="flex:0 0 auto">${[1, 2, 4, 8, 16].map((s) => `<button data-v="${s}" class="${s === 4 ? 'on' : ''}">${s}×</button>`).join('')}</div>
    </div>
  </div>`);
  document.body.appendChild(el);
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const scrub = el.querySelector('[data-scrub]');
  const playBtn = el.querySelector('[data-play]');
  const timeEl = el.querySelector('[data-time]');

  const st = { t: 0, playing: true, speed: 4, cam: 'page', mode: 'auto', engine: null, R: null, jump: true, last: performance.now(), dirty: true };
  const segSel = (name, v) => el.querySelectorAll(`[data-${name}] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));

  async function build(mode) {
    st.mode = mode;
    segSel('mode', mode);
    st.engine = new ReplayEngine(editor, pageId, { mode });
    st.R = new ReplayRenderer(st.engine, editor);
    await st.R.prepare();
    scrub.max = String(Math.round(st.engine.duration));
    const edits = st.engine.editCount;
    const hb = el.querySelector('[data-mode] [data-v=history]');
    hb.textContent = edits ? `My edits (${edits})` : 'My edits';
    hb.title = edits ? 'Writes the original page, then plays back every recorded edit' : 'No edits recorded on this page yet';
    st.t = 0; st.jump = true; st.dirty = true;
  }
  await build(st.mode);

  function resize() {
    const r = el.querySelector('.player-stage').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(2, Math.round(r.width * dpr));
    canvas.height = Math.max(2, Math.round(r.height * dpr));
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    st.jump = true; st.dirty = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(el.querySelector('.player-stage'));
  resize();

  let raf = 0;
  const loop = (now) => {
    const dt = Math.min(100, now - st.last);
    st.last = now;
    const E = st.engine;
    if (st.playing && E) {
      st.t += dt * st.speed;
      if (st.t >= E.duration) { st.t = E.duration; st.playing = false; }
      st.dirty = true;
    }
    if (st.dirty && E) {
      st.R.render(ctx, canvas.width, canvas.height, st.t, { mode: st.cam, jump: st.jump, ease: 1 - Math.exp(-dt / 220), background: '#1c1c20' });
      st.jump = false;
      st.dirty = false;
      if (document.activeElement !== scrub) scrub.value = String(Math.round(st.t));
      timeEl.textContent = `${fmt(st.t)} / ${fmt(E.duration)}`;
      playBtn.innerHTML = st.playing ? '❚❚' : '▶';
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const seek = (t) => { st.t = Math.max(0, Math.min(st.engine.duration, t)); st.jump = true; st.dirty = true; };
  scrub.addEventListener('input', () => seek(+scrub.value));
  playBtn.onclick = () => { if (st.t >= st.engine.duration) seek(0); st.playing = !st.playing; st.dirty = true; };
  el.querySelectorAll('[data-speed] button').forEach((b) => (b.onclick = () => { st.speed = +b.dataset.v; segSel('speed', st.speed); }));
  el.querySelectorAll('[data-cam] button').forEach((b) => (b.onclick = () => { st.cam = b.dataset.v; segSel('cam', st.cam); st.jump = true; st.dirty = true; }));
  el.querySelectorAll('[data-mode] button').forEach((b) => (b.onclick = async () => { if (b.dataset.v !== st.mode) { await build(b.dataset.v); st.playing = true; } }));
  el.querySelector('[data-export]').onclick = () => { st.playing = false; app.replayExportDialog({ pageId, mode: st.mode, speed: st.speed }); };

  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input[type=text], .modal')) return;
    if (document.querySelector('.modal-backdrop')) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'ArrowRight') seek(st.t + 5000 * st.speed);
    else if (e.key === 'ArrowLeft') seek(st.t - 5000 * st.speed);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(st.engine.duration);
    else if (/^[1-5]$/.test(e.key)) { st.speed = [1, 2, 4, 8, 16][+e.key - 1]; segSel('speed', st.speed); }
  };
  window.addEventListener('keydown', onKey, true);
  el.querySelector('[data-close]').onclick = () => close();

  function close() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    open = null;
  }
  open = { close, state: st, el };
  window.__player = open;
  return open;
}

void esc;
