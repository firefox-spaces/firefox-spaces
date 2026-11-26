import { SPACE_COLORS, CONTAINER_COLORS, EXPIRY_OPTIONS } from '../shared/constants.js';

const openSetup = () => browser.tabs.create({ url: browser.runtime.getURL('setup/setup.html') });
const openMigrate = () => browser.tabs.create({ url: browser.runtime.getURL('migrate/migrate.html') });

const $ = (sel) => document.querySelector(sel);

// Tiny DOM builder: h('div', { class: 'x', onclick: fn }, child, 'text', ...)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
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

// ---------------------------------------------------------------------------
// Connection to the background page
// ---------------------------------------------------------------------------

const win = await browser.windows.getCurrent();
let port = null;
const pending = new Map();
let nextId = 0;

let S = null;            // latest view model from the background
let queuedState = null;  // held back while dragging or renaming
let dragging = false;
let editing = false;
let view = 'main';       // 'main' | 'archive' | 'settings'
let pendingRenameId = null;

function connect() {
  port = browser.runtime.connect({ name: `sidebar:${win.id}` });
  port.onMessage.addListener(onMessage);
  // The background restarted (e.g. the extension was reloaded): start over.
  port.onDisconnect.addListener(() => setTimeout(() => location.reload(), 700));
}

function onMessage(msg) {
  if (msg.type === 'state') {
    if (dragging || editing) queuedState = msg.state;
    else {
      S = msg.state;
      render();
    }
  } else if (msg.type === 'reply') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }
}

function callStrict(name, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    port.postMessage({ type: 'cmd', id, name, args });
  });
}

// Errors show as a toast; resolves to undefined on failure.
function call(name, args = {}) {
  return callStrict(name, args).catch((err) => {
    toast(err.message);
    return undefined;
  });
}

