// Tests the Arc migration: the StorableSidebar.json parser, then the real background
// import command driven through the fake browser.
//   node dev/arc-test.mjs
import { createFakeBrowser, settle } from './fake-browser.mjs';
import { parseArcSidebar, parseArcProfileNames, countTabs, countFolders } from '../extension/migrate/arc-parser.js';

let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};

// ---- Fixture: a trimmed StorableSidebar.json covering both containerIDs shapes,
// nested folders, a split view, a renamed tab, favorites, and skippable items. ----

const tab = (id, parentID, url, title, itemTitle = null) =>
  ({ id, parentID, childrenIds: [], title: itemTitle, data: { tab: { savedURL: url, savedTitle: title } } });

const fixture = {
  version: 1,
  sidebar: {
    containers: [
      { global: {} },
      {
        topAppsContainerIDs: [{ default: {} }, 'favs-root'],
        items: [
          'favs-root', { id: 'favs-root', childrenIds: ['fav1', 'fav2'], data: { itemContainer: {} } },
          'fav1', tab('fav1', 'favs-root', 'https://mail.example/', 'Mail'),
          'fav2', tab('fav2', 'favs-root', 'https://cal.example/', 'Calendar'),

          'pin-a', { id: 'pin-a', childrenIds: ['folder1', 'tab1'], data: { itemContainer: {} } },
          'un-a', { id: 'un-a', childrenIds: ['today1', 'today2'], data: { itemContainer: {} } },
          'folder1', { id: 'folder1', parentID: 'pin-a', childrenIds: ['tab2', 'folder2', 'easel1'], title: 'Research', data: { list: {} } },
          'folder2', { id: 'folder2', parentID: 'folder1', childrenIds: ['tab3'], title: 'Deep', data: { list: {} } },
          'tab1', tab('tab1', 'pin-a', 'https://docs.example/', 'Docs', 'My Docs'),
          'tab2', tab('tab2', 'folder1', 'https://a.example/', 'A'),
          'tab3', tab('tab3', 'folder2', 'https://b.example/', 'B'),
          'easel1', { id: 'easel1', parentID: 'folder1', childrenIds: [], title: 'Sketch', data: { easel: {} } },
          'today1', tab('today1', 'un-a', 'https://news.example/', 'News'),
          'today2', tab('today2', 'un-a', 'arc://settings', 'Arc settings'),

          'pin-b', { id: 'pin-b', childrenIds: ['split1'], data: { itemContainer: {} } },
          'un-b', { id: 'un-b', childrenIds: [], data: { itemContainer: {} } },
          'split1', { id: 'split1', parentID: 'pin-b', childrenIds: ['tab4', 'tab5'], data: { splitView: {} } },
          'tab4', tab('tab4', 'split1', 'https://left.example/', 'Left'),
          'tab5', tab('tab5', 'split1', 'https://right.example/', 'Right'),
        ],
        spaces: [
          'space-a', {
            id: 'space-a',
            title: 'Work',
            customInfo: {
              iconType: { emoji_v2: '💼' },
              windowTheme: { primaryColorPalette: { midTone: { red: 1, green: 0, blue: 0, alpha: 1, colorSpace: 'extendedSRGB' } } },
            },
            containerIDs: ['pinned', 'pin-a', 'unpinned', 'un-a'],
            profile: { custom: { _0: { directoryBasename: 'Profile 7', machineID: 'x' } } },
          },
          'space-b', {
            id: 'space-b',
            customInfo: { iconType: { emoji: 0x1f3e0 } },
            newContainerIDs: [{ pinned: {} }, 'pin-b', { unpinned: {} }, 'un-b'],
            profile: { default: {} },
          },
          'space-c', { id: 'space-c', title: 'Icons', customInfo: { iconType: { icon: 'planet.fill' } } },
        ],
      },
    ],
  },
};

// ---- Parser ----

const parsed = parseArcSidebar(fixture);
check(parsed.spaces.length === 3, 'three spaces found', parsed.spaces.length);
const [work, home, icons] = parsed.spaces;
check(work.color === '#ff0000' && home.color === '', 'space theme color extracted from the palette midTone', work.color);
check(icons.emoji === '🪐' && icons.pinned.length === 0 && icons.temp.length === 0,
  'built-in Arc icon mapped to an emoji; missing containers tolerated', icons);
