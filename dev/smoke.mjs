// Drives the real background code against the fake browser.
//   node dev/smoke.mjs            -> fresh-install scenario, writes a snapshot
//   node dev/smoke.mjs restart    -> simulates a Firefox restart from that snapshot
import { createFakeBrowser, settle } from './fake-browser.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const SNAP = new URL('./.snapshot.json', import.meta.url);
const mode = process.argv[2] || 'fresh';
let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};
const DAY = 86400000;

process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e); failures++; });
const origError = console.error;
console.error = (...a) => { origError('CONSOLE.ERROR', ...a); failures++; };

if (mode === 'fresh') {
  const { browser, helpers: B } = createFakeBrowser();
  globalThis.browser = browser;
  const W1 = B.addWindow();
  const A = B.seedTab({ windowId: W1, url: 'https://example.com/', title: 'Example', active: true });
  const Bt = B.seedTab({ windowId: W1, url: 'https://work.example/', title: 'Work site', cookieStoreId: 'firefox-container-1' });
  const P = B.seedTab({ windowId: W1, url: 'https://mail.example/', title: 'Mail', pinned: true });
  B.seedTab({ windowId: W1, url: 'https://old.example/', title: 'Old' });

  await import('../extension/background/main.js');
  const { state, entryByTab, getEntry } = await import('../extension/background/store.js');
  const ops = await import('../extension/background/ops.js');
  await settle();

  const names = state.spaces.map((s) => s.name);
  check(names.join() === 'Personal,Work', 'seeded Personal + Work spaces', names);
  const personal = state.spaces[0];
  const work = state.spaces[1];
  check(work.cookieStoreId === 'firefox-container-1', 'Work space uses the Work container');
  check(ops.windowSpace.get(W1) === personal.id, 'window shows the active tab’s space');
  check(B.tabs.get(Bt.id).hidden === true, 'Work tab hidden while in Personal');
  check(!B.tabs.get(P.id).pinned && entryByTab(P.id)?.space === personal, 'Firefox-pinned tab is unpinned into the space');
  check(B.themes.has(W1), 'window got a tinted theme');

  const sb = B.connectSidebar(W1);
  await settle(100);
  const s0 = sb.lastState();
  check(s0?.space?.name === 'Personal' && s0.space.temp.length === 3, 'sidebar receives Personal with 3 temp tabs', s0?.space?.temp?.length);
  check(!('favorites' in s0), 'sidebar state has no favorites');

  // Ctrl+T in Personal, then switch to Work: the untouched new tab should be cleaned up.
  const nt = B.openTab({ windowId: W1, url: 'about:newtab' });
  await settle(100);
  check(!!entryByTab(nt.id) && personal.temp[0].tabId === nt.id, 'new tab joins the top of Personal');
  await sb.cmd('switchSpace', { spaceId: work.id });
  await settle(100);
  check(B.tabs.get(Bt.id).active && !B.tabs.get(Bt.id).hidden, 'switching to Work activates and shows the Work tab');
  check(B.tabs.get(A.id).hidden, 'Personal tab hidden after switch');
  check(!B.tabs.has(nt.id), 'empty new tab in the space we left was closed');

  // Ctrl+T inside Work opens in the default container; it must move into the Work container.
  const nt2 = B.openTab({ windowId: W1, url: 'about:newtab', cookieStoreId: 'firefox-default' });
  await settle(150);
  check(!B.tabs.has(nt2.id), 'default-container new tab was replaced');
  const workNew = [...B.tabs.values()].find((t) => t.url === 'about:newtab' && t.windowId === W1);
  check(workNew?.cookieStoreId === 'firefox-container-1', 'replacement new tab is in the Work container', workNew);
  check(!!(workNew && entryByTab(workNew.id)?.space === work), 'replacement new tab belongs to Work');

  // A link arriving in the wrong container gets reopened in the space's container.
  const ext = B.openTab({ windowId: W1, url: 'about:blank', cookieStoreId: 'firefox-default', active: false });
  await settle(100);
  const res = await B.request(ext.id, 'https://news.example/');
  await settle(150);
  check(res[0]?.cancel === true, 'wrong-container request was cancelled', res);
  const reopened = [...B.tabs.values()].find((t) => t.url === 'https://news.example/');
  check(reopened?.cookieStoreId === 'firefox-container-1', 'request reopened in Work container', reopened);
  const okRes = await B.request(Bt.id, 'https://work.example/page');
  check(!okRes[0]?.cancel, 'right-container request passes through');

  // Pin + folders
  const nodeB = entryByTab(Bt.id).node;
  await sb.cmd('moveNode', { nodeId: nodeB.id, spaceId: work.id, section: 'pinned', parentId: null, index: null });
  check(getEntry(nodeB.id).section === 'pinned' && nodeB.pinnedUrl === 'https://work.example/', 'tab pinned with its pinned URL');
  const folderId = await sb.cmd('createFolder', { spaceId: work.id, parentId: null });
  await sb.cmd('moveNode', { nodeId: nodeB.id, spaceId: work.id, section: 'pinned', parentId: folderId, index: 0 });
  check(getEntry(nodeB.id).parent?.id === folderId, 'tab moved into folder');
  const sub = await sb.cmd('createFolder', { spaceId: work.id, parentId: folderId });
  await sb.cmd('moveNode', { nodeId: folderId, spaceId: work.id, section: 'pinned', parentId: sub, index: 0 });
  check(getEntry(folderId).parent == null, 'folder cannot be dropped inside its own child');
  await sb.cmd('moveNode', { nodeId: sub, spaceId: work.id, section: 'temp', parentId: null, index: 0 }).then(
    () => check(false, 'folder into temp should be rejected'),
    () => check(true, 'folder into temp section is rejected'),
  );
  B.navigate(Bt.id, 'https://work.example/other');
  await settle(100);
  check(sb.lastState().space.pinned[0].children.find((c) => c.id === nodeB.id)?.drifted === true, 'pinned tab shows "drifted" after navigating away');

  // Close pinned tab -> stays as unloaded entry reset to pinned URL; activate reopens it.
  await sb.cmd('closeNode', { nodeId: nodeB.id });
  await settle(100);
  check(!B.tabs.has(Bt.id) && getEntry(nodeB.id) && nodeB.tabId == null, 'closing a pinned tab keeps it, unloaded');
  check(nodeB.url === 'https://work.example/', 'unloaded pinned tab reset to pinned URL');
  await sb.cmd('activateNode', { nodeId: nodeB.id });
  await settle(100);
  const reopenedPinned = B.tabs.get(nodeB.tabId);
  check(reopenedPinned?.url === 'https://work.example/' && reopenedPinned.cookieStoreId === 'firefox-container-1', 'activating unloaded pinned tab reopens it in Work container');

  // New space with a new profile
  const sideId = await sb.cmd('createSpace', { name: 'Side', emoji: '🧪', color: '#30a46c', profile: { create: { name: 'Side', color: 'green' } } });
  await settle(150);
  const side = state.spaces.find((s) => s.id === sideId);
  check(side && side.cookieStoreId.startsWith('firefox-container-') && side.cookieStoreId !== 'firefox-container-1', 'new space got its own new container');
  check(ops.windowSpace.get(W1) === sideId, 'window switched to the new space');
  const sideTab = B.tabs.get(side.temp[0]?.tabId);
  check(sideTab?.active && sideTab.cookieStoreId === side.cookieStoreId, 'empty new space opened a tab in its profile');
  check(B.tabs.get(reopenedPinned.id).hidden, 'Work tabs hidden in Side');

  // Move a Personal tab into Side: it must be reopened in Side's container and become visible.
  const nodeA = entryByTab(A.id).node;
  await sb.cmd('moveNode', { nodeId: nodeA.id, spaceId: sideId, section: 'temp', parentId: null, index: 0 });
  await settle(150);
  const movedA = B.tabs.get(nodeA.tabId);
  check(!B.tabs.has(A.id) && movedA?.cookieStoreId === side.cookieStoreId, 'moved tab reopened in target container');
  check(movedA && !movedA.hidden, 'moved tab visible in current space');

  // Share a profile: point Personal at the Work profile.
  await sb.cmd('updateSpace', { spaceId: personal.id, profile: { cookieStoreId: 'firefox-container-1' } });
  await settle(150);
  const personalLive = personal.temp.map((n) => B.tabs.get(n.tabId)).filter(Boolean);
  check(personalLive.length > 0 && personalLive.every((t) => t.cookieStoreId === 'firefox-container-1' && t.hidden), 'changing a space profile reopens its tabs (still hidden)', personalLive);

  // Clear -> archive -> restore
  await sb.cmd('clearTemp', { spaceId: sideId });
  await settle(150);
  const archive = await sb.cmd('getArchive');
  check(archive.some((a) => a.url === 'https://example.com/'), 'Clear archived the temp tab', archive.map((a) => a.url));
  check(side.temp.length === 1 && B.tabs.get(side.temp[0].tabId)?.active, 'Clear left one fresh new tab in front');
  await sb.cmd('restoreArchive', { id: archive.find((a) => a.url === 'https://example.com/').id });
  await settle(150);
  check(side.temp.some((n) => n.url === 'https://example.com/' && n.tabId != null), 'restored archived tab into current space');

  // Expiry
  const old = personal.temp.find((n) => n.url === 'https://old.example/');
  old.lastActive = Date.now() - 31 * DAY;
  B.fireAlarm('expire');
  await settle(150);
  check(!getEntry(old.id), 'expired temp tab removed from space');
  check(state.archive.some((a) => a.url === 'https://old.example/'), 'expired temp tab is in the archive');

  // Something pins a tab natively (another extension, a keyboard shortcut): it's undone,
  // because pinned tabs would be stuck in the hidden tab strip.
  const ex = side.temp.find((n) => n.url === 'https://example.com/');
  await browser.tabs.update(ex.tabId, { pinned: true });
  await settle(150);
  check(!B.tabs.get(ex.tabId).pinned && getEntry(ex.id)?.space.id === sideId, 'natively pinned tab is unpinned and stays in its space');

  // Closing the last tab of a space must not jump to another space.
  await sb.cmd('switchSpace', { spaceId: personal.id });
  await settle(100);
  for (const n of [...personal.temp]) if (n.tabId != null) B.userClose(n.tabId);
  await settle(200);
  check(ops.windowSpace.get(W1) === personal.id, 'still in Personal after closing all its tabs');
  const act = [...B.tabs.values()].find((t) => t.active && t.windowId === W1);
  check(act && (act.pinned || entryByTab(act.id)?.space === personal), 'front tab belongs to Personal (or is a favorite)', act);

  // Picking a hidden tab directly (all-tabs menu) switches to its space.
  const hiddenWork = B.tabs.get(nodeB.tabId);
  const newPersonal = B.openTab({ windowId: W1, url: 'https://p.example/' });
  await settle(100);
  B.userActivate(hiddenWork.id);
  await settle(150);
  check(ops.windowSpace.get(W1) === work.id, 'activating a hidden Work tab switches to Work');
  check(B.tabs.get(newPersonal.id).hidden, 'Personal tabs hidden again');

  // Second window + tear-off + window close
  const W2 = B.addWindow();
  browser.windows.onCreated.emit({ id: W2, type: 'normal', incognito: false });
  const w2tab = B.openTab({ windowId: W2, url: 'https://w2.example/' });
  await settle(150);
  const w2space = ops.windowSpace.get(W2);
  check(entryByTab(w2tab.id)?.space.id === w2space, 'tab in new window joins that window’s space');
  B.closeWindow(W2);
  await settle(150);
  const w2node = state.spaces.flatMap((s) => s.temp).find((n) => n.url === 'https://w2.example/');
  check(w2node && w2node.tabId == null, 'closing a window keeps its tabs as unloaded entries');

  // Delete a space
  await sb.cmd('deleteSpace', { spaceId: sideId });
  await settle(150);
  check(!state.spaces.some((s) => s.id === sideId), 'space deleted');
  check([...B.tabs.values()].every((t) => t.cookieStoreId !== side.cookieStoreId || t.pinned), 'deleted space’s tabs closed');
  await sb.cmd('deleteProfile', { cookieStoreId: 'firefox-container-1' }).then(
    () => check(false, 'deleting an in-use profile should fail'),
    () => check(true, 'deleting an in-use profile is refused'),
  );

  // Rename / reorder / settings
  await sb.cmd('renameNode', { nodeId: nodeB.id, title: 'Dashboard' });
  await sb.cmd('reorderSpaces', { order: [work.id, personal.id] });
  await sb.cmd('updateSettings', { patch: { tintWindow: false } });
  await settle(100);
  check(nodeB.customTitle === 'Dashboard' && state.spaces[0] === work && !B.themes.has(W1), 'rename, reorder and tint toggle work');

  // Order sync: real tab order follows the sidebar.
  await settle(400);
  const wOrder = [...B.tabs.values()].filter((t) => t.windowId === W1 && !t.pinned && entryByTab(t.id)?.space === work)
    .sort((a, b) => a.index - b.index).map((t) => entryByTab(t.id).node.id);
  const { spaceTabNodes } = await import('../extension/background/store.js');
  const want = spaceTabNodes(work).filter((n) => n.tabId != null && B.tabs.get(n.tabId)?.windowId === W1).map((n) => n.id);
  check(wOrder.join() === want.join(), 'real tab order matches the sidebar order', { wOrder, want });

  await settle(1300); // let the debounced save run
  writeFileSync(SNAP, JSON.stringify({ snap: B.snapshot(), work: work.id, personal: personal.id, W1 }));
  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'} (fresh)`);
  process.exit(failures ? 1 : 0);
}