function flush() {
  if (dragging || editing) return;
  if (queuedState) {
    S = queuedState;
    queuedState = null;
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const index = new Map(); // nodeId -> { node, section, parentId, idx, depth }

let lastActiveRowId = null;

function render() {
  if (!S || !S.space) return;
  document.documentElement.style.setProperty('--space', S.space.color);
  renderHeader();
  $('#tabbar-tip').hidden = !!S.settings.tabBarTipDismissed;
  renderTree();
  // When a different tab became active (e.g. picked in the quick switcher), bring its
  // row into view; its folders are already expanded by the background.
  const activeRow = document.querySelector('.row.active');
  if (activeRow && activeRow.dataset.id !== lastActiveRowId) {
    lastActiveRowId = activeRow.dataset.id;
    activeRow.scrollIntoView({ block: 'nearest' });
  }
  renderDots();
  if (view === 'archive' && S.archiveCount !== archiveCountSeen) refreshArchive();
  if (view === 'settings' && !settingsHasFocus()) renderSettings();
  if (pendingRenameId) {
    const row = rowFor(pendingRenameId);
    if (row) {
      pendingRenameId = null;
      startRename(row);
    }
  }
}

function favicon(src, loading = false) {
  if (loading) return h('span', { class: 'spinner' });
  if (!src || /^(chrome|resource):/.test(src)) return ico('globe', 'fav');
  const img = h('img', { class: 'fav', src, alt: '', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(ico('globe', 'fav')), { once: true });
  return img;
}

function renderHeader() {
  const sp = S.space;
  // replaceChildren() would print a null as the text "null", so drop the empty slots.
  // The space's profile (container) is deliberately not shown here.
  $('#space-header').replaceChildren(...[
    sp.emoji ? h('span', { class: 'space-emoji' }, sp.emoji) : null,
    h('span', { class: 'space-name', title: 'Double-click to rename' }, sp.name),
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn', id: 'space-menu-btn', title: 'Space options' }, ico('more')),
  ].filter(Boolean));
}

function nodeEl(n, section, parentId, idx, depth) {
  index.set(n.id, { node: n, section, parentId, idx, depth });
  if (n.type === 'folder') {
    const row = h('div', {
      class: 'row folder-row', draggable: 'true', dataset: { id: n.id }, style: `--depth:${depth}`,
    },
    ico('chevron', n.collapsed ? '' : 'open'),
    ico(n.collapsed ? 'folder' : 'folder-open'),
    h('span', { class: 'title' }, n.title || 'Folder'));
    const wrap = h('div', { class: 'folder' }, row);
    if (!n.collapsed) {
      wrap.append(h('div', { class: 'children' },
        n.children.map((c, i) => nodeEl(c, section, n.id, i, depth + 1))));
    }
    return wrap;
  }
  const cls = ['row', 'tab', n.active && 'active', !n.open && 'unloaded', n.discarded && 'discarded',
    n.elsewhere && 'elsewhere'].filter(Boolean).join(' ');
  const tip = n.elsewhere ? `${n.url}\n(open in another window — click to bring it here)` : n.url;
  return h('div', { class: cls, draggable: 'true', dataset: { id: n.id }, style: `--depth:${depth}`, title: tip },
    favicon(n.favIconUrl, n.loading),
    h('span', { class: 'title' }, n.title || n.url || 'New Tab'),
    (n.audible || n.muted)
      ? h('button', { class: 'icon-btn act-mute', title: n.muted ? 'Unmute' : 'Mute' }, ico(n.muted ? 'muted' : 'speaker'))
      : null,
    n.drifted ? h('button', { class: 'icon-btn act-reset', title: 'Back to the pinned page' }, ico('reset')) : null,
    h('button', {
      class: 'icon-btn act-close',
      title: section === 'pinned' ? 'Close (stays pinned)' : 'Close tab',
    }, ico('close')),
    section === 'pinned' ? h('button', { class: 'icon-btn act-unpin', title: 'Unpin tab' }, ico('pin')) : null);
}

function renderTree() {
  index.clear();
  const sp = S.space;
  const pinned = $('#pinned');
  pinned.replaceChildren(...sp.pinned.map((n, i) => nodeEl(n, 'pinned', null, i, 0)));
  if (!sp.pinned.length) pinned.append(h('div', { class: 'empty-hint' }, 'Drag tabs here to pin them'));
  $('#temp').replaceChildren(...sp.temp.map((n, i) => nodeEl(n, 'temp', null, i, 0)));
  $('#clear-btn').hidden = !sp.temp.length;
}

function renderDots() {
  $('#dots').replaceChildren(...S.spaces.map((s) => h('button', {
    class: `dot${s.id === S.space.id ? ' active' : ''}${s.emoji ? ' has-emoji' : ''}`,
    draggable: 'true',
    dataset: { space: s.id },
    title: s.name,
    style: `--c:${s.color}`,
  }, s.emoji || '')));
}

const rowFor = (id) => document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);

// ---------------------------------------------------------------------------
// Inline rename
// ---------------------------------------------------------------------------

function inlineEdit(target, value, cls, onCommit) {
  editing = true;
  const input = h('input', { class: cls, value });
  target.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    editing = false;
    if (commit) onCommit(input.value.trim());
    flush();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  for (const evt of ['click', 'dblclick', 'mousedown']) input.addEventListener(evt, (e) => e.stopPropagation());
}

function startRename(row) {
  const ent = row && index.get(row.dataset.id);
  const titleEl = row?.querySelector('.title');
  if (!ent || !titleEl) return;
  row.draggable = false;
  inlineEdit(titleEl, ent.node.title || '', 'rename', (title) => {
    if (ent.node.type === 'folder' && !title) return;
    call('renameNode', { nodeId: ent.node.id, title });
  });
}

// Edits a pinned tab's URL in place, where the title normally sits.
function startEditUrl(row) {
  const ent = row && index.get(row.dataset.id);
  const titleEl = row?.querySelector('.title');
  if (!ent || !titleEl) return;
  row.draggable = false;
  const current = ent.node.pinnedUrl || ent.node.url || '';
  inlineEdit(titleEl, current, 'rename', async (url) => {
    if (!url || url === current) return;
    try {
      await call('setPinnedUrl', { nodeId: ent.node.id, url });
    } catch (err) {
      toast(err.message);
    }
  });
}

function renameSpaceInline() {
  const nameEl = $('#space-header .space-name');
  if (!nameEl) return;
  const spaceId = S.space.id;
  inlineEdit(nameEl, S.space.name, 'space-name-input', (name) => {
    if (name) call('updateSpace', { spaceId, name });
  });
}

async function newFolder(parentId = null) {
  if (parentId) {
    const ent = index.get(parentId);
    if (ent?.node.collapsed) await call('toggleFolder', { nodeId: parentId });
  }
  const id = await call('createFolder', { spaceId: S.space.id, parentId, index: parentId ? 0 : null });
  if (!id) return;
  pendingRenameId = id;
  const row = rowFor(id);
  if (row) {
    pendingRenameId = null;
    startRename(row);
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function showMenu(x, y, items) {
  const clean = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      if (clean.length && clean[clean.length - 1] !== '-') clean.push('-');
    } else clean.push(it);
  }
  while (clean[clean.length - 1] === '-') clean.pop();
  if (!clean.length) return;
  const menu = $('#menu');
  menu.replaceChildren(...clean.map((it) => (it === '-'
    ? h('div', { class: 'menu-sep' })
    : h('button', {
      class: `menu-item${it.danger ? ' danger' : ''}`,
      role: 'menuitem',
      disabled: !!it.disabled,
      onclick: () => {
        hideMenu();
        it.run();
      },
    }, it.label))));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}

function hideMenu() {
  $('#menu').hidden = true;
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#menu')) hideMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
});
window.addEventListener('blur', hideMenu);

const spaceLabel = (s) => `${s.emoji ? `${s.emoji} ` : ''}${s.name}`;

function tabMenu(ent) {
  const n = ent.node;
  const sp = S.space;
  const others = S.spaces.filter((s) => s.id !== sp.id);
  const move = (section, extra = {}) => call('moveNode', {
    nodeId: n.id, spaceId: sp.id, section, parentId: null, index: section === 'temp' ? 0 : null, ...extra,
  });
  return [
    ent.section === 'temp'
      ? { label: 'Pin tab', run: () => move('pinned') }
      : { label: 'Unpin tab', run: () => move('temp') },
    { label: 'Rename…', run: () => startRename(rowFor(n.id)) },
    ent.section === 'pinned' && { label: 'Edit URL…', run: () => startEditUrl(rowFor(n.id)) },
    n.pinnedUrl && n.drifted && { label: 'Back to pinned page', run: () => call('resetPinned', { nodeId: n.id }) },
    n.open && !n.active && !n.discarded && { label: 'Unload tab', run: () => call('unloadNode', { nodeId: n.id }) },
    n.url && { label: 'Copy link', run: () => navigator.clipboard.writeText(n.url).then(() => toast('Link copied')) },
    '-',
    ...others.map((s) => ({
      label: `Move to ${spaceLabel(s)}`,
      run: () => call('moveNode', {
        nodeId: n.id, spaceId: s.id, section: ent.section, parentId: null, index: ent.section === 'temp' ? 0 : null,
      }),
    })),
    '-',
    ent.section === 'pinned' && n.open && { label: 'Close tab (keep pinned)', run: () => call('closeNode', { nodeId: n.id }) },
    ent.section === 'pinned'
      ? { label: 'Remove from pinned', danger: true, run: () => call('deleteNode', { nodeId: n.id }) }
      : { label: 'Close tab', danger: true, run: () => call('closeNode', { nodeId: n.id }) },
  ];
}

function folderMenu(ent) {
  const n = ent.node;
  return [
    { label: 'Rename…', run: () => startRename(rowFor(n.id)) },
    { label: 'New folder inside', run: () => newFolder(n.id) },
    { label: n.collapsed ? 'Expand' : 'Collapse', run: () => call('toggleFolder', { nodeId: n.id }) },
    '-',
    { label: 'Delete folder (keep its tabs)', danger: true, run: () => call('deleteFolder', { nodeId: n.id }) },
  ];
}

function spaceMenu(space) {
  return [
    { label: 'Edit space…', run: () => openSpaceDialog(space) },
    { label: 'New space…', run: () => openSpaceDialog() },
    space.id === S.space.id && { label: 'New folder', run: () => newFolder(null) },
    space.id === S.space.id && S.space.temp.length && {
      label: 'Clear temporary tabs', run: () => call('clearTemp', { spaceId: space.id }),
    },
    '-',
    {
      label: 'Delete space…',
      danger: true,
      disabled: S.spaces.length <= 1,
      run: async () => {
        const ok = await confirmDialog(`Delete “${space.name}”? Its tabs will be closed. Its profile and logins are kept.`);
        if (ok) call('deleteSpace', { spaceId: space.id });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main view interactions
// ---------------------------------------------------------------------------

$('#main-view').addEventListener('click', (e) => {
  const row = e.target.closest('.row[data-id]');
  if (!row) return;
  const ent = index.get(row.dataset.id);
  if (!ent) return;
  const id = ent.node.id;
  if (e.target.closest('.act-close')) return void call('closeNode', { nodeId: id });
  if (e.target.closest('.act-mute')) return void call('toggleMute', { nodeId: id });
  if (e.target.closest('.act-reset')) return void call('resetPinned', { nodeId: id });
  if (e.target.closest('.act-unpin')) {
    // Same as the menu's "Unpin tab": to the top of the unpinned tabs, no confirmation.
    return void call('moveNode', { nodeId: id, spaceId: S.space.id, section: 'temp', parentId: null, index: 0 });
  }
  if (ent.node.type === 'folder') return void call('toggleFolder', { nodeId: id });
  call('activateNode', { nodeId: id });
});

$('#main-view').addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const row = e.target.closest('.row.tab[data-id]');
  if (row) {
    e.preventDefault();
    call('closeNode', { nodeId: row.dataset.id });
  }
});

$('#main-view').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row[data-id]');
  if (row && !e.target.closest('button')) startRename(row);
});

$('#main-view').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.row[data-id]');
  if (row) {
    const ent = index.get(row.dataset.id);
    if (ent) showMenu(e.clientX, e.clientY, ent.node.type === 'folder' ? folderMenu(ent) : tabMenu(ent));
    return;
  }
  if (e.target.closest('#pinned')) {
    showMenu(e.clientX, e.clientY, [{ label: 'New folder', run: () => newFolder(null) }]);
  } else {
    showMenu(e.clientX, e.clientY, [
      { label: 'New tab', run: () => call('newTab') },
      S.space.temp.length && { label: 'Clear temporary tabs', run: () => call('clearTemp', { spaceId: S.space.id }) },
    ]);
  }
});

