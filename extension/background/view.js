// Builds the per-window view model the sidebar renders, and pushes it to open sidebars.

import { state, getSpace } from './store.js';
import { windowSpace, activeTab, liveTabs, runtime } from './ops.js';
import { DEFAULT_STORE } from '../shared/constants.js';

const ports = new Map(); // windowId -> Set<Port>

export function addPort(windowId, port) {
  if (!ports.has(windowId)) ports.set(windowId, new Set());
  ports.get(windowId).add(port);
  port.onDisconnect.addListener(() => ports.get(windowId)?.delete(port));
}

export function post(port, msg) {
  try { port.postMessage(msg); } catch { /* sidebar closed */ }
}

let timer = null;
export function scheduleBroadcast() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    broadcast();
  }, 40);
}

export function broadcast() {
  for (const [windowId, set] of ports) {
    if (!set.size) continue;
    const view = buildView(windowId);
    for (const port of set) post(port, { type: 'state', state: view });
  }
}

export function profilesView() {
  return [
    { cookieStoreId: DEFAULT_STORE, name: 'Default', color: 'toolbar', colorCode: '#8f8f9d', icon: 'circle', isDefault: true },
    ...runtime.containers.map((c) => ({
      cookieStoreId: c.cookieStoreId, name: c.name, color: c.color, colorCode: c.colorCode, icon: c.icon,
    })),
  ];
}

const normalize = (u) => String(u || '').replace(/#.*$/, '').replace(/\/$/, '');

export function buildView(windowId) {
  const space = getSpace(windowSpace.get(windowId)) || state.spaces[0];
  const activeTabId = activeTab.get(windowId);

  const viewNode = (n) => {
    if (n.type === 'folder') {
      return { type: 'folder', id: n.id, title: n.title, collapsed: !!n.collapsed, children: n.children.map(viewNode) };
    }
    const live = n.tabId != null ? liveTabs.get(n.tabId) : null;
    return {
      type: 'tab',
      id: n.id,
      title: n.customTitle || live?.title || n.title || n.url || 'New Tab',
      url: live?.url || n.url,
      favIconUrl: live?.favIconUrl || n.favIconUrl || '',
      open: !!live,
      discarded: !!live?.discarded,
      active: !!live && n.tabId === activeTabId,
      elsewhere: !!live && live.windowId !== windowId,
      loading: live?.status === 'loading',
      audible: !!live?.audible,
      muted: !!live?.mutedInfo?.muted,
      renamed: !!n.customTitle,
      pinnedUrl: n.pinnedUrl || null,
      drifted: !!(n.pinnedUrl && live && normalize(live.url) !== normalize(n.pinnedUrl)),
    };
  };

  return {
    windowId,
    spaces: state.spaces.map((s) => ({
      id: s.id, name: s.name, emoji: s.emoji, color: s.color, cookieStoreId: s.cookieStoreId,
    })),
    space: space && {
      id: space.id,
      name: space.name,
      emoji: space.emoji,
      color: space.color,
      cookieStoreId: space.cookieStoreId,
      pinned: space.pinned.map(viewNode),
      temp: space.temp.map(viewNode),
    },
    profiles: profilesView(),
    settings: state.settings,
    backup: state.backupStatus,
    archiveCount: state.archive.length,
  };
}
