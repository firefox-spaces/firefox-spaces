// A small in-memory imitation of the Firefox WebExtension APIs the background page uses,
// good enough to drive the real background code through scenarios in Node.

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    emit(...args) { for (const fn of [...listeners]) setTimeout(() => fn(...args), 0); },
    call(...args) { return listeners.map((fn) => fn(...args)); },
  };
}

export function createFakeBrowser(snapshot = null) {
  let nextTabId = 100;
  let nextWindowId = 10;
  const tabs = new Map();          // id -> tab
  const windows = new Map();       // id -> { id, type, focused, incognito }
  const tabValues = new Map();     // id -> {}
  const windowValues = new Map();  // id -> {}
  let storage = {};
  let containers = [{ cookieStoreId: 'firefox-container-1', name: 'Work', color: 'blue', colorCode: '#37adff', icon: 'briefcase' }];
  let nextContainer = 2;
  const themes = new Map();
  const log = [];

  const ev = {
    tabs: Object.fromEntries(['onCreated', 'onRemoved', 'onActivated', 'onUpdated', 'onAttached', 'onDetached', 'onMoved'].map((k) => [k, makeEvent()])),
    windows: Object.fromEntries(['onCreated', 'onRemoved', 'onFocusChanged'].map((k) => [k, makeEvent()])),
    ci: Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved'].map((k) => [k, makeEvent()])),
  };
  const webRequestBefore = makeEvent();
  const alarmEvent = makeEvent();
  const commandEvent = makeEvent();
  const connectEvent = makeEvent();
  const messageEvent = makeEvent();

  const clone = (t) => structuredClone(t);
  const windowTabs = (wid) => [...tabs.values()].filter((t) => t.windowId === wid).sort((a, b) => a.index - b.index);
  const reindexWindow = (wid) => windowTabs(wid).forEach((t, i) => { t.index = i; });
  const pinnedFirst = (wid) => {
    const list = windowTabs(wid);
    const sorted = [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)];
    sorted.forEach((t, i) => { t.index = i; });
  };

  function makeTab(props) {
    const id = nextTabId++;
    const wid = props.windowId ?? [...windows.keys()][0];
    const list = windowTabs(wid);
    const url = props.url || 'about:newtab';
    const tab = {
      id, windowId: wid, index: props.index ?? list.length, url, title: props.title || (url === 'about:newtab' ? 'New Tab' : url),
      favIconUrl: '', active: false, hidden: false, pinned: !!props.pinned, discarded: false, status: 'complete',
      audible: false, mutedInfo: { muted: false }, cookieStoreId: props.cookieStoreId || 'firefox-default',
      incognito: false, openerTabId: props.openerTabId,
    };
    for (const t of list) if (t.index >= tab.index) t.index++;
    tabs.set(id, tab);
    reindexWindow(wid);
    return tab;
  }

  function activate(tab) {
    const prev = windowTabs(tab.windowId).find((t) => t.active);
    if (prev?.id === tab.id) return;
    if (prev) prev.active = false;
    tab.active = true;
    if (tab.hidden) { tab.hidden = false; ev.tabs.onUpdated.emit(tab.id, { hidden: false }, clone(tab)); }
    ev.tabs.onActivated.emit({ tabId: tab.id, previousTabId: prev?.id, windowId: tab.windowId });
  }

  function removeTab(id, isWindowClosing = false) {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`Invalid tab ID: ${id}`);
    const wasActive = tab.active;
    tabs.delete(id);
    reindexWindow(tab.windowId);
    ev.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing });
    if (wasActive && !isWindowClosing) {
      const rest = windowTabs(tab.windowId);
      // Firefox prefers a visible neighbor, falling back to a hidden tab.
      const next = rest.find((t) => !t.hidden && t.index >= tab.index) || [...rest].reverse().find((t) => !t.hidden) || rest[0];
      if (next) activate(next);
    }
  }

  function addWindow({ type = 'normal', focused = true, incognito = false, id } = {}) {
    const wid = id ?? nextWindowId++;
    if (focused) for (const w of windows.values()) w.focused = false;
    windows.set(wid, { id: wid, type, focused, incognito });
    return wid;
  }

  // ---- bookmarks: id -> { id, parentId, title, url?, type, children?: id[] } ----
  const bms = new Map();
  let nextBm = 1;
  const bmOps = { create: 0, update: 0, move: 0, remove: 0 };
  const granted = new Set();
  const permAdded = makeEvent();
  const permRemoved = makeEvent();
  for (const [id, parentId] of [['root________', null], ['menu________', 'root________'],
    ['toolbar_____', 'root________'], ['unfiled_____', 'root________']]) {
    bms.set(id, { id, parentId, title: id.replace(/_+$/, ''), type: 'folder', children: [] });
    if (parentId) bms.get(parentId).children.push(id);
  }
  const bmNode = (id, deep) => {
    const b = bms.get(id);
    const out = { id, parentId: b.parentId ?? undefined, title: b.title, type: b.type,
      index: b.parentId ? bms.get(b.parentId).children.indexOf(id) : 0 };
    if (b.url) out.url = b.url;
    if (b.type === 'folder' && deep) out.children = b.children.map((c) => bmNode(c, true));
    return out;
  };
  const bmGet = (id) => {
    const b = bms.get(id);
    if (!b) throw new Error(`Bookmark not found: ${id}`);
    return b;
  };
  const insertAt = (list, id, index) => {
    const i = index == null || index < 0 || index > list.length ? list.length : index;
    list.splice(i, 0, id);
  };
  const bmDropTree = (id) => {
    const b = bms.get(id);
    for (const c of b.children || []) bmDropTree(c);
    bms.delete(id);
  };
  const bookmarksApi = {
    async getSubTree(id) { bmGet(id); return [bmNode(id, true)]; },
    async getChildren(id) { return bmGet(id).children.map((c) => bmNode(c, false)); },
    async get(id) { return [].concat(id).map((x) => { bmGet(x); return bmNode(x, false); }); },
    async create({ parentId = 'unfiled_____', index, title = '', url }) {
      const parent = bmGet(parentId);
      if (parent.type !== 'folder') throw new Error('Parent is not a folder');
      if (url && !/^https?:/i.test(url)) throw new Error(`Invalid url: ${url}`);
      const id = `bm${nextBm++}`;
      bms.set(id, { id, parentId, title, type: url ? 'bookmark' : 'folder', ...(url ? { url } : { children: [] }) });
      insertAt(parent.children, id, index);
      bmOps.create++;
      return bmNode(id, false);
    },
    async update(id, changes) {
      const b = bmGet(id);
      if (changes.title != null) b.title = changes.title;
      if (changes.url != null) b.url = changes.url;
      bmOps.update++;
      return bmNode(id, false);
    },
    async move(id, { parentId, index }) {
      const b = bmGet(id);
      const from = bmGet(b.parentId).children;
      from.splice(from.indexOf(id), 1);
      b.parentId = parentId ?? b.parentId;
      insertAt(bmGet(b.parentId).children, id, index);
      bmOps.move++;
      return bmNode(id, false);
    },
    async remove(id) {
      const b = bmGet(id);
      if (b.children?.length) throw new Error('Folder is not empty');
      const from = bmGet(b.parentId).children;
      from.splice(from.indexOf(id), 1);
      bms.delete(id);
      bmOps.remove++;
    },
    async removeTree(id) {
      const b = bmGet(id);
      const from = bmGet(b.parentId).children;
      from.splice(from.indexOf(id), 1);
      bmDropTree(id);
      bmOps.remove++;
    },
    async search(q) {
      const query = String(typeof q === 'string' ? q : q.query || '').toLowerCase();
      return [...bms.values()]
        .filter((b) => b.parentId && (b.title.toLowerCase().includes(query) || (b.url || '').toLowerCase().includes(query)))
        .map((b) => bmNode(b.id, false));
    },
  };

  if (snapshot?.bookmarks) {
    bms.clear();
    for (const b of snapshot.bookmarks.items) bms.set(b.id, structuredClone(b));
    nextBm = snapshot.bookmarks.nextBm;
  }

  if (snapshot?.windows) {
    for (const w of snapshot.windows) windows.set(w.id, { ...w });
    for (const t of snapshot.tabs) tabs.set(t.id, { ...t });
    for (const [k, v] of snapshot.tabValues) tabValues.set(k, v);
    for (const [k, v] of snapshot.windowValues) windowValues.set(k, v);
    storage = snapshot.storage;
    containers = snapshot.containers;
    nextTabId = snapshot.nextTabId;
    nextWindowId = snapshot.nextWindowId;
  }

  const browser = {
    tabs: {
      ...ev.tabs,
      async query(q = {}) {
        let list = [...tabs.values()];
        if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        if (q.active != null) list = list.filter((t) => t.active === q.active);
        if (q.hidden != null) list = list.filter((t) => t.hidden === q.hidden);
        return list.sort((a, b) => a.windowId - b.windowId || a.index - b.index).map(clone);
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        return clone(t);
      },
      async create(props = {}) {
        if (props.url && /^(about:(?!blank)|chrome:|file:)/.test(props.url)) throw new Error(`Illegal URL: ${props.url}`);
        if (props.cookieStoreId && props.cookieStoreId !== 'firefox-default' && !containers.some((c) => c.cookieStoreId === props.cookieStoreId)) {
          throw new Error(`No cookie store exists with ID ${props.cookieStoreId}`);
        }
        const tab = makeTab(props);
        log.push(['create', tab.id, tab.cookieStoreId, tab.url]);
        ev.tabs.onCreated.emit(clone(tab));
        if (props.active !== false) activate(tab);
        return clone(tab);
      },
      async update(id, props) {
        const t = tabs.get(id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        if (props.active) activate(t);
        if (props.url) { t.url = props.url; t.title = props.url; ev.tabs.onUpdated.emit(id, { url: props.url }, clone(t)); }
        if (props.pinned != null && props.pinned !== t.pinned) {
          t.pinned = props.pinned;
          if (t.pinned) t.hidden = false;
          pinnedFirst(t.windowId);
          ev.tabs.onUpdated.emit(id, { pinned: t.pinned }, clone(t));
        }
        if (props.muted != null) { t.mutedInfo = { muted: props.muted }; ev.tabs.onUpdated.emit(id, { mutedInfo: t.mutedInfo }, clone(t)); }
        return clone(t);
      },
      async remove(ids) {
        for (const id of [].concat(ids)) removeTab(id);
      },
      async move(ids, { windowId, index }) {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (!t) throw new Error(`Invalid tab ID: ${id}`);
          const from = t.windowId;
          if (windowId != null && windowId !== from) {
            const wasActive = t.active;
            t.active = false;
            ev.tabs.onDetached.emit(id, { oldWindowId: from, oldPosition: t.index });
            t.windowId = windowId;
            t.index = 1e6;
            reindexWindow(from);
            reindexWindow(windowId);
            ev.tabs.onAttached.emit(id, { newWindowId: windowId, newPosition: t.index });
            if (wasActive) {
              const next = windowTabs(from).find((x) => !x.hidden);
              if (next) activate(next);
            }
          } else {
            t.index = index === -1 ? 1e6 : index - 0.5;
            reindexWindow(from);
            ev.tabs.onMoved.emit(id, { windowId: from, toIndex: t.index });
          }
        }
      },
      async hide(ids) {
        const done = [];
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (!t || t.active || t.pinned || t.hidden) continue;
          t.hidden = true;
          done.push(id);
          ev.tabs.onUpdated.emit(id, { hidden: true }, clone(t));
        }
        return done;
      },
      async show(ids) {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (!t || !t.hidden) continue;
          t.hidden = false;
          ev.tabs.onUpdated.emit(id, { hidden: false }, clone(t));
        }
      },
      async discard(ids) {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (t && !t.active) { t.discarded = true; ev.tabs.onUpdated.emit(id, { discarded: true }, clone(t)); }
        }
      },
    },
    windows: {
      ...ev.windows,
      WINDOW_ID_NONE: -1,
      async getAll({ populate } = {}) {
        return [...windows.values()].map((w) => ({ ...w, tabs: populate ? windowTabs(w.id).map(clone) : undefined }));
      },
      async get(id) {
        const w = windows.get(id);
        if (!w) throw new Error(`Invalid window ID: ${id}`);
        return { ...w };
      },
      async getLastFocused() {
        return { ...[...windows.values()].find((w) => w.focused) };
      },
    },
    sessions: {
      async setTabValue(id, k, v) { if (!tabs.has(id)) throw new Error('bad tab'); tabValues.set(id, { ...tabValues.get(id), [k]: v }); },
      async getTabValue(id, k) { return tabValues.get(id)?.[k]; },
      async setWindowValue(id, k, v) { windowValues.set(id, { ...windowValues.get(id), [k]: v }); },
      async getWindowValue(id, k) { return windowValues.get(id)?.[k]; },
    },
    storage: {
      local: {
        async get(key) { return key in storage ? { [key]: structuredClone(storage[key]) } : {}; },
        async set(obj) { for (const [k, v] of Object.entries(obj)) storage[k] = structuredClone(v); },
      },
    },
    contextualIdentities: {
      ...ev.ci,
      async query() { return containers.map((c) => ({ ...c })); },
      async create({ name, color, icon }) {
        const c = { cookieStoreId: `firefox-container-${nextContainer++}`, name, color, colorCode: '#000', icon };
        containers.push(c);
        ev.ci.onCreated.emit({ contextualIdentity: c });
        return { ...c };
      },
      async update(id, details) {
        const c = containers.find((x) => x.cookieStoreId === id);
        Object.assign(c, details);
        ev.ci.onUpdated.emit({ contextualIdentity: c });
        return { ...c };
      },
      async remove(id) {
        containers = containers.filter((x) => x.cookieStoreId !== id);
        for (const t of [...tabs.values()]) if (t.cookieStoreId === id) removeTab(t.id);
        ev.ci.onRemoved.emit({ contextualIdentity: { cookieStoreId: id } });
      },
    },
    alarms: {
      onAlarm: alarmEvent,
      create() {},
    },
    theme: {
      async update(windowId, theme) { themes.set(windowId, theme); },
      async reset(windowId) { themes.delete(windowId); },
    },
    webRequest: { onBeforeRequest: webRequestBefore },
    commands: { onCommand: commandEvent },
    runtime: { onConnect: connectEvent, onMessage: messageEvent },
    bookmarks: bookmarksApi,
    permissions: {
      onAdded: permAdded,
      onRemoved: permRemoved,
      async contains({ permissions = [] }) { return permissions.every((p) => granted.has(p)); },
      async request({ permissions = [] }) { for (const p of permissions) granted.add(p); return true; },
    },
  };

  // ---- test helpers ----
  const helpers = {
    tabs, windows, log, themes, bmOps,
    grant(p) { granted.add(p); permAdded.emit({ permissions: [p], origins: [] }); },
    revoke(p) { granted.delete(p); permRemoved.emit({ permissions: [p], origins: [] }); },
    bookmarkTree(id = 'root________') { return bmNode(id, true); },
    bookmarkSnapshot() { return { items: [...bms.values()].map((b) => structuredClone(b)), nextBm }; },
    get storage() { return storage; },
    addWindow,
    openTab(props) {
      const tab = makeTab(props);
      ev.tabs.onCreated.emit(clone(tab));
      if (props.active !== false) activate(tab);
      return tab;
    },
    seedTab(props) { const t = makeTab(props); if (props.active) t.active = true; return t; },
    userActivate(id) { activate(tabs.get(id)); },
    userClose(id) { removeTab(id); },
    navigate(id, url, title = url) {
      const t = tabs.get(id);
      t.url = url;
      t.title = title;
      ev.tabs.onUpdated.emit(id, { url, title }, clone(t));
    },
    closeWindow(wid) {
      for (const t of windowTabs(wid)) removeTab(t.id, true);
      windows.delete(wid);
      ev.windows.onRemoved.emit(wid);
    },
    async request(tabId, url, method = 'GET') {
      const t = tabs.get(tabId);
      const results = webRequestBefore.call({ tabId, url, method, type: 'main_frame', cookieStoreId: t?.cookieStoreId, incognito: false });
      return Promise.all(results);
    },
    fireAlarm(name) { alarmEvent.emit({ name }); },
    // Like a page calling browser.runtime.sendMessage: the first listener to answer wins.
    async sendMessage(msg) {
      for (const r of messageEvent.call(structuredClone(msg), {})) {
        if (r !== undefined) return r;
      }
      return undefined;
    },
    connectSidebar(windowId) {
      const messages = [];
      const msgListeners = [];
      const port = {
        name: `sidebar:${windowId}`,
        postMessage(m) { messages.push(structuredClone(m)); },
        onMessage: { addListener(fn) { msgListeners.push(fn); } },
        onDisconnect: { addListener() {} },
      };
      connectEvent.call(port);
      let id = 0;
      return {
        messages,
        lastState() { return [...messages].reverse().find((m) => m.type === 'state')?.state; },
        async cmd(name, args = {}) {
          const myId = ++id + 1000 * Math.random();
          for (const fn of msgListeners) fn({ type: 'cmd', id: myId, name, args });
          for (let i = 0; i < 400; i++) {
            const reply = messages.find((m) => m.type === 'reply' && m.id === myId);
            if (reply) { if (reply.error) throw new Error(reply.error); return reply.result; }
            await tick();
          }
          throw new Error(`timeout waiting for ${name}`);
        },
      };
    },
    snapshot() {
      return {
        windows: [...windows.values()], tabs: [...tabs.values()], tabValues: [...tabValues], windowValues: [...windowValues],
        storage, containers, nextTabId, nextWindowId,
      };
    },
  };
  return { browser, helpers };
}

export async function settle(ms = 400) {
  // Let events, the serial queue and debounced timers drain.
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
