# Spaces for Firefox

Arc-style Spaces as a Firefox extension: a vertical tab sidebar with spaces, nested folders, pinned and auto-archiving tabs, and per-space **profiles** (Firefox containers) with their own cookies and logins.

## Install (for testing)

1. Install Firefox (142 or newer).
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `extension/manifest.json`.
3. The Spaces sidebar opens automatically. If it doesn't, use View → Sidebar → Spaces.
4. The first time it hides tabs, Firefox shows a notice saying an extension is hiding tabs. Keep it enabled.

Temporary add-ons are removed when Firefox quits, so spaces may not survive a restart in this mode. For daily use, install it permanently. Either sign it for free as an *unlisted* add-on on addons.mozilla.org (`web-ext sign`), or use Firefox Developer Edition with `xpinstall.signatures.required` set to `false`.

After editing code, click **Reload** on the add-on in `about:debugging`. The sidebar reconnects on its own.

### Hide Firefox's own tab strip

The sidebar is meant to replace the tab bar. Firefox doesn't let extensions hide it, so the sidebar recommends it once with a **Show me how** prompt, which opens a step-by-step setup page (also under ⚙ Settings). By hand, it's `userChrome.css`:

1. In `about:config`, set `toolkit.legacyUserProfileCustomizations.stylesheets` to `true`.
2. In `about:support`, click **Open Folder** next to *Profile Folder*. Create a `chrome` folder and copy [`extras/userChrome.css`](extras/userChrome.css) into it.
3. Restart Firefox. On macOS, turn on **Title Bar** under Customize Toolbar so the window buttons stay visible.

The CSS hides the horizontal tab strip, the title bar above the sidebar, and the container (profile) label in the address bar. The sidebar never shows which container a space uses either. Keep Firefox's own vertical tabs turned off.

On macOS, **Show in Finder** opens the folder *around* the profile with the profile highlighted. The `chrome` folder goes inside the highlighted folder, not next to it.

### Import from Arc

⚙ Settings → **Import from Arc** opens a wizard that reads Arc's `StorableSidebar.json` (you pick the file; nothing leaves your machine) and recreates your Arc spaces: pinned tabs with their nested folders, favorites, and today's tabs. Arc's profiles come along too — each space keeps its profile grouping, matched to your Firefox containers by name (Arc's "Work" lands in a "Work" profile, reused if it already exists), and the wizard shows the mapping so you can point any Arc profile at a different Firefox profile, a new one, or Default. Add Arc's `User Data/Local State` file in the wizard to carry the profile names over. Imported tabs arrive unloaded and load the first time you click them, so importing hundreds of tabs is free until you use them. Optionally each imported space gets its own profile.

### Save to Firefox profile (sync between computers)

Everything Spaces knows lives in the extension's own storage, which Firefox deletes if the extension is removed and never syncs. ⚙ Settings → **Save to Firefox profile** (off by default) also keeps your spaces in your bookmarks, under Other Bookmarks → Spaces: one folder per space with its pinned tabs and nested folders, a *Temporary tabs* folder for its open tabs, and small data bookmarks holding each space's icon, color and profile plus your settings. Bookmarks are part of the Firefox profile, so the copy survives reinstalling Spaces, and Firefox Sync carries it between computers.

Turn it on on each computer and changes are merged both ways, like a git merge: Spaces compares what it last wrote, what's here now and what the folder holds now. A change made on one computer is applied on the other; when both changed the same thing, the most recent edit wins. Tabs deleted on another computer go to the Archive (so nothing is lost), and a tab that's open on this computer is never closed by a change from elsewhere. The first time a computer joins, spaces with the same name are combined rather than duplicated. Edit spaces in the sidebar, not in that bookmarks folder. Turning the option on asks for permission to use bookmarks; Spaces doesn't request it otherwise. With syncing off, **Restore from profile** imports the saved copy once.

## How it works

