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

## Slice 3 live run (same day, 30 rows)

- Preview: Tick All (557) → Import showed the large-session warning; Untick All → 30 clean
  rows → Import 30 Items. Progress window appeared; session finished in ~1.5 s
  (17:51:30 → 17:51:31), too fast to cancel at this size.
- Result: `Created 30 items … skipped 0, failed 0.` Log entry written normally this time
  (`appendOrCreate`).
- DB: 30 new items, 30 `owl:sameAs` links, all in `Reconciler Imports / 2026-09-18 17:51`,
  0 tags. Debug log shows a handful of DB transactions for the session, not 30: chunking live.
- Undo: `Moved 30 imported items to the trash.` DB: 30 in `deletedItems`; log has the undo
  entry with 30 refs and the import marked `undoneAt`.
- Not exercised live: cancel between chunks (needs a session long enough to click), chunk
  failure → row-by-row retry. Both covered by tests against the recording fake.
- Dark-theme contrast of the amber warnings fixed with `light-dark()`.

## Large live run with Cancel (same day, 495 rows)

Purpose: exercise cancel-between-chunks and the >250 soft cap for real; the 30-row run was
too fast to click.

- Preview: Tick All → 495 ticked (the 62 flagged rows stay unticked). Import → amber
  large-session warning → second click → progress window. Cancel clicked mid-run.
- Result dialog: `Created 417 items … skipped 8, failed 0, cancelled 70 (not attempted).`
  417 + 8 + 70 = 495; 425 attempted = 17 × 25, so Cancel took effect at a chunk boundary
  and never inside a transaction (§40 / executor design).
- Log entry `2026-09-18T20:41:23.870Z-15fd`: 417 `created` rows, 8
  `already-present` rows, 70 rows `cancelled: the session was cancelled before this row;
  nothing was written.`; totals `{created:417, skippedExisting:8, failed:0, cancelled:70}`.
- DB cross-check of the 417 created keys from the log: 417 present, all in
  `Reconciler Imports / 2026-09-18 20:41`, all carry `owl:sameAs` → source, 0 tags,
  0 attachments, 0 notes, none in trash, every one has a title. Two have no creators —
  their sources have none either (a report and a webpage).
- Invariant 3 (sources untouched): all 417 source versions (libs 2/5/6 = 44/277/96) equal
  the versions recorded in the log; none missing.
- The 8 `already-present` skips are live My Library items that already carry an
  `owl:sameAs` link to the group source but were rule-denied at match time (Tier 0 cannot
  override a denial, §8.0a), so the work showed as missing. The executor's pre-write link
  check is the second line of defence and held. These are the stale links reported by the
  earlier audit; they stay a user decision.
- Prior-run items in the trash (32, also linked to their sources) did not block re-import:
  Zotero's `getLinkedItem` skips trashed targets, matching the scanner's `includeDeleted=false`.
- Undo: `Moved 417 imported items to the trash.` DB: 449 in trash (32 + 417); the 8 skipped
  items untouched; undo entry `…-c6a5` reverses `…-15fd`; import marked `undoneAt`.
- Trash emptied by the user afterwards (0 items). Three empty session subcollections remain
  under `Reconciler Imports` (16:49, 17:51, 20:41) — WriteAPI has no collection delete by
  design.
- Still not exercised live: chunk failure → row-by-row retry (`failed 0`). Test-only.
