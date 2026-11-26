// Commands sent from the sidebar. Each runs in the serial queue with { windowId } of the
// sidebar that sent it, and may return a value to the sidebar.

import {
  state, getSpace, getEntry, unlink, detachNode, insertNode, listFor, reindex, makeTabNode,
  makeFolder, makeSpace, spaceTabNodes, tabNodesIn, expandAncestors,
} from './store.js';
import {
  windowSpace, activeTab, liveTabs, expectedRemovals, refreshContainers, storeExists, isActiveTab, runtime,
  switchSpace, openTabForNode, newTabInSpace, reopenInContainer, ensureNotActive, applyVisibilityAll,
  applyTheme, applyThemeAll, scheduleOrderSync, relocate,
} from './ops.js';
import { archiveNode, runExpiry } from './archive.js';
import { UserError } from './queue.js';
import { resetPinnedNode } from './events.js';
import { scheduleBackup, hasBookmarkAccess, readBackup, adoptBookmarks } from './backup.js';
import { CONTAINER_COLORS, CONTAINER_ICONS, DEFAULT_STORE } from '../shared/constants.js';

function tabEntry(nodeId) {
  const entry = getEntry(nodeId);
  if (!entry || entry.node.type !== 'tab') throw new UserError('That tab no longer exists.');
  return entry;
}

async function createProfile({ name, color = 'blue', icon = 'circle' } = {}) {
  if (!name || !name.trim()) throw new UserError('A profile needs a name.');
  if (!(color in CONTAINER_COLORS)) color = 'blue';
  if (!CONTAINER_ICONS.includes(icon)) icon = 'circle';
  const identity = await browser.contextualIdentities.create({ name: name.trim(), color, icon });
  await refreshContainers();
  return identity.cookieStoreId;
}

async function resolveProfile(profile) {
  if (!profile) return DEFAULT_STORE;
  if (profile.create) return createProfile(profile.create);
  return storeExists(profile.cookieStoreId) ? profile.cookieStoreId : DEFAULT_STORE;
}


