// Tests "Save to Firefox profile" (background/backup.js) through the fake browser.
//   node dev/backup-test.mjs           -> one computer: saving, incremental updates,
//                                         another computer's copy, restore; writes a
//                                         bookmark snapshot
//   node dev/backup-test.mjs device2   -> a second computer that gets those bookmarks
//                                         through Firefox Sync and restores from them
import { createFakeBrowser, settle } from './fake-browser.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const SNAP = new URL('./.bm-snapshot.json', import.meta.url);
const mode = process.argv[2] || 'device1';
const DAY = 86400000;
let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e); failures++; });

const META_PREFIX = 'https://spaces-sidebar.invalid/backup#';
const readMeta = (folder) => {
  const b = folder.children.find((c) => c.url?.startsWith(META_PREFIX));
  return b && JSON.parse(decodeURIComponent(b.url.slice(META_PREFIX.length)));
};
const SPACE_PREFIX = 'https://spaces-sidebar.invalid/space#';
const spaceData = (folder) => {
  const b = folder.children.find((c) => c.url?.startsWith(SPACE_PREFIX));
  return b && JSON.parse(decodeURIComponent(b.url.slice(SPACE_PREFIX.length)));
};
const spacesFolder = (B) => B.bookmarkTree('unfiled_____').children.find((c) => c.title === 'Spaces' && c.children);
const opsSince = (B, before) => Object.fromEntries(Object.entries(B.bmOps).map(([k, v]) => [k, v - before[k]]));

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await settle(20);
  }
  return false;
}

async function boot(snapshot, seedUrl) {
  const { browser, helpers: B } = createFakeBrowser(snapshot);
  globalThis.browser = browser;
  const W1 = B.addWindow();
  B.seedTab({ windowId: W1, url: seedUrl, title: 'Seed', active: true });
  await import('../extension/background/main.js');
  const store = await import('../extension/background/store.js');
  await settle();
  return { B, W1, store, sidebar: B.connectSidebar(W1) };
}

// Waits for a save that finishes after the given moment.
const saved = (state, after) => waitFor(() => state.backupStatus && !state.backupStatus.running
  && (state.backupStatus.checkedAt || 0) >= after);

