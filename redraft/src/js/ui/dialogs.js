// Toasts, modals, progress and tooltips.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, { ms = 2600, action } = {}) {
  const el = h(`<div class="toast">${esc(msg)}</div>`);
  if (action) {
    const a = h(`<a>${esc(action.label)}</a>`);
    a.onclick = () => { action.run(); el.remove(); };
    el.appendChild(a);
  }
  const root = $('#toasts');
  root.appendChild(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  setTimeout(() => el.remove(), action ? ms * 2 : ms);
}

let modalOpen = null;
export const isModalOpen = () => !!modalOpen;

/** Open a modal. Returns { el, close }. */
export function modal(html, { wide = false, onClose } = {}) {
  closeModal();
  const back = h(`<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`);
  $('#modal-root').appendChild(back);
  const close = () => {
    if (!back.isConnected) return;
    back.remove();
    modalOpen = null;
    onClose && onClose();
  };
  back.addEventListener('pointerdown', (e) => { if (e.target === back && !back.dataset.locked) close(); });
  modalOpen = { el: back.firstElementChild, close, back };
  return modalOpen;
}
export function closeModal() { if (modalOpen && !modalOpen.back.dataset.locked) modalOpen.close(); }

export function progressModal(title) {
  const m = modal(`<h2>${esc(title)}</h2><p class="sub" data-label>Starting…</p><div class="progress"><div></div></div>
    <div class="actions"><button class="btn outline" data-cancel hidden>Cancel</button></div>`);
  m.back.dataset.locked = '1';
  let cancelled = false;
  const btn = m.el.querySelector('[data-cancel]');
  btn.onclick = () => { cancelled = true; btn.textContent = 'Cancelling…'; };
  return {
    set(done, total, label) {
      m.el.querySelector('.progress > div').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      if (label) m.el.querySelector('[data-label]').textContent = label;
    },
    cancellable() { btn.hidden = false; },
    get cancelled() { return cancelled; },
    close() { delete m.back.dataset.locked; m.close(); },
  };
}

export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p>
      <div class="actions"><button class="btn outline" data-no>Cancel</button><button class="btn primary ${danger ? 'danger-bg' : ''}" data-yes>${esc(okLabel)}</button></div>`,
    { onClose: () => resolve(false) });
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-yes]').onclick = () => { resolve(true); m.close(); };
    setTimeout(() => m.el.querySelector('[data-yes]').focus(), 0);
  });
}

/** Tooltips from data-tip="Label|Shortcut". */
export function initTooltips() {
  let tip = null, timer = 0;
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    hide();
    if (!el) return;
    timer = setTimeout(() => {
      const [label, key] = el.dataset.tip.split('|');
      tip = h(`<div class="tip">${esc(label)}${key ? `<kbd>${esc(key)}</kbd>` : ''}</div>`);
      document.body.appendChild(tip);
      const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
      let x = r.right + 8, y = r.top + r.height / 2 - t.height / 2;
      if (el.closest('.topbar') || el.closest('.panel-foot') || el.closest('.card')) { x = r.left + r.width / 2 - t.width / 2; y = r.bottom + 6; }
      if (el.closest('.panel-foot')) y = r.top - t.height - 6;
      x = Math.max(6, Math.min(innerWidth - t.width - 6, x));
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }, 450);
  });
  document.addEventListener('pointerdown', hide, true);
}
