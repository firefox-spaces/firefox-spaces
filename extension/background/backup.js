// "Save to Firefox profile": spaces, tabs and settings kept in Firefox bookmarks
// (Other Bookmarks → Spaces), and merged between computers.
//
// Bookmarks live in the profile, so the copy survives removing the extension, and
// Firefox Sync carries it between computers. Every computer that turns this on merges
// its spaces with that shared folder the way git merges branches: a three-way merge of
//   base   — what this computer last wrote (kept in storage.local as `syncBase`),
//   local  — the spaces here now,
//   remote — the folder now, including whatever other computers changed since.
// A change on one side wins; when both sides changed the same thing, the most recent
// edit wins. Something deleted on another computer goes to the Archive here instead of
// vanishing, and tabs that are open here are never closed by it.
//
// Identity: every item is known by its bookmark id, which Firefox Sync keeps the same on
// every computer. Items not written yet are "local:<model key>".
//
// Folder layout:
//   Spaces/
//     🏠 Personal/                  one folder per space
//       <pinned tabs and folders>
//       Temporary tabs/             the space's open (unpinned) tabs
//       Spaces space data           icon, color, profile, collapsed/renamed, edit times
//     Spaces sync data              settings, which computer wrote last
//
// Reading the folder happens outside the serial queue, merging into the model inside it
// (so it never interleaves with tab events), and writing outside again: a first save of
// hundreds of tabs takes a while and must not stall tab events.

import {
  state, scheduleSave, getEntry, makeTabNode, makeFolder, makeSpace, reindex, spaceTabNodes, expandAncestors,
} from './store.js';
import {
  runtime, refreshContainers, relocate, applyThemeAll, activeTab, windowSpace, switchSpace,
} from './ops.js';
import { archiveNode, runExpiry } from './archive.js';
import { scheduleBroadcast } from './view.js';
import { enqueue } from './queue.js';
import { CONTAINER_COLORS, CONTAINER_ICONS, DEFAULT_STORE } from '../shared/constants.js';

export const ROOT_TITLE = 'Spaces';
export const TEMP_TITLE = 'Temporary tabs';
const PINNED_TEMP_ALIAS = 'Temporary tabs (folder)'; // a pinned folder that happens to be called that
const META_HOST = 'spaces-sidebar.invalid';
const META_PREFIX = `https://${META_HOST}/backup#`;
const SPACE_PREFIX = `https://${META_HOST}/space#`;
const META_TITLE = 'Spaces sync data (don’t edit)';
const SPACE_DATA_TITLE = 'Spaces space data (don’t edit)';
const LOCAL_DEBOUNCE_MS = 15_000;
const REMOTE_DEBOUNCE_MS = 3_000;
const QUIET_AFTER_WRITE_MS = 2_000;
const AT_KEEP_MS = 60 * 86_400_000;
const MAX_DATA_URL = 60_000;
const SETTING_KEYS = ['expiryMs', 'archiveRetentionMs', 'tintWindow'];
const FIELDS = {
  space: ['name', 'emoji', 'color', 'profile'],
  folder: ['title', 'collapsed', 'pos'],
  tab: ['title', 'url', 'renamed', 'pos'],
};

const saveable = (url) => /^https?:\/\//i.test(url || '') && url.length < 8000;
const isFolder = (b) => (b.type ? b.type === 'folder' : !b.url);
const parentOf = (pos) => pos.split('|')[0];
const sectionOf = (pos) => pos.split('|')[1];
const decode = (url, prefix) => {
  try {
    return JSON.parse(decodeURIComponent(url.slice(prefix.length)));
  } catch {
    return null;
  }
};
const encode = (prefix, obj) => prefix + encodeURIComponent(JSON.stringify(obj));
const sameExceptSavedAt = (a, b) => !!a && !!b && JSON.stringify({ ...a, savedAt: 0 }) === JSON.stringify({ ...b, savedAt: 0 });
const differs = (a, b) => (FIELDS[a.kind] || []).some((f) => a[f] !== b[f]) || a.kind !== b.kind;
const pickSettings = (s) => Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k]]));

export async function hasBookmarkAccess() {
  try {
    return !!browser.bookmarks && !!browser.permissions
      && await browser.permissions.contains({ permissions: ['bookmarks'] });
  } catch {
    return false;
  }
}

// Called after every task that isn't the sync itself: something here may have changed.
export function noteLocalChange() {
  state.localEditAt = Date.now();
}

// ---- Trees ---------------------------------------------------------------------------
// A tree is { items: { id: item }, order: { pos: [ids] }, settings, settingsAt }.
// item.pos is where it sits: 'root' for spaces, '<parent id>|p' for pinned things (the
// parent is a space or a folder), '<space id>|t' for a space's temporary tabs.

function profileOf(space) {
  const c = runtime.containers.find((x) => x.cookieStoreId === space.cookieStoreId);
  return c || null;
}

