// Browser event handlers. All of them run inside the serial queue (see main.js).

import {
  state, getSpace, getEntry, entryByTab, tabIndex, link, unlink, detachNode, insertNode, makeTabNode,
  expandAncestors,
} from './store.js';
import {
  windowSpace, activeTab, liveTabs, expectedRemovals, ignoredWindows, ensureWindow,
  guardedReopen, isNewTabUrl, switchSpace, newTabInSpace, applyVisibility, applyTheme, scheduleOrderSync,
  openableUrl, storeExists, refreshContainers,
} from './ops.js';
import { DEFAULT_STORE } from '../shared/constants.js';

// Firefox's own pinned tabs live in the native tab strip, which userChrome.css hides, so
// they would be unreachable. Turn them back into ordinary tabs; they then join a space.
export async function unpinNative(tabId) {
  await browser.tabs.update(tabId, { pinned: false }).catch(() => {});
}

export function resetPinnedNode(node) {
  if (!node.pinnedUrl) return;
  node.url = node.pinnedUrl;
  if (node.pinnedTitle) node.title = node.pinnedTitle;
}

export async function onTabCreated(tab) {
  if (tab.incognito) return;
  const spaceId = await ensureWindow(tab.windowId);
  if (!spaceId) return;
  liveTabs.set(tab.id, tab);
  if (tab.pinned) {
    // The resulting onUpdated({ pinned: false }) adds it to the space.
    await unpinNative(tab.id);
    return;
  }
  if (tabIndex.has(tab.id)) return; // a tab we opened ourselves

  // A tab restored by session restore (or "reopen closed window") carries its node id.
  let nodeId = null;
  try { nodeId = await browser.sessions.getTabValue(tab.id, 'nodeId'); } catch { /* none */ }
  if (nodeId) {
    const entry = getEntry(nodeId);
    // If the node already has a live tab, this is a duplicate: treat it as a brand new tab.
    if (entry && (entry.node.tabId == null || !liveTabs.has(entry.node.tabId))) {
      link(entry.node, tab.id);
      entry.node.lastActive = Date.now();
      if (entry.space.id !== spaceId) await applyVisibility(tab.windowId);
      return;
    }
  }

  const space = getSpace(spaceId);
  const node = makeTabNode(tab);
  const opener = tab.openerTabId != null ? entryByTab(tab.openerTabId) : null;
  if (opener && opener.space.id === space.id && opener.section === 'temp') {
    insertNode(node, space, 'temp', null, opener.list.indexOf(opener.node) + 1);
  } else {
    insertNode(node, space, 'temp', null, 0);
  }
  link(node, tab.id);

  // Ctrl/Cmd+T opens in the default container; move it into the space's profile.
  if (isNewTabUrl(tab.url) && tab.cookieStoreId !== space.cookieStoreId) {
    await guardedReopen(tab.id, space.cookieStoreId, { url: '' });
  }
  scheduleOrderSync(tab.windowId);
}

export function onTabRemoved(tabId, { isWindowClosing }) {
  liveTabs.delete(tabId);
  const entry = entryByTab(tabId);
  if (expectedRemovals.delete(tabId)) {
    if (entry) unlink(entry.node);
    return;
  }
  if (!entry) return;
  if (isWindowClosing) {
    // Closing a window keeps its tabs in the space as unloaded entries, like Arc.
    unlink(entry.node);
  } else if (entry.section === 'pinned') {
    // Closing a pinned tab only unloads it.
    unlink(entry.node);
    resetPinnedNode(entry.node);
  } else {
    detachNode(entry.node.id);
  }
}

export async function onTabActivated({ tabId, previousTabId, windowId }) {
  const spaceId = await ensureWindow(windowId);
  if (!spaceId) return;
  // Events queue behind other work, so by the time this runs another tab may already be
  // active; acting on a stale event would roll activeTab backwards.
  const t = await browser.tabs.get(tabId).catch(() => null);
  if (!t || !t.active) return;
  const now = Date.now();
  activeTab.set(windowId, tabId);
  if (previousTabId != null) {
    const prev = entryByTab(previousTabId);
    if (prev) prev.node.lastActive = now;
  }
  const entry = entryByTab(tabId);
  if (!entry) return;
  entry.node.lastActive = now;
  entry.space.lastActiveNodeId = entry.node.id;
  expandAncestors(entry.node.id); // the active tab must never hide in a collapsed folder
  if (entry.space.id === spaceId) return;

  // A tab from another space came to the front.
  const tabs = await browser.tabs.query({ windowId });
  if (tabs.find((t) => t.active)?.id !== tabId) return; // stale event
  const unpinned = tabs.filter((t) => !t.pinned);
  const spaceStillHasTabs = unpinned.some((t) => t.id !== tabId && entryByTab(t.id)?.space.id === spaceId);
  if (spaceStillHasTabs || unpinned.length === 1) {
    // The user picked it (e.g. from the all-tabs menu), or it's alone in a torn-off window.
    await switchSpace(windowId, entry.space.id, { focusTabId: tabId });
  } else {
    // The space's last tab was closed and Firefox fell back to a hidden tab. Stay put.
    await newTabInSpace(getSpace(spaceId), windowId);
    await applyVisibility(windowId);
  }
}

