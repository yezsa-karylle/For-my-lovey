// Home screen: the app's main menu. Shows "continue where you left off",
// recently edited notebooks with cover thumbnails, favourites, every notebook,
// and settings. main.js supplies the library (list/open/rename/...) through `lib`.
import { icon } from './icons.js';
import { $, $$, h, esc, toast, modal, closeModal, confirmDialog } from './dialogs.js';
import { VERSION } from '../version.js';

// ---------------------------------------------------------------- per-notebook info kept on this device
const META_KEY = 'redraft.library';
const THUMB = (p) => 'redraft.thumb:' + p;
function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; } }
export function getMeta(path) { return readMeta()[path] || {}; }
export function setMeta(path, patch) {
  if (!path) return;
  const all = readMeta();
  all[path] = { ...all[path], ...patch };
  try { localStorage.setItem(META_KEY, JSON.stringify(all)); } catch { /* storage full */ }
}
export function forgetMeta(path) {
  const all = readMeta();
  delete all[path];
  try { localStorage.setItem(META_KEY, JSON.stringify(all)); localStorage.removeItem(THUMB(path)); } catch { /* ignore */ }
}
export function getThumb(path) { try { return localStorage.getItem(THUMB(path)); } catch { return null; } }
export function setThumb(path, dataUrl) {
  try { localStorage.setItem(THUMB(path), dataUrl); } catch { /* storage full: the cover falls back to a drawn one */ }
}

// ---------------------------------------------------------------- formatting
export function ago(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) { const n = Math.round(s / 3600); return `${n} hour${n > 1 ? 's' : ''} ago`; }
  if (s < 172800) return 'Yesterday';
  if (s < 7 * 86400) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