check(work.name === 'Work' && work.emoji === '💼', 'space name and emoji_v2', work);
check(home.name === 'Space 2' && home.emoji === '🏠', 'untitled space gets a fallback name, codepoint emoji decoded', home);
check(countTabs(work.pinned) === 3 && countFolders(work.pinned) === 2, 'nested pinned folders carried over', work.pinned);
check(work.pinned[0].type === 'folder' && work.pinned[0].children[1].children[0].url === 'https://b.example/', 'folder nesting order kept', work.pinned);
check(work.pinned[1].customTitle === 'My Docs', 'Arc rename becomes customTitle', work.pinned[1]);
check(work.temp.length === 1 && work.temp[0].url === 'https://news.example/', 'today tabs kept, arc:// URL dropped', work.temp);
check(home.pinned.length === 2 && home.pinned.every((n) => n.type === 'tab'), 'split view flattened to tabs', home.pinned);
check(parsed.favorites.map((f) => f.url).join() === 'https://mail.example/,https://cal.example/', 'favorites collected', parsed.favorites);
check(parsed.skipped === 2, 'easel + arc:// counted as skipped', parsed.skipped);

check(work.profileDir === 'Profile 7' && home.profileDir === null,
  'space profiles extracted; Arc default profile is null', [work.profileDir, home.profileDir]);

const names = parseArcProfileNames({ profile: { info_cache: {
  Default: { name: 'Person 1' }, 'Profile 7': { name: 'Work' }, 'Profile 2': { name: '  ' },
} } });
check(names['Profile 7'] === 'Work' && !('Profile 2' in names), 'Local State profile names parsed', names);

let threw = false;
try { parseArcSidebar({ hello: 1 }); } catch { threw = true; }
check(threw, 'unrecognized JSON is rejected with an error');
threw = false;
try { parseArcProfileNames({ hello: 1 }); } catch { threw = true; }
check(threw, 'non-Local-State JSON is rejected with an error');

// ---- Background import through the fake browser ----

const { browser, helpers: B } = createFakeBrowser();
globalThis.browser = browser;
const W1 = B.addWindow();
B.seedTab({ windowId: W1, url: 'https://example.com/', title: 'Example', active: true });

await import('../extension/background/main.js');
const { state, getSpace } = await import('../extension/background/store.js');
await settle();

const before = state.spaces.length;
// Profile names as the wizard resolves them: Local State name, or null for Arc's default.
// Profiles as the wizard's mapping resolves them: { name } to match-or-create,
// { cookieStoreId } when the user picked an existing container, null for Default.
const specs = parsed.spaces.map((s) => ({
  name: s.name,
  emoji: s.emoji,
  color: s.color,
  profile: s.profileDir ? { name: names[s.profileDir] || s.profileDir } : null,
  pinned: [...parsed.favorites, ...s.pinned],
  temp: s.temp,
}));
specs.push({ name: 'Also Work', profile: { name: 'work' }, pinned: [], temp: [] });
specs.push({ name: 'Side', profile: { name: 'Hermes' }, pinned: [], temp: [] });
specs.push({ name: 'Direct', profile: { cookieStoreId: 'firefox-container-1' }, pinned: [], temp: [] });
specs.push({ name: 'Bogus', profile: { cookieStoreId: 'firefox-container-99' }, pinned: [], temp: [] });
const result = await B.sendMessage({ type: 'cmd', name: 'importArcSpaces', args: { spaces: specs } });
await settle();

check(result.spaces === 7 && result.tabs === 12, 'import summary counts spaces and tabs', result);
check(state.spaces.length === before + 7, 'spaces appended, existing ones untouched', state.spaces.length);
const [impWork, impHome, , impWork2, impSide, impDirect, impBogus] = result.spaceIds.map(getSpace);
check(impWork.name === 'Work' && impWork.emoji === '💼' && impWork.color === '#ff0000',
  'imported space keeps name, emoji and Arc color');
check(impWork.pinned.length === 4, 'favorites prepended to pinned', impWork.pinned.length);
const docs = impWork.pinned.find((n) => n.url === 'https://docs.example/');
check(docs && docs.pinnedUrl === docs.url && docs.pinnedTitle === 'Docs' && docs.customTitle === 'My Docs',
  'pinned tabs get pinnedUrl/pinnedTitle and keep renames', docs);
check(impWork.pinned.every((n) => n.type === 'folder' || n.tabId === null)
  && impWork.temp.every((n) => n.tabId === null), 'imported tabs start unloaded');
check(impWork.cookieStoreId === 'firefox-container-1',
  "Arc's Work profile matched the existing Work container by name", impWork.cookieStoreId);
check(impWork2.cookieStoreId === impWork.cookieStoreId,
  'profile name matching ignores case; shared profiles share a container', impWork2.cookieStoreId);
check(impHome.cookieStoreId === 'firefox-default', "Arc's default profile maps to the Default profile");
const hermes = (await browser.contextualIdentities.query({})).find((c) => c.name === 'Hermes');
check(hermes && impSide.cookieStoreId === hermes.cookieStoreId,
  'unknown Arc profile creates a new container with its name', impSide.cookieStoreId);
check(impDirect.cookieStoreId === 'firefox-container-1', 'a hand-picked existing container is used as-is');
check(impBogus.cookieStoreId === 'firefox-default', 'a container that no longer exists falls back to Default');
check(result.profiles === 2, 'summary counts distinct profiles used', result.profiles);

