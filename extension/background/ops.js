// Live browser state and the operations that change it: switching spaces, hiding/showing
// tabs, opening tabs for nodes, and moving tabs between containers.

import {
  state, getSpace, getEntry, entryByTab, link, insertNode, detachNode, makeTabNode, spaceTabNodes,
} from './store.js';
import { DEFAULT_STORE, NEWTAB_URLS } from '../shared/constants.js';
import { buildTheme } from './theme.js';
import { enqueue } from './queue.js';

export const windowSpace = new Map();   // windowId -> spaceId shown in that window
export const activeTab = new Map();     // windowId -> active tabId
export const liveTabs = new Map();      // tabId -> latest tabs.Tab
export const expectedRemovals = new Set(); // tabIds we're closing ourselves while keeping their node
export const ignoredWindows = new Set(); // popups, devtools, private windows
export const runtime = { containers: [] };

const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
export const isDark = () => !!darkQuery?.matches;
export const onDarkChange = (fn) => darkQuery?.addEventListener?.('change', fn);

export async function refreshContainers() {
  try {
    runtime.containers = (await browser.contextualIdentities.query({})) || [];
  } catch {
    runtime.containers = [];
  }
}

export const storeExists = (id) =>
  id === DEFAULT_STORE || runtime.containers.some((c) => c.cookieStoreId === id);

export const isNewTabUrl = (url) => NEWTAB_URLS.includes(url);

// tabs.create() refuses privileged URLs; return undefined to open a plain new tab instead.
export function openableUrl(url) {
  if (!url || isNewTabUrl(url) || url === 'about:blank') return undefined;
  if (url.startsWith('about:reader?url=')) {
    try { return decodeURIComponent(url.slice('about:reader?url='.length)); } catch { return undefined; }
  }
  if (/^(about|chrome|resource|moz-extension|file|javascript|data|view-source|jar):/i.test(url)) return undefined;
  return url;
}

export function isActiveTab(tabId) {
  const t = liveTabs.get(tabId);
  return !!t && activeTab.get(t.windowId) === tabId;
}

export const lastActiveOf = (tabId) => entryByTab(tabId)?.node.lastActive || 0;

export function setWindowSpace(windowId, spaceId) {
  windowSpace.set(windowId, spaceId);
  state.lastSpaceId = spaceId;
  browser.sessions.setWindowValue(windowId, 'spaceId', spaceId).catch(() => {});
}

// Returns the window's space id, initializing it for windows we haven't seen.
// Returns null for windows we don't manage (popups, private windows).
export async function ensureWindow(windowId) {
  if (windowSpace.has(windowId)) return windowSpace.get(windowId);
  if (ignoredWindows.has(windowId) || windowId == null) return null;
  let win;
  try { win = await browser.windows.get(windowId); } catch { return null; }
  if (win.type !== 'normal' || win.incognito) {
    ignoredWindows.add(windowId);
    return null;
  }
  let id = null;
  try { id = await browser.sessions.getWindowValue(windowId, 'spaceId'); } catch { /* not restored */ }
  if (!getSpace(id)) id = getSpace(state.lastSpaceId) ? state.lastSpaceId : state.spaces[0]?.id;
  if (!id) return null;
  setWindowSpace(windowId, id);
  return id;
}

export async function openTabForNode(node, space, windowId, { active = true, index } = {}) {
  const props = {
    windowId,
    active,
    cookieStoreId: storeExists(space.cookieStoreId) ? space.cookieStoreId : DEFAULT_STORE,
  };
  const url = openableUrl(node.url);
  if (url) props.url = url;
  if (index != null) props.index = index;
  let tab;
  try {
    tab = await browser.tabs.create(props);
  } catch (err) {
    if (!props.url) throw err;
    delete props.url;
    tab = await browser.tabs.create(props);
  }
  liveTabs.set(tab.id, tab);
  link(node, tab.id);
  node.lastActive = Date.now();
  if (active) activeTab.set(windowId, tab.id);
  return tab;
}

export async function newTabInSpace(space, windowId, { active = true } = {}) {
  const node = makeTabNode();
  insertNode(node, space, 'temp', null, 0);
  await openTabForNode(node, space, windowId, { active });
  return node;
}