$('#new-tab-btn').addEventListener('click', () => call('newTab'));
$('#clear-btn').addEventListener('click', () => call('clearTemp', { spaceId: S.space.id }));

$('#space-header').addEventListener('dblclick', (e) => {
  if (e.target.closest('.space-name')) renameSpaceInline();
});
$('#space-header').addEventListener('click', (e) => {
  const btn = e.target.closest('#space-menu-btn');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, spaceMenu(S.space));
});
$('#space-header').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, spaceMenu(S.space));
});

// "Hide Firefox's tab bar?" prompt
const dismissTip = () => call('updateSettings', { patch: { tabBarTipDismissed: true } });
$('#tip-how').addEventListener('click', () => {
  openSetup();
  dismissTip();
});
$('#tip-dismiss').addEventListener('click', dismissTip);

// Footer
$('#dots').addEventListener('click', (e) => {
  const dot = e.target.closest('.dot');
  if (!dot) return;
  if (view !== 'main') showView('main');
  if (dot.dataset.space !== S.space.id) call('switchSpace', { spaceId: dot.dataset.space });
});
$('#dots').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const dot = e.target.closest('.dot');
  const space = dot && S.spaces.find((s) => s.id === dot.dataset.space);
  if (space) showMenu(e.clientX, e.clientY, spaceMenu(space));
});
$('#add-space-btn').addEventListener('click', () => openSpaceDialog());
$('#archive-btn').addEventListener('click', () => showView(view === 'archive' ? 'main' : 'archive'));
$('#settings-btn').addEventListener('click', () => showView(view === 'settings' ? 'main' : 'settings'));
for (const btn of document.querySelectorAll('.back-btn')) btn.addEventListener('click', () => showView('main'));

