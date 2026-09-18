# Phase 3 live validation — 2026-09-18 (dev profile, Zotero 10.0.3)

First ever write by the plugin. Dev profile `reconciler-dev`, auto-sync off, real-account
metadata copy (My Library 4,060 items, 7 groups). Pref
`extensions.zotero-library-reconciler.enableImport = true` set in prefs.js.

## Import

- Preview: 557 works found only in group libraries; 306 flagged with a possible My Library copy
  and unticked. User unticked all, ticked two clean rows, clicked Import 2 Items.
- Result: `Created 2 items in My Library (collection "Reconciler Imports"), skipped 0, failed 0.`
- DB check (copy of zotero.sqlite): two new items in My Library, filed in
  `Reconciler Imports / 2026-09-18 16:49` (collection 24 under 23), each with one
  `owl:sameAs` relation to its group source, fields + creators copied, 0 tags, 0 attachments,
  0 notes. Source items: version, clientDateModified and relation count identical before and
  after (invariant 3).
- **Defect found and fixed:** transaction log write failed with
  `NS_ERROR_FILE_NOT_FOUND` — `IOUtils.writeUTF8` mode `"append"` does not create a missing
  file. The result window showed the WARNING (invariant 8 fail-loud path worked as designed).
  Fixed to `"appendOrCreate"`. The entry for this session was reconstructed by hand from the
  DB (`id … -manual`) so the undo path could be exercised.

## Undo

- `Undo Last Import Session…` listed both titles, Cancel as default button; user chose
  Move to Trash. Result: `Moved 2 imported items to the trash.`
- DB check: both items in `deletedItems` (recoverable), still members of the session
  collection (Zotero keeps membership for trashed items), sources untouched. Log: undo entry
  with both refs, import entry marked `undoneAt`.

## Observations to act on later

- Preview sizing bug (list pushed the buttons off-screen) fixed the same day
  (`min-height: 0`, `flex: 1 1 0`).
- 306/557 flagged is high. `similar-title` (title substitution + shared author) fires on
  clearly different papers by the same author — e.g. one work drew six near-misses. Recall is
  the point here, but the noise makes the warnings easy to ignore. Candidate tuning: cap the
  substitution ratio, or rank/collapse same-author hits. **Done same day:** `similar-title`
  now also needs Jaccard ≥ 0.5 on content words or ≤ 2 differing words; live re-run
  flagged 62 of 557 (was 306).
- Zotero auto-updated 10.0.2 → 10.0.3 overnight and left the proxy-installed plugin
  `appDisabled` in extensions.json; deleting `addonStartup.json.lz4` and restarting fixed it.
- `bootstrap startup` fired twice after that re-enable (ADDON_ENABLE then APP_STARTUP);
  registration is idempotent so no harm, but `runtime.startup()` has no re-entry guard.
