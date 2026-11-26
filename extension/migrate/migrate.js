import { parseArcSidebar, parseArcProfileNames, countTabs, countFolders } from './arc-parser.js';

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ---- Step 1: where the file lives on this platform --------------------------

const MAC_PATH = '~/Library/Application Support/Arc/StorableSidebar.json';
const WIN_PATH = '%LOCALAPPDATA%\\Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\StorableSidebar.json';
const MAC_STATE_PATH = '~/Library/Application Support/Arc/User Data/Local State';
const WIN_STATE_PATH = '%LOCALAPPDATA%\\Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\User Data\\Local State';

const { os } = await browser.runtime.getPlatformInfo().catch(() => ({ os: '' }));
const arcPath = os === 'win' ? WIN_PATH : MAC_PATH;
const statePath = os === 'win' ? WIN_STATE_PATH : MAC_STATE_PATH;
$('#arc-path').textContent = arcPath;
$('#state-path').textContent = statePath;
$('#path-hint').textContent = os === 'win'
  ? 'Paste the path into the file picker’s name box to jump straight to it. The long folder name can differ slightly between Arc versions; if it’s not found, search for StorableSidebar.json inside %LOCALAPPDATA%\\Packages.'
  : 'In the file picker, press ⌘⇧G, paste the path, and press Enter. The file stays put even after uninstalling Arc.';

for (const [btn, text] of [['#copy-path', arcPath], ['#copy-state-path', statePath]]) {
  $(btn).addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied'),
      () => toast('Couldn’t copy. Select the text and copy it by hand.'),
    );
  });
}

// ---- Step 2: parse and preview ----------------------------------------------

let parsed = null;              // { spaces, favorites, skipped }
let profileNames = null;        // { "Profile 3": "Personal", ... } from Local State
const selected = new Set();     // indexes into parsed.spaces

// Existing Firefox containers, for the profile-mapping dropdowns.
const containers = await browser.contextualIdentities.query({}).catch(() => []);

// Where each Arc profile should land. Keyed by profile directory ('' = Arc's default
// profile); values are 'new', 'default', or an existing container's cookieStoreId.
// Only holds choices the user made by hand — everything else follows the auto match,
// which can improve when Local State arrives with the real profile names.
const profileChoice = new Map();

const dirKey = (space) => space.profileDir || '';
const dirDisplayName = (dir) => (dir ? profileNames?.[dir] || dir : 'Default');

function autoChoice(dir) {
  if (!dir) return 'default';
  const name = dirDisplayName(dir).trim().toLowerCase();
  const match = containers.find((c) => c.name.trim().toLowerCase() === name);
  return match ? match.cookieStoreId : 'new';
}
const choiceOf = (dir) => profileChoice.get(dir) ?? autoChoice(dir);

// One drop zone takes either file: StorableSidebar.json (spaces and tabs) or
// User Data/Local State (profile names). Tell them apart by their content.
async function handleFile(file) {
  const errEl = $('#parse-error');
  errEl.hidden = true;
  let json;
  try {
    json = JSON.parse(await file.text());
  } catch {
    errEl.textContent = 'That file isn’t valid JSON. Make sure you picked StorableSidebar.json itself, not a copy your editor re-saved.';
    errEl.hidden = false;
    return;
  }
  try {
    if (json?.profile?.info_cache) {
      profileNames = parseArcProfileNames(json);
      toast('Profile names loaded');
      if (parsed) renderPreview();
      return;
    }
    parsed = parseArcSidebar(json);
  } catch (err) {
    errEl.textContent = String(err.message || err);
    errEl.hidden = false;
    return;
  }
  selected.clear();
  parsed.spaces.forEach((_, i) => selected.add(i));
  renderPreview();
}

function renderPreview() {
  $('#step-preview').classList.remove('pending');
  $('#preview-placeholder').hidden = true;
  $('#preview').hidden = false;

  const total = parsed.spaces.reduce((n, s) => n + countTabs(s.pinned) + s.temp.length, 0);
  $('#found-summary').textContent =
    `Found ${parsed.spaces.length} space${parsed.spaces.length === 1 ? '' : 's'} with ${total} tabs.`;

  $('#space-list').replaceChildren(...parsed.spaces.map((s, i) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = selected.has(i);
    box.addEventListener('change', () => {
      box.checked ? selected.add(i) : selected.delete(i);
      renderImportStep();
    });
    const pinned = countTabs(s.pinned);
    const folders = countFolders(s.pinned);
    const parts = [`${pinned} pinned`];
    if (folders) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
    parts.push(`${s.temp.length} today`);
    return h('label', { class: 'space-row' },
      box,
      h('span', { class: 'emoji', style: !s.emoji && s.color ? `color:${s.color}` : null }, s.emoji || '●'),
      h('span', { class: 'name' }, s.name),
      h('span', { class: 'profile' }, dirDisplayName(dirKey(s))),
      h('span', { class: 'counts' }, parts.join(' · ')));
  }));

  // Profiles whose display name we don't know yet (it lives in the Local State file).
  const unnamed = [...new Set(parsed.spaces.map((s) => s.profileDir).filter(Boolean))]
    .filter((dir) => !profileNames?.[dir]);
  $('#names-row').hidden = !unnamed.length;
  if (unnamed.length) $('#names-fallback').textContent = `“${unnamed.join('”, “')}”`;

  renderProfileMap();

  if (parsed.favorites.length) {
    $('#opt-favs-row').hidden = false;
    $('#opt-favs-label').textContent =
      `Add Arc’s ${parsed.favorites.length} favorites to the top of each imported space’s pinned tabs (Arc showed them in every space)`;
  } else {
    $('#opt-favs-row').hidden = true;
  }

  const skippedNote = $('#skipped-note');
  skippedNote.hidden = !parsed.skipped;
  if (parsed.skipped) {
    skippedNote.textContent = `${parsed.skipped} item${parsed.skipped === 1 ? '' : 's'} can’t come along — Easels, notes and other Arc-only things, or pages that aren’t web links.`;
  }

  renderImportStep();
}

