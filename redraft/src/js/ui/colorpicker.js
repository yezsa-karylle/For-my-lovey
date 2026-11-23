// HSV colour picker popover.
import { h } from './dialogs.js';

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return [hh, max ? d / max : 0, max];
}
function hsvToRgb(hh, s, v) {
  const f = (n) => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

let current = null, currentOutside = null;
export function closePicker() {
  if (currentOutside) document.removeEventListener('pointerdown', currentOutside, true);
  currentOutside = null;
  if (current) { current.remove(); current = null; }
}

/** Open a picker anchored to `anchor`. onChange(hex, final) */
export function openPicker(anchor, hex, onChange, { onEyedropper } = {}) {
  closePicker();
  let [hh, s, v] = rgbToHsv(...(hexToRgb(hex) || [0, 0, 0]));
  const el = h(`<div class="popover picker" data-keeps-text tabindex="-1">
    <div class="sv"><canvas width="220" height="150"></canvas><div class="knob"></div></div>
    <div class="hue"><div class="knob"></div></div>
    <div class="row" style="margin-top:12px">
      <span class="chip small" data-prev></span>
      <input type="text" data-hex maxlength="7" style="flex:1;font-family:ui-monospace,Consolas,monospace">
      <button class="btn icon outline" data-eye data-tip="Pick from page|I"><svg class="i" viewBox="0 0 24 24"><path d="M13 7.5l3.5 3.5"/><path d="M15.4 4.4a2.3 2.3 0 0 1 3.2 0l1 1a2.3 2.3 0 0 1 0 3.2l-2.4 2.4-4.2-4.2z"/><path d="M13.2 8.4L5 16.6V19h2.4l8.2-8.2"/></svg></button>
    </div>
  </div>`);
  document.getElementById('popover-root').appendChild(el);
  current = el;
  const r = anchor.getBoundingClientRect();
  const pw = 246;
  el.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left - pw - 10)) + 'px';
  el.style.top = Math.max(8, Math.min(innerHeight - 300, r.top - 20)) + 'px';

  const cv = el.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const svKnob = el.querySelector('.sv .knob'), hueKnob = el.querySelector('.hue .knob');
  const hexIn = el.querySelector('[data-hex]'), prev = el.querySelector('[data-prev]');

  function paint(emit = true, final = false) {
    const [r0, g0, b0] = hsvToRgb(hh, 1, 1);
    ctx.fillStyle = rgbToHex(r0, g0, b0);
    ctx.fillRect(0, 0, 220, 150);
    let g = ctx.createLinearGradient(0, 0, 220, 0);
    g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 220, 150);
    g = ctx.createLinearGradient(0, 0, 0, 150);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 220, 150);
    svKnob.style.left = s * 100 + '%';
    svKnob.style.top = (1 - v) * 100 + '%';
    hueKnob.style.left = (hh / 360) * 100 + '%';
    const hx = rgbToHex(...hsvToRgb(hh, s, v));
    if (document.activeElement !== hexIn) hexIn.value = hx;
    prev.style.background = hx;
    if (emit) onChange(hx, final);
  }
  function drag(target, fn) {
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      const move = (ev) => { const rr = target.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (ev.clientX - rr.left) / rr.width)), Math.max(0, Math.min(1, (ev.clientY - rr.top) / rr.height))); paint(true, false); };
      move(e);
      const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); paint(true, true); };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
    });
  }
  drag(el.querySelector('.sv'), (x, y) => { s = x; v = 1 - y; });
  drag(el.querySelector('.hue'), (x) => { hh = x * 359.9; });
  hexIn.addEventListener('input', () => {
    const rgb = hexToRgb(hexIn.value.startsWith('#') ? hexIn.value : '#' + hexIn.value);
    if (rgb) { [hh, s, v] = rgbToHsv(...rgb); paint(true, true); }
  });
  hexIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') closePicker(); });
  el.querySelector('[data-eye]').onclick = () => { closePicker(); onEyedropper && onEyedropper(); };
  paint(false);
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePicker(); };
  setTimeout(() => { if (current !== el) return; currentOutside = outside; document.addEventListener('pointerdown', outside, true); }, 0);
  return el;
}