if (mode === 'device1') {
  const { B, store, sidebar } = await boot(null, 'https://example.com/');
  const { state } = store;

  await B.sendMessage({
    type: 'cmd',
    name: 'importArcSpaces',
    args: {
      spaces: [
        {
          name: 'Home', emoji: '🏠', color: '#30a46c', profile: { name: 'Hobby' },
          pinned: [
            { type: 'tab', url: 'https://a.example/', title: 'A' },
            {
              type: 'folder', title: 'Infra', collapsed: true, children: [
                { type: 'tab', url: 'https://px.example/04', title: '04', customTitle: 'Proxmox 04' },
                { type: 'folder', title: 'Deep', children: [{ type: 'tab', url: 'https://deep.example/', title: 'Deep' }] },
              ],
            },
          ],
          temp: [{ type: 'tab', url: 'https://t.example/', title: 'T' }],
        },
        { name: 'Work', profile: { name: 'Work' }, pinned: [{ type: 'tab', url: 'https://w.example/', title: 'W' }], temp: [] },
      ],
    },
  });
  await sidebar.cmd('updateSettings', { patch: { expiryMs: 7 * DAY } });
  await settle();

  // ---- Turned on without the permission ----
  let t0 = Date.now();
  await sidebar.cmd('updateSettings', { patch: { profileBackup: true } });
  await saved(state, t0);
  check(/permission/i.test(state.backupStatus?.error || ''), 'without bookmarks access, saving reports why', state.backupStatus);
  check(!spacesFolder(B), 'nothing is written without the permission');

  // ---- First save ----
  B.grant('bookmarks');
  t0 = Date.now();
  await sidebar.cmd('backupNow');
  await saved(state, t0);
  check(state.backupStatus?.at && !state.backupStatus.error, 'first save succeeds', state.backupStatus);
  let root = spacesFolder(B);
  check(!!root, 'a Spaces folder is created in Other Bookmarks');
  const titles = root.children.filter((c) => c.children).map((c) => c.title);
  check(JSON.stringify(titles) === JSON.stringify(state.spaces.map((s) => `${s.emoji || ''} ${s.name}`.trim())),
    'one folder per space, in order, named with its icon', titles);
  const home = root.children.find((c) => c.title === '🏠 Home');
  const infra = home.children.find((c) => c.title === 'Infra');
  check(home.children[0].url === 'https://a.example/' && infra?.children[0].title === 'Proxmox 04'
    && infra.children[1].children?.[0].url === 'https://deep.example/',
  'pinned tabs and nested folders are mirrored, renamed tabs keep their name', home.children.map((c) => c.title));
  const temp = home.children.find((c) => c.title === 'Temporary tabs');
  check(temp?.children[0].url === 'https://t.example/', 'open tabs go in a Temporary tabs folder');
  const meta = readMeta(root);
  check(root.children[root.children.length - 1].url?.startsWith(META_PREFIX), 'the sync data bookmark sits last in the folder');
  check(meta?.device === state.deviceId && meta.settings.expiryMs === 7 * DAY, 'sync data records this computer and the settings', meta);
  const homeMeta = spaceData(home);
  check(homeMeta?.profile === 'Hobby' && homeMeta.color === '#30a46c' && homeMeta.emoji === '🏠',
    'space icon, color and profile name are recorded with the space', homeMeta);
  check(homeMeta.collapsed.includes(infra.id) && homeMeta.renamed.includes(infra.children[0].id), 'collapsed folders and renamed tabs are recorded');

  // ---- Incremental updates ----
  let before = { ...B.bmOps };
  t0 = Date.now();
  await sidebar.cmd('backupNow');
  await settle(300);
  let d = opsSince(B, before);
  check(d.create + d.update + d.move + d.remove === 0, 'saving with no changes touches no bookmarks', d);

  const homeSpace = state.spaces.find((s) => s.name === 'Home');
  const aNode = homeSpace.pinned[0];
  before = { ...B.bmOps };
  t0 = Date.now();
  await sidebar.cmd('setPinnedUrl', { nodeId: aNode.id, url: 'https://a2.example/' });
  await sidebar.cmd('backupNow');
  await saved(state, t0);
  d = opsSince(B, before);
  root = spacesFolder(B);
  check(root.children.find((c) => c.title === '🏠 Home').children[0].url === 'https://a2.example/'
    && d.create === 0 && d.remove === 0 && d.update <= 2, 'changing one tab updates its bookmark, not the folder', d);

  const pinnedOrder = homeSpace.pinned.map((n) => n.id);
  before = { ...B.bmOps };
  t0 = Date.now();
  await sidebar.cmd('moveNode', { nodeId: pinnedOrder[1], spaceId: homeSpace.id, section: 'pinned', index: 0 });
  await sidebar.cmd('backupNow');
  await saved(state, t0);
  d = opsSince(B, before);
  root = spacesFolder(B);
  check(root.children.find((c) => c.title === '🏠 Home').children[0].title === 'Infra' && d.create === 0 && d.remove === 0,
    'reordering moves bookmarks instead of recreating them', d);

  const work = state.spaces.find((s) => s.name === 'Work');
  t0 = Date.now();
  await sidebar.cmd('deleteSpace', { spaceId: work.id });
  await sidebar.cmd('backupNow');
  await saved(state, t0);
  root = spacesFolder(B);
  check(!root.children.some((c) => c.title === 'Work'), 'a deleted space’s folder is removed');

  // ---- Changes from another computer, as Firefox Sync would apply them ----
  let homeF = spacesFolder(B).children.find((c) => c.title === '🏠 Home');
  const aBm = homeF.children.find((c) => c.url === 'https://a2.example/');
  const tBm = homeF.children.find((c) => c.title === 'Temporary tabs').children[0];
  await browser.bookmarks.update(aBm.id, { title: 'A from laptop', url: 'https://laptop.example/' });
  await browser.bookmarks.remove(tBm.id);
  await browser.bookmarks.create({ parentId: homeF.id, index: 0, title: 'New on laptop', url: 'https://new.example/' });
  t0 = Date.now();
  await sidebar.cmd('backupNow');
  await saved(state, t0);
  check(aNode.pinnedUrl === 'https://laptop.example/' && aNode.pinnedTitle === 'A from laptop', 'an edit from another computer is merged in', aNode);
  check(homeSpace.pinned[0].url === 'https://new.example/' && homeSpace.pinned[0].tabId === null,
    'a tab added on another computer appears here, unloaded', homeSpace.pinned.map((n) => n.title));
  check(!homeSpace.temp.some((n) => n.url === 'https://t.example/') && state.archive.some((a) => a.url === 'https://t.example/'),
    'a tab deleted on another computer goes to the Archive here');

  // Both computers renamed the same tab: the most recent edit wins.
  homeF = spacesFolder(B).children.find((c) => c.title === '🏠 Home');
  const setRemote = async (title, at) => {
    const dataBm = homeF.children.find((c) => c.url?.startsWith(SPACE_PREFIX));
    const data = spaceData(homeF);
    data.at[aBm.id] = at;
    await browser.bookmarks.update(dataBm.id, { url: SPACE_PREFIX + encodeURIComponent(JSON.stringify(data)) });
    await browser.bookmarks.update(aBm.id, { title });
  };
  await setRemote('Older remote name', Date.now() - 3600000);
  t0 = Date.now();
  await sidebar.cmd('renameNode', { nodeId: aNode.id, title: 'Newer local name' });
  await sidebar.cmd('backupNow');
  await saved(state, t0);
  homeF = spacesFolder(B).children.find((c) => c.title === '🏠 Home');
  check(aNode.customTitle === 'Newer local name' && homeF.children.find((c) => c.id === aBm.id)?.title === 'Newer local name',
    'when both changed it, the newer local edit wins everywhere', aNode);
  await sidebar.cmd('renameNode', { nodeId: aNode.id, title: 'Older local name' });
  await setRemote('Newer remote name', Date.now() + 3600000);
  t0 = Date.now();
  await sidebar.cmd('backupNow');
  await saved(state, t0);
  check(aNode.customTitle === 'Newer remote name', 'when both changed it, the newer remote edit wins', aNode);

  writeFileSync(SNAP, JSON.stringify(B.bookmarkSnapshot()));

  // ---- Restore on the same computer ----
  await sidebar.cmd('updateSettings', { patch: { profileBackup: false } });
  await sidebar.cmd('deleteSpace', { spaceId: homeSpace.id });
  await sidebar.cmd('updateSettings', { patch: { expiryMs: DAY } });
  const r = await sidebar.cmd('restoreBackup');
  const back = state.spaces.find((s) => s.name === 'Home');
  check(r.spaces === 1 && r.skipped.includes('Personal'), 'restore adds missing spaces and leaves non-empty ones alone', r);
  const backInfra = back?.pinned.find((n) => n.type === 'folder');
  check(back && back.emoji === '🏠' && back.color === '#30a46c' && backInfra?.collapsed === true
    && backInfra.children[0].customTitle === 'Proxmox 04' && backInfra.children[0].tabId === null,
  'a restored space keeps its icon, color, folders, collapsed state and names, unloaded', back?.pinned);
  check(back?.pinned.some((n) => n.url === 'https://new.example/'), 'tabs added on other computers come back too');
  const hobby = (await browser.contextualIdentities.query()).find((c) => c.name === 'Hobby');
  check(back?.cookieStoreId === hobby?.cookieStoreId, 'the restored space uses its profile again');
  check(state.settings.expiryMs === 7 * DAY, 'saved settings are restored');

  // ---- Permission taken away ----
  await sidebar.cmd('updateSettings', { patch: { profileBackup: true } });
  B.revoke('bookmarks');
  await settle(200);
  check(state.settings.profileBackup === false, 'revoking bookmarks access turns saving off');

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'} (profile backup)`);
  process.exit(failures ? 1 : 0);
}