// One row per distinct Arc profile: its name, and a dropdown picking the Firefox
// profile it maps to. The auto match is preselected; any change sticks.
function renderProfileMap() {
  $('#profile-map').hidden = !$('#opt-profiles').checked;
  const dirs = [...new Set(parsed.spaces.map(dirKey))];
  $('#profile-rows').replaceChildren(...dirs.map((dir) => {
    const display = dirDisplayName(dir);
    const sel = h('select', { 'aria-label': `Firefox profile for Arc's ${display} profile` },
      dir ? h('option', { value: 'new' }, `New profile “${display}”`) : null,
      h('option', { value: 'default' }, 'Default profile'),
      ...containers.map((c) => h('option', { value: c.cookieStoreId }, `Existing: ${c.name}`)));
    sel.value = choiceOf(dir);
    sel.addEventListener('change', () => {
      profileChoice.set(dir, sel.value);
      renderImportStep();
    });
    const spaceCount = parsed.spaces.filter((s) => dirKey(s) === dir).length;
    return h('div', { class: 'map-row' },
      h('span', { class: 'map-name' }, display,
        h('span', { class: 'map-count' }, ` ${spaceCount} space${spaceCount === 1 ? '' : 's'}`)),
      h('span', { class: 'map-arrow' }, '→'),
      sel);
  }));
}

$('#select-all').addEventListener('click', () => {
  parsed.spaces.forEach((_, i) => selected.add(i));
  renderPreview();
});
$('#select-none').addEventListener('click', () => {
  selected.clear();
  renderPreview();
});
$('#opt-today').addEventListener('change', renderImportStep);
$('#opt-favs').addEventListener('change', renderImportStep);
$('#opt-profiles').addEventListener('change', () => {
  $('#profile-map').hidden = !$('#opt-profiles').checked;
  renderImportStep();
});
$('#pick-names').addEventListener('click', () => $('#file').click());

// ---- Step 3: import ----------------------------------------------------------

function buildSpecs() {
  const includeToday = $('#opt-today').checked;
  const includeFavs = !$('#opt-favs-row').hidden && $('#opt-favs').checked;
  const recreate = $('#opt-profiles').checked;
  const profileFor = (s) => {
    if (!recreate) return null;
    const choice = choiceOf(dirKey(s));
    if (choice === 'default') return null;
    if (choice === 'new') return { name: dirDisplayName(dirKey(s)) };
    return { cookieStoreId: choice };
  };
  return parsed.spaces
    .filter((_, i) => selected.has(i))
    .map((s) => ({
      name: s.name,
      emoji: s.emoji,
      color: s.color,
      profile: profileFor(s),
      pinned: includeFavs ? [...parsed.favorites, ...s.pinned] : s.pinned,
      temp: includeToday ? s.temp : [],
    }));
}

function renderImportStep() {
  const specs = parsed ? buildSpecs() : [];
  const step = $('#step-import');
  if (!specs.length) {
    step.classList.add('pending');
    $('#import-box').hidden = true;
    $('#import-placeholder').hidden = false;
    return;
  }
  const tabs = specs.reduce((n, s) => n + countTabs(s.pinned) + s.temp.length, 0);
  step.classList.remove('pending');
  $('#import-placeholder').hidden = true;
  $('#import-box').hidden = false;
  $('#import-summary').textContent =
    `${specs.length} space${specs.length === 1 ? '' : 's'} and ${tabs} tabs will be added to your Spaces sidebar. Your existing spaces aren’t touched.`;
}

$('#import-btn').addEventListener('click', async () => {
  const btn = $('#import-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const result = await browser.runtime.sendMessage({
      type: 'cmd',
      name: 'importArcSpaces',
      args: { spaces: buildSpecs() },
    });
    $('#import-box').hidden = true;
    $('#result').hidden = false;
    $('#result-text').textContent =
      `Done — ${result.spaces} space${result.spaces === 1 ? '' : 's'} and ${result.tabs} tabs imported`
      + (result.profiles ? `, across ${result.profiles} profile${result.profiles === 1 ? '' : 's'}. 🎉` : '. 🎉');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Import into Spaces';
    toast(`Import failed: ${String(err?.message || err)}`);
  }
});

// ---- File picking ------------------------------------------------------------

$('#pick').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', () => {
  if ($('#file').files[0]) handleFile($('#file').files[0]);
});

const drop = $('#drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer.files?.[0];
  if (file) handleFile(file);
});
