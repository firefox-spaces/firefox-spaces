# AMO listing

The text of the add-on's page on addons.mozilla.org. `npm run release` sends these with every submission, so edit them here rather than in the Developer Hub (changes made there are overwritten on the next release):

- `summary.txt` — the one-line summary (250 characters at most)
- `description.txt` — the full description
- `reviewer-notes.txt` — notes to Mozilla's reviewers, only visible to them

The license comes from `package.json`.

`privacy-policy.txt` is **not** sent automatically: the AMO API sets privacy policies through a separate endpoint that `web-ext` doesn't use. Paste it into Developer Hub → Edit Product Page → Privacy Policy when it changes. It matches `docs/privacy.html`.
