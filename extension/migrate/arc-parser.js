// Parses Arc's StorableSidebar.json into plain spaces, folders and tabs.
//
// The file lives at:
//   macOS    ~/Library/Application Support/Arc/StorableSidebar.json
//   Windows  %LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_ttt1ap7aakyb4\LocalCache\Local\Arc\StorableSidebar.json
//
// The parts we read:
//   sidebar.containers[]   one entry per Arc profile, each with { spaces: [...], items: [...] }
//                          (both arrays mix id strings with the actual objects)
//   space.containerIDs     names the space's "pinned" and "unpinned" root items; older files
//                          use plain strings as markers, newer ones use { pinned: {} } objects
//   items                  form a tree through childrenIds; data.tab is a tab, data.list a
//                          folder, data.splitView a split whose children are tabs
//   topAppsContainerIDs    the favorites row shown in every space
//   space.profile          { default: {} }, or { custom: { _0: { directoryBasename: "Profile 3" } } };
//                          the profile's display name lives in a second file, User Data/Local State

const isHttp = (url) => /^https?:\/\//i.test(String(url || ''));

// Arc's built-in icons are SF Symbols; carry the common ones over as a close emoji.
const ICON_EMOJI = {
  planet: '🪐', briefcase: '💼', house: '🏠', heart: '❤️', star: '⭐', book: '📚',
  gamecontroller: '🎮', cart: '🛒', graduationcap: '🎓', hammer: '🔨', wrench: '🔧',
  leaf: '🍃', flame: '🔥', bolt: '⚡', airplane: '✈️', car: '🚗', paintbrush: '🖌️',
  camera: '📷', globe: '🌐', music: '🎵', dollarsign: '💵', creditcard: '💳',
  gift: '🎁', pawprint: '🐾', gamecontroller2: '🎮', lightbulb: '💡', moon: '🌙',
  sun: '☀️', snowflake: '❄️', drop: '💧', pencil: '✏️', folder: '📁', flask: '🧪',
};

function emojiOf(space) {
  const icon = space.customInfo?.iconType || {};
  if (typeof icon.emoji_v2 === 'string') return icon.emoji_v2;
  if (typeof icon.emoji === 'number') {
    try { return String.fromCodePoint(icon.emoji); } catch { return ''; }
  }
  if (typeof icon.icon === 'string') return ICON_EMOJI[icon.icon.split('.')[0]] || '';
  return '';
}