// The model as a tree. refs maps tree ids back to model keys (space and node ids).
function localTree(base) {
  const ids = state.backupIds;
  const key = (k) => ids[k] || `local:${k}`;
  const T = { items: {}, order: {}, refs: {}, settings: pickSettings(state.settings), settingsAt: state.settingsAt || 0 };
  const add = (it, pos, ref) => {
    it.pos = pos;
    T.items[it.id] = it;
    (T.order[pos] ||= []).push(it.id);
    T.refs[it.id] = ref;
  };
  for (const s of state.spaces) {
    const sid = key(s.id);
    add({
      id: sid, kind: 'space', name: s.name, emoji: s.emoji || '', color: s.color || '',
      profile: profileOf(s)?.name || '', live: spaceTabNodes(s).some((n) => n.tabId != null),
    }, 'root', s.id);
    const tab = (n, pos, pinned) => {
      const id = key(n.id);
      let url = pinned ? (n.pinnedUrl || n.url) : n.url;
      let title = n.customTitle || (pinned && n.pinnedTitle) || n.title || url;
      if (!saveable(url)) {
        // A page bookmarks can't hold (a new-tab page, about:…): keep its last shared
        // version if it has one, otherwise it simply stays on this computer.
        const old = ids[n.id] && base.items[id];
        if (!old || old.kind !== 'tab') return;
        ({ url, title } = old);
      }
      add({ id, kind: 'tab', title, url, renamed: !!n.customTitle, live: n.tabId != null }, pos, n.id);
    };
    const walk = (list, parentId, top) => {
      for (const n of list) {
        if (n.type === 'folder') {
          const id = key(n.id);
          const title = top && n.title === TEMP_TITLE ? PINNED_TEMP_ALIAS : (n.title || 'Folder');
          add({ id, kind: 'folder', title, collapsed: !!n.collapsed }, `${parentId}|p`, n.id);
          walk(n.children, id, false);
        } else {
          tab(n, `${parentId}|p`, true);
        }
      }
    };
    walk(s.pinned, sid, true);
    for (const n of s.temp) tab(n, `${sid}|t`, false);
  }
  return T;
}

// The bookmark folder as a tree, plus what the data bookmarks say.
function remoteTree(root) {
  const T = {
    items: {}, order: {}, at: {}, temps: {}, dataIds: {}, styles: {}, ids: new Set(),
    settings: null, settingsAt: 0, savedAt: 0, metaId: null, metaData: null,
  };
  if (!root) return T;
  const add = (it, pos) => {
    it.pos = pos;
    T.items[it.id] = it;
    (T.order[pos] ||= []).push(it.id);
  };
  (function walkIds(n) {
    T.ids.add(n.id);
    for (const c of n.children || []) walkIds(c);
  }(root));

  const top = root.children || [];
  const metaBm = top.find((c) => c.url?.startsWith(META_PREFIX));
  const meta = metaBm ? decode(metaBm.url, META_PREFIX) : null;
  if (metaBm) {
    T.metaId = metaBm.id;
    T.metaData = meta;
  }
  if (meta) {
    T.settings = meta.settings || null;
    T.settingsAt = meta.settingsAt || meta.savedAt || 0;
    T.savedAt = meta.savedAt || 0;
    Object.assign(T.at, meta.at || {});
  }
  // Version 1 kept every space's details in the one data bookmark.
  const v1 = meta?.v === 1 ? meta : null;
  const v1Renamed = new Set(v1?.renamed || []);
  const v1Collapsed = new Set(v1?.collapsed || []);

  for (const f of top) {
    if (!isFolder(f)) continue;
    const kids = f.children || [];
    const dataBm = kids.find((c) => c.url?.startsWith(SPACE_PREFIX));
    const data = dataBm ? decode(dataBm.url, SPACE_PREFIX) : null;
    const old = v1?.spaces?.find((s) => s.folder === f.id) || null;
    const props = data || old || {};
    if (dataBm) T.dataIds[f.id] = { id: dataBm.id, data };
    Object.assign(T.at, data?.at || {});
    const savedAt = data?.savedAt || T.savedAt;
    const renamed = new Set([...(data?.renamed || []), ...v1Renamed]);
    const collapsed = new Set([...(data?.collapsed || []), ...v1Collapsed]);
    const profile = typeof props.profile === 'string' ? props.profile : (props.profile?.name || '');
    T.styles[f.id] = data?.profileStyle || (old?.profile ? { color: old.profile.color, icon: old.profile.icon } : null);
    add({ id: f.id, kind: 'space', name: props.name || f.title, emoji: props.emoji || '', color: props.color || '', profile, savedAt }, 'root');

    const tab = (b, pos) => {
      if (!saveable(b.url)) return;
      add({ id: b.id, kind: 'tab', title: b.title || b.url, url: b.url, renamed: renamed.has(b.id), savedAt }, pos);
    };
    const temps = kids.filter((c) => isFolder(c) && c.title === TEMP_TITLE);
    if (temps.length) T.temps[f.id] = temps.find((t) => t.id === data?.temp)?.id || temps[0].id;
    const walk = (list, parentId) => {
      for (const c of list) {
        if (isFolder(c)) {
          add({ id: c.id, kind: 'folder', title: c.title || 'Folder', collapsed: collapsed.has(c.id), savedAt }, `${parentId}|p`);
          walk(c.children || [], c.id);
        } else if (c.url && c !== dataBm) {
          tab(c, `${parentId}|p`);
        }
      }
    };
    walk(kids.filter((c) => !temps.includes(c)), f.id);
    for (const t of temps) for (const c of t.children || []) if (!isFolder(c) && c.url) tab(c, `${f.id}|t`);
  }
  return T;
}

