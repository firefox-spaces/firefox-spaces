// Keep the user's keyboard shortcuts across updates and reinstalls of the xpi.
//
// Firefox can drop shortcuts customized in about:addons → Manage Extension Shortcuts
// when the extension is updated or reinstalled, and they come back as the manifest
// defaults. We remember every shortcut the user sets and put it back on startup if
// Firefox has reset it to the default.

const KEY = 'shortcuts';

function defaults() {
  const out = {};
  for (const [name, cmd] of Object.entries(browser.runtime.getManifest().commands || {})) {
    out[name] = new Set(Object.values(cmd.suggested_key || {}));
  }
  return out;
}

async function remember(name, shortcut) {
  const { [KEY]: saved = {} } = await browser.storage.local.get(KEY);
  saved[name] = shortcut || '';
  await browser.storage.local.set({ [KEY]: saved });
}

export async function restoreShortcuts() {
  if (!browser.commands?.getAll) return;
  try {
    const { [KEY]: saved = {} } = await browser.storage.local.get(KEY);
    const dflt = defaults();
    let changed = false;
    // The quick switcher's command was "quick-search" before it moved to the toolbar popup.
    if ('quick-search' in saved) {
      if (saved._execute_browser_action === undefined) saved._execute_browser_action = saved['quick-search'];
      delete saved['quick-search'];
      changed = true;
    }
    for (const cmd of await browser.commands.getAll()) {
      const current = cmd.shortcut || '';
      const want = saved[cmd.name];
      if (want === undefined) {
        saved[cmd.name] = current;
        changed = true;
      } else if (want !== current) {
        const isDefault = !current || dflt[cmd.name]?.has(current);
        if (isDefault) {
          await browser.commands.update({ name: cmd.name, shortcut: want })
            .catch((err) => console.warn('[Spaces] could not restore shortcut', cmd.name, err));
        } else {
          saved[cmd.name] = current;
          changed = true;
        }
      }
    }
    if (changed) await browser.storage.local.set({ [KEY]: saved });
  } catch (err) {
    console.warn('[Spaces] shortcut restore failed', err);
  }
}

export function watchShortcuts() {
  browser.commands?.onChanged?.addListener(({ name, newShortcut }) => {
    remember(name, newShortcut).catch(() => {});
  });
}
