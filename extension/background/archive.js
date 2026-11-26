// Temporary tabs that go unused for the expiry period get archived (closed but restorable).

import { state, getEntry, detachNode, uid } from './store.js';
import { liveTabs, isActiveTab, ensureNotActive, isNewTabUrl, windowSpace } from './ops.js';

const ARCHIVE_MAX = 1000;

export async function archiveNode(node) {
  const entry = getEntry(node.id);
  if (!entry) return;
  const tabId = node.tabId;
  const live = tabId != null ? liveTabs.get(tabId) : null;
  if (live && isActiveTab(tabId) && windowSpace.get(live.windowId) === entry.space.id) {
    await ensureNotActive(tabId, live.windowId);
  }
  detachNode(node.id);
  const url = live?.url || node.url;
  if (url && !isNewTabUrl(url) && url !== 'about:blank') {
    state.archive.unshift({
      id: uid('a'),
      url,
      title: node.customTitle || live?.title || node.title || url,
      favIconUrl: live?.favIconUrl || node.favIconUrl || '',
      spaceId: entry.space.id,
      spaceName: entry.space.name,
      archivedAt: Date.now(),
    });
    if (state.archive.length > ARCHIVE_MAX) state.archive.length = ARCHIVE_MAX;
  }
  // The node is gone from the index, so the resulting onRemoved event is a no-op.
  if (tabId != null) await browser.tabs.remove(tabId).catch(() => {});
}

export async function runExpiry() {
  const now = Date.now();
  const { expiryMs, archiveRetentionMs } = state.settings;
  if (expiryMs > 0) {
    for (const space of state.spaces) {
      for (const node of [...space.temp]) {
        const live = node.tabId != null ? liveTabs.get(node.tabId) : null;
        if (live && (isActiveTab(node.tabId) || live.audible)) {
          node.lastActive = now;
          continue;
        }
        const last = node.lastActive || node.createdAt || now;
        if (now - last > expiryMs) await archiveNode(node);
      }
    }
  }
  if (archiveRetentionMs > 0) {
    state.archive = state.archive.filter((a) => now - a.archivedAt <= archiveRetentionMs);
  }
}