// Two-finger horizontal swipe switches spaces, like Arc.
let wheelAcc = 0;
let wheelLockUntil = 0;
let wheelResetTimer = null;
document.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Date.now() < wheelLockUntil) return;
  wheelAcc += e.deltaX;
  clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => { wheelAcc = 0; }, 250);
  if (Math.abs(wheelAcc) > 120) {
    call('cycleSpace', { dir: Math.sign(wheelAcc) });
    wheelAcc = 0;
    wheelLockUntil = Date.now() + 700;
  }
}, { passive: true });

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

let drag = null; // { kind: 'node' | 'dot', id }

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-end')) {
    el.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-end');
  }
}

function isInside(ent, folderId) {
  for (let p = ent.parentId; p; p = index.get(p)?.parentId) if (p === folderId) return true;
  return false;
}

document.addEventListener('dragstart', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const dot = el?.closest('.dot');
  const row = el?.closest('#main-view .row[data-id]');
  if (dot) drag = { kind: 'dot', id: dot.dataset.space };
  else if (row) drag = { kind: 'node', id: row.dataset.id };
  else return;
  hideMenu();
  dragging = true;
  document.body.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  const url = drag.kind === 'node' ? index.get(drag.id)?.node.url : '';
  e.dataTransfer.setData('text/plain', url || '');
  if (url) e.dataTransfer.setData('text/uri-list', url);
  (row || dot).classList.add('dragging');
});

document.addEventListener('dragend', () => {
  drag = null;
  dragging = false;
  document.body.classList.remove('dragging');
  clearDropMarks();
  for (const el of document.querySelectorAll('.dragging')) el.classList.remove('dragging');
  flush();
});