// Event-driven container moves are budgeted. If another container manager (Multi-Account
// Containers, Temporary Containers, a new-tab container pref, ...) keeps undoing them, the
// two extensions reopen each other's tabs forever — an open/close storm that kills the
// browser. User-initiated moves (changing a space's profile, dragging between spaces)
// don't go through this guard.
const REOPEN_WINDOW_MS = 10_000;
const REOPEN_MAX = 10;        // event-driven reopens allowed per window
const REOPEN_COOLDOWN_MS = 30_000;
const reopenBudget = { stamps: [], blockedUntil: 0 };

// Returns the reopened tab, or null when the budget is exhausted (caller leaves the tab alone).
export async function guardedReopen(tabId, cookieStoreId, opts) {
  const now = Date.now();
  if (now < reopenBudget.blockedUntil) return null;
  reopenBudget.stamps = reopenBudget.stamps.filter((t) => now - t < REOPEN_WINDOW_MS);
  if (reopenBudget.stamps.length >= REOPEN_MAX) {
    reopenBudget.blockedUntil = now + REOPEN_COOLDOWN_MS;
    console.warn('[Spaces] too many container moves in a few seconds — another extension or '
      + 'setting seems to be fighting over tab containers. Pausing container moves for 30s.');
    return null;
  }
  reopenBudget.stamps.push(now);
  return reopenInContainer(tabId, cookieStoreId, opts);
}

// A tab's container can't change, so moving it to another container means opening a copy
// there and closing the original. The node is carried over to the new tab.
export async function reopenInContainer(tabId, cookieStoreId, { url } = {}) {
  let old;
  try { old = await browser.tabs.get(tabId); } catch { return null; }
  if (old.cookieStoreId === cookieStoreId) return old;
  if (!storeExists(cookieStoreId)) return old;
  const entry = entryByTab(tabId);
  const props = { windowId: old.windowId, index: old.index + 1, active: old.active, cookieStoreId };
  const target = openableUrl(url ?? old.url);
  if (target) props.url = target;
  let tab;
  try {
    tab = await browser.tabs.create(props);
  } catch {
    delete props.url;
    tab = await browser.tabs.create(props);
  }
  liveTabs.set(tab.id, tab);
  if (entry) link(entry.node, tab.id);
  if (old.active) activeTab.set(old.windowId, tab.id);
  expectedRemovals.add(tabId);
  await browser.tabs.remove(tabId).catch(() => {});
  return tab;
}

// Show the window's space's tabs and hide everything else (Firefox can't hide pinned tabs).
export async function applyVisibility(windowId) {
  const spaceId = windowSpace.get(windowId);
  if (!spaceId) return;
  let tabs;
  try { tabs = await browser.tabs.query({ windowId }); } catch { return; }
  const show = [];
  const hide = [];
  for (const t of tabs) {
    if (t.pinned) continue;
    const entry = entryByTab(t.id);
    if (!entry) continue; // not ours; leave it alone
    if (entry.space.id === spaceId) {
      if (t.hidden) show.push(t.id);
    } else if (!t.hidden && !t.active) {
      hide.push(t.id);
    }
  }
  if (show.length) await browser.tabs.show(show).catch((e) => console.warn('[Spaces] show', e));
  if (hide.length) await browser.tabs.hide(hide).catch((e) => console.warn('[Spaces] hide', e));
}

export async function applyVisibilityAll() {
  for (const windowId of [...windowSpace.keys()]) await applyVisibility(windowId);
}

export async function switchSpace(windowId, spaceId, { focusTabId } = {}) {
  const space = getSpace(spaceId);
  if (!space) return;
  const prev = windowSpace.get(windowId);
  setWindowSpace(windowId, spaceId);

  const tabs = await browser.tabs.query({ windowId });
  const mine = tabs.filter((t) => !t.pinned && entryByTab(t.id)?.space.id === spaceId);
  const hidden = mine.filter((t) => t.hidden).map((t) => t.id);
  if (hidden.length) await browser.tabs.show(hidden).catch((e) => console.warn('[Spaces] show', e));

  let target = focusTabId ?? null;
  if (target == null) {
    const last = space.lastActiveNodeId ? getEntry(space.lastActiveNodeId)?.node : null;
    if (last?.tabId != null && mine.some((t) => t.id === last.tabId)) target = last.tabId;
    else if (mine.length) target = mine.reduce((a, b) => (lastActiveOf(b.id) > lastActiveOf(a.id) ? b : a)).id;
  }
  const current = tabs.find((t) => t.active);
  if (target != null) {
    if (current?.id !== target) await browser.tabs.update(target, { active: true });
    activeTab.set(windowId, target);
  } else if (!current?.pinned) {
    // Empty space: give it a fresh tab.
    await newTabInSpace(space, windowId);
  }

  await applyVisibility(windowId);
  if (prev && prev !== spaceId) await closeEmptyNewTabs(prev, windowId);
  await applyTheme(windowId);
  scheduleOrderSync(windowId);
}