const greeting = () => { const hr = new Date().getHours(); return hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
const pagesTxt = (n) => (n ? `${n} page${n === 1 ? '' : 's'}` : '');
const COVERS = ['#3b6cf6', '#e3453d', '#268c4d', '#c07a12', '#8a4fd8', '#16899c', '#d6457f'];
function coverColor(title) { let x = 0; for (const c of String(title)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return COVERS[x % COVERS.length]; }
function coverHtml(e) {
  if (e.thumb) return `<img src="${e.thumb}" alt="" draggable="false">`;
  return `<div class="cover-blank" style="--c:${coverColor(e.title)}"><span>${esc((e.title || '?').trim().charAt(0).toUpperCase())}</span></div>`;
}

// ---------------------------------------------------------------- the view
export class Home {
  constructor(lib) {
    this.lib = lib;
    this.el = $('#home');
    this.tab = 'home';
    this.query = '';
    this.prefs = (() => { try { return { sort: 'recent', view: 'grid', ...JSON.parse(localStorage.getItem('redraft.homePrefs') || '{}') }; } catch { return { sort: 'recent', view: 'grid' }; } })();
    this.entries = [];
    this.build();
  }

  savePrefs() { try { localStorage.setItem('redraft.homePrefs', JSON.stringify(this.prefs)); } catch { /* ignore */ } }

  build() {
    const navItems = [
      ['home', 'home', 'Home'],
      ['all', 'books', 'All notebooks'],
      ['favs', 'star', 'Favourites'],
      ['settings', 'gear', 'Settings'],
    ];
    this.el.innerHTML = `
      <aside class="home-nav">
        <div class="home-brand"><span class="brand-mark">${icon('mark')}</span><div><b>Redraft</b><small>Notes studio</small></div></div>
        <nav>${navItems.map(([id, ic, label]) => `<button class="nav-item" data-tab="${id}">${icon(ic)}<span>${label}</span><em class="count"></em></button>`).join('')}</nav>
        <div class="nav-foot">
          <button class="nav-item small desktop-only" data-act="help">${icon('keyboard')}<span>Keyboard shortcuts</span></button>
          <div class="storage" id="home-storage"></div>
        </div>
      </aside>
      <main class="home-main">
        <header class="home-top">
          <div class="home-head"><h1 id="home-heading"></h1><p id="home-sub"></p></div>
          <label class="search">${icon('search')}<input id="home-search" type="search" placeholder="Search notebooks" autocomplete="off" spellcheck="false"></label>
          <div class="menu-wrap">
            <button class="btn primary new-btn" data-menu="new-menu">${icon('plus')}<span>New</span></button>
            <div class="menu right" id="new-menu">
              <button data-cmd="newNotebook">${icon('grid')}Blank grid notebook<span class="k">Ctrl+N</span></button>
              <button data-cmd="open">${icon('image')}Import PDF or photos<span class="k">Ctrl+O</span></button>
              <button data-act="openProject">${icon('folder')}Open a .redraft project</button>
            </div>
          </div>
          <button class="btn icon outline" data-cmd="theme" data-tip="Dark / light">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
        </header>
        <div class="home-body" id="home-body"></div>
      </main>
      <nav class="home-tabs">${navItems.map(([id, ic, label]) => `<button data-tab="${id}">${icon(ic)}<span>${label.replace('All notebooks', 'Library')}</span></button>`).join('')}</nav>`;
    this.el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { this.setTab(t.dataset.tab); return; }
      const a = e.target.closest('[data-act]');
      if (a) this.act(a.dataset.act, a);
    });
    const s = $('#home-search', this.el);
    s.addEventListener('input', () => {
      this.query = s.value.trim().toLowerCase();
      if (this.query && this.tab !== 'all' && this.tab !== 'favs') this.setTab('all', true);
      else this.renderBody();
    });
    this.el.addEventListener('contextmenu', (e) => {
      const c = e.target.closest('.nb-card');
      if (!c) return;
      e.preventDefault();
      this.cardMenu(this.entry(c.dataset.path), e.clientX, e.clientY);
    });
    // Long-press a notebook on touch screens for its menu.
    let lp = 0, lpStart = null;
    this.el.addEventListener('pointerdown', (e) => {
      const c = e.target.closest('.nb-card');
      if (!c || e.pointerType === 'mouse') return;
      lpStart = [e.clientX, e.clientY];
      lp = setTimeout(() => { lp = 0; c.dataset.lp = '1'; this.cardMenu(this.entry(c.dataset.path), e.clientX, e.clientY); }, 550);
    });
    const cancelLp = (e) => { if (lp && (!lpStart || e.type !== 'pointermove' || Math.hypot(e.clientX - lpStart[0], e.clientY - lpStart[1]) > 10)) { clearTimeout(lp); lp = 0; } };
    ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => this.el.addEventListener(t, cancelLp));
  }

  entry(path) { return this.entries.find((x) => x.path === path); }

  setTab(tab, keepQuery = false) {
    this.tab = tab;
    if (!keepQuery) { this.query = ''; $('#home-search', this.el).value = ''; }
    this.renderBody();
    $('.home-body', this.el).scrollTop = 0;
  }

  async show() {
    this.el.classList.add('show');
    await this.refresh();
  }

  async refresh() {
    try { this.entries = await this.lib.list(); } catch (e) { console.error(e); this.entries = []; }
    for (const e of this.entries) { const m = getMeta(e.path); e.fav = !!m.fav; e.lastPage = m.lastPage || 0; e.thumb = getThumb(e.path); }
    this.renderBody();
    this.renderStorage();
  }

  renderStorage() {
    const el = $('#home-storage', this.el);
    if (!this.lib.web || !navigator.storage?.estimate) { el.innerHTML = `<span>Redraft ${VERSION}</span>`; return; }
    navigator.storage.estimate().then(({ usage = 0, quota = 0 }) => {
      const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
      el.innerHTML = `<div class="bar"><i style="width:${Math.max(2, pct).toFixed(1)}%"></i></div><span>${(usage / 1e6).toFixed(usage < 1e8 ? 1 : 0)} MB used on this device</span>`;
    }).catch(() => {});
  }

  // -------------------------------------------------------------- body
  sorted(list) {
    const by = this.prefs.sort;
    const out = list.slice();
    if (by === 'name') out.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    else if (by === 'pages') out.sort((a, b) => (b.pages || 0) - (a.pages || 0));
    else out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return out;
  }

  renderBody() {
    $$('[data-tab]', this.el).forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const favN = this.entries.filter((e) => e.fav).length;
    $$('.nav-item[data-tab]', this.el).forEach((b) => {
      const n = b.dataset.tab === 'all' ? this.entries.length : b.dataset.tab === 'favs' ? favN : 0;
      b.querySelector('.count').textContent = n || '';
    });
    const body = $('#home-body', this.el);
    const head = $('#home-heading', this.el), sub = $('#home-sub', this.el);
    $('.home-top .search', this.el).style.display = this.tab === 'settings' ? 'none' : '';
    if (this.tab === 'settings') {
      head.textContent = 'Settings';
      sub.textContent = 'Appearance, writing and storage';
      return this.renderSettings(body);
    }
    if (this.tab === 'home' && !this.query) {
      head.textContent = greeting();
      const last = this.sorted(this.entries)[0];
      sub.textContent = this.entries.length ? `${this.entries.length} notebook${this.entries.length === 1 ? '' : 's'} · last edited ${ago(last.updated).toLowerCase()}` : 'Welcome to Redraft';
      return this.renderHome(body);
    }
    const favs = this.tab === 'favs';
    head.textContent = favs ? 'Favourites' : 'All notebooks';
    let list = favs ? this.entries.filter((e) => e.fav) : this.entries;
    if (this.query) list = list.filter((e) => e.title.toLowerCase().includes(this.query));
    sub.textContent = this.query ? `${list.length} result${list.length === 1 ? '' : 's'} for “${this.query}”` : `${list.length} notebook${list.length === 1 ? '' : 's'}`;
    body.innerHTML = '';
    const bar = h(`<div class="list-bar">
      <div class="seg small" data-k="sort">${[['recent', 'Last edited'], ['name', 'Name'], ['pages', 'Pages']].map(([v, l]) => `<button data-v="${v}" class="${this.prefs.sort === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg small icons" data-k="view">${[['grid', 'grid'], ['list', 'list']].map(([v, ic]) => `<button data-v="${v}" class="${this.prefs.view === v ? 'on' : ''}" aria-label="${v} view">${icon(ic)}</button>`).join('')}</div>
    </div>`);
    bar.querySelectorAll('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.prefs[seg.dataset.k] = b.dataset.v;
      this.savePrefs();
      this.renderBody();
    }));
    body.appendChild(bar);
    if (!list.length) {
      body.appendChild(this.query
        ? h(`<div class="empty small">${icon('search')}<b>No notebooks match “${esc(this.query)}”</b></div>`)
        : favs
          ? h(`<div class="empty small">${icon('star')}<b>No favourites yet</b><span>Tap the star on a notebook to pin it here.</span></div>`)
          : this.emptyState());
      return;
    }
    body.appendChild(this.grid(this.sorted(list), this.prefs.view));
  }

  emptyState(buttons = true) {
    return h(`<div class="empty">
      <svg viewBox="0 0 120 96" class="empty-art" aria-hidden="true"><rect x="22" y="10" width="64" height="80" rx="6" fill="var(--panel)" stroke="var(--border)" stroke-width="2"/><path d="M32 30h40M32 42h44M32 54h30" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" opacity=".55"/><path d="M70 74c6-2 8-8 14-14s10-8 14-8" stroke="var(--text)" stroke-width="3" fill="none" stroke-linecap="round"/></svg>
      <b>No notebooks yet</b><span>Import your scanned notes or start on fresh grid paper. Everything saves automatically.</span>
      ${buttons ? '' : '<!--'}<div class="row-btns"><button class="btn primary" data-cmd="open">${icon('image')}Import PDF or photos</button><button class="btn outline" data-cmd="newNotebook">${icon('grid')}Blank notebook</button></div>${buttons ? '' : '-->'}
    </div>`);
  }

  renderHome(body) {
    body.innerHTML = '';
    const recent = this.sorted(this.entries.map((e) => e)).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (recent.length) {
      const e = recent[0];
      const cur = this.lib.current();
      const page = cur && cur.path === e.path ? cur.page : e.lastPage;
      const hero = h(`<section class="hero" data-path="${esc(e.path)}">
        <button class="hero-cover" data-open aria-label="Open ${esc(e.title)}">${coverHtml(e)}</button>
        <div class="hero-info">
          <span class="eyebrow">${icon('clock')}Continue where you left off</span>
          <h2>${esc(e.title)}</h2>
          <p>${[pagesTxt(e.pages), page ? `on page ${page + 1}` : '', `edited ${ago(e.updated).toLowerCase()}`].filter(Boolean).join(' · ')}</p>
          <div class="row-btns">
            <button class="btn primary big" data-open>${icon('pen')}Continue writing</button>
            <button class="btn outline big" data-replay>${icon('play')}Watch replay</button>
          </div>
        </div>
      </section>`);
      hero.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => this.lib.open(e)));
      hero.querySelector('[data-replay]').onclick = () => this.lib.open(e, { replay: true });
      body.appendChild(hero);
    }
    body.appendChild(h(`<h3 class="sec">Start something</h3>`));
    body.appendChild(h(`<div class="quick">
      <button class="big-action" data-cmd="newNotebook"><span class="qi" style="--c:#3b6cf6">${icon('grid')}</span><b>Blank notebook</b><span>Fresh 5 mm grid paper</span></button>
      <button class="big-action" data-cmd="open"><span class="qi" style="--c:#e3453d">${icon('image')}</span><b>Import notes</b><span>PDF, scans or photos</span></button>
      <button class="big-action" data-act="openProject"><span class="qi" style="--c:#268c4d">${icon('folder')}</span><b>Open project</b><span>A .redraft file from Files</span></button>
    </div>`));
    if (!recent.length) { body.appendChild(this.emptyState(false)); return; }
    const favs = recent.filter((e) => e.fav);
    if (favs.length) {
      body.appendChild(h(`<div class="sec-row"><h3 class="sec">Favourites</h3><button class="link" data-tab="favs">See all</button></div>`));
      body.appendChild(this.grid(favs.slice(0, 6), 'grid', true));
    }
    body.appendChild(h(`<div class="sec-row"><h3 class="sec">Recently edited</h3>${recent.length > 8 ? '<button class="link" data-tab="all">See all</button>' : ''}</div>`));
    body.appendChild(this.grid(recent.slice(0, 8), 'grid'));
  }

  grid(list, view, compact = false) {
    const wrap = h(`<div class="nb-${view === 'list' ? 'list' : 'grid'}${compact ? ' compact' : ''}"></div>`);
    const cur = this.lib.current();
    for (const e of list) {
      const open = cur && cur.path === e.path;
      const card = h(`<div class="nb-card" data-path="${esc(e.path)}">
        <button class="cover" aria-label="Open ${esc(e.title)}">${coverHtml(e)}${open ? '<span class="badge-open">Open</span>' : ''}</button>
        <div class="nb-meta">
          <div class="nb-text"><div class="nb-title" title="${esc(e.title)}">${esc(e.title)}</div><div class="nb-sub">${[pagesTxt(e.pages), ago(e.updated)].filter(Boolean).join(' · ')}</div></div>
          <button class="btn icon star ${e.fav ? 'on' : ''}" aria-label="Favourite">${icon('star')}</button>
          <button class="btn icon more" aria-label="More">${icon('more')}</button>
        </div>
      </div>`);
      card.querySelector('.cover').onclick = () => { if (card.dataset.lp) { delete card.dataset.lp; return; } this.lib.open(e); };
      card.querySelector('.star').onclick = () => this.toggleFav(e);
      card.querySelector('.more').onclick = (ev) => { const r = ev.currentTarget.getBoundingClientRect(); this.cardMenu(e, r.right, r.bottom + 4, true); };
      wrap.appendChild(card);
    }
    return wrap;
  }

  toggleFav(e) {
    e.fav = !e.fav;
    setMeta(e.path, { fav: e.fav });
    toast(e.fav ? 'Added to Favourites' : 'Removed from Favourites', { ms: 1400 });
    this.renderBody();
  }

  cardMenu(e, x, y, alignRight = false) {
    if (!e) return;
    document.querySelector('.ctx-menu')?.remove();
    const web = this.lib.web;
    const m = h(`<div class="menu open ctx-menu home-ctx">
      <button data-c="open">${icon('pen')}Open</button>
      <button data-c="replay">${icon('play')}Watch replay</button>
      <button data-c="fav">${icon('star')}${e.fav ? 'Remove from Favourites' : 'Add to Favourites'}</button>
      <hr>
      <button data-c="rename">${icon('text')}Rename…</button>
      <button data-c="duplicate">${icon('dup')}Duplicate</button>
      <button data-c="share">${icon(web ? 'share' : 'folder')}${web ? 'Share / download file' : 'Show in folder'}</button>
      <button data-c="info">${icon('info')}Details</button>
      <hr>
      <button data-c="remove" class="danger-item">${icon(web ? 'trash' : 'x')}${web ? 'Delete…' : 'Remove from list'}</button>
    </div>`);
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    const px = Math.max(8, Math.min((alignRight ? x - r.width : x), innerWidth - r.width - 8));
    const py = Math.max(8, Math.min(y, innerHeight - r.height - 8));
    m.style.cssText = `position:fixed;left:${px}px;top:${py}px`;
    m.querySelectorAll('button').forEach((b) => (b.onclick = () => { m.remove(); this.act(b.dataset.c, null, e); }));
    setTimeout(() => document.addEventListener('pointerdown', (ev) => { if (!m.contains(ev.target)) m.remove(); }, { once: true }), 0);
  }

  async act(c, el, e) {
    const lib = this.lib;
    try {
      if (c === 'help') return lib.help();
      if (c === 'openProject') return lib.openProject();
      if (c === 'open') return lib.open(e);
      if (c === 'replay') return lib.open(e, { replay: true });
      if (c === 'fav') return this.toggleFav(e);
      if (c === 'share') return lib.share(e);
      if (c === 'info') return this.details(e);
      if (c === 'rename') {
        const t = await this.prompt('Rename notebook', e.title, 'Rename');
        if (t && t !== e.title) { await lib.rename(e, t); toast('Renamed'); await this.refresh(); }
        return;
      }
      if (c === 'duplicate') { await lib.duplicate(e); toast(`Duplicated “${e.title}”`); await this.refresh(); return; }
      if (c === 'remove') {
        if (lib.web && !(await confirmDialog('Delete notebook?', `“${e.title}” will be removed from this device. Use Share / download first if you want to keep a copy.`, 'Delete', true))) return;
        await lib.remove(e);
        forgetMeta(e.path);
        toast(lib.web ? 'Notebook deleted' : 'Removed from the list (the file is still on your PC)');
        await this.refresh();
      }
    } catch (err) {
      console.error(err);
      toast('Something went wrong: ' + err.message, { ms: 5000 });
    }
  }

  prompt(title, value, ok) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
      modal(`<h2>${esc(title)}</h2><input type="text" class="wide-input" id="prompt-in" maxlength="120">
        <div class="actions"><button class="btn outline" data-x>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`, { onClose: () => { if (!done) { done = true; resolve(null); } } });
      const inp = $('#prompt-in');
      inp.value = value;
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(inp.value.trim()); });
      $('.modal [data-ok]').onclick = () => finish(inp.value.trim());
      $('.modal [data-x]').onclick = () => finish(null);
    });
  }

  details(e) {
    const rows = [
      ['Pages', e.pages || '—'],
      ['Last edited', e.updated ? new Date(e.updated).toLocaleString() : '—'],
      ['Size', e.size ? (e.size / 1e6).toFixed(1) + ' MB' : '—'],
      ['Stored', this.lib.web ? 'On this device (works offline)' : e.path],
    ];
    modal(`<h2>${esc(e.title)}</h2><div class="details">${rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
      <div class="actions"><button class="btn primary" data-x>Done</button></div>`);
    $('.modal [data-x]').onclick = () => closeModal();
  }

  // -------------------------------------------------------------- settings
  renderSettings(body) {
    const s = this.lib.settings();
    const theme = this.lib.themePref();
    body.innerHTML = '';
    const sec = (title, inner) => h(`<section class="set-card"><h3>${title}</h3>${inner}</section>`);
    const appearance = sec('Appearance', `
      <div class="set-row"><div><b>Theme</b><span>Light paper, dark studio, or follow your device.</span></div>
        <div class="seg" id="set-theme">${[['light', 'Light'], ['dark', 'Dark'], ['system', 'Automatic']].map(([v, l]) => `<button data-v="${v}" class="${theme === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>`);
    appearance.querySelector('#set-theme').onclick = (ev) => { const b = ev.target.closest('button'); if (b) { this.lib.setThemePref(b.dataset.v); this.renderBody(); } };
    body.appendChild(appearance);

    const writing = sec('Writing', `
      <div class="set-row"><div><b>Stabilizer</b><span>Smooths shaky lines. Higher is smoother but lags a little.</span></div>
        <div class="set-ctl"><input type="range" min="0" max="100" step="5" id="set-stab" value="${s.stabilizer}"><output>${s.stabilizer}</output></div></div>
      <div class="set-row"><div><b>Mark words the scan reader wasn’t sure about</b><span>Shows an orange dotted line under them so you can proofread.</span></div>
        <label class="switch"><input type="checkbox" id="set-unsure" ${s.markUnsure !== false ? 'checked' : ''}><i></i></label></div>
      <div class="set-row"><div><b>Reopen on the page I left</b><span>Notebooks open where you stopped instead of page 1.</span></div>
        <label class="switch"><input type="checkbox" id="set-resume" ${s.resumePage !== false ? 'checked' : ''}><i></i></label></div>`);
    const stab = writing.querySelector('#set-stab');
    stab.oninput = () => { stab.nextElementSibling.textContent = stab.value; this.lib.setSetting('stabilizer', +stab.value); };
    writing.querySelector('#set-unsure').onchange = (ev) => this.lib.setSetting('markUnsure', ev.target.checked);
    writing.querySelector('#set-resume').onchange = (ev) => this.lib.setSetting('resumePage', ev.target.checked);
    body.appendChild(writing);

    if (this.lib.web) {
      const st = sec('Storage', `
        <div class="set-row"><div><b>Saved on this device</b><span id="set-usage">Checking…</span></div></div>
        <div class="set-row"><div><b>Protect my notes</b><span id="set-persist-txt">Asks the browser never to clear Redraft’s storage when space runs low.</span></div>
          <button class="btn outline" id="set-persist">${icon('shield')}Protect</button></div>
        <p class="set-note">Notebooks never leave your device. To move one to another device or the Windows app, use “Share / download file” from its ••• menu.</p>`);
      body.appendChild(st);
      navigator.storage?.estimate?.().then(({ usage = 0, quota = 0 }) => {
        st.querySelector('#set-usage').textContent = `${(usage / 1e6).toFixed(1)} MB used of about ${quota > 1e9 ? (quota / 1e9).toFixed(1) + ' GB' : (quota / 1e6).toFixed(0) + ' MB'} available · ${this.entries.length} notebook${this.entries.length === 1 ? '' : 's'}`;
      }).catch(() => {});
      const pbtn = st.querySelector('#set-persist');
      const showPersist = (on) => { if (on) { pbtn.disabled = true; pbtn.innerHTML = `${icon('shield')}Protected`; st.querySelector('#set-persist-txt').textContent = 'The browser will keep your notes even when space runs low.'; } };
      navigator.storage?.persisted?.().then(showPersist).catch(() => {});
      pbtn.onclick = async () => {
        const ok = await navigator.storage?.persist?.().catch(() => false);
        if (ok) showPersist(true);
        else toast('Your browser decides this itself. Adding Redraft to your Home Screen keeps notes safest.', { ms: 5000 });
      };
    } else {
      body.appendChild(sec('Saving', `
        <div class="set-row"><div><b>Autosave</b><span>Every change is saved a moment after you make it, next to the file you opened. New notebooks are kept in the app folder until you choose Save as.</span></div></div>`));
    }

    const about = sec('About', `
      <div class="about"><span class="brand-mark big">${icon('mark')}</span><div><b>Redraft ${VERSION}</b><span>Rewrite your scanned notes in your own handwriting, then watch them being written.</span></div></div>
      <div class="set-row"><div><b>Works offline</b><span>${this.lib.web ? (navigator.serviceWorker?.controller ? 'Ready — Redraft opens without internet.' : 'Will be ready after this first visit.') : 'Everything runs on your PC.'}</span></div></div>
      <div class="row-btns"><button class="btn outline desktop-only" data-act="help">${icon('keyboard')}Keyboard shortcuts</button><button class="btn outline" id="set-tips">${icon('help')}Tips</button></div>`);
    about.querySelector('#set-tips').onclick = () => this.tips();
    body.appendChild(about);
  }

  tips() {
    const tips = [
      ['pen', 'Write with your finger or Apple Pencil', 'One finger draws. Pencil pressure makes lines thicker.'],
      ['undo', 'Undo with two fingers', 'Tap with two fingers to undo, three fingers to redo. Pinch to zoom.'],
      ['eraser', 'Erase letters, not just ink', 'Pick the eraser, set it to “Strokes & letters”, and rub over a word.'],
      ['wand', 'Make scans editable', 'Make editable turns a scanned page into handwriting you can retype.'],
      ['play', 'Watch it being written', 'Replay plays every page or your own edits, and exports a video.'],
    ];
    modal(`<h2>Tips</h2><div class="tips">${tips.map(([ic, t, d]) => `<div>${icon(ic)}<p><b>${t}</b><span>${d}</span></p></div>`).join('')}</div>
      <div class="actions"><button class="btn primary" data-x>Got it</button></div>`);
    $('.modal [data-x]').onclick = () => closeModal();
  }
}