if (mode === 'restart') {
  const { snap, work, personal, W1 } = JSON.parse(readFileSync(SNAP, 'utf8'));
  // Session restore gives every tab a new id but keeps its session values.
  const remap = new Map(snap.tabs.map((t) => [t.id, t.id + 5000]));
  snap.tabs = snap.tabs.map((t) => ({ ...t, id: remap.get(t.id) }));
  snap.tabValues = snap.tabValues.filter(([id]) => remap.has(id)).map(([id, v]) => [remap.get(id), v]);
  snap.nextTabId += 6000;
  const { browser, helpers: B } = createFakeBrowser(snap);
  globalThis.browser = browser;
  await import('../extension/background/main.js');
  const { state, entryByTab, spaceTabNodes } = await import('../extension/background/store.js');
  const ops = await import('../extension/background/ops.js');
  await settle();

  const unpinned = [...B.tabs.values()].filter((t) => !t.pinned);
  check(unpinned.every((t) => entryByTab(t.id)), 'every restored tab re-linked to a node', unpinned.filter((t) => !entryByTab(t.id)).map((t) => t.url));
  const linked = state.spaces.flatMap(spaceTabNodes).filter((n) => n.tabId != null).length;
  check(linked === unpinned.length, 'no duplicate nodes created on restart', { linked, tabs: unpinned.length });
  check(ops.windowSpace.get(W1) === work, 'window restored to its space');
  const visibleWrong = unpinned.filter((t) => !t.hidden && entryByTab(t.id).space.id !== work);
  check(!visibleWrong.length, 'only the current space’s tabs are visible after restart', visibleWrong.map((t) => t.url));
  check(state.spaces.find((s) => s.id === work).pinned.length > 0, 'pinned structure survived restart');
  check(state.spaces.some((s) => s.id === personal), 'spaces survived restart');
  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'} (restart)`);
  process.exit(failures ? 1 : 0);
}