// ---- Editing a pinned tab's URL ----

const sidebar = B.connectSidebar(W1);
const mail = impWork.pinned[0]; // the imported Mail favorite, unloaded, no custom title
await sidebar.cmd('setPinnedUrl', { nodeId: mail.id, url: 'newmail.example/inbox' });
check(mail.pinnedUrl === 'https://newmail.example/inbox' && mail.url === mail.pinnedUrl,
  'setPinnedUrl normalizes a bare domain and updates both URLs', mail);
check(mail.title === 'newmail.example/inbox' && mail.favIconUrl === '',
  'unloaded pin shows its new target instead of the stale title/icon', mail.title);
let rejected = await sidebar.cmd('setPinnedUrl', { nodeId: mail.id, url: 'not a url ::' }).then(() => null, (e) => e);
check(rejected !== null, 'invalid URL is rejected', rejected?.message);
rejected = await sidebar.cmd('setPinnedUrl', { nodeId: impWork.temp[0].id, url: 'https://x.example/' }).then(() => null, (e) => e);
check(rejected !== null, 'editing the URL of a temporary tab is refused');

// ---- Quick switcher search ----

const empty = await sidebar.cmd('quickSearch', { query: '' });
check(empty.length && empty[0].kind === 'space' && empty.some((r) => r.kind === 'tab'),
  'empty query lists spaces first, then recent tabs', empty.slice(0, 3));
const byName = await sidebar.cmd('quickSearch', { query: 'work' });
check(byName[0].kind === 'space' && byName[0].title === 'Work',
  'an exact space name wins the ranking', byName[0]);
const byTab = await sidebar.cmd('quickSearch', { query: 'my docs' });
check(byTab.length && byTab[0].kind === 'tab' && byTab[0].spaceName === 'Work' && byTab[0].pinned === true,
  'tabs are found by custom title, tagged with their space', byTab[0]);
const byUrl = await sidebar.cmd('quickSearch', { query: 'b.example' });
check(byUrl.some((r) => r.kind === 'tab' && r.url === 'https://b.example/'),
  'tabs are found by URL too', byUrl.map((r) => r.url));
const byFolder = await sidebar.cmd('quickSearch', { query: 'research' });
check(byFolder[0]?.kind === 'folder' && byFolder[0].title === 'Research'
  && byFolder[1]?.indent === true && byFolder.filter((r) => r.indent).length === 2,
  'a folder name match groups all its tabs indented under the header', byFolder.slice(0, 4));
const nested = await sidebar.cmd('quickSearch', { query: 'deep' });
check(nested[0]?.kind === 'folder' && nested[0].path.join('/') === 'Research'
  && nested[1]?.indent === true && nested[1].url === 'https://b.example/',
  'nested folders match and carry their breadcrumb path', nested.slice(0, 2));
const findNode = (list, id) => {
  for (const n of list) {
    if (n.id === id) return n;
    if (n.children) { const r = findNode(n.children, id); if (r) return r; }
  }
  return null;
};
const folderNode = state.spaces.map((s) => findNode(s.pinned, byFolder[0].nodeId)).find(Boolean);
folderNode.collapsed = true;
await sidebar.cmd('revealFolder', { nodeId: folderNode.id });
check(folderNode.collapsed === false, 'revealFolder expands a collapsed folder');

const findTabNode = (list, url) => {
  for (const n of list) {
    if (n.type === 'folder') { const r = findTabNode(n.children, url); if (r) return r; }
    else if (n.url === url) return n;
  }
  return null;
};
const deepNode = state.spaces.map((s) => findTabNode(s.pinned, 'https://b.example/')).find(Boolean);
const deepFolder = folderNode.children.find((n) => n.type === 'folder');
folderNode.collapsed = true;
deepFolder.collapsed = true;
await sidebar.cmd('activateNode', { nodeId: deepNode.id });
check(!folderNode.collapsed && !deepFolder.collapsed,
  'activating a tab expands its collapsed ancestor folders');
const refused = await sidebar.cmd('toggleFolder', { nodeId: folderNode.id }).then(() => null, (e) => e);
check(refused !== null && folderNode.collapsed === false,
  'a folder holding the active tab refuses to collapse', refused?.message);

await settle(1200); // the store debounces saves by a second
const saved = B.storage.state;
check(saved && saved.spaces.length === state.spaces.length, 'imported state was persisted');

const err = await B.sendMessage({ type: 'cmd', name: 'importArcSpaces', args: { spaces: [] } }).then(() => null, (e) => e);
check(err !== null, 'empty import is rejected', err);
console.log(failures ? `\n${failures} FAILURES` : '\nAll Arc migration checks passed.');
process.exit(failures ? 1 : 0);