| Concept | What it is |
|---|---|
| **Space** | A named set of tabs with an icon and color. Each window shows one space. The others' tabs are hidden, not closed, so switching is instant. |
| **Profile** | A Firefox container: separate cookies, logins and site storage. Each space picks one, and spaces can share one. New spaces default to a new profile of their own. |
| **Pinned tabs** | Top section. They stay until you remove them, can be organized into nested folders, and remember their pinned URL. Closing one only unloads it. ↩ returns a pinned tab to its original page. |
| **Temporary tabs** | Below the divider. Archived after a period of inactivity (30 days by default; 12h, 24h, 7d or never in Settings). **Clear** archives them all at once. |
| **Archive** | Expired and cleared tabs, searchable and restorable for 30 days. |

Firefox's own pinned tabs aren't used: they'd be stuck in the hidden tab strip, so any tab pinned that way is unpinned and joins the current space.

Tabs always open in their space's profile. Ctrl/Cmd+T, links from other apps, and tabs dragged in from another window are all moved into the right container automatically.

### Controls

- **Click** a tab to open it (unloaded tabs load on click). **Middle-click** or **×** closes it.
- **Double-click** a tab, folder or the space name to rename it.
- **Right-click** anything for more actions: pin/unpin, move to another space, unload, new folder, edit/delete space.
- **Drag** tabs and folders to reorder them, pin or unpin (drag across the divider), or nest them into folders. Drop a tab on a space dot to move it to that space. Drag dots to reorder spaces.
- **Quick switcher**: Ctrl+Shift+Space (Cmd+Shift+Space on Mac), or the Spaces toolbar button, opens a popup that searches every space, every tab (pinned and temporary, in any space) and the archive. Enter jumps there — switching spaces, waking sleeping tabs, or restoring archived ones as needed. With nothing typed it lists your spaces and most recent tabs.
- **Switch spaces** by clicking a dot, swiping sideways with two fingers over the sidebar, or pressing Ctrl+Alt+←/→ (Control+Option on Mac).
- **Ctrl+Tab between your two most recent tabs**: enable Firefox's own Settings → General → *Ctrl+Tab cycles through tabs in recently used order*. Firefox reserves Ctrl+Tab, so extensions can't rebind it, but the built-in behavior stays within the current space (hidden tabs are skipped).
- **Show or hide the sidebar** with Ctrl+Alt+S (Control+Option+S on Mac). Shortcuts can be changed in `about:addons` → ⚙ → Manage Extension Shortcuts.

## Limitations

- **Per-space extensions are impossible.** No browser exposes that to extensions. Profiles isolate cookies, logins and site data. History, bookmarks, passwords and extensions are shared.
- **Changing a space's profile reopens its open tabs** in the new container, because a tab can't change containers. Unsaved form input in those tabs is lost.
- A form submission (POST) that lands in the wrong container is allowed through rather than reopened, so no data gets dropped.
- Hidden tabs still use memory until Firefox unloads them. Right-click → **Unload tab** frees one right away.

## Development

```
npm test     # runs the background logic against a fake browser (dev/fake-browser.mjs)
```

The tests simulate a fresh install and a Firefox restart, which gives every tab a new id. They cover switching, container enforcement, pinning and folders, archiving and expiry, multiple windows and re-linking after restart. The sidebar UI isn't covered, so test it by hand in Firefox.

```
extension/
  manifest.json
  background/
    main.js       startup, listener wiring, sidebar connection
    store.js      persistent model (spaces, tab/folder trees, archive, settings)
    ops.js        live browser state: switching, hide/show, container reopening, theme, tab order
    events.js     tab/window/request event handlers
    commands.js   actions the sidebar can request
    archive.js    expiry and archiving
    backup.js     sync through Firefox bookmarks ("Save to Firefox profile"): three-way merge
    view.js       per-window view model pushed to the sidebar
    queue.js      serial queue so handlers never interleave
    shortcuts.js  keeps customized keyboard shortcuts across updates
    theme.js      per-space window tint
  sidebar/        sidebar.html / .css / .js and icons
  popup/          quick switcher (toolbar popup, so it gets keyboard focus)
  shared/constants.js
extras/userChrome.css
```
