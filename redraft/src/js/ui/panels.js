// Toolbar, tool options, colour card, layers and page thumbnails.
import { icon } from './icons.js';
import { $, h, esc, toast } from './dialogs.js';
import { openPicker, closePicker } from './colorpicker.js';
import { PAINT_TOOLS, TOOL_NAMES } from '../editor.js';
import { detectGrid } from '../render/paper.js';

export const TOOLS = [
  ['pen', 'P'], ['pencil', 'N'], ['marker', 'M'], ['highlighter', 'H'],
  ['eraser', 'E'], ['cover', 'W'], ['text', 'T'], ['lasso', 'L'], ['eyedropper', 'I'],
];
export const FONTS = ['Gaegu', 'Caveat', 'Patrick Hand', 'Kalam', 'Architects Daughter', 'Indie Flower', 'Ink Free', 'Segoe Print', 'Segoe UI', 'Arial'];
const WEIGHTS = { Gaegu: [[300, 'Light'], [400, 'Regular'], [700, 'Bold']], Kalam: [[300, 'Light'], [400, 'Regular'], [700, 'Bold']] };

function slider({ label, min, max, step = 1, value, fmt = (v) => v, onInput, onChange }) {
  const el = h(`<div class="row"><label>${esc(label)}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><span class="val">${esc(fmt(value))}</span></div>`);
  const inp = el.querySelector('input'), val = el.querySelector('.val');
  inp.addEventListener('input', () => { val.textContent = fmt(+inp.value); onInput && onInput(+inp.value); });
  inp.addEventListener('change', () => onChange && onChange(+inp.value));
  inp.addEventListener('keydown', (e) => e.stopPropagation());
  return el;
}