const remoteAt = (R, id) => R.at[id] || R.items[id]?.savedAt || R.savedAt || 0;

// ---- Merge ---------------------------------------------------------------------------

// Things added on both sides independently — or everything, the first time a computer
// joins — that are clearly the same: spaces by name, folders by title and tabs by
// address, under the same parent. The local one takes the remote id so they merge
// instead of showing up twice.
function pair(B, L, R) {
  const alias = {};
  const rev = {};
  const localOnly = (id) => !B.items[id] && !R.items[id];
  const remoteOnly = (id) => !B.items[id] && !L.items[id];
  const sig = (it) => (it.kind === 'space' ? `s:${it.name.trim().toLowerCase()}`
    : it.kind === 'folder' ? `f:${it.title.trim().toLowerCase()}` : `t:${it.url}`);
  const matchGroup = (rPos, lPos) => {
    const rIds = (R.order[rPos] || []).filter(remoteOnly);
    const lIds = (L.order[lPos] || []).filter(localOnly);
    if (!rIds.length || !lIds.length) return;
    const pool = new Map();
    for (const id of lIds) {
      const k = sig(L.items[id]);
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(id);
    }
    for (const rid of rIds) {
      const lid = pool.get(sig(R.items[rid]))?.shift();
      if (lid) {
        alias[lid] = rid;
        rev[rid] = lid;
      }
    }
  };
  const visit = (rParent, depth) => {
    if (depth > 8) return;
    const lParent = rev[rParent] || rParent;
    const groups = rParent === 'root' ? [['root', 'root']]
      : [[`${rParent}|p`, `${lParent}|p`], [`${rParent}|t`, `${lParent}|t`]];
    for (const [rp, lp] of groups) {
      matchGroup(rp, lp);
      for (const rid of R.order[rp] || []) {
        if (R.items[rid].kind !== 'tab' && L.items[rev[rid] || rid]) visit(rid, depth + 1);
      }
    }
  };
  visit('root', 0);
  if (!Object.keys(alias).length) return;

  const re = (id) => alias[id] || id;
  const repos = (pos) => (pos === 'root' ? pos : `${re(parentOf(pos))}|${sectionOf(pos)}`);
  const items = {};
  const refs = {};
  for (const [id, it] of Object.entries(L.items)) {
    items[re(id)] = { ...it, id: re(id), pos: repos(it.pos) };
    refs[re(id)] = L.refs[id];
  }
  const order = {};
  for (const [pos, list] of Object.entries(L.order)) order[repos(pos)] = list.map(re);
  L.items = items;
  L.refs = refs;
  L.order = order;
}