function computeDrop(e) {
  const el = e.target instanceof Element ? e.target : e.target?.parentElement;
  if (!el || !drag || !S) return null;

  if (drag.kind === 'dot') {
    const dot = el.closest('.dot');
    if (!dot || dot.dataset.space === drag.id) return null;
    const r = dot.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    return {
      mark: () => dot.classList.add(after ? 'drop-after' : 'drop-before'),
      apply: () => {
        const ids = S.spaces.map((s) => s.id).filter((id) => id !== drag.id);
        ids.splice(ids.indexOf(dot.dataset.space) + (after ? 1 : 0), 0, drag.id);
        call('reorderSpaces', { order: ids });
      },
    };
  }

  const src = index.get(drag.id);
  if (!src) return null;
  const nodeId = drag.id;
  const isFolder = src.node.type === 'folder';

  const dot = el.closest('.dot');
  if (dot) {
    if (dot.dataset.space === S.space.id) return null;
    return {
      mark: () => dot.classList.add('drop-into'),
      apply: () => call('moveNode', {
        nodeId, spaceId: dot.dataset.space, section: src.section, parentId: null,
        index: src.section === 'temp' ? 0 : null,
      }),
    };
  }

  const row = el.closest('#main-view .row[data-id]');
  if (row) {
    const tgt = index.get(row.dataset.id);
    if (!tgt || tgt.node.id === nodeId) return null;
    if (isFolder && (tgt.section === 'temp' || isInside(tgt, nodeId))) return null;
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    let pos;
    if (tgt.node.type === 'folder') pos = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'into';
    else pos = y < 0.5 ? 'before' : 'after';
    // "After" an open folder means "first thing inside it".
    if (pos === 'after' && tgt.node.type === 'folder' && !tgt.node.collapsed && tgt.node.children.length) {
      pos = 'into-start';
    }
    let target;
    if (pos === 'into') target = { section: tgt.section, parentId: tgt.node.id, index: tgt.node.children.length };
    else if (pos === 'into-start') target = { section: tgt.section, parentId: tgt.node.id, index: 0 };
    else target = { section: tgt.section, parentId: tgt.parentId, index: tgt.idx + (pos === 'after' ? 1 : 0) };
    const markClass = pos === 'before' ? 'drop-before' : pos === 'into' ? 'drop-into' : 'drop-after';
    return {
      mark: () => row.classList.add(markClass),
      apply: () => call('moveNode', { nodeId, spaceId: S.space.id, ...target }),
    };
  }

  const zone = el.closest('#pinned, #temp, #divider, #new-tab-btn');
  if (zone) {
    const section = zone.id === 'pinned' ? 'pinned' : 'temp';
    if (isFolder && section === 'temp') return null;
    return {
      mark: () => $(section === 'pinned' ? '#pinned' : '#temp').classList.add('drop-end'),
      apply: () => call('moveNode', {
        nodeId, spaceId: S.space.id, section, parentId: null, index: section === 'temp' ? 0 : null,
      }),
    };
  }
  return null;
}

document.addEventListener('dragover', (e) => {
  if (!drag) return;
  const target = computeDrop(e);
  clearDropMarks();
  if (!target) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  target.mark();
});

document.addEventListener('drop', (e) => {
  if (!drag) return;
  const target = computeDrop(e);
  clearDropMarks();
  if (!target) return;
  e.preventDefault();
  target.apply();
});

// ---------------------------------------------------------------------------
// Views: archive & settings
// ---------------------------------------------------------------------------

function showView(next) {
  view = next;
  $('#main-panel').hidden = next !== 'main';
  $('#archive-view').hidden = next !== 'archive';
  $('#settings-view').hidden = next !== 'settings';
  $('#archive-btn').classList.toggle('on', next === 'archive');
  if (next === 'archive') {
    refreshArchive();
    $('#archive-search').focus();
  } else if (next === 'settings') {
    renderSettings();
  }
}

let archiveItems = [];
let archiveCountSeen = -1;

