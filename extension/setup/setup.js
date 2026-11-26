import { USERCHROME_CSS, USERCHROME_PREF } from '../shared/constants.js';

const $ = (sel) => document.querySelector(sel);

$('#pref-name').textContent = USERCHROME_PREF;
$('#css').textContent = USERCHROME_CSS;

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

const COPY = { pref: USERCHROME_PREF, css: USERCHROME_CSS };
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(COPY[btn.dataset.copy]).then(
      () => toast('Copied'),
      () => toast('Couldn’t copy. Select the text and copy it by hand.'),
    );
  });
}

$('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([USERCHROME_CSS], { type: 'text/css' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'userChrome.css';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  $('#download-hint').hidden = false;
});

const { os } = await browser.runtime.getPlatformInfo().catch(() => ({ os: '' }));
if (os === 'mac') {
  $('#mac-step').hidden = false;
  $('#mac-folder-hint').hidden = false;
  $('#open-folder-label').textContent = 'Show in Finder';
} else if (os === 'linux') {
  $('#open-folder-label').textContent = 'Open Directory';
}