function seg(label, options, value, onPick) {
  const el = h(`<div class="row"><label>${esc(label)}</label><div class="seg">${options.map(([v, l]) => `<button data-v="${v}" class="${v === value ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>`);
  el.querySelectorAll('button').forEach((b) => (b.onclick = () => onPick(b.dataset.v)));
  return el;
}

function check(label, value, onChange) {
  const el = h(`<label class="check"><input type="checkbox" ${value ? 'checked' : ''}> ${esc(label)}</label>`);
  el.querySelector('input').onchange = (e) => onChange(e.target.checked);
  return el;
}

export class Panels {
  constructor(editor, app) {
    this.ed = editor;
    this.app = app;
    this.thumbs = new Map();
    this.buildToolbar();
    editor.on('tool', () => { this.updateToolbar(); this.renderToolCard(); this.renderColorCard(); });
    editor.on('settings', () => { this.renderToolCard(false); this.renderColorCard(false); this.updateToolbar(); });
    editor.on('selection', () => this.renderToolCard());
    editor.on('layers', () => this.renderLayers());
    editor.on('page', () => { this.renderLayers(); this.renderPages(); this.renderToolCard(); });
    editor.on('pages', () => this.renderPages());
    editor.on('ruler', () => this.updateToolbar());
    editor.on('doc', () => { clearTimeout(this._thumbTimer); this._thumbTimer = setTimeout(() => this.renderPages(), 450); });
  }

  refreshAll() {
    this.updateToolbar();
    this.renderToolCard();
    this.renderColorCard();
    this.renderLayers();
    this.renderPages();
  }

  // ---------------------------------------------------------- toolbar
  buildToolbar() {
    const bar = $('#toolbar');
    bar.innerHTML = '';
    for (const [t, key] of TOOLS) {
      const b = h(`<button class="tool" data-tool="${t}" data-tip="${TOOL_NAMES[t]}|${key}">${icon(t)}<span class="badge">${key}</span></button>`);
      b.onclick = () => this.ed.setTool(t);
      bar.appendChild(b);
      if (t === 'highlighter' || t === 'cover' || t === 'eyedropper') bar.appendChild(h('<div class="divider"></div>'));
    }
    const r = h(`<button class="tool" data-ruler data-tip="Ruler (straight lines)|R">${icon('ruler')}<span class="badge">R</span></button>`);
    r.onclick = () => this.ed.toggleRuler();
    bar.appendChild(r);
    const sw = h('<div class="swatch-now" data-tip="Colour|C" data-keeps-text tabindex="-1"></div>');
    sw.onclick = () => this.openColorPicker(sw);
    bar.appendChild(sw);
    this.swatchNow = sw;
  }

  updateToolbar() {
    const ed = this.ed;
    document.querySelectorAll('#toolbar .tool[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === ed.tool);
      const t = b.dataset.tool;
      b.querySelector('.mode-dot')?.remove();
      if ((t === 'eraser' && ed.settings.tools.eraser.mode === 'stroke') || (t === 'cover' && ed.settings.tools.cover.mode === 'box')) b.appendChild(h('<span class="mode-dot"></span>'));
    });
    document.querySelector('#toolbar [data-ruler]').classList.toggle('active', ed.ruler.on);
    this.swatchNow.style.background = ed.currentColor();
  }

  // ---------------------------------------------------------- tool card
  renderToolCard(force = true) {
    const ed = this.ed;
    const card = $('#tool-card');
    if (!force && card.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    const t = ed.tool;
    const s = ed.settings.tools[t] || {};
    card.innerHTML = '';
    card.appendChild(h(`<h3>${esc(TOOL_NAMES[t])}</h3>`));
    const set = (k, v) => ed.setToolSetting(k, v);
    const size = (max = 120, step = 0.5) => slider({ label: 'Size', min: 0.5, max, step, value: s.size, fmt: (v) => (+v).toFixed(v < 10 ? 1 : 0), onInput: (v) => set('size', v) });

    if (PAINT_TOOLS.includes(t)) {
      card.appendChild(size(t === 'highlighter' ? 160 : 80));
      card.appendChild(slider({ label: 'Opacity', min: 5, max: 100, value: Math.round(s.opacity * 100), fmt: (v) => v + '%', onInput: (v) => set('opacity', v / 100) }));
      card.appendChild(slider({
        label: 'Stabilizer', min: 0, max: 100, value: ed.settings.stabilizer, fmt: (v) => v,
        onInput: (v) => { ed.settings.stabilizer = v; }, onChange: () => this.app.saveSettings(),
      }));
      card.appendChild(h(matchMedia('(pointer: coarse)').matches
        ? `<p class="hint">Higher stabilizer = smoother lines. <b>Hold still</b> at the end of a stroke to snap it to a clean line, box, circle or arrow. <b>Two fingers</b> pan and zoom · <b>two-finger tap</b> undo · <b>three-finger tap</b> redo. Apple Pencil pressure changes the width.</p>`
        : `<p class="hint">Higher stabilizer = smoother, hand-drawn lines. <b>Hold still</b> at the end of a stroke to snap it to a clean line, box, circle or arrow. <b>Shift</b>-drag draws a straight line. <b>Alt</b>-click picks a colour.</p>`));
    } else if (t === 'eraser') {
      card.appendChild(seg('Mode', [['brush', 'Brush'], ['stroke', 'Strokes & letters']], s.mode, (v) => { s.mode = v; ed.emit('settings'); ed.updateCursor(); }));
      card.appendChild(size(200, 1));
      card.appendChild(check('Erase on all layers', s.allLayers, (v) => { s.allLayers = v; }));
      card.appendChild(h(`<p class="hint"><b>Brush</b> rubs out ink, even half a letter. <b>Strokes &amp; letters</b> removes whole strokes, and on handwriting removes just the letters you touch; the rest stays exactly in place and editable. Replay shows the erasing. The scan underneath is never touched. Press <b>E</b> to switch.</p>`));
    } else if (t === 'cover') {
      card.appendChild(seg('Mode', [['brush', 'Brush'], ['box', 'Box']], s.mode, (v) => { s.mode = v; ed.emit('settings'); ed.updateCursor(); }));
      if (s.mode === 'brush') card.appendChild(size(300, 1));
      this.renderGridControls(card);
      card.appendChild(h(`<p class="hint">Paints matching grid paper to hide old writing, then write on top. In brush mode, draw a loop and <b>hold</b> to fill it as a clean box. <b>Alt</b>-click samples the paper colour.</p>`));
    } else if (t === 'text') {
      const fonts = h(`<div class="row"><label>Font</label><select style="flex:1">${FONTS.map((f) => `<option ${f === s.font ? 'selected' : ''} style="font-family:'${f}'">${f}</option>`).join('')}</select></div>`);
      const sel = fonts.querySelector('select');
      sel.onchange = () => { set('font', sel.value); ed.refocusText(); };
      card.appendChild(fonts);
      card.appendChild(slider({ label: 'Size', min: 8, max: 220, value: s.size, onInput: (v) => set('size', v), onChange: () => ed.refocusText() }));
      const weights = WEIGHTS[s.font] || [[400, 'Regular'], [700, 'Bold']];
      card.appendChild(seg('Weight', weights.map(([v, l]) => [String(v), l]), String(s.weight || 400), (v) => { set('weight', +v); ed.refocusText(); }));
      card.appendChild(check('Natural handwriting (every letter different)', s.hand, (v) => { set('hand', v); this.renderToolCard(); ed.refocusText(); }));
      card.appendChild(check('Sit on grid lines', s.snap !== false, (v) => { s.snap = v; this.app.saveSettings(); }));
      card.appendChild(check('Mark lines the OCR was unsure about', ed.settings.markUnsure !== false, (v) => { ed.settings.markUnsure = v; ed.requestRender(); this.app.saveSettings(); }));
      card.appendChild(h(`<div class="font-preview" style="font-family:'${esc(s.font)}';font-weight:${s.weight || 400};color:${s.color}">Housing = a basic human need</div>`));
      card.appendChild(h(`<p class="hint"><b>Click</b> to type. <b>Click</b> existing text to retype it, <b>drag</b> it to move. <b>Esc</b> or click away to finish. Natural handwriting gives each letter its own size, tilt and baseline when you finish typing. Use the Lasso to resize, rotate or recolour.</p>`));
    } else if (t === 'lasso') {
      card.appendChild(check('Select on all layers', ed.settings.tools.lasso.allLayers, (v) => { ed.settings.tools.lasso.allLayers = v; }));
      const n = ed.selection ? ed.selection.items.length : 0;
      if (n) {
        card.appendChild(h(`<p class="hint" style="margin-top:0"><b>${n}</b> item${n > 1 ? 's' : ''} selected. Drag to move, corners to scale, top knob to rotate (Shift snaps 15°). Pick a colour to recolour.</p>`));
        const row = h('<div class="btn-row"></div>');
        const add = (ic, label, fn, tip) => { const b = h(`<button class="btn outline" data-tip="${tip}">${icon(ic)}${label}</button>`); b.onclick = fn; row.appendChild(b); };
        add('copy', 'Copy', () => ed.copySelection(), 'Copy|Ctrl+C');
        add('scissors', 'Cut', () => ed.copySelection(true), 'Cut|Ctrl+X');
        add('dup', 'Duplicate', () => ed.duplicateSelection(), 'Duplicate|Ctrl+D');
        add('trash', 'Delete', () => ed.deleteSelection(), 'Delete|Del');
        card.appendChild(row);
        if (ed.selectedObjects().some((x) => x.obj.type === 'text')) {
          const r2 = h('<div class="btn-row"></div>');
          const fsel = h(`<select style="flex:1">${FONTS.map((f) => `<option>${f}</option>`).join('')}</select>`);
          const first = ed.selectedObjects().find((x) => x.obj.type === 'text').obj;
          fsel.value = first.font;
          fsel.onchange = () => ed.applyToSelection({ font: fsel.value });
          r2.appendChild(fsel);
          const smaller = h(`<button class="btn outline icon" data-tip="Smaller text">${icon('minus')}</button>`);
          const bigger = h(`<button class="btn outline icon" data-tip="Bigger text">${icon('plus')}</button>`);
          smaller.onclick = () => ed.scaleSelectedText(1 / 1.12);
          bigger.onclick = () => ed.scaleSelectedText(1.12);
          r2.append(smaller, bigger);
          card.appendChild(r2);
        }
      } else {
        card.appendChild(h(`<p class="hint">Draw a loop around anything you wrote to select it, or click a single stroke or text. <b>Ctrl+A</b> selects the whole layer. Double-click text to edit it.</p>`));
      }
      if (ed.clipboard) {
        const b = h(`<button class="btn outline" style="margin-top:8px" data-tip="Paste|Ctrl+V">${icon('paste')}Paste</button>`);
        b.onclick = () => ed.paste();
        card.appendChild(b);
      }
    } else if (t === 'eyedropper') {
      card.appendChild(h(`<p class="hint" style="margin-top:0">Click anywhere on the page to pick its colour for your current brush. Tip: hold <b>Alt</b> and click while using any brush.</p>`));
    }
  }

  renderGridControls(card) {
    const ed = this.ed;
    const page = ed.page;
    if (!page) return;
    const g = page.grid;
    let orig = null;
    const preview = (k, v) => {
      if (!orig) orig = { ...page.grid };
      page.grid[k] = v;
      if (k === 'sx') page.grid.sy = v * (orig.sy / orig.sx);
      ed.invalidateAll();
      ed.requestRender();
    };
    const commit = () => {
      if (!orig) return;
      const next = { ...page.grid };
      page.grid = orig;
      orig = null;
      ed.setGrid(next);
    };
    const colors = h(`<div class="row"><label>Paper</label>
      <span class="chip small" data-k="paper" style="background:${g.paper}" data-tip="Paper colour"></span>
      <span style="color:var(--muted);margin-left:8px">Lines</span>
      <span class="chip small" data-k="line" style="background:${g.line}" data-tip="Grid line colour"></span></div>`);
    colors.querySelectorAll('[data-k]').forEach((chip) => {
      chip.onclick = () => openPicker(chip, page.grid[chip.dataset.k], (hex, final) => {
        chip.style.background = hex;
        preview(chip.dataset.k, hex);
        if (final) commit();
      });
    });
    card.appendChild(colors);
    const mm = page.dpi / 25.4;
    card.appendChild(slider({ label: 'Grid size', min: 1, max: 15, step: 0.05, value: +(g.sx / mm).toFixed(2), fmt: (v) => (+v).toFixed(1) + ' mm', onInput: (v) => preview('sx', v * mm), onChange: commit }));
    card.appendChild(slider({ label: 'Shift X', min: 0, max: Math.ceil(g.sx), step: 0.25, value: +(((g.ox % g.sx) + g.sx) % g.sx).toFixed(2), fmt: (v) => (+v).toFixed(1), onInput: (v) => preview('ox', v), onChange: commit }));
    card.appendChild(slider({ label: 'Shift Y', min: 0, max: Math.ceil(g.sy), step: 0.25, value: +(((g.oy % g.sy) + g.sy) % g.sy).toFixed(2), fmt: (v) => (+v).toFixed(1), onInput: (v) => preview('oy', v), onChange: commit }));
    card.appendChild(slider({ label: 'Line width', min: 0, max: 6, step: 0.1, value: +g.lw.toFixed(1), fmt: (v) => (+v).toFixed(1), onInput: (v) => preview('lw', v), onChange: commit }));
    if (page.bg.kind === 'image') {
      const b = h(`<button class="btn outline" style="margin-top:4px" data-tip="Detect grid size, position and colours from the scan">${icon('wand')}Auto-match scan grid</button>`);
      b.onclick = async () => {
        const bmp = await ed.ensureBitmap(page);
        const d = detectGrid(bmp, page.w, page.h);
        if (!d.found) { ed.setGrid({ paper: d.paper }); toast('No grid found; matched the paper colour'); return; }
        ed.setGrid({ sx: d.sx, sy: d.sy, ox: d.ox, oy: d.oy, paper: d.paper, line: d.line, lw: d.lw });
        toast('Grid matched to the scan');
        this.renderToolCard();
      };
      card.appendChild(b);
    }
  }

  // ---------------------------------------------------------- colour
  openColorPicker(anchor) {
    const ed = this.ed;
    openPicker(anchor, ed.currentColor(), (hex, final) => {
      if (final) ed.setColor(hex);
      else { const t = ed.settings.tools[ed.tool]?.color ? ed.tool : null; if (t) ed.settings.tools[t].color = hex; ed.updateTextDraft({ color: hex }); this.swatchNow.style.background = hex; }
    }, { onEyedropper: () => ed.setTool('eyedropper') });
  }

  renderColorCard(force = true) {
    const ed = this.ed;
    const card = $('#color-card');
    if (!force && card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    if (!ed.project) { card.innerHTML = ''; return; }
    const color = ed.currentColor();
    card.innerHTML = `<h3>Colour</h3>
      <div class="color-now"><span class="chip" data-tip="Open colour picker|C" style="background:${color}"></span>
      <input type="text" id="hex-input" value="${color}" maxlength="7" spellcheck="false">
      <button class="btn icon outline" data-eye data-tip="Eyedropper|I">${icon('eyedropper')}</button></div>
      <div class="swatches"></div>`;
    const chip = card.querySelector('.chip');
    chip.onclick = () => this.openColorPicker(chip);
    const hex = card.querySelector('#hex-input');
    hex.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') hex.blur(); });
    hex.addEventListener('change', () => { const v = hex.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) ed.setColor(v.startsWith('#') ? v.toLowerCase() : '#' + v.toLowerCase()); });
    card.querySelector('[data-eye]').onclick = () => ed.setTool('eyedropper');
    const wrap = card.querySelector('.swatches');
    const sw = ed.project.swatches;
    sw.forEach((c, i) => {
      const b = h(`<button class="swatch ${c.toLowerCase() === color.toLowerCase() ? 'on' : ''}" style="background:${c}" data-tip="${c}  (right-click to remove)${i < 9 ? '|' + (i + 1) : ''}">${i < 9 ? `<span class="n">${i + 1}</span>` : ''}</button>`);
      b.onclick = () => ed.setColor(c);
      b.oncontextmenu = (e) => {
        e.preventDefault();
        sw.splice(i, 1);
        this.app.markDirty();
        this.renderColorCard();
        toast('Swatch removed', { action: { label: 'Undo', run: () => { sw.splice(i, 0, c); this.app.markDirty(); this.renderColorCard(); } } });
      };
      wrap.appendChild(b);
    });
    const add = h(`<button class="swatch add" data-tip="Save current colour as swatch">${icon('plus')}</button>`);
    add.onclick = () => { if (!sw.includes(color)) { sw.push(color); this.app.markDirty(); this.renderColorCard(); } };
    wrap.appendChild(add);
  }

  // ---------------------------------------------------------- layers
  renderLayers() {
    const ed = this.ed;
    const card = $('#layers-card');
    const page = ed.page;
    if (!page) { card.innerHTML = ''; return; }
    card.innerHTML = `<h3>Layers <span class="actions">
      <button class="btn icon" data-add data-tip="New layer|Ctrl+Shift+N">${icon('plus')}</button>
      <button class="btn icon danger" data-del data-tip="Delete layer">${icon('trash')}</button></span></h3><div class="layers"></div>`;
    card.querySelector('[data-add]').onclick = () => ed.addLayer();
    card.querySelector('[data-del]').onclick = () => ed.deleteLayer();
    const list = card.querySelector('.layers');
    const layers = [...page.layers].reverse();
    layers.forEach((layer) => {
      const active = layer.id === ed.activeLayerId;
      const row = h(`<div class="layer ${active ? 'active' : ''} ${layer.visible ? '' : 'hidden'}" draggable="true">
        <button class="eye" data-tip="${layer.visible ? 'Hide' : 'Show'} layer">${icon(layer.visible ? 'eye' : 'eyeOff')}</button>
        <div class="name">${esc(layer.name)}</div>
        <div class="meta">${layer.objects.length ? layer.objects.length + ' · ' : ''}${Math.round(layer.opacity * 100)}%</div>
      </div>`);
      row.onclick = (e) => { if (!e.target.closest('.eye') && !e.target.closest('input')) ed.setActiveLayer(layer.id); };
      row.querySelector('.eye').onclick = () => ed.setLayerProps(layer.id, { visible: !layer.visible });
      row.querySelector('.name').ondblclick = () => this.renameLayer(row, layer);
      if (active) {
        const op = h(`<div class="opacity-row"><span style="color:var(--muted);font-size:11px">Opacity</span><input type="range" min="0" max="100" value="${Math.round(layer.opacity * 100)}">
          <button class="btn icon" data-up data-tip="Move up">${icon('up')}</button><button class="btn icon" data-down data-tip="Move down">${icon('down')}</button></div>`);
        const r = op.querySelector('input');
        r.oninput = () => { ed.previewLayerOpacity(layer.id, r.value / 100); row.querySelector('.meta').textContent = r.value + '%'; };
        r.onchange = () => ed.commitLayerOpacity(layer.id, r.value / 100);
        r.onkeydown = (e) => e.stopPropagation();
        op.querySelector('[data-up]').onclick = (e) => { e.stopPropagation(); ed.moveLayer(layer.id, 1); };
        op.querySelector('[data-down]').onclick = (e) => { e.stopPropagation(); ed.moveLayer(layer.id, -1); };
        row.appendChild(op);
      }
      // Drag to reorder.
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/layer', layer.id); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/layer')) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        row.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
        row.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/layer');
        const above = row.classList.contains('drop-before');
        row.classList.remove('drop-before', 'drop-after');
        if (!id || id === layer.id) return;
        const from = page.layers.findIndex((l) => l.id === id);
        let to = page.layers.findIndex((l) => l.id === layer.id) + (above ? 1 : 0);
        if (from < to) to--;
        ed.moveLayerTo(id, to);
      });
      list.appendChild(row);
    });
    // Original scan kept for comparison on rebuilt pages.
    if (page.ref) {
      const ref = h(`<div class="layer locked ${page.refVisible ? '' : 'hidden'}">
        <button class="eye" data-tip="${page.refVisible ? 'Hide' : 'Show'} the original scan on top, to compare">${icon(page.refVisible ? 'eye' : 'eyeOff')}</button>
        <div class="name">Original scan (compare)</div>
        <div class="meta" data-tip="Reference only: never exported">${icon('lock')}</div>
        <div class="opacity-row"><span style="color:var(--muted);font-size:11px">Opacity</span><input type="range" min="5" max="100" value="${Math.round((page.refOpacity ?? 0.5) * 100)}"></div>
      </div>`);
      ref.querySelector('.eye').onclick = () => ed.setPageProps({ refVisible: !page.refVisible });
      const rr = ref.querySelector('input');
      rr.oninput = () => { page.refOpacity = rr.value / 100; ed.requestRender(); };
      rr.onchange = () => ed.requestRender();
      rr.onkeydown = (e) => e.stopPropagation();
      list.appendChild(ref);
    }
    // The locked scan / paper layer.
    const scan = page.bg.kind === 'image';
    const bg = h(`<div class="layer locked ${page.bgVisible === false ? 'hidden' : ''}">
      <button class="eye" data-tip="${page.bgVisible === false ? 'Show' : 'Hide'} ${scan ? 'scan' : 'paper'}|Shift+B">${icon(page.bgVisible === false ? 'eyeOff' : 'eye')}</button>
      <div class="name">${scan ? 'Original scan' : page.rebuilt ? 'Grid paper (rebuilt)' : 'Grid paper'}</div>
      <div class="meta" data-tip="Locked: nothing can change it">${icon('lock')}</div>
      <div class="opacity-row"><span style="color:var(--muted);font-size:11px">Opacity</span><input type="range" min="0" max="100" value="${Math.round((page.bgOpacity ?? 1) * 100)}"></div>
    </div>`);
    bg.querySelector('.eye').onclick = () => ed.setPageProps({ bgVisible: page.bgVisible === false });
    const r = bg.querySelector('input');
    let origOp = null;
    r.oninput = () => { if (origOp === null) origOp = page.bgOpacity ?? 1; page.bgOpacity = r.value / 100; ed.requestRender(); };
    r.onchange = () => { const v = r.value / 100; page.bgOpacity = origOp ?? v; origOp = null; ed.setPageProps({ bgOpacity: v }); };
    r.onkeydown = (e) => e.stopPropagation();
    list.appendChild(bg);
  }

  renameLayer(row, layer) {
    const name = row.querySelector('.name');
    name.innerHTML = '';
    const inp = h(`<input type="text" value="${esc(layer.name)}">`);
    name.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok && inp.value.trim() && inp.value.trim() !== layer.name) this.ed.setLayerProps(layer.id, { name: inp.value.trim() });
      else this.renderLayers();
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  }

  // ---------------------------------------------------------- pages
  renderPages() {
    const ed = this.ed;
    const list = $('#page-list');
    if (!ed.project) { list.innerHTML = ''; return; }
    const pages = ed.project.pages;
    $('#page-count').textContent = pages.length;
    const ids = pages.map((p) => p.id).join(',');
    if (this._ids !== ids) {
      this._ids = ids;
      list.innerHTML = '';
      const keep = new Map();
      pages.forEach((page, i) => {
        let t = this.thumbs.get(page.id);
        if (!t) {
          const el = h(`<div class="thumb" draggable="true"><canvas></canvas><span class="num"></span></div>`);
          t = { el, version: -1, busy: false };
          el.onclick = () => ed.setPage(ed.project.pages.findIndex((p) => p.id === page.id));
          el.oncontextmenu = (e) => { e.preventDefault(); ed.setPage(ed.project.pages.findIndex((p) => p.id === page.id)); this.app.pageMenu(e.clientX, e.clientY); };
          el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/page', page.id); });
          el.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('text/page')) return;
            e.preventDefault();
            const r = el.getBoundingClientRect();
            el.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
            el.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
          });
          el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
          el.addEventListener('drop', (e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/page');
            const before = el.classList.contains('drop-before');
            el.classList.remove('drop-before', 'drop-after');
            const ps = ed.project.pages;
            const from = ps.findIndex((p) => p.id === id);
            let to = ps.findIndex((p) => p.id === page.id) + (before ? 0 : 1);
            if (from < to) to--;
            if (from >= 0 && from !== to) this.app.movePage(from, to);
          });
        }
        t.el.querySelector('.num').textContent = i + 1;
        keep.set(page.id, t);
        list.appendChild(t.el);
      });
      this.thumbs = keep;
    }
    pages.forEach((page, i) => {
      const t = this.thumbs.get(page.id);
      t.el.classList.toggle('active', i === ed.pageIndex);
      t.el.querySelector('.num').textContent = i + 1;
      const v = ed.pageVersion(page.id);
      if (t.version !== v && !t.busy) {
        t.busy = true;
        ed.renderThumb(page, 280).then((c) => {
          const cv = t.el.querySelector('canvas');
          cv.width = c.width; cv.height = c.height;
          cv.getContext('2d').drawImage(c, 0, 0);
          t.version = v;
          t.busy = false;
          if (ed.pageVersion(page.id) !== v) this.renderPages();
        }).catch(() => { t.busy = false; });
      }
    });
    this.thumbs.get(pages[ed.pageIndex]?.id)?.el.scrollIntoView({ block: 'nearest' });
  }
}

export { closePicker };