async function refreshArchive() {
  archiveCountSeen = S?.archiveCount ?? -1;
  archiveItems = (await call('getArchive')) || [];
  renderArchive();
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function renderArchive() {
  const q = $('#archive-search').value.trim().toLowerCase();
  const items = q
    ? archiveItems.filter((a) => `${a.title} ${a.url}`.toLowerCase().includes(q))
    : archiveItems;
  const list = $('#archive-list');
  $('#archive-clear').hidden = !archiveItems.length;
  if (!items.length) {
    list.replaceChildren(h('div', { class: 'archive-empty' }, q ? 'No matches' : 'Nothing archived yet'));
    return;
  }
  list.replaceChildren(...items.map((a) => h('div', { class: 'row archive-item', dataset: { archive: a.id }, title: a.url },
    favicon(a.favIconUrl),
    h('span', { class: 'text' },
      h('span', { class: 'title' }, a.title || a.url),
      h('span', { class: 'meta' }, [a.spaceName, ago(a.archivedAt)].filter(Boolean).join(' · '))),
    h('button', { class: 'icon-btn act-delete', title: 'Delete from archive' }, ico('close')))));
}

$('#archive-search').addEventListener('input', renderArchive);
$('#archive-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.archive-item');
  if (!item) return;
  const id = item.dataset.archive;
  if (e.target.closest('.act-delete')) await call('deleteArchive', { id });
  else {
    await call('restoreArchive', { id });
    showView('main');
  }
});
$('#archive-clear').addEventListener('click', async () => {
  if (await confirmDialog('Permanently delete everything in the archive?', 'Clear all')) await call('clearArchive');
});

function settingsHasFocus() {
  const a = document.activeElement;
  return !!a && $('#settings-view').contains(a)
    && ((a.tagName === 'INPUT' && a.type !== 'checkbox') || a.tagName === 'SELECT');
}

function renderSettings() {
  if (!S) return;
  const usedBy = (id) => S.spaces.filter((s) => s.cookieStoreId === id).map((s) => s.name);

  const expiry = h('select', { 'aria-label': 'Archive temporary tabs after' },
    EXPIRY_OPTIONS.map((o) => h('option', { value: String(o.ms), selected: o.ms === S.settings.expiryMs }, o.label)));
  expiry.addEventListener('change', () => call('updateSettings', { patch: { expiryMs: Number(expiry.value) } }));

  const tint = h('input', { type: 'checkbox', checked: !!S.settings.tintWindow });
  tint.addEventListener('change', () => call('updateSettings', { patch: { tintWindow: tint.checked } }));

  const profileRows = S.profiles.filter((p) => !p.isDefault).map((p) => {
    const used = usedBy(p.cookieStoreId);
    const name = h('input', { value: p.name, 'aria-label': 'Profile name' });
    name.addEventListener('change', () => call('updateProfile', { cookieStoreId: p.cookieStoreId, name: name.value }));
    const color = h('select', { 'aria-label': 'Profile color' },
      Object.keys(CONTAINER_COLORS).map((c) => h('option', { value: c, selected: c === p.color }, c)));
    color.addEventListener('change', () => call('updateProfile', { cookieStoreId: p.cookieStoreId, color: color.value }));
    const del = h('button', {
      class: 'icon-btn', title: used.length ? `In use by ${used.join(', ')}` : 'Delete profile', disabled: used.length > 0,
    }, ico('trash'));
    del.addEventListener('click', async () => {
      const ok = await confirmDialog(`Delete the profile “${p.name}”? Its cookies, logins and site data will be erased.`);
      if (ok) call('deleteProfile', { cookieStoreId: p.cookieStoreId });
    });
    return h('div', {},
      h('div', { class: 'profile-row' }, h('span', { class: 'profile-dot', style: `--c:${p.colorCode}` }), name, color, del),
      used.length ? h('div', { class: 'hint used-by' }, `Used by ${used.join(', ')}`) : null);
  });

  const newName = h('input', { placeholder: 'New profile name', 'aria-label': 'New profile name' });
  const addProfile = async () => {
    if (!newName.value.trim()) return;
    const colors = Object.keys(CONTAINER_COLORS);
    const ok = await call('createProfile', { name: newName.value, color: colors[S.profiles.length % 8], icon: 'fingerprint' });
    if (ok) newName.value = '';
  };
  newName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addProfile();
  });

  $('#settings-body').replaceChildren(
    h('div', { class: 'set-group' },
      h('label', { class: 'label' }, 'Archive temporary tabs after'),
      expiry,
      h('p', { class: 'hint' }, 'Unpinned tabs you haven’t opened in this long move to the Archive. Pinned tabs never expire.')),
    h('div', { class: 'set-group' },
      h('label', { class: 'check' }, tint, h('span', {}, 'Tint the browser window with the space’s color'))),
    h('div', { class: 'set-group' },
      h('div', { class: 'label' }, 'Profiles'),
      h('p', { class: 'hint' }, 'Each profile is a Firefox container with its own cookies, logins and site data. Spaces that share a profile share logins.'),
      profileRows.length ? profileRows : h('p', { class: 'hint' }, 'No profiles yet. Spaces use the Default profile.'),
      h('div', { class: 'profile-row' }, newName, h('button', { class: 'btn', onclick: addProfile }, 'Add'))),
    backupGroup(),
    h('div', { class: 'set-group' },
      h('div', { class: 'label' }, 'Shortcuts'),
      h('p', { class: 'hint' }, 'Ctrl+Shift+Space (Cmd+Shift+Space on Mac) opens the quick switcher: type to jump to any space or tab, in any space. Ctrl+Alt+← / → (Control+Option on Mac) switches spaces, and so does a two-finger sideways swipe over the sidebar. Ctrl+Alt+S (Control+Option+S on Mac) shows or hides the sidebar. Change keys in about:addons → ⚙ → Manage Extension Shortcuts.'),
      h('p', { class: 'hint' }, 'Want Ctrl+Tab to flip between your two most recent tabs? That’s built into Firefox: Settings → General → “Ctrl+Tab cycles through tabs in recently used order”. It only sees this space’s tabs, since other spaces are hidden.')),
    h('div', { class: 'set-group' },
      h('div', { class: 'label' }, 'Coming from Arc?'),
      h('p', { class: 'hint' }, 'Bring your Arc spaces over: pinned tabs, folders, favorites and today’s tabs.'),
      h('button', { class: 'btn', onclick: openMigrate }, 'Import from Arc')),
    h('div', { class: 'set-group' },
      h('div', { class: 'label' }, 'Hide Firefox’s tab bar'),
      h('p', { class: 'hint' }, 'Recommended. The sidebar replaces the tab bar at the top of the window. Firefox doesn’t let extensions hide it, so it takes a one-time, 2-minute setup.'),
      h('button', { class: 'btn', onclick: openSetup }, 'Show me how')),
  );
}