// The space's theme color: the palette's midTone, as hex.
function colorOf(space) {
  const c = space.customInfo?.windowTheme?.primaryColorPalette?.midTone;
  if (!c || typeof c !== 'object') return '';
  const parts = [c.red, c.green, c.blue];
  if (!parts.every((v) => typeof v === 'number' && Number.isFinite(v))) return '';
  return `#${parts.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

// ["pinned", "<id>", "unpinned", "<id>"] or [{ pinned: {} }, "<id>", { unpinned: {} }, "<id>"]
function sectionRoots(space) {
  const out = {};
  for (const arr of [space.newContainerIDs, space.containerIDs]) {
    if (!Array.isArray(arr)) continue;
    let section = null;
    for (const el of arr) {
      if (el === 'pinned' || el === 'unpinned') section = el;
      else if (el && typeof el === 'object') section = 'pinned' in el ? 'pinned' : 'unpinned' in el ? 'unpinned' : null;
      else if (typeof el === 'string') {
        if (section && out[section] == null) out[section] = el;
        section = null;
      }
    }
  }
  return out;
}

// The Arc profile a space belongs to: its directory basename, or null for Arc's default profile.
function profileDirOf(space) {
  const dir = space.profile?.custom?._0?.directoryBasename;
  return typeof dir === 'string' && dir.trim() ? dir.trim() : null;
}

// Arc is Chromium-based, so profile display names live in User Data/Local State,
// under profile.info_cache: { "Profile 3": { name: "Personal" }, ... }.
// Returns { "Profile 3": "Personal", ... } or throws if this isn't that file.
export function parseArcProfileNames(data) {
  const cache = data?.profile?.info_cache;
  if (!cache || typeof cache !== 'object') {
    throw new Error("This doesn't look like Arc's Local State file — it has no profile names in it.");
  }
  const names = {};
  for (const [dir, info] of Object.entries(cache)) {
    if (typeof info?.name === 'string' && info.name.trim()) names[dir] = info.name.trim();
  }
  return names;
}

export function countTabs(nodes) {
  let n = 0;
  for (const node of nodes || []) n += node.type === 'folder' ? countTabs(node.children) : 1;
  return n;
}

export function countFolders(nodes) {
  let n = 0;
  for (const node of nodes || []) if (node.type === 'folder') n += 1 + countFolders(node.children);
  return n;
}

// Returns { spaces: [{ name, emoji, pinned, temp }], favorites: [tab], skipped }.
// A tab is { type: 'tab', url, title, customTitle? }; a folder { type: 'folder', title, children }.
// `skipped` counts items we couldn't carry over (Easels, notes, non-web URLs).
export function parseArcSidebar(data) {
  const containers = data?.sidebar?.containers;
  if (!Array.isArray(containers)) {
    throw new Error("This doesn't look like Arc's StorableSidebar.json — it has no sidebar data in it.");
  }

  const items = new Map();
  const rawSpaces = [];
  const topAppIds = [];
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    for (const it of c.items || []) if (it && typeof it === 'object' && it.id) items.set(it.id, it);
    for (const s of c.spaces || []) if (s && typeof s === 'object' && s.id) rawSpaces.push(s);
    for (const el of c.topAppsContainerIDs || []) if (typeof el === 'string') topAppIds.push(el);
  }
  if (!rawSpaces.length) {
    throw new Error('No spaces found in this file. Is it really StorableSidebar.json, and has Arc been used on this machine?');
  }

  let skipped = 0;

  const tabNode = (item) => {
    const tab = item.data.tab;
    const url = tab.savedURL || tab.savedUrl || '';
    if (!isHttp(url)) {
      skipped++;
      return null;
    }
    const node = { type: 'tab', url, title: tab.savedTitle || item.title || url };
    // Arc stores a user rename in item.title, alongside the page's own savedTitle.
    if (item.title && tab.savedTitle && item.title !== tab.savedTitle) node.customTitle = item.title;
    return node;
  };

  // Converts an item's children. Folders are kept only where `folders` is true
  // (our temporary section is flat); elsewhere their tabs are hoisted up.
  const convertChildren = (id, folders, seen = new Set()) => {
    const item = items.get(id);
    if (!item || seen.has(id)) return [];
    seen.add(id);
    const out = [];
    for (const childId of item.childrenIds || []) {
      const child = items.get(childId);
      if (!child || !child.data || typeof child.data !== 'object') continue;
      if (child.data.tab) {
        const node = tabNode(child);
        if (node) out.push(node);
      } else if (child.data.splitView || child.data.itemContainer) {
        out.push(...convertChildren(childId, false, seen));
      } else if (child.data.list || (Array.isArray(child.childrenIds) && child.childrenIds.length)) {
        const children = convertChildren(childId, folders, seen);
        if (folders) out.push({ type: 'folder', title: child.title || 'Folder', children });
        else out.push(...children);
      } else {
        skipped++; // Easels, notes, media — nothing to open in Firefox
      }
    }
    return out;
  };

  const spaces = rawSpaces.map((s, i) => {
    const roots = sectionRoots(s);
    return {
      name: String(s.title || '').trim() || `Space ${i + 1}`,
      emoji: emojiOf(s),
      color: colorOf(s),
      profileDir: profileDirOf(s),
      pinned: roots.pinned ? convertChildren(roots.pinned, true) : [],
      temp: roots.unpinned ? convertChildren(roots.unpinned, false) : [],
    };
  });

  const favorites = [];
  const seenUrls = new Set();
  for (const id of topAppIds) {
    for (const node of convertChildren(id, false)) {
      if (node.type !== 'tab' || seenUrls.has(node.url)) continue;
      seenUrls.add(node.url);
      favorites.push(node);
    }
  }

  return { spaces, favorites, skipped };
}