export async function onTabUpdated(tabId, change, tab) {
  if (tab.incognito) return;
  if (!(await ensureWindow(tab.windowId))) return;
  liveTabs.set(tabId, tab);

  if ('pinned' in change) {
    if (change.pinned) {
      await unpinNative(tabId);
    } else {
      if (!entryByTab(tabId)) {
        const space = getSpace(windowSpace.get(tab.windowId));
        const node = makeTabNode(tab);
        insertNode(node, space, 'temp', null, 0);
        link(node, tabId);
      }
      await applyVisibility(tab.windowId);
      scheduleOrderSync(tab.windowId);
    }
    return;
  }

  const entry = entryByTab(tabId);
  if (!entry) return;
  const node = entry.node;
  if (change.url) node.url = change.url;
  if (change.title) node.title = change.title;
  if (change.favIconUrl) node.favIconUrl = change.favIconUrl;
  if (change.url && isNewTabUrl(change.url) && tab.cookieStoreId !== entry.space.cookieStoreId) {
    await guardedReopen(tabId, entry.space.cookieStoreId, { url: '' });
  }
}

export async function onTabAttached(tabId, { newWindowId }) {
  const spaceId = await ensureWindow(newWindowId);
  if (!spaceId) return;
  let tab;
  try { tab = await browser.tabs.get(tabId); } catch { return; }
  liveTabs.set(tabId, tab);
  if (tab.pinned) return;
  const space = getSpace(spaceId);
  const entry = entryByTab(tabId);
  if (!entry) {
    const node = makeTabNode(tab);
    insertNode(node, space, 'temp', null, 0);
    link(node, tabId);
    return;
  }
  const tabs = await browser.tabs.query({ windowId: newWindowId });
  if (tabs.filter((t) => !t.pinned).length === 1) {
    // Torn off into its own window: that window shows the tab's space.
    if (entry.space.id !== spaceId) await switchSpace(newWindowId, entry.space.id, { focusTabId: tabId });
    return;
  }
  if (entry.space.id !== spaceId) {
    // Dropped into a window showing another space: it joins that space.
    const section = entry.section;
    detachNode(entry.node.id);
    insertNode(entry.node, space, section, null, section === 'temp' ? 0 : null);
    if (tab.cookieStoreId !== space.cookieStoreId) await guardedReopen(tabId, space.cookieStoreId);
  }
  await applyVisibility(newWindowId);
  scheduleOrderSync(newWindowId);
}

export function onTabMoved(tabId, { toIndex }) {
  const t = liveTabs.get(tabId);
  if (t) t.index = toIndex;
}

export async function onWindowCreated(win) {
  if (win.incognito || win.type !== 'normal') {
    ignoredWindows.add(win.id);
    return;
  }
  await ensureWindow(win.id);
  await applyTheme(win.id);
}

export function onWindowRemoved(windowId) {
  windowSpace.delete(windowId);
  activeTab.delete(windowId);
  ignoredWindows.delete(windowId);
}

export function onFocusChanged(windowId) {
  if (windowSpace.has(windowId)) state.lastSpaceId = windowSpace.get(windowId);
}

// Keeps every tab in its space's container: a link opened from another app (or any
// navigation in the wrong container) gets reopened in the right one.
export async function checkRequest(d) {
  if (d.tabId < 0 || d.incognito) return {};
  if (!openableUrl(d.url)) return {};
  if (d.method && d.method !== 'GET') return {}; // never drop form submissions
  let tab = liveTabs.get(d.tabId);
  if (!tab) {
    try { tab = await browser.tabs.get(d.tabId); } catch { return {}; }
  }
  if (tab.pinned) return {};
  const spaceId = await ensureWindow(tab.windowId);
  if (!spaceId) return {};
  const entry = entryByTab(d.tabId);
  if (!entry) {
    let nodeId = null;
    try { nodeId = await browser.sessions.getTabValue(d.tabId, 'nodeId'); } catch { /* none */ }
    if (nodeId && getEntry(nodeId)) return {}; // restored tab that hasn't been re-linked yet
  }
  const space = entry ? entry.space : getSpace(spaceId);
  const store = d.cookieStoreId || tab.cookieStoreId;
  if (!space || store === space.cookieStoreId || !storeExists(space.cookieStoreId)) return {};
  // When the reopen budget is exhausted (another extension fighting over containers),
  // let the request proceed in the wrong container rather than loop or break loading.
  const moved = await guardedReopen(d.tabId, space.cookieStoreId, { url: d.url });
  return moved ? { cancel: true } : {};
}

export async function onContainersChanged() {
  await refreshContainers();
  for (const space of state.spaces) {
    if (!storeExists(space.cookieStoreId)) space.cookieStoreId = DEFAULT_STORE;
  }
}