function mergeOrder(pos, members, B, L, R, localAt) {
  const rel = (a, b) => {
    const s = new Set(b);
    return a.filter((x) => s.has(x));
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const bs = B.order[pos] || [];
  const ls = L.order[pos] || [];
  const rs = R.order[pos] || [];
  const lChanged = !same(rel(ls, bs), rel(bs, ls));
  const rChanged = !same(rel(rs, bs), rel(bs, rs));
  const rAt = R.at[`o:${pos}`] || R.items[parentOf(pos)]?.savedAt || R.savedAt || 0;
  const localFirst = lChanged && (!rChanged || localAt >= rAt);
  const primary = localFirst ? ls : rs;
  const secondary = localFirst ? rs : ls;
  const result = primary.filter((id) => members.has(id));
  const inResult = new Set(result);
  // Anything only the other side has goes right after the neighbor it follows there.
  const place = (id, src) => {
    if (inResult.has(id)) return;
    let at = 0;
    for (let j = src.indexOf(id) - 1; j >= 0; j--) {
      const k = result.indexOf(src[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    result.splice(at, 0, id);
    inResult.add(id);
  };
  for (const id of secondary) if (members.has(id)) place(id, secondary);
  for (const id of members) {
    if (!inResult.has(id)) {
      result.push(id);
      inResult.add(id);
    }
  }
  const at = lChanged || rChanged ? (localFirst ? localAt : rAt) : 0;
  return { ids: result, at };
}

function merge(B, L, R, localAt) {
  pair(B, L, R);
  const out = {};
  const at = {};
  const archive = new Set();
  const all = new Set([...Object.keys(L.items), ...Object.keys(R.items)]);

  for (const id of all) {
    const b = B.items[id];
    const l = L.items[id];
    const r = R.items[id];
    const rAt = remoteAt(R, id);
    if (l && r) {
      // No history (first sync, or added on both sides): the shared copy wins.
      const base = b || l;
      const m = { ...l };
      let tookRemote = false;
      let keptLocal = false;
      if (r.kind === l.kind) {
        for (const f of FIELDS[l.kind]) {
          const lv = l[f];
          const rv = r[f];
          if (lv === rv) continue;
          if (lv === base[f]) {
            m[f] = rv;
            tookRemote = true;
          } else if (rv === base[f]) {
            keptLocal = true;
          } else if (localAt >= rAt) {
            keptLocal = true;
          } else {
            m[f] = rv;
            tookRemote = true;
          }
        }
      }
      out[id] = m;
      if (tookRemote || keptLocal) at[id] = Math.max(tookRemote ? rAt : 0, keptLocal ? localAt : 0);
    } else if (l) {
      if (!b) {
        out[id] = l; // added here
        at[id] = localAt;
      } else if (l.live || (differs(b, l) && localAt > (R.savedAt || 0))) {
        // Deleted elsewhere, but open here (or edited here since): keep it, re-shared.
        out[id] = { ...l, reborn: true };
        at[id] = localAt;
      } else {
        archive.add(id); // deleted on another computer
      }
    } else if (!b) {
      out[id] = r; // added on another computer
      at[id] = rAt;
    } else if (differs(b, r) && rAt > localAt) {
      out[id] = r; // deleted here, but edited elsewhere since: it comes back
      at[id] = rAt;
    }
    // else: deleted here; the write removes it from the folder
  }

  // Things whose parent is gone move up to the nearest surviving ancestor. A tab that
  // must stay (open here) brings its space back if that space was deleted elsewhere.
  const lookup = (id) => out[id] || L.items[id] || R.items[id] || B.items[id];
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [id, it] of Object.entries(out)) {
      if (it.kind === 'space') continue;
      let pos = it.kind === 'folder' && sectionOf(it.pos) === 't' ? `${parentOf(it.pos)}|p` : it.pos;
      for (let guard = 0; pos && !out[parentOf(pos)] && guard < 20; guard++) {
        const pid = parentOf(pos);
        const p = lookup(pid);
        if (!p) pos = null;
        else if (p.kind === 'space') {
          if ((it.live || it.reborn) && L.items[pid]) out[pid] = { ...L.items[pid], reborn: true };
          else pos = null;
        } else {
          pos = sectionOf(pos) === 't' ? null : p.pos;
        }
      }
      if (!pos) {
        delete out[id];
        if (L.items[id]) archive.add(id);
        changed = true;
      } else if (pos !== it.pos) {
        out[id] = { ...it, pos };
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = {};
  for (const [id, it] of Object.entries(out)) (groups[it.pos] ||= new Set()).add(id);
  const order = {};
  const orderAt = {};
  for (const [pos, members] of Object.entries(groups)) {
    const o = mergeOrder(pos, members, B, L, R, localAt);
    order[pos] = o.ids;
    if (o.at) orderAt[pos] = o.at;
  }

  // Settings: same rule, field by field.
  const settings = { ...L.settings };
  let settingsAt = L.settingsAt;
  if (R.settings) {
    const bs = B.settings || L.settings;
    for (const k of SETTING_KEYS) {
      const lv = L.settings[k];
      const rv = R.settings[k];
      if (rv === undefined || lv === rv) continue;
      if (lv === bs[k] || (rv !== bs[k] && R.settingsAt > L.settingsAt)) {
        settings[k] = rv;
        settingsAt = Math.max(settingsAt, R.settingsAt);
      }
    }
  }
  return { out, order, at, orderAt, archive, settings, settingsAt };
}

// ---- Applying a merge to the model (inside the queue) -------------------------------

async function storeFor(name, style) {
  if (!name) return DEFAULT_STORE;
  const key = name.trim().toLowerCase();
  const existing = runtime.containers.find((c) => c.name.trim().toLowerCase() === key);
  if (existing) return existing.cookieStoreId;
  try {
    const identity = await browser.contextualIdentities.create({
      name: name.trim(),
      color: style?.color in CONTAINER_COLORS ? style.color : 'blue',
      icon: CONTAINER_ICONS.includes(style?.icon) ? style.icon : 'circle',
    });
    await refreshContainers();
    return identity.cookieStoreId;
  } catch {
    return DEFAULT_STORE;
  }
}

function setTab(n, it, pinned) {
  const urlChanged = (pinned ? (n.pinnedUrl || n.url) : n.url) !== it.url;
  if (pinned) {
    n.pinnedUrl = it.url;
    if (it.renamed) n.customTitle = it.title;
    else {
      delete n.customTitle;
      n.pinnedTitle = it.title;
    }
  } else {
    delete n.pinnedUrl;
    delete n.pinnedTitle;
    if (it.renamed) n.customTitle = it.title;
    else delete n.customTitle;
  }
  if (n.tabId == null) {
    if (urlChanged) n.favIconUrl = '';
    n.url = it.url;
    if (!it.renamed) n.title = it.title;
  } else if (!pinned) {
    // An open tab isn't navigated; it just stops disagreeing with the shared copy.
    n.url = it.url;
  }
}

async function apply(plan, L, R) {
  const { out, order } = plan;
  if (!order.root?.length) return;
  const refOf = (cid) => L.refs[cid];
  const nodeFor = (cid) => {
    const ref = refOf(cid);
    return ref ? getEntry(ref)?.node : null;
  };

  // Deleted on another computer: into the Archive here.
  for (const cid of plan.archive) {
    const e = getEntry(refOf(cid));
    if (e?.node.type === 'tab') await archiveNode(e.node);
  }

  const synced = new Set(Object.values(L.refs));
  const keyOf = {};
  const placed = new Set();
  const moved = new Map(); // destination space -> live nodes that changed space
  const prevSpace = new Map();
  const unsynced = []; // [node, spaceId, section] — pages bookmarks can't hold
  for (const s of state.spaces) {
    for (const n of spaceTabNodes(s)) prevSpace.set(n.id, s.id);
    const walk = (list, section) => {
      for (const n of list) {
        if (n.type === 'folder') walk(n.children, section);
        else if (!synced.has(n.id)) unsynced.push([n, s.id, section]);
      }
    };
    walk(s.pinned, 'pinned');
    walk(s.temp, 'temp');
  }

  const link = (cid, obj) => {
    keyOf[cid] = obj.id;
    if (!cid.startsWith('local:') && R.items[cid]) state.backupIds[obj.id] = cid;
  };
  const withUnsynced = (list, old) => {
    old.forEach((n, i) => {
      if (n.type === 'tab' && !synced.has(n.id) && !placed.has(n.id)) {
        list.splice(Math.min(i, list.length), 0, n);
        placed.add(n.id);
      }
    });
    return list;
  };
  const build = (pos, pinned, space) => (order[pos] || []).map((cid) => {
    const it = out[cid];
    const l = L.items[cid];
    if (it.kind === 'folder') {
      let f = nodeFor(cid);
      const oldKids = f?.children || [];
      if (!f || f.type !== 'folder') f = makeFolder(it.title);
      if (!l || l.title !== it.title) f.title = it.title === PINNED_TEMP_ALIAS ? TEMP_TITLE : it.title;
      f.collapsed = !!it.collapsed;
      f.children = withUnsynced(build(`${cid}|p`, true, space), oldKids);
      link(cid, f);
      return f;
    }
    if (it.kind !== 'tab') return null;
    let n = nodeFor(cid);
    const fresh = !n || n.type !== 'tab';
    if (fresh) n = makeTabNode({ url: it.url, title: it.title });
    if (fresh || !l || l.url !== it.url || l.title !== it.title || l.renamed !== it.renamed
      || (sectionOf(l.pos) === 'p') !== pinned) {
      setTab(n, it, pinned);
    }
    if (n.tabId != null && prevSpace.has(n.id) && prevSpace.get(n.id) !== space.id) {
      if (!moved.has(space)) moved.set(space, []);
      moved.get(space).push(n);
    }
    link(cid, n);
    placed.add(n.id);
    return n;
  }).filter(Boolean);

  const oldSpaces = new Map(state.spaces.map((s) => [s.id, s]));
  const next = [];
  for (const sid of order.root) {
    const it = out[sid];
    const l = L.items[sid];
    let space = refOf(sid) ? oldSpaces.get(refOf(sid)) : null;
    const isNew = !space;
    const color = /^#[0-9a-f]{6}$/i.test(it.color) ? it.color : undefined;
    if (isNew) space = makeSpace({ name: it.name, emoji: it.emoji, color });
    else if (!l || l.name !== it.name || l.emoji !== it.emoji || l.color !== it.color) {
      if (it.name) space.name = it.name;
      space.emoji = it.emoji;
      if (color) space.color = color;
    }
    link(sid, space);
    if (R.temps[sid]) state.backupIds[`${space.id}:temp`] = R.temps[sid];
    if (R.dataIds[sid]) state.backupIds[`${space.id}:data`] = R.dataIds[sid].id;
    const oldPinned = space.pinned;
    const oldTemp = space.temp;
    space.pinned = withUnsynced(build(`${sid}|p`, true, space), oldPinned);
    space.temp = withUnsynced(build(`${sid}|t`, false, space), oldTemp);
    next.push({ space, sid, it, l, isNew });
  }

  // Pages bookmarks can't hold whose folder or space went away land at the top level.
  for (const [n, spaceId, section] of unsynced) {
    if (placed.has(n.id)) continue;
    const home = next.find((x) => x.space.id === spaceId)?.space || next[0].space;
    (section === 'pinned' ? home.pinned : home.temp).push(n);
    placed.add(n.id);
  }

  const kept = new Set(next.map((x) => x.space.id));
  const fallback = next[0].space;
  for (const [windowId, shown] of [...windowSpace]) {
    if (!kept.has(shown)) await switchSpace(windowId, fallback.id);
  }
  state.spaces = next.map((x) => x.space);
  if (!kept.has(state.lastSpaceId)) state.lastSpaceId = fallback.id;
  reindex();

  for (const { space, sid, it, l, isNew } of next) {
    if (!isNew && l && l.profile === it.profile) continue;
    const store = await storeFor(it.profile, R.styles[sid]);
    if (store !== space.cookieStoreId) {
      space.cookieStoreId = store;
      if (!isNew) await relocate(spaceTabNodes(space), space);
    }
  }
  for (const [space, nodes] of moved) await relocate(nodes, space);

  // Settings
  const before = { ...state.settings };
  Object.assign(state.settings, plan.settings);
  state.settingsAt = plan.settingsAt;
  if (before.tintWindow !== state.settings.tintWindow) await applyThemeAll();
  if (before.expiryMs !== state.settings.expiryMs) await runExpiry();

  // Edit times, by model key, for the next write.
  const syncAt = state.syncAt || {};
  for (const [cid, t] of Object.entries(plan.at)) if (keyOf[cid]) syncAt[keyOf[cid]] = t;
  for (const [pos, t] of Object.entries(plan.orderAt)) {
    const k = pos === 'root' ? 'o:root' : keyOf[parentOf(pos)] && `o:${keyOf[parentOf(pos)]}|${sectionOf(pos)}`;
    if (k) syncAt[k] = t;
  }
  const cutoff = Date.now() - AT_KEEP_MS;
  for (const [k, t] of Object.entries(syncAt)) if (t < cutoff) delete syncAt[k];
  state.syncAt = syncAt;

  // The current tab must stay visible even if another computer collapsed its folder.
  const activeIds = new Set(activeTab.values());
  for (const s of state.spaces) {
    for (const n of spaceTabNodes(s)) if (n.tabId != null && activeIds.has(n.tabId)) expandAncestors(n.id);
  }
}

// ---- Writing the folder (outside the queue) ------------------------------------------

async function write(root, T, R) {
  const bm = browser.bookmarks;
  if (!root) {
    const made = await bm.create({ parentId: 'unfiled_____', title: ROOT_TITLE });
    root = { ...made, children: [] };
  }
  const ids = state.backupIds;
  const nodes = new Map();
  const where = new Map();
  const kids = new Map();
  (function walk(n) {
    nodes.set(n.id, n);
    if (!isFolder(n)) return;
    kids.set(n.id, (n.children || []).map((c) => c.id));
    for (const c of n.children || []) {
      where.set(c.id, n.id);
      walk(c);
    }
  }(root));
  const claimed = new Set([root.id]);
  const next = { root: root.id };
  const bmOf = {}; // tree id -> bookmark id

  // Puts one item at parentId[index]. Items 0..index-1 are already in place, so the
  // item is either further down this folder or elsewhere: moving it up is unambiguous.
  async function place({ cid, key, title, url, folder, urlFor }, parentId, index) {
    let id = cid && !cid.startsWith('local:') && nodes.has(cid) ? cid : ids[key];
    let cur = id ? nodes.get(id) : null;
    if (cur && (claimed.has(id) || isFolder(cur) !== folder)) cur = null;
    if (urlFor) url = urlFor(cur?.url);
    if (!cur) {
      const made = await bm.create({ parentId, index, title, ...(folder ? {} : { url }) });
      id = made.id;
      nodes.set(id, { ...made, children: folder ? [] : undefined });
      kids.get(parentId).splice(index, 0, id);
      where.set(id, parentId);
      if (folder) kids.set(id, []);
    } else {
      const from = where.get(id);
      const list = kids.get(from);
      if (from !== parentId || list.indexOf(id) !== index) {
        await bm.move(id, { parentId, index });
        list.splice(list.indexOf(id), 1);
        kids.get(parentId).splice(index, 0, id);
        where.set(id, parentId);
      }
      const changes = {};
      if (cur.title !== title) changes.title = title;
      if (!folder && cur.url !== url) changes.url = url;
      if (Object.keys(changes).length) await bm.update(id, changes);
    }
    claimed.add(id);
    next[key] = id;
    if (cid) bmOf[cid] = id;
    return id;
  }

  const syncAt = state.syncAt || {};
  const spaceIds = T.order.root || [];
  for (let i = 0; i < spaceIds.length; i++) {
    const sid = spaceIds[i];
    const s = T.items[sid];
    const key = T.refs[sid];
    const fid = await place({ cid: sid, key, title: `${s.emoji || ''} ${s.name}`.trim(), folder: true }, root.id, i);
    const inSpace = [sid];
    let idx = 0;
    const children = async (pos, parentBm) => {
      let j = 0;
      for (const cid of T.order[pos] || []) {
        const it = T.items[cid];
        inSpace.push(cid);
        if (it.kind === 'folder') {
          const id = await place({ cid, key: T.refs[cid], title: it.title, folder: true }, parentBm, j++);
          await children(`${cid}|p`, id);
        } else {
          await place({ cid, key: T.refs[cid], title: it.title, url: it.url, folder: false }, parentBm, j++);
        }
      }
      return j;
    };
    idx = await children(`${sid}|p`, fid);
    const temp = T.order[`${sid}|t`] || [];
    if (temp.length) {
      const tid = await place({ cid: R.temps[sid] || null, key: `${key}:temp`, title: TEMP_TITLE, folder: true }, fid, idx++);
      for (let j = 0; j < temp.length; j++) {
        const it = T.items[temp[j]];
        inSpace.push(temp[j]);
        await place({ cid: temp[j], key: T.refs[temp[j]], title: it.title, url: it.url, folder: false }, tid, j);
      }
    }

    const at = {};
    for (const cid of inSpace) {
      const t = syncAt[T.refs[cid]];
      if (t && bmOf[cid]) at[bmOf[cid]] = t;
      for (const sec of ['p', 't']) {
        const ot = syncAt[`o:${T.refs[cid]}|${sec}`];
        if (ot && bmOf[cid]) at[`o:${bmOf[cid]}|${sec}`] = ot;
      }
    }
    const style = s.profile ? runtime.containers.find((c) => c.name === s.profile) : null;
    const data = {
      v: 2,
      name: s.name,
      emoji: s.emoji || '',
      color: s.color || '',
      profile: s.profile || '',
      profileStyle: style ? { color: style.color, icon: style.icon } : (R.styles[sid] || null),
      temp: next[`${key}:temp`] || null,
      collapsed: inSpace.filter((c) => T.items[c].kind === 'folder' && T.items[c].collapsed).map((c) => bmOf[c]),
      renamed: inSpace.filter((c) => T.items[c].kind === 'tab' && T.items[c].renamed).map((c) => bmOf[c]),
      at,
    };
    await place({
      cid: R.dataIds[sid]?.id || null,
      key: `${key}:data`,
      title: SPACE_DATA_TITLE,
      folder: false,
      urlFor: (curUrl) => {
        const old = curUrl?.startsWith(SPACE_PREFIX) ? decode(curUrl, SPACE_PREFIX) : null;
        if (sameExceptSavedAt(old, data)) return curUrl;
        let url = encode(SPACE_PREFIX, { ...data, savedAt: Date.now() });
        if (url.length > MAX_DATA_URL) url = encode(SPACE_PREFIX, { ...data, at: {}, savedAt: Date.now() });
        return url;
      },
    }, fid, idx);
  }

  const meta = {
    v: 2,
    device: state.deviceId,
    settings: T.settings,
    settingsAt: T.settingsAt,
    at: syncAt['o:root'] ? { 'o:root': syncAt['o:root'] } : {},
  };
  await place({
    cid: R.metaId,
    key: 'meta',
    title: META_TITLE,
    folder: false,
    urlFor: (curUrl) => {
      const old = curUrl?.startsWith(META_PREFIX) ? decode(curUrl, META_PREFIX) : null;
      return sameExceptSavedAt(old, meta) ? curUrl : encode(META_PREFIX, { ...meta, savedAt: Date.now() });
    },
  }, root.id, spaceIds.length);

  // Remove what the merge dropped. Only bookmarks that were there when we read the
  // folder: anything Firefox Sync added since is merged next time, not deleted.
  for (const [id, parentId] of where) {
    if (claimed.has(id) || !claimed.has(parentId) || !R.ids.has(id) || !nodes.has(id)) continue;
    await (isFolder(nodes.get(id)) ? bm.removeTree(id) : bm.remove(id)).catch(() => {});
  }

  state.backupIds = next;
  // The new base: what was just written, by bookmark id.
  const re = (cid) => bmOf[cid] || cid;
  const base = { items: {}, order: {}, settings: T.settings, settingsAt: T.settingsAt };
  for (const [cid, it] of Object.entries(T.items)) {
    const id = re(cid);
    const pos = it.pos === 'root' ? 'root' : `${re(parentOf(it.pos))}|${sectionOf(it.pos)}`;
    const { live, reborn, ...rest } = it;
    base.items[id] = { ...rest, id, pos };
  }
  for (const [pos, list] of Object.entries(T.order)) {
    const p = pos === 'root' ? 'root' : `${re(parentOf(pos))}|${sectionOf(pos)}`;
    base.order[p] = list.map(re);
  }
  for (const id of nodes.keys()) known.add(id);
  return base;
}

// ---- Base (last written state) ---------------------------------------------------------

let baseCache = null;
async function loadBase() {
  if (!baseCache) {
    const { syncBase } = await browser.storage.local.get('syncBase');
    baseCache = syncBase && syncBase.items ? syncBase : { items: {}, order: {}, settings: null, settingsAt: 0 };
  }
  return baseCache;
}
async function saveBase(base) {
  baseCache = base;
  await browser.storage.local.set({ syncBase: base });
}

// ---- Finding the folder ----------------------------------------------------------------

async function subTree(id) {
  const r = await browser.bookmarks.getSubTree(id).catch(() => null);
  return r?.[0] && isFolder(r[0]) ? r[0] : null;
}

async function findRoot() {
  if (state.backupIds.root) {
    const r = await subTree(state.backupIds.root);
    if (r) return r;
  }
  // Written by this profile before, or synced in from another computer.
  const hits = await browser.bookmarks.search({ query: META_HOST }).catch(() => []);
  for (const h of hits) {
    if (!h.url?.startsWith(META_PREFIX) || !h.parentId) continue;
    const r = await subTree(h.parentId);
    if (r) return r;
  }
  return null;
}

// ---- Scheduling ------------------------------------------------------------------------

let timer = null;
let timerDue = 0;
let running = false;
let again = false;
let writing = false;
let quietUntil = 0;
const known = new Set();

export function scheduleBackup(delay = LOCAL_DEBOUNCE_MS) {
  if (!state.settings.profileBackup) return;
  const due = Date.now() + delay;
  if (timer && timerDue <= due) return;
  clearTimeout(timer);
  timerDue = due;
  timer = setTimeout(() => {
    timer = null;
    runSync();
  }, delay);
}

class NoAccess extends Error {}

function setStatus(patch) {
  state.backupStatus = { at: null, error: null, running: false, ...state.backupStatus, ...patch };
  scheduleSave();
  scheduleBroadcast();
}

export async function runSync() {
  if (!state.settings.profileBackup) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  setStatus({ running: true });
  try {
    if (!(await hasBookmarkAccess())) throw new NoAccess('Spaces doesn’t have permission to use bookmarks.');
    watchBookmarks();
    const root = await findRoot();
    const R = remoteTree(root);
    for (const id of R.ids) known.add(id);
    const B = await loadBase();
    const T = await enqueue(async () => {
      const L = localTree(B);
      const plan = merge(B, L, R, state.localEditAt || 0);
      await apply(plan, L, R);
      return localTree(B);
    }, 'profileSync');
    writing = true;
    const base = await write(root, T, R);
    await saveBase(base);
    const now = Date.now();
    setStatus({ running: false, at: now, checkedAt: now, error: null });
  } catch (err) {
    if (!(err instanceof NoAccess)) console.warn('[Spaces] syncing with the Firefox profile failed', err);
    setStatus({ running: false, checkedAt: Date.now(), error: String(err?.message || err) });
  } finally {
    writing = false;
    quietUntil = Date.now() + QUIET_AFTER_WRITE_MS;
    running = false;
    scheduleSave();
  }
  if (again) {
    again = false;
    scheduleBackup(1000);
  }
}

// Firefox Sync applying another computer's changes shows up as bookmark events.
let watching = false;
export function watchBookmarks() {
  const bm = browser.bookmarks;
  if (watching || !bm?.onCreated) return;
  watching = true;
  const poke = (...ids) => {
    if (writing || Date.now() < quietUntil || !state.settings.profileBackup) return;
    if (ids.some((id) => id && known.has(id))) scheduleBackup(REMOTE_DEBOUNCE_MS);
  };
  bm.onCreated.addListener((id, b) => poke(b?.parentId));
  bm.onChanged?.addListener((id) => poke(id));
  bm.onMoved?.addListener((id, info) => poke(id, info?.parentId, info?.oldParentId));
  bm.onRemoved?.addListener((id, info) => poke(id, info?.parentId));
}

// ---- One-time restore (when syncing is off) --------------------------------------------

// The shared copy as import specs (the Arc importer's shape), plus settings. Each item
// carries `ref`, its bookmark id, so restored nodes adopt the existing bookmarks.
export async function readBackup() {
  const root = await findRoot();
  if (!root) return null;
  const R = remoteTree(root);
  const build = (pos) => (R.order[pos] || []).map((id) => {
    const it = R.items[id];
    if (it.kind === 'folder') {
      return { type: 'folder', ref: id, title: it.title, collapsed: it.collapsed, children: build(`${id}|p`) };
    }
    return { type: 'tab', ref: id, url: it.url, title: it.title, ...(it.renamed ? { customTitle: it.title } : {}) };
  });
  const specs = (R.order.root || []).map((sid) => {
    const s = R.items[sid];
    return {
      ref: sid,
      tempRef: R.temps[sid] || null,
      name: s.name,
      emoji: s.emoji,
      color: s.color,
      profile: s.profile ? { name: s.profile, ...(R.styles[sid] || {}) } : null,
      pinned: build(`${sid}|p`),
      temp: build(`${sid}|t`).filter((x) => x.type === 'tab'),
    };
  });
  return { rootId: root.id, metaId: R.metaId, specs, settings: R.settings, savedAt: R.savedAt };
}

export function adoptBookmarks(rootId, metaId, refs) {
  state.backupIds = { ...state.backupIds, root: rootId, ...(metaId ? { meta: metaId } : {}), ...refs };
}
