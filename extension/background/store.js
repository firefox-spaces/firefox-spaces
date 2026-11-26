// Persistent model: spaces, their tab/folder trees, the archive and settings.
//
// A space:  { id, name, emoji, color, cookieStoreId, pinned: Node[], temp: Node[], lastActiveNodeId }
// A tab:    { type: 'tab', id, url, title, favIconUrl, customTitle?, pinnedUrl?, pinnedTitle?,
//             lastActive, createdAt, tabId }   (tabId = live Firefox tab, or null when unloaded)
// A folder: { type: 'folder', id, title, collapsed, children: Node[] }   (pinned section only)

import { DEFAULT_SETTINGS, DEFAULT_STORE, SPACE_COLORS } from '../shared/constants.js';

export const uid = (prefix = 'n') =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

export const state = {
  spaces: [],
  archive: [],
  settings: { ...DEFAULT_SETTINGS },
  lastSpaceId: null,
  // Profile backup (backup.js): which install wrote the bookmark copy, model key ->
  // bookmark id for the mirrored tree, and the last run's outcome for the sidebar.
  deviceId: uid('d'),
  backupIds: {},
  backupStatus: null,
  syncAt: {},        // model key -> when it last changed, for "most recent edit wins"
  settingsAt: 0,     // when expiry/retention/tint last changed here
  localEditAt: 0,    // when anything last changed here
};

// nodeId -> { node, space, list, parent, section }
export const nodeIndex = new Map();
// live tabId -> nodeId
export const tabIndex = new Map();

export async function loadState() {
  const { state: saved } = await browser.storage.local.get('state');
  if (!saved || saved.version !== 1 || !Array.isArray(saved.spaces) || !saved.spaces.length) return false;
  state.spaces = saved.spaces;
  state.archive = saved.archive || [];
  state.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  state.lastSpaceId = saved.lastSpaceId || null;
  if (saved.deviceId) state.deviceId = saved.deviceId;
  state.backupIds = saved.backupIds || {};
  state.backupStatus = saved.backupStatus ? { ...saved.backupStatus, running: false } : null;
  state.syncAt = saved.syncAt || {};
  state.settingsAt = saved.settingsAt || 0;
  state.localEditAt = saved.localEditAt || 0;
  return true;
}

let saveTimer = null;
export function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 1000);
}
export async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await browser.storage.local.set({ state: { version: 1, ...state } });
  } catch (err) {
    console.error('[Spaces] save failed', err);
  }
}

export function reindex() {
  nodeIndex.clear();
  tabIndex.clear();
  for (const space of state.spaces) {
    const walk = (list, parent, section) => {
      for (const node of list) {
        nodeIndex.set(node.id, { node, space, list, parent, section });
        if (node.type === 'folder') walk(node.children, node, section);
        else if (node.tabId != null) tabIndex.set(node.tabId, node.id);
      }
    };
    walk(space.pinned, null, 'pinned');
    walk(space.temp, null, 'temp');
  }
}

export const getSpace = (id) => state.spaces.find((s) => s.id === id);
export const getEntry = (id) => nodeIndex.get(id);
export function entryByTab(tabId) {
  const id = tabIndex.get(tabId);
  return id ? nodeIndex.get(id) : undefined;
}

export function link(node, tabId) {
  if (node.tabId != null) tabIndex.delete(node.tabId);
  node.tabId = tabId;
  if (tabId != null) {
    tabIndex.set(tabId, node.id);
    // Survives browser restarts with session restore, so we can re-link tabs to nodes.
    browser.sessions.setTabValue(tabId, 'nodeId', node.id).catch(() => {});
  }
}

export function unlink(node) {
  if (node.tabId != null) tabIndex.delete(node.tabId);
  node.tabId = null;
}

export function detachNode(id) {
  const entry = nodeIndex.get(id);
  if (!entry) return null;
  entry.list.splice(entry.list.indexOf(entry.node), 1);
  reindex();
  return entry;
}

export function listFor(space, section, parentId) {
  if (section === 'pinned' && parentId) {
    const parent = nodeIndex.get(parentId);
    if (parent && parent.node.type === 'folder' && parent.space === space) return parent.node.children;
  }
  return section === 'pinned' ? space.pinned : space.temp;
}

export function insertNode(node, space, section, parentId, index) {
  const list = listFor(space, section, parentId);
  if (index == null || index < 0 || index > list.length) index = list.length;
  list.splice(index, 0, node);
  reindex();
}

// Un-collapse every folder above a node, so the node is visible in the sidebar.
export function expandAncestors(nodeId) {
  for (let e = nodeIndex.get(nodeId); e?.parent; e = nodeIndex.get(e.parent.id)) {
    e.parent.collapsed = false;
  }
}

export function tabNodesIn(list, out = []) {
  for (const n of list) {
    if (n.type === 'folder') tabNodesIn(n.children, out);
    else out.push(n);
  }
  return out;
}

export function spaceTabNodes(space) {
  return tabNodesIn(space.temp, tabNodesIn(space.pinned));
}

export function makeTabNode(tab = {}) {
  const now = Date.now();
  return {
    type: 'tab',
    id: uid(),
    url: tab.url || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    lastActive: now,
    createdAt: now,
    tabId: null,
  };
}

export function makeFolder(title = 'New Folder') {
  return { type: 'folder', id: uid('f'), title, collapsed: false, children: [] };
}

export function makeSpace({ name, emoji, color, cookieStoreId } = {}) {
  return {
    id: uid('s'),
    name: name || 'New Space',
    emoji: emoji || '',
    color: color || SPACE_COLORS[state.spaces.length % SPACE_COLORS.length],
    cookieStoreId: cookieStoreId || DEFAULT_STORE,
    pinned: [],
    temp: [],
    lastActiveNodeId: null,
  };
}