// Untouched "New Tab" pages left behind in a space we just left are just clutter.
export async function closeEmptyNewTabs(spaceId, windowId) {
  const space = getSpace(spaceId);
  if (!space) return;
  const doomed = space.temp.filter((n) => {
    const t = n.tabId != null ? liveTabs.get(n.tabId) : null;
    return t && t.windowId === windowId && isNewTabUrl(t.url) && activeTab.get(windowId) !== t.id;
  });
  if (!doomed.length) return;
  const ids = doomed.map((n) => n.tabId);
  for (const n of doomed) detachNode(n.id);
  await browser.tabs.remove(ids).catch(() => {});
}

// Before a tab leaves the window's space (moved/archived), focus something else in that space.
export async function ensureNotActive(tabId, windowId) {
  const tabs = await browser.tabs.query({ windowId });
  const current = tabs.find((t) => t.active);
  if (!current || current.id !== tabId) return;
  const spaceId = windowSpace.get(windowId);
  const candidates = tabs.filter((t) => t.id !== tabId && !t.pinned && entryByTab(t.id)?.space.id === spaceId);
  if (candidates.length) {
    const pick = candidates.reduce((a, b) => (lastActiveOf(b.id) > lastActiveOf(a.id) ? b : a));
    await browser.tabs.update(pick.id, { active: true });
    activeTab.set(windowId, pick.id);
  } else {
    await newTabInSpace(getSpace(spaceId), windowId);
  }
}

export async function applyTheme(windowId) {
  if (!browser.theme) return;
  try {
    if (!state.settings.tintWindow) {
      await browser.theme.reset(windowId);
      return;
    }
    const space = getSpace(windowSpace.get(windowId));
    if (space) await browser.theme.update(windowId, buildTheme(space.color, isDark()));
  } catch (err) {
    console.warn('[Spaces] theme', err);
  }
}

export async function applyThemeAll() {
  for (const windowId of [...windowSpace.keys()]) await applyTheme(windowId);
}

// Keep the real tab order matching the sidebar so Ctrl+Tab and "close goes to the next tab"
// behave the way the sidebar looks.
const orderTimers = new Map();
export function scheduleOrderSync(windowId) {
  clearTimeout(orderTimers.get(windowId));
  orderTimers.set(windowId, setTimeout(() => {
    orderTimers.delete(windowId);
    enqueue(() => syncOrder(windowId)).catch(() => {});
  }, 250));
}

async function syncOrder(windowId) {
  const space = getSpace(windowSpace.get(windowId));
  if (!space) return;
  let tabs;
  try { tabs = await browser.tabs.query({ windowId }); } catch { return; }
  const present = new Map(tabs.filter((t) => !t.pinned).map((t) => [t.id, t]));
  const desired = spaceTabNodes(space).map((n) => n.tabId).filter((id) => id != null && present.has(id));
  const wanted = new Set(desired);
  const current = tabs.filter((t) => wanted.has(t.id)).sort((a, b) => a.index - b.index).map((t) => t.id);
  if (current.join() === desired.join()) return;
  await browser.tabs.move(desired, { windowId, index: -1 }).catch((e) => console.warn('[Spaces] reorder', e));
}

// After nodes change space (or a space changes profile), bring their live tabs along:
// move focus off them if they're leaving the visible space, fix their container, re-hide.
export async function relocate(tabNodes, toSpace) {
  for (const node of tabNodes) {
    if (node.tabId == null) continue;
    const tab = liveTabs.get(node.tabId);
    if (!tab) continue;
    if (isActiveTab(node.tabId) && windowSpace.get(tab.windowId) !== toSpace.id) {
      await ensureNotActive(node.tabId, tab.windowId);
    }
    if (tab.cookieStoreId !== toSpace.cookieStoreId) await reopenInContainer(node.tabId, toSpace.cookieStoreId);
  }
  await applyVisibilityAll();
}