// "Save to Firefox profile": an optional copy of everything in Firefox bookmarks.
// permissions.request() only works synchronously inside the click/change handler, so it
// is always the first thing those handlers do.
const askBookmarks = () => browser.permissions.request({ permissions: ['bookmarks'] }).catch(() => false);

async function restoreFromProfile() {
  const allowed = await askBookmarks();
  if (!allowed) return toast('Spaces needs bookmarks access to read the saved copy.');
  const ok = await confirmDialog('Restore the spaces saved in your Firefox bookmarks? Spaces you don’t have yet are added and empty spaces with the same name are filled in. Spaces that already have tabs are left as they are.', 'Restore');
  if (!ok) return;
  const r = await call('restoreBackup');
  if (!r) return;
  const added = r.spaces + r.merged;
  let msg = added ? `Restored ${added} space${added === 1 ? '' : 's'} (${r.tabs} tabs)` : 'Nothing new to restore';
  if (r.skipped.length) msg += `. Kept your current ${r.skipped.join(', ')}`;
  toast(msg);
}

function backupGroup() {
  const st = S.backup || {};
  const on = !!S.settings.profileBackup;
  const box = h('input', { type: 'checkbox', checked: on });
  box.addEventListener('change', async () => {
    if (box.checked) {
      const allowed = await askBookmarks();
      if (!allowed) {
        box.checked = false;
        return toast('Spaces needs bookmarks access to sync through your profile.');
      }
    }
    call('updateSettings', { patch: { profileBackup: box.checked } });
  });

  let status = null;
  if (on && st.running) status = h('p', { class: 'hint' }, 'Syncing…');
  else if (on && st.error) status = h('p', { class: 'hint backup-error' }, `Couldn’t sync: ${st.error}`);
  else if (on && st.at) status = h('p', { class: 'hint' }, `Last synced ${ago(st.at)}.`);

  return h('div', { class: 'set-group' },
    h('div', { class: 'label' }, 'Save to Firefox profile'),
    h('label', { class: 'check' }, box, h('span', {}, 'Keep my spaces in Firefox bookmarks and sync them between computers')),
    h('p', { class: 'hint' }, 'Your spaces, pinned tabs, folders, open tabs and settings are kept in Other Bookmarks → Spaces, which will sync with your Firefox Account.'),
    status,
    h('div', { class: 'actions' },
      on ? h('button', { class: 'btn', onclick: () => call('backupNow') }, 'Sync now') : null,
      on ? null : h('button', { class: 'btn', onclick: restoreFromProfile }, 'Restore from profile…')));
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const spaceDialog = $('#space-dialog');
let dlgSpace = null;
let dlgColor = SPACE_COLORS[0];
let dlgProfileColor = 'blue';

function renderColorSwatches() {
  const custom = h('input', { type: 'color', class: 'swatch-custom', value: dlgColor, title: 'Custom color' });
  custom.addEventListener('input', () => {
    dlgColor = custom.value;
    for (const s of document.querySelectorAll('#sd-colors .swatch')) s.classList.remove('selected');
  });
  $('#sd-colors').replaceChildren(
    ...SPACE_COLORS.map((c) => h('button', {
      type: 'button',
      class: `swatch${c.toLowerCase() === String(dlgColor).toLowerCase() ? ' selected' : ''}`,
      style: `--c:${c}`,
      title: c,
      onclick: () => {
        dlgColor = c;
        renderColorSwatches();
      },
    })),
    custom,
  );
}

function renderProfileColorSwatches() {
  $('#sd-pcolors').replaceChildren(...Object.entries(CONTAINER_COLORS).map(([name, hex]) => h('button', {
    type: 'button',
    class: `swatch${name === dlgProfileColor ? ' selected' : ''}`,
    style: `--c:${hex}`,
    title: name,
    onclick: () => {
      dlgProfileColor = name;
      renderProfileColorSwatches();
    },
  })));
}

function updateProfileFields() {
  const value = $('#sd-profile').value;
  $('#sd-newprofile').hidden = value !== '__new';
  const changing = dlgSpace && value !== dlgSpace.cookieStoreId;
  $('#sd-hint').textContent = changing
    ? 'Changing the profile reopens this space’s open tabs in the new profile, so you may need to log in again.'
    : 'Spaces that share a profile share cookies and logins. A new profile starts logged out everywhere.';
}

function openSpaceDialog(space = null) {
  hideMenu();
  dlgSpace = space;
  $('#sd-title').textContent = space ? 'Edit space' : 'New space';
  $('#sd-save').textContent = space ? 'Save' : 'Create';
  $('#sd-delete').hidden = !space || S.spaces.length <= 1;
  $('#sd-name').value = space ? space.name : '';
  $('#sd-emoji').value = space ? space.emoji || '' : '';
  dlgColor = space ? space.color : SPACE_COLORS[S.spaces.length % SPACE_COLORS.length];
  renderColorSwatches();

  const others = (id) => S.spaces.filter((s) => s.cookieStoreId === id && s.id !== space?.id).map((s) => s.name);
  $('#sd-profile').replaceChildren(
    ...S.profiles.map((p) => {
      const shared = others(p.cookieStoreId);
      const label = p.isDefault ? 'Default (Firefox’s normal logins)' : p.name;
      return h('option', { value: p.cookieStoreId }, label, shared.length ? ` · shared with ${shared.join(', ')}` : '');
    }),
    h('option', { value: '__new' }, '＋ New profile…'),
  );
  $('#sd-profile').value = space ? space.cookieStoreId : '__new';
  $('#sd-pname').value = '';
  $('#sd-pname').placeholder = 'Profile name (defaults to the space name)';
  dlgProfileColor = Object.keys(CONTAINER_COLORS)[S.profiles.length % 8];
  renderProfileColorSwatches();
  updateProfileFields();
  spaceDialog.showModal();
  $('#sd-name').focus();
}

$('#sd-profile').addEventListener('change', updateProfileFields);
$('#sd-cancel').addEventListener('click', () => spaceDialog.close());
$('#sd-delete').addEventListener('click', async () => {
  const space = dlgSpace;
  spaceDialog.close();
  if (!space) return;
  const ok = await confirmDialog(`Delete “${space.name}”? Its tabs will be closed. Its profile and logins are kept.`);
  if (ok) call('deleteSpace', { spaceId: space.id });
});
$('#space-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#sd-name').value.trim();
  if (!name) return;
  const choice = $('#sd-profile').value;
  const profile = choice === '__new'
    ? { create: { name: $('#sd-pname').value.trim() || name, color: dlgProfileColor, icon: 'fingerprint' } }
    : { cookieStoreId: choice };
  const payload = { name, emoji: $('#sd-emoji').value.trim(), color: dlgColor, profile };
  try {
    if (dlgSpace) await callStrict('updateSpace', { spaceId: dlgSpace.id, ...payload });
    else await callStrict('createSpace', payload);
    spaceDialog.close();
  } catch (err) {
    toast(err.message);
  }
});

function confirmDialog(message, okLabel = 'Delete') {
  const dialog = $('#confirm-dialog');
  $('#cd-msg').textContent = message;
  $('#cd-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

connect();
