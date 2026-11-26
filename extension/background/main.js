// Background entry point: startup, listener wiring and the sidebar connection.

import {
  state, loadState, reindex, link, getSpace, getEntry, entryByTab, tabIndex, makeTabNode, makeSpace,
  spaceTabNodes, scheduleSave,
} from './store.js';
import { enqueue, fire, setAfterTask } from './queue.js';
import {
  windowSpace, activeTab, liveTabs, runtime, refreshContainers, storeExists, setWindowSpace,
  ensureWindow, applyVisibility, applyTheme, applyThemeAll, onDarkChange, openableUrl,
} from './ops.js';
import * as ev from './events.js';
import { commands } from './commands.js';
import { addPort, post, scheduleBroadcast, buildView } from './view.js';
import { runExpiry } from './archive.js';
import { scheduleBackup, noteLocalChange, watchBookmarks, hasBookmarkAccess } from './backup.js';
import { restoreShortcuts, watchShortcuts } from './shortcuts.js';
import { DEFAULT_STORE, SPACE_COLORS } from '../shared/constants.js';

setAfterTask((label) => {
  scheduleSave();
  scheduleBroadcast();
  // The sync's own changes to the model are written in the same run; counting them as
  // local edits would make every sync schedule another.
  if (label !== 'profileSync') {
    noteLocalChange();
    scheduleBackup();
  }
});

// First run: one "Personal" space for default-container tabs, plus a space for each
// container that already has open tabs.
function seed(windows) {
  state.spaces = [];
  const personal = makeSpace({ name: 'Personal', emoji: '🏠', color: SPACE_COLORS[0], cookieStoreId: DEFAULT_STORE });
  state.spaces.push(personal);
  const byStore = new Map([[DEFAULT_STORE, personal]]);
  for (const w of windows) {
    for (const t of w.tabs) {
      if (t.pinned) continue;
      let space = byStore.get(t.cookieStoreId);
      if (!space) {
        const c = runtime.containers.find((x) => x.cookieStoreId === t.cookieStoreId);
        if (c) {
          space = makeSpace({ name: c.name, color: c.colorCode, cookieStoreId: c.cookieStoreId });
          state.spaces.push(space);
          byStore.set(c.cookieStoreId, space);
        } else {
          space = personal;
        }
      }
      const node = makeTabNode(t);
      space.temp.push(node);
      link(node, t.id);
    }
  }
  reindex();
  for (const w of windows) {
    const act = entryByTab(activeTab.get(w.id));
    setWindowSpace(w.id, act ? act.space.id : personal.id);
  }
}

async function init() {
  await refreshContainers();
  const restored = await loadState();
  const windows = (await browser.windows.getAll({ populate: true, windowTypes: ['normal'] }))
    .filter((w) => !w.incognito);
  for (const w of windows) {
    for (const t of w.tabs) {
      if (t.pinned) {
        await ev.unpinNative(t.id);
        t.pinned = false;
      }
      liveTabs.set(t.id, t);
      if (t.active) activeTab.set(w.id, t.id);
    }
  }

  if (!restored) {
    seed(windows);
  } else {
    // Tab ids don't survive restarts; re-link through the node id stored on each tab.
    for (const space of state.spaces) {
      if (!storeExists(space.cookieStoreId)) space.cookieStoreId = DEFAULT_STORE;
      for (const n of spaceTabNodes(space)) n.tabId = null;
    }
    reindex();
    const tabs = windows.flatMap((w) => w.tabs).filter((t) => !t.pinned);
    const ids = await Promise.all(tabs.map((t) => browser.sessions.getTabValue(t.id, 'nodeId').catch(() => null)));
    tabs.forEach((t, i) => {
      const entry = ids[i] ? getEntry(ids[i]) : null;
      if (!entry || entry.node.tabId != null) return;
      link(entry.node, t.id);
      if (t.url) entry.node.url = t.url;
      if (t.title) entry.node.title = t.title;
      if (t.favIconUrl) entry.node.favIconUrl = t.favIconUrl;
    });
  }

  for (const w of windows) {
    if (windowSpace.has(w.id)) continue;
    let id = null;
    try { id = await browser.sessions.getWindowValue(w.id, 'spaceId'); } catch { /* none */ }
    if (!getSpace(id)) {
      const act = entryByTab(activeTab.get(w.id));
      id = act ? act.space.id : (getSpace(state.lastSpaceId) ? state.lastSpaceId : state.spaces[0].id);
    }
    setWindowSpace(w.id, id);
  }

  // Anything still unknown joins its window's space as a temporary tab.
  for (const w of windows) {
    for (const t of w.tabs) {
      if (t.pinned || tabIndex.has(t.id)) continue;
      const node = makeTabNode(t);
      getSpace(windowSpace.get(w.id)).temp.push(node);
      link(node, t.id);
    }
  }
  reindex();

  for (const w of windows) {
    const act = entryByTab(activeTab.get(w.id));
    if (act && act.space.id !== windowSpace.get(w.id)) setWindowSpace(w.id, act.space.id);
    await applyVisibility(w.id);
    await applyTheme(w.id);
  }
  const focused = windows.find((w) => w.focused);
  if (focused) state.lastSpaceId = windowSpace.get(focused.id);

  await runExpiry();
  browser.alarms.create('expire', { periodInMinutes: 15 });
}

// ---- Listeners (registered synchronously; they queue up behind init) ----