// Creates spaces from import specs (the Arc wizard, or a profile-backup restore). Tabs
// arrive as unloaded nodes (tabId null) that open lazily when clicked.
// Each spec's profile says where its logins live: null for the Default profile,
// { cookieStoreId } for an existing container the user picked, or { name, color?, icon? }
// to match an existing container by name (case-insensitive) and create one if there's no
// match — so Arc's "Work" lands in a "Work" profile here, and spaces that shared a profile
// share the container.
// merge: a spec whose name matches an existing space fills that space in if it's empty
// (no pinned tabs, no real temporary tabs) and is skipped otherwise.
// Spec items may carry `ref` (an outside id, e.g. a bookmark id); the result maps each
// new model key to its ref.
async function addSpaces(specs, { merge = false } = {}) {
  if (!Array.isArray(specs) || !specs.length) throw new UserError('Nothing to import.');
  const clean = (v) => String(v || '').slice(0, 500);
  const refs = {};
  let tabCount = 0;

  const toTab = (raw, pinned) => {
    if (!raw || raw.type !== 'tab' || !/^https?:\/\//i.test(String(raw.url || ''))) return null;
    const node = makeTabNode({ url: String(raw.url).slice(0, 8000), title: clean(raw.title) });
    if (clean(raw.customTitle)) node.customTitle = clean(raw.customTitle);
    if (pinned) {
      node.pinnedUrl = node.url;
      node.pinnedTitle = node.title;
    }
    if (raw.ref) refs[node.id] = String(raw.ref);
    tabCount++;
    return node;
  };
  const toPinned = (raw, depth = 0) => {
    if (raw && raw.type === 'folder' && depth < 5) {
      const folder = makeFolder(clean(raw.title) || 'Folder');
      folder.collapsed = !!raw.collapsed;
      folder.children = (Array.isArray(raw.children) ? raw.children : [])
        .slice(0, 2000).map((c) => toPinned(c, depth + 1)).filter(Boolean);
      if (raw.ref) refs[folder.id] = String(raw.ref);
      return folder;
    }
    return toTab(raw, true);
  };
  const nodesOf = (spec) => ({
    pinned: (Array.isArray(spec.pinned) ? spec.pinned : []).slice(0, 2000).map((n) => toPinned(n)).filter(Boolean),
    temp: (Array.isArray(spec.temp) ? spec.temp : []).slice(0, 2000).map((n) => toTab(n, false)).filter(Boolean),
  });

  const profileColors = Object.keys(CONTAINER_COLORS).filter((c) => c !== 'toolbar');
  let created = 0;
  const byName = new Map(); // lower-cased profile name -> cookieStoreId
  const usedStores = new Set();
  const resolveSpecProfile = async (p) => {
    if (!p || typeof p !== 'object') return DEFAULT_STORE;
    if (p.cookieStoreId) {
      return storeExists(p.cookieStoreId) ? String(p.cookieStoreId) : DEFAULT_STORE;
    }
    const profileName = clean(p.name).trim();
    if (!profileName) return DEFAULT_STORE;
    const key = profileName.toLowerCase();
    if (!byName.has(key)) {
      const existing = runtime.containers.find((c) => c.name.trim().toLowerCase() === key);
      byName.set(key, existing
        ? existing.cookieStoreId
        : await createProfile({
          name: profileName,
          color: p.color in CONTAINER_COLORS ? p.color : profileColors[created++ % profileColors.length],
          icon: CONTAINER_ICONS.includes(p.icon) ? p.icon : 'circle',
        }));
    }
    return byName.get(key);
  };
  const isEmpty = (s) => !s.pinned.length && s.temp.every((n) => !/^https?:\/\//i.test(n.url || ''));

  const spaceIds = [];
  const merged = [];
  const skipped = [];
  for (const spec of specs.slice(0, 100)) {
    const name = clean(spec.name).trim() || 'Imported space';
    const color = /^#[0-9a-f]{6}$/i.test(spec.color || '') ? spec.color : undefined;
    const existing = merge ? state.spaces.find((s) => s.name.trim().toLowerCase() === name.toLowerCase()) : null;
    if (existing && !isEmpty(existing)) {
      skipped.push(existing.name);
      continue;
    }
    const cookieStoreId = await resolveSpecProfile(spec.profile);
    if (cookieStoreId !== DEFAULT_STORE) usedStores.add(cookieStoreId);
    const { pinned, temp } = nodesOf(spec);
    let space = existing;
    if (space) {
      space.pinned = pinned;
      space.temp.push(...temp);
      if (clean(spec.emoji)) space.emoji = clean(spec.emoji);
      if (color) space.color = color;
      merged.push(space.id);
    } else {
      space = makeSpace({ name, emoji: clean(spec.emoji), color, cookieStoreId });
      space.pinned = pinned;
      space.temp = temp;
      state.spaces.push(space);
      spaceIds.push(space.id);
    }
    if (spec.ref) refs[space.id] = String(spec.ref);
    if (spec.tempRef && temp.length) refs[`${space.id}:temp`] = String(spec.tempRef);
    reindex();
    if (existing && cookieStoreId !== existing.cookieStoreId) {
      existing.cookieStoreId = cookieStoreId;
      await relocate(spaceTabNodes(existing), existing);
    }
  }
  reindex();
  return { spaces: spaceIds.length, tabs: tabCount, profiles: usedStores.size, spaceIds, merged, skipped, refs };
}

export const commands = {
  async activateNode({ nodeId }, { windowId }) {
    const entry = tabEntry(nodeId);
    expandAncestors(nodeId);
    if (windowSpace.get(windowId) !== entry.space.id) await switchSpace(windowId, entry.space.id);
    const live = entry.node.tabId != null ? liveTabs.get(entry.node.tabId) : null;
    if (live) {
      if (live.windowId !== windowId) {
        await browser.tabs.move(live.id, { windowId, index: -1 });
        live.windowId = windowId;
      }
      await browser.tabs.update(live.id, { active: true });
      activeTab.set(windowId, live.id);
    } else {
      await openTabForNode(entry.node, entry.space, windowId, { active: true });
    }
    entry.node.lastActive = Date.now();
    entry.space.lastActiveNodeId = entry.node.id;
    scheduleOrderSync(windowId);
  },

  async closeNode({ nodeId }) {
    const entry = tabEntry(nodeId);
    const node = entry.node;
    const tabId = node.tabId;
    if (entry.section === 'pinned') {
      // Pinned tabs stay in the sidebar, unloaded and reset to their pinned page.
      if (tabId == null) return;
      expectedRemovals.add(tabId);
      unlink(node);
      resetPinnedNode(node);
      await browser.tabs.remove(tabId).catch(() => expectedRemovals.delete(tabId));
    } else {
      detachNode(node.id);
      if (tabId != null) await browser.tabs.remove(tabId).catch(() => {});
    }
  },

  async deleteNode({ nodeId }) {
    const entry = getEntry(nodeId);
    if (!entry) return;
    if (entry.node.type === 'folder') return commands.deleteFolder({ nodeId });
    const tabId = entry.node.tabId;
    detachNode(nodeId);
    if (tabId != null) await browser.tabs.remove(tabId).catch(() => {});
  },

  // Removes the folder but keeps its contents, moved up one level.
  deleteFolder({ nodeId }) {
    const entry = getEntry(nodeId);
    if (!entry || entry.node.type !== 'folder') return;
    entry.list.splice(entry.list.indexOf(entry.node), 1, ...entry.node.children);
    reindex();
  },

  async newTab(_args, { windowId }) {
    const space = getSpace(windowSpace.get(windowId));
    if (!space) return;
    await newTabInSpace(space, windowId);
    scheduleOrderSync(windowId);
  },

  async switchSpace({ spaceId }, { windowId }) {
    await switchSpace(windowId, spaceId);
  },

  async cycleSpace({ dir }, { windowId }) {
    const ids = state.spaces.map((s) => s.id);
    if (ids.length < 2) return;
    const i = ids.indexOf(windowSpace.get(windowId));
    await switchSpace(windowId, ids[(i + (dir < 0 ? -1 : 1) + ids.length) % ids.length]);
  },

  async createSpace({ name, emoji, color, profile }, { windowId }) {
    const cookieStoreId = await resolveProfile(profile);
    const space = makeSpace({ name: name && name.trim(), emoji, color, cookieStoreId });
    state.spaces.push(space);
    reindex();
    await switchSpace(windowId, space.id);
    return space.id;
  },

  async updateSpace({ spaceId, name, emoji, color, profile }) {
    const space = getSpace(spaceId);
    if (!space) throw new UserError('That space no longer exists.');
    if (name != null && name.trim()) space.name = name.trim();
    if (emoji != null) space.emoji = emoji.trim();
    if (color) space.color = color;
    if (profile) {
      const store = await resolveProfile(profile);
      if (store !== space.cookieStoreId) {
        space.cookieStoreId = store;
        await relocate(spaceTabNodes(space), space);
      }
    }
    for (const [windowId, spaceIdShown] of windowSpace) {
      if (spaceIdShown === spaceId) await applyTheme(windowId);
    }
  },

  async deleteSpace({ spaceId }) {
    if (state.spaces.length <= 1) throw new UserError("You can't delete your only space.");
    const space = getSpace(spaceId);
    if (!space) return;
    const idx = state.spaces.indexOf(space);
    const fallback = state.spaces[idx + 1] || state.spaces[idx - 1];
    for (const [windowId, shown] of [...windowSpace]) {
      if (shown === spaceId) await switchSpace(windowId, fallback.id);
    }
    const tabIds = spaceTabNodes(space).map((n) => n.tabId).filter((id) => id != null);
    state.spaces.splice(state.spaces.indexOf(space), 1);
    reindex();
    if (state.lastSpaceId === spaceId) state.lastSpaceId = fallback.id;
    if (tabIds.length) await browser.tabs.remove(tabIds).catch(() => {});
  },

  reorderSpaces({ order }) {
    const byId = new Map(state.spaces.map((s) => [s.id, s]));
    const next = order.map((id) => byId.get(id)).filter(Boolean);
    for (const s of state.spaces) if (!next.includes(s)) next.push(s);
    state.spaces = next;
    reindex();
  },

  async moveNode({ nodeId, spaceId, section, parentId = null, index = null }) {
    const entry = getEntry(nodeId);
    const target = getSpace(spaceId);
    if (!entry || !target) return;
    const node = entry.node;
    if (section !== 'pinned') {
      section = 'temp';
      parentId = null;
    }
    if (node.type === 'folder') {
      if (section !== 'pinned') throw new UserError('Folders live in the pinned section.');
      for (let p = parentId; p; p = getEntry(p)?.parent?.id ?? null) {
        if (p === node.id) return; // can't drop a folder into itself
      }
    }
    if (parentId) {
      const parent = getEntry(parentId);
      if (!parent || parent.node.type !== 'folder' || parent.space !== target) parentId = null;
    }
    const targetList = listFor(target, section, parentId);
    if (targetList === entry.list && index != null && entry.list.indexOf(node) < index) index -= 1;

    const fromSpace = entry.space;
    const fromSection = entry.section;
    detachNode(node.id);
    if (node.type === 'tab') {
      const live = node.tabId != null ? liveTabs.get(node.tabId) : null;
      if (section === 'pinned' && fromSection !== 'pinned') {
        node.pinnedUrl = live?.url || node.url;
        node.pinnedTitle = live?.title || node.title;
      } else if (section === 'temp' && fromSection === 'pinned') {
        delete node.pinnedUrl;
        delete node.pinnedTitle;
        node.lastActive = Date.now();
      }
    }
    insertNode(node, target, section, parentId, index);
    if (target !== fromSpace) {
      await relocate(node.type === 'folder' ? tabNodesIn(node.children) : [node], target);
    }
    for (const windowId of windowSpace.keys()) scheduleOrderSync(windowId);
  },

  createFolder({ spaceId, parentId = null, index = null, title }, { windowId }) {
    const space = getSpace(spaceId || windowSpace.get(windowId));
    if (!space) return null;
    const folder = makeFolder(title || 'New Folder');
    insertNode(folder, space, 'pinned', parentId, index);
    return folder.id;
  },

  renameNode({ nodeId, title }) {
    const entry = getEntry(nodeId);
    if (!entry) return;
    const t = String(title || '').trim();
    if (entry.node.type === 'folder') {
      if (t) entry.node.title = t;
    } else if (t) {
      entry.node.customTitle = t;
    } else {
      delete entry.node.customTitle;
    }
  },

  toggleFolder({ nodeId }) {
    const entry = getEntry(nodeId);
    if (entry?.node.type !== 'folder') return;
    // The current tab must stay visible: a folder holding any window's active tab won't collapse.
    if (!entry.node.collapsed) {
      const activeIds = new Set(activeTab.values());
      if (tabNodesIn(entry.node.children).some((n) => n.tabId != null && activeIds.has(n.tabId))) {
        throw new UserError('That folder holds the current tab.');
      }
    }
    entry.node.collapsed = !entry.node.collapsed;
  },

  // Changes what a pinned tab points at. The new URL becomes the pinned URL, so it's what
  // the tab returns to when closed and what survives a restart. A live tab navigates there
  // right away; an unloaded one opens it on the next click.
  async setPinnedUrl({ nodeId, url }) {
    const entry = tabEntry(nodeId);
    if (entry.section !== 'pinned') throw new UserError('Only pinned tabs have a pinned URL.');
    let u = String(url || '').trim();
    if (!u) throw new UserError('Enter a URL.');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
    try { new URL(u); } catch { throw new UserError('That doesn’t look like a valid URL.'); }
    if (!/^https?:/i.test(u)) throw new UserError('Only http(s) pages can be pinned.');
    const node = entry.node;
    node.pinnedUrl = u;
    node.url = u;
    // The old page's title and icon no longer describe the pin; the page supplies new ones on load.
    delete node.pinnedTitle;
    node.favIconUrl = '';
    if (node.tabId != null) {
      await browser.tabs.update(node.tabId, { url: u }).catch(() => {});
    } else if (!node.customTitle) {
      node.title = u.replace(/^https?:\/\//, '');
    }
  },

  async resetPinned({ nodeId }) {
    const node = tabEntry(nodeId).node;
    if (!node.pinnedUrl) return;
    if (node.tabId != null) await browser.tabs.update(node.tabId, { url: node.pinnedUrl }).catch(() => {});
    else resetPinnedNode(node);
  },

  async unloadNode({ nodeId }) {
    const tabId = tabEntry(nodeId).node.tabId;
    if (tabId == null) return;
    const live = liveTabs.get(tabId);
    if (live && isActiveTab(tabId)) await ensureNotActive(tabId, live.windowId);
    await browser.tabs.discard(tabId).catch(() => {});
  },

  async toggleMute({ nodeId }) {
    const node = tabEntry(nodeId).node;
    const live = node.tabId != null ? liveTabs.get(node.tabId) : null;
    if (live) await browser.tabs.update(live.id, { muted: !live.mutedInfo?.muted });
  },

  // Arc's "Clear": archive every temporary tab in the space.
  async clearTemp({ spaceId }, { windowId }) {
    const space = getSpace(spaceId || windowSpace.get(windowId));
    if (!space) return;
    const doomed = [...space.temp];
    if (windowSpace.get(windowId) === space.id && doomed.some((n) => n.tabId === activeTab.get(windowId))) {
      await newTabInSpace(space, windowId);
    }
    for (const node of doomed) await archiveNode(node);
  },

  // The quick switcher's search: spaces, every space's tabs, and the archive.
  // An empty query lists the spaces plus the most recently used tabs.
  quickSearch({ query }) {
    const q = String(query || '').trim().toLowerCase();
    const score = (text) => {
      if (!text) return 0;
      const t = String(text).toLowerCase();
      if (t === q) return 120;
      if (t.startsWith(q)) return 100;
      const i = t.indexOf(q);
      if (i < 0) return 0;
      return /[^a-z0-9]/.test(t[i - 1]) ? 80 : 55;
    };
    const spaceRow = (s) => ({ kind: 'space', spaceId: s.id, title: s.name, emoji: s.emoji, color: s.color });
    const tabRow = (node, space, pinned, path = []) => ({
      kind: 'tab',
      nodeId: node.id,
      title: node.customTitle || node.title || node.url || 'New Tab',
      url: node.url || '',
      favIconUrl: node.favIconUrl || '',
      spaceName: space.name,
      emoji: space.emoji,
      pinned,
      path,
      lastActive: node.lastActive || 0,
    });
    const allTabs = [];
    const folders = [];
    for (const space of state.spaces) {
      const walk = (list, pinned, path) => {
        for (const n of list) {
          if (n.type === 'folder') {
            folders.push({ node: n, space, path, tabs: tabNodesIn(n.children) });
            walk(n.children, pinned, [...path, n.title || 'Folder']);
          } else {
            allTabs.push(tabRow(n, space, pinned, path));
          }
        }
      };
      walk(space.pinned, true, []);
      walk(space.temp, false, []);
    }

    if (!q) {
      const recent = allTabs.filter((t) => t.url).sort((a, b) => b.lastActive - a.lastActive).slice(0, 8);
      return [...state.spaces.map(spaceRow), ...recent];
    }

    const results = [];
    for (const space of state.spaces) {
      const s = score(space.name);
      if (s) results.push({ ...spaceRow(space), score: s + 15 });
    }
    // A folder whose name matches brings everything inside it along, as an indented
    // group under a folder header, so a tab named "04" in a "Proxmox" folder is a
    // hit for "proxmox". Those tabs are then left out of the flat results below.
    const grouped = new Set();
    for (const f of folders) {
      const s = score(f.node.title);
      if (!s) continue;
      for (const n of f.tabs) grouped.add(n.id);
      results.push({
        kind: 'folder',
        nodeId: f.node.id,
        title: f.node.title || 'Folder',
        path: f.path,
        spaceName: f.space.name,
        emoji: f.space.emoji,
        score: s + 5,
        children: f.tabs.slice(0, 12).map((n) => ({ ...tabRow(n, f.space, true), indent: true })),
      });
    }
    for (const t of allTabs) {
      if (grouped.has(t.nodeId)) continue;
      const s = Math.max(score(t.title), score(t.url) - 15, score(t.url.replace(/^https?:\/\/(www\.)?/, '')) - 10);
      if (s > 0) results.push({ ...t, score: s });
    }
    for (const a of state.archive) {
      const s = Math.max(score(a.title), score(a.url) - 15);
      if (s > 0) {
        results.push({
          kind: 'archive', id: a.id, title: a.title, url: a.url, favIconUrl: a.favIconUrl || '',
          spaceName: a.spaceName, score: s - 20, lastActive: a.archivedAt,
        });
      }
    }
    results.sort((a, b) => b.score - a.score || (b.lastActive || 0) - (a.lastActive || 0));
    // Flatten folder groups so their tabs sit right under the header.
    const rows = [];
    for (const r of results) {
      if (rows.length >= 20) break;
      if (r.kind === 'folder') {
        const { children, ...head } = r;
        rows.push(head, ...children);
      } else {
        rows.push(r);
      }
    }
    return rows;
  },

  // Enter on a folder in the quick switcher: show it in its space, expanded.
  async revealFolder({ nodeId }, { windowId }) {
    const entry = getEntry(nodeId);
    if (!entry) return;
    for (let n = entry.node; n; n = getEntry(n.id)?.parent || null) {
      if (n.type === 'folder') n.collapsed = false;
    }
    await switchSpace(windowId, entry.space.id);
  },

  getArchive() {
    return state.archive;
  },

  async restoreArchive({ id }, { windowId }) {
    const i = state.archive.findIndex((a) => a.id === id);
    if (i < 0) return;
    const [item] = state.archive.splice(i, 1);
    const space = getSpace(windowSpace.get(windowId));
    const node = makeTabNode(item);
    insertNode(node, space, 'temp', null, 0);
    await openTabForNode(node, space, windowId, { active: true });
    scheduleOrderSync(windowId);
  },

  deleteArchive({ id }) {
    state.archive = state.archive.filter((a) => a.id !== id);
  },

  clearArchive() {
    state.archive = [];
  },

  async updateSettings({ patch }) {
    const before = { ...state.settings };
    if (typeof patch.expiryMs === 'number' && patch.expiryMs >= 0) state.settings.expiryMs = patch.expiryMs;
    if (typeof patch.tintWindow === 'boolean') state.settings.tintWindow = patch.tintWindow;
    if (typeof patch.tabBarTipDismissed === 'boolean') state.settings.tabBarTipDismissed = patch.tabBarTipDismissed;
    if (typeof patch.archiveRetentionMs === 'number' && patch.archiveRetentionMs > 0) {
      state.settings.archiveRetentionMs = patch.archiveRetentionMs;
    }
    if (typeof patch.profileBackup === 'boolean') {
      state.settings.profileBackup = patch.profileBackup;
      if (patch.profileBackup && !before.profileBackup) scheduleBackup(0);
      if (!patch.profileBackup && state.backupStatus) {
        state.backupStatus = { ...state.backupStatus, error: null, running: false };
      }
    }
    if (['expiryMs', 'archiveRetentionMs', 'tintWindow'].some((k) => before[k] !== state.settings[k])) {
      state.settingsAt = Date.now();
    }
    if (before.tintWindow !== state.settings.tintWindow) await applyThemeAll();
    if (before.expiryMs !== state.settings.expiryMs) await runExpiry();
  },

  createProfile(args) {
    return createProfile(args);
  },

  async updateProfile({ cookieStoreId, name, color }) {
    const details = {};
    if (name && name.trim()) details.name = name.trim();
    if (color in CONTAINER_COLORS) details.color = color;
    if (!Object.keys(details).length) return;
    await browser.contextualIdentities.update(cookieStoreId, details);
    await refreshContainers();
  },

  // One-shot import from the Arc migration wizard (migrate/migrate.html). See addSpaces.
  async importArcSpaces({ spaces: specs }) {
    const { spaces, tabs, profiles, spaceIds } = await addSpaces(specs);
    return { spaces, tabs, profiles, spaceIds };
  },

  // Settings → Save to Firefox profile → Sync now. The work happens in backup.js, outside
  // the queue, and reports back through state.backupStatus.
  backupNow() {
    if (!state.settings.profileBackup) throw new UserError('Turn on “Save to Firefox profile” first.');
    scheduleBackup(0);
  },

  // Bring in the copy saved in bookmarks: spaces this profile doesn't have are added, an
  // empty space of the same name is filled in, and spaces that already have tabs are left
  // alone. The saved settings come back too.
  async restoreBackup() {
    if (!(await hasBookmarkAccess())) throw new UserError('Spaces needs permission to read your bookmarks first.');
    const backup = await readBackup();
    if (!backup || !backup.specs.length) throw new UserError('No saved copy of your spaces was found in your bookmarks.');
    const result = await addSpaces(backup.specs, { merge: true });
    const s = backup.settings;
    if (s) {
      await commands.updateSettings({
        patch: { expiryMs: s.expiryMs, archiveRetentionMs: s.archiveRetentionMs, tintWindow: s.tintWindow },
      });
    }
    adoptBookmarks(backup.rootId, backup.metaId, result.refs);
    if (state.settings.profileBackup) scheduleBackup(500);
    return {
      spaces: result.spaces, merged: result.merged.length, skipped: result.skipped, tabs: result.tabs, savedAt: backup.savedAt,
    };
  },

  async deleteProfile({ cookieStoreId }) {
    const users = state.spaces.filter((s) => s.cookieStoreId === cookieStoreId);
    if (users.length) {
      throw new UserError(`Used by ${users.map((s) => s.name).join(', ')}. Give those spaces another profile first.`);
    }
    await browser.contextualIdentities.remove(cookieStoreId);
    await refreshContainers();
  },
};