if (mode === 'device2') {
  const bookmarks = JSON.parse(readFileSync(SNAP, 'utf8'));
  const { B, store, sidebar } = await boot({ bookmarks }, 'about:newtab');
  const { state } = store;
  B.grant('bookmarks');

  const before = { ...B.bmOps };
  const t0 = Date.now();
  await sidebar.cmd('updateSettings', { patch: { profileBackup: true } });
  await saved(state, t0);
  const d = opsSince(B, before);
  check(state.backupStatus?.at && !state.backupStatus.error, 'turning sync on next to a synced copy merges it', state.backupStatus);
  const names = state.spaces.map((s) => s.name);
  check(names.includes('Home') && names.filter((n) => n === 'Personal').length === 1,
    'the other computer’s spaces arrive, and same-named spaces merge instead of doubling', names);
  const home = state.spaces.find((s) => s.name === 'Home');
  const hobby = (await browser.contextualIdentities.query()).find((c) => c.name === 'Hobby');
  check(hobby && home?.cookieStoreId === hobby.cookieStoreId, 'a missing profile is created with its saved name', hobby);
  check(state.settings.expiryMs === 7 * DAY, 'settings follow the copy to the new computer');
  const personal = state.spaces.find((s) => s.name === 'Personal');
  check(personal.temp.some((n) => n.url === 'https://example.com/'), 'the merged space gets the other computer’s tabs');
  check(readMeta(spacesFolder(B)).device === state.deviceId && d.create === 0 && d.remove === 0,
    'joining adopts the existing bookmarks instead of rewriting them', d);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'} (profile backup, second computer)`);
  process.exit(failures ? 1 : 0);
}