browser.tabs.onCreated.addListener((tab) => fire(() => ev.onTabCreated(tab), 'onTabCreated'));
browser.tabs.onRemoved.addListener((tabId, info) => fire(() => ev.onTabRemoved(tabId, info), 'onTabRemoved'));
browser.tabs.onActivated.addListener((info) => fire(() => ev.onTabActivated(info), 'onTabActivated'));
browser.tabs.onAttached.addListener((tabId, info) => fire(() => ev.onTabAttached(tabId, info), 'onTabAttached'));
browser.tabs.onMoved.addListener(ev.onTabMoved);
browser.tabs.onUpdated.addListener(
  (tabId, change, tab) => fire(() => ev.onTabUpdated(tabId, change, tab), 'onTabUpdated'),
  { properties: ['audible', 'discarded', 'favIconUrl', 'hidden', 'mutedInfo', 'pinned', 'status', 'title', 'url'] },
);
browser.windows.onCreated.addListener((win) => fire(() => ev.onWindowCreated(win), 'onWindowCreated'));
browser.windows.onRemoved.addListener((windowId) => fire(() => ev.onWindowRemoved(windowId), 'onWindowRemoved'));
browser.windows.onFocusChanged.addListener(ev.onFocusChanged);

if (browser.contextualIdentities?.onCreated) {
  for (const evt of ['onCreated', 'onUpdated', 'onRemoved']) {
    browser.contextualIdentities[evt].addListener(() => fire(ev.onContainersChanged));
  }
}

// This listener blocks every page load, so it must almost never touch the serial queue:
// anything queued ahead of it (a space switch, a container move, an import) would stall
// navigation for up to 2s per request. The common case — a known tab already in its
// space's container — is answered synchronously from in-memory state; only tabs we don't
// recognize, or that really are in the wrong container, take the queued slow path.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || details.incognito) return {};
    if (!openableUrl(details.url) || (details.method && details.method !== 'GET')) return {};
    const entry = entryByTab(details.tabId);
    if (entry) {
      const store = details.cookieStoreId || liveTabs.get(details.tabId)?.cookieStoreId;
      if (store === entry.space.cookieStoreId || !storeExists(entry.space.cookieStoreId)) return {};
    }
    const timeout = new Promise((resolve) => setTimeout(() => resolve({}), 2000));
    return Promise.race([enqueue(() => ev.checkRequest(details), 'checkRequest').catch(() => ({})), timeout]);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking'],
);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'expire') {
    fire(runExpiry, 'runExpiry');
    scheduleBackup(0); // also catch changes from other computers that came in quietly
  }
});

browser.commands.onCommand.addListener((name) => {
  fire(async () => {
    const win = await browser.windows.getLastFocused();
    if (!(await ensureWindow(win.id))) return;
    if (name === 'next-space') await commands.cycleSpace({ dir: 1 }, { windowId: win.id });
    if (name === 'previous-space') await commands.cycleSpace({ dir: -1 }, { windowId: win.id });
  }, name);
});

// The quick-switcher popup only runs searches and jumps; it doesn't get state pushes.
const POPUP_COMMANDS = new Set(['quickSearch', 'switchSpace', 'revealFolder', 'activateNode', 'restoreArchive']);

browser.runtime.onConnect.addListener((port) => {
  const match = /^(sidebar|popup):(\d+)$/.exec(port.name);
  if (!match) return;
  const isSidebar = match[1] === 'sidebar';
  const windowId = Number(match[2]);
  if (isSidebar) addPort(windowId, port);
  port.onMessage.addListener((msg) => {
    if (msg?.type !== 'cmd') return;
    const fn = (isSidebar || POPUP_COMMANDS.has(msg.name)) ? commands[msg.name] : null;
    if (!fn) {
      post(port, { type: 'reply', id: msg.id, error: `Unknown command: ${msg.name}` });
      return;
    }
    enqueue(async () => {
      await ensureWindow(windowId);
      return fn(msg.args || {}, { windowId });
    }, msg.name).then(
      (result) => post(port, { type: 'reply', id: msg.id, result }),
      (err) => post(port, { type: 'reply', id: msg.id, error: String(err?.message || err) }),
    );
  });
  if (!isSidebar) return;
  fire(async () => {
    await ensureWindow(windowId);
    post(port, { type: 'state', state: buildView(windowId) });
  });
});

// The migration wizard runs in a tab, not a sidebar, so it talks over runtime messages.
// Only the import command is exposed this way; everything else needs a sidebar's windowId.
browser.runtime.onMessage?.addListener((msg) => {
  if (msg?.type !== 'cmd' || msg.name !== 'importArcSpaces') return undefined;
  return enqueue(() => commands.importArcSpaces(msg.args || {}, {}), 'importArcSpaces');
});

// "Save to Firefox profile" depends on the optional bookmarks permission; if the user
// takes it away in about:addons, stop trying to save.
browser.permissions?.onAdded?.addListener(({ permissions = [] }) => {
  if (permissions.includes('bookmarks')) watchBookmarks();
});
hasBookmarkAccess().then((ok) => ok && watchBookmarks());
browser.permissions?.onRemoved?.addListener(({ permissions = [] }) => {
  if (permissions.includes('bookmarks')) {
    fire(() => {
      state.settings.profileBackup = false;
    }, 'bookmarksRevoked');
  }
});

watchShortcuts();
restoreShortcuts();

onDarkChange(() => fire(applyThemeAll));

fire(init);
