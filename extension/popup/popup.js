// The quick switcher (Cmd/Ctrl+Shift+Space). It lives in a toolbar popup rather than the
// sidebar because Firefox gives a popup keyboard focus when it opens, while an extension
// sidebar can't take focus away from the page on its own.

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
const ico = (name, cls = '') => h('span', { class: `ico i-${name} ${cls}`.trim() });

function favicon(src) {
  if (!src || /^(chrome|resource):/.test(src)) return ico('globe', 'fav');
  const img = h('img', { class: 'fav', src, alt: '', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(ico('globe', 'fav')), { once: true });
  return img;
}

const win = await browser.windows.getCurrent();
const port = browser.runtime.connect({ name: `popup:${win.id}` });
const pending = new Map();
let nextId = 0;
port.onMessage.addListener((msg) => {
  if (msg.type !== 'reply') return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
});
function call(name, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    port.postMessage({ type: 'cmd', id, name, args });
  });
}

const palInput = $('#palette-input');
let palResults = [];
let palSelected = 0;
let palSeq = 0;
let palTimer = null;

async function palSearch(query) {
  const seq = ++palSeq;
  const results = await call('quickSearch', { query }).catch(() => []);
  if (seq !== palSeq) return;
  palResults = results;
  palSelected = 0;
  renderPalette();
}

// The popup closes as soon as it loses focus, so the command is sent first and the popup
// waits for it to finish before closing itself.
async function palRun(r) {
  if (!r) return;
  // A revealed folder is shown in the sidebar, so open it. This must happen synchronously
  // inside the click/keypress handler.
  if (r.kind === 'folder') browser.sidebarAction.open().catch(() => {});
  try {
    if (r.kind === 'space') await call('switchSpace', { spaceId: r.spaceId });
    else if (r.kind === 'folder') await call('revealFolder', { nodeId: r.nodeId });
    else if (r.kind === 'tab') await call('activateNode', { nodeId: r.nodeId });
    else if (r.kind === 'archive') await call('restoreArchive', { id: r.id });
  } catch { /* the sidebar shows errors; there's nothing useful to show here */ }
  window.close();
}

function renderPalette() {
  const list = $('#palette-results');
  if (!palResults.length) {
    list.replaceChildren(h('div', { class: 'pal-empty' }, palInput.value.trim() ? 'No matches' : 'Nothing here yet'));
    return;
  }
  const crumbs = (r) => (r.path?.length ? ` · ${r.path.join(' › ')}` : '');
  list.replaceChildren(...palResults.map((r, i) => h('div', {
    class: `pal-row${i === palSelected ? ' selected' : ''}${r.indent ? ' pal-indent' : ''}`,
    role: 'option',
    onmousedown: (e) => e.preventDefault(), // keep the input focused
    onclick: () => palRun(r),
    onmousemove: () => {
      if (palSelected === i) return;
      palSelected = i;
      renderPalette();
    },
  },
    r.kind === 'space'
      ? h('span', { class: 'pal-space', style: `--c:${r.color || 'var(--space)'}` }, r.emoji || '')
      : r.kind === 'folder' ? ico('folder-open')
        : favicon(r.favIconUrl),
    h('span', { class: 'pal-title' }, r.title || r.url || 'New Tab'),
    h('span', { class: 'pal-where' },
      r.kind === 'space' ? 'Space'
        : r.kind === 'archive' ? `Archived${r.spaceName ? ` · ${r.spaceName}` : ''}`
          : r.indent ? ''
            : `${r.emoji ? `${r.emoji} ` : ''}${r.spaceName}${crumbs(r)}${r.pinned && r.kind !== 'folder' ? ' · 📌' : ''}`),
  )));
  list.children[palSelected]?.scrollIntoView({ block: 'nearest' });
}

palInput.addEventListener('keydown', (e) => {
  const move = (d) => {
    if (!palResults.length) return;
    palSelected = (palSelected + d + palResults.length) % palResults.length;
    renderPalette();
  };
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    palRun(palResults[palSelected]);
  } else if (e.key === 'Escape') {
    window.close();
  }
});
palInput.addEventListener('input', () => {
  clearTimeout(palTimer);
  palTimer = setTimeout(() => palSearch(palInput.value), 80);
});

palInput.focus();
palSearch('');
