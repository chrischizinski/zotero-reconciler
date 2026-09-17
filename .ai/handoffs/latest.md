# Zotero Library Reconciler — resume checkpoint

## Current state

- The active design authority is `design.md`; `design.md.bak` is the pre-safety-pass snapshot.
- The repository now has a TypeScript/Zotero 10.0.x Phase 1 foundation and its first
  read-only UI command. It has no import, metadata write, dashboard, clustering, persistence,
  or reconciliation UI.
- Installed Zotero is **10.0.2**. The manifest is intentionally pinned to `10.0.*` until the
  next compatible minor build is tested.

## Implemented

- `src/matching/types.ts`: immutable scan, normalization, evidence, verdict, and tier contracts.
- `src/matching/normalize.ts`: title/creator/year/DOI/ISBN normalization and line-wise `extra`
  parsing for PMID, PMCID, arXiv, and DOI.
- `src/matching/matcher.ts`: Tier 1 exact identifiers; Tier 2 evidence; D1/D2/D3/D5/D6;
  safe D7 handling; type relationships; and the near-typo Tier 3 review route.
- `tests/matching/matcher.test.ts`: 14 executable regression tests for the pairwise rules.
- `manifest.json`, bootstrapped lifecycle source, TypeScript/Vitest/esbuild configuration,
  `justfile`, and `README.md`.
- `scripts/link-dev-plugin.zsh`: links only a built `dist/` bundle to an explicitly supplied,
  absolute Zotero profile path. With no argument it exits 64 without writing; it also clears the
  two Zotero extension-discovery cache preferences before restart.
- `just package`: produces the installable `dist/zotero-library-reconciler.xpi` bundle.
- `src/plugin/bootstrap.js` now uses Zotero's required top-level lifecycle hooks; the bundled
  application code is loaded as `runtime.js` only after Zotero initialization.
- `chrome.manifest` is included at the root of the distributable XPI, matching the required
  bootstrap add-on package layout.
- `src/zotero/adapter.ts`: maps regular Zotero items into `ScannedItem` and uses
  `Zotero.Items.getAll(libraryID, true, false)` to read only top-level, non-trashed candidates.
- `src/zotero/findCopiesCommand.ts`: registers **Find Copies in Other Libraries** in the item
  context menu, requires exactly one regular source item, scans other libraries only, and
  displays library provenance plus `MatchEvidence` in a read-only alert.

## Design corrections retained

- ISBN normalization no longer contains copied DOI examples.
- A print ISSN versus an electronic ISSN is a metadata difference, not a match denial.
- Tier 2, confidence evidence, MVP wording, and fixtures use any-creator, addition-only-title,
  and plus-or-minus-one-year rules consistently.

## Verification completed

```text
just check      # tsc --noEmit and 19 Vitest tests passed
just build      # produced dist/bootstrap.js and dist/manifest.json
npm audit --omit=dev --audit-level=moderate  # 0 production vulnerabilities
```

Zotero 10.0.2 was launched once against the isolated `/tmp/zotero-reconciler-dev-profile`.
Its extension proxy points only to this checkout's `dist/` directory; no production profile
was linked or modified. The Computer Use connection is now functional, but the visible Zotero
window is the user's regular **My Library** (2,679 items), not the isolated development
profile. One existing item was selected for inspection; no items, metadata, or libraries were
changed, and no reconciler scan was run. The user explicitly approved installation in the
regular profile. A development pointer was tried, then removed when Zotero did not register it;
the installable `.xpi` was tried and Zotero reported it incompatible. The add-on id was corrected
from the invalid `@local` to `@local.dev`. The package was then corrected to use a plain,
top-level Zotero bootstrap script plus a separately bundled runtime, matching the lifecycle layout
of working Zotero 10 plugins. `just check`, `just package`, and `unzip -t` passed afterward.
Two subsequent installer rejections identified a missing `chrome.manifest` in the XPI. The rebuilt
archive now includes it, alongside `manifest.json`, `bootstrap.js`, and `runtime.js`; `just check`,
`just package`, and `unzip -t` passed. Retry manual installation using
`dist/zotero-library-reconciler.xpi`; visual confirmation of the menu entry remains outstanding.

## Next implementation target

1. In the isolated Zotero profile, create two disposable libraries, add an exact DOI match and
   a deliberately different-title record, then visually confirm the context-menu command and
   its evidence output. Do not use a production library. Alternatively, install the add-on in
   the regular profile only with explicit user approval, and restrict the run to its read-only
   command.
2. Reconcile every matcher disagreement with Zotero's Duplicate Items view before implementing
   blocking, clustering, reports, persistence, imports, or any write path.

## Latest implementation

- `src/audit/crossLibraryAudit.ts` now performs a read-only, candidate-blocked cross-library
  pair audit; it builds a scholarly-work index and identifies works absent from My Library.
- `src/works/scholarlyWorkIndex.ts` clusters only confirmed matches while preserving multiple
  items from the same library in one work.
- The item context menu now also exposes **Audit Cross-Library Coverage**. It displays a compact
  audit summary and up to 20 works absent from My Library. It does not import or edit anything.
- Candidate blocking was added to Find Copies: matching identifiers always pass; otherwise a
  compatible year plus shared creator is required, with a same-title creatorless fallback.
- `just check` and `just build` pass with 23 tests. Zotero was restarted to load the audit command.

## 2026-09-17 review pass

Changed:
- `src/works/scholarlyWorkIndex.ts`: tier-restricted union-find (§8.2). Tier 1 edges union
  freely; Tier 2 edges are refused when any member pair across the two clusters is denied by
  D1–D6; Tier 3 edges never union. Works now carry `confidence` (weakest edge) and
  `canonical` (published form by `CANONICAL_TYPE_RANK`).
- `src/matching/blocking.ts` (new): `isCandidatePair` moved here from the adapter;
  `candidatePairs` hash-joins on identifier / creator-key / creatorless-title blocks.
  Audit of 5,000 synthetic items: 14.7 s → 0.2 s, identical pair set. Circular import
  `audit ↔ adapter` removed.
- `src/zotero/adapter.ts`: reads `getField("date", true, true)` (multipart) so the year
  parses for user-formatted dates; previously D5 and the year block never fired on real data.
- `src/matching/matcher.ts`: RELATED types sharing a persistent identifier now match at
  Tier 1 with §8.4 evidence naming the canonical type (user decision; recorded in
  `design.md` §8.4). `denialEvidence` exported (now includes D6) for cluster checks.
- Tests: 25 → 41. §46 fixture table covered, each asserting the producing rule; three
  clustering fixtures; multipart-date fixture; blocking equivalence fixture.
- `CLAUDE.md` rewritten for the code that now exists; `README.md` scope updated; `git init`
  run (no commits yet).

Commands run: `npm run typecheck`, `npx vitest run` (41 passed), `npm run build`.

Still open from the review (not changed):
- ~~Feed libraries~~ — fixed 2026-09-17: `isBibliographicLibrary` filters `getAll()` to user/group (verified against `feed.js`: `libraryType = 'feed'`).
- `bootstrap.js` lacks `onMainWindowLoad` / `onMainWindowUnload`; menu lost on window reopen.
- `manifest.json` placeholder `update_url`.
- `edition` field not scanned; arXiv version suffix not stripped; `alert()` output.
- Phase 1 exit gate (real-library validation vs. Duplicate Items view) still not done.

## 2026-09-17 real-library validation (Phase 1 exit gate — met)

- Pulled 4,149 items via local API into scratch; ported `duplicates.js` as oracle; diffed.
  Record: `docs/validation-2026-09-17.md`. Harness in session scratchpad, not committed.
- Matcher fixes: ISBN Tier 1 book-only; ADDITION-ONLY = ordered prefix ≥2 words; edition
  marker → review; Unicode punctuation folded. 48 tests. design.md §7/§8.1/§8.3/§42 amended.
- Decided 2026-09-17: `thesis` ↔ `journalArticle` stays incompatible (D6) — different works.
- Still outstanding: UI run in disposable profile; adapter field shapes against real
  `Zotero.Item`; `onMainWindowLoad`; placeholder `update_url`; `alert()` output.

## Queued (user-approved 2026-09-17)

1. Persist the Scholarly Work index in plugin storage (§32) — prerequisite for 2.
2. Read-only **"Also in"** item-tree column (`Zotero.ItemTreeManager.registerColumn`) showing
   the other libraries holding each work. Chosen over writing `reconciler:in:<lib>` tags:
   tags are a write path (§25 gates), sync to collaborators, and go stale. Tag writer may
   come later as opt-in, My-Library-only, namespaced, one-click removable.

## 2026-09-17 index persistence (queued item 1 — done)

- `src/works/indexSnapshot.ts` (pure): `createSnapshot`, `WorkLookup.alsoIn`, `staleLibraries`.
  Snapshot holds refs + versions only — no bibliographic fields (§10 rebuildable).
- `src/zotero/indexStore.ts`: one JSON file, `<dataDir>/zotero-library-reconciler/index.json`,
  atomic write via `IOUtils.writeJSON` tmpPath. Corrupt/foreign file → treated as absent.
- Audit command saves snapshot and reports the path; `restoreIndex()` at startup loads it
  and logs how many libraries changed since (versions from `Zotero.Library.libraryVersion`).
- Decision: JSON, not SQLite — audit compute is 0.06 s; incremental reprocessing (§29) not
  justified yet. Revisit if it ever is.
- Report window gained **Copy All** (nsIClipboardHelper).
- Confirmed live: 534 KB file, restore log line on restart, 0 stale.
- Next: queued item 2, "Also in" item-tree column reading `FindCopiesCommand.workLookup`.

## 2026-09-17 "Also in" column (queued item 2 — done)

- `src/zotero/coverageColumn.ts`: `Zotero.ItemTreeManager.registerColumn` (main tree only,
  `pluginID` = manifest id, persists width/hidden/sort). `dataProvider` reads
  `FindCopiesCommand.workLookup`; `refreshColumns()` after audit/restore.
- Zotero 10.0.2 logs two bogus `defaultIn`/`disableIn` deprecation warnings for every plugin
  column — its `checkHook` runs on undefined optional keys. Not ours; ignore.
- Confirmed live in dev profile: column populates from restored index at startup.
- Remaining deferred: `onMainWindowLoad`; placeholder `update_url`; `edition` field; arXiv
  version suffix; §29 incremental rescan (only if needed).

## 2026-09-17 stale-index rescan prompt — done

- `restoreIndex()` compares snapshot library versions to `Zotero.Library.libraryVersion`;
  if any moved → `Services.prompt.confirmEx` "Rescan Now / Later". Old index stays in use
  until rescan completes. `FindCopiesCommand` constructor now takes an options object.
- Confirmed live by decrementing two versions in index.json → prompt → rescan → rewritten.
- **Known gap:** `libraryVersion` advances only on sync. Local unsynced edits and mid-session
  syncs are not detected until next startup. Options if it matters: Notifier 'item' modify
  → dirty flag; or `MAX(clientDateModified)` per library via `Zotero.DB` (read-only).

## 2026-09-17 (afternoon) window hooks, manifest, same-library marker, Phase 3 design

- `FindCopiesCommand.register(window)` / `unregister(window?)` track menu items per main
  window (`Map<Window, Element[]>`); `bootstrap.js` forwards `onMainWindowLoad/Unload`;
  startup registers into every `Zotero.getMainWindows()`. Column is ItemTreeManager-global,
  untouched. Test pins: unregistering one window leaves the other's entries.
- `manifest.json`: placeholder `update_url` removed.
- `WorkLookup.copiesHere()` + column prefix `"N copies here"`. Only fires when a group copy
  links two My Library items transitively — `crossLibraryAudit.ts` deliberately skips
  same-library pairs (Zotero's Duplicate Items owns intra-library dupes). Documented.
- `design.md` §8.4: the two type-policy decisions (preprint↔article DOI = match; thesis↔
  article incompatible) flagged as one user's policy → future `matchingPolicy` preference,
  defaults = today, index records policy, policy may never turn REVIEW into auto-match.
- **Phase 3 design written: `docs/phase3-write-safeguards.md`.** Key findings from
  Zotero 10.0.2 source (omni.ja): `UndoHistory` tracks only existing-object modifications
  → native undo does NOT cover item creation; §27 and §42 Phase 3 corrected. Zotero's
  drag-copy uses `item.clone(libraryID)` + `newItem.addLinkedItem(source)` (`owl:sameAs`);
  Phase 3 must write that link, and linked items are a free Tier 0 match + matcher oracle.
- 62 tests; tsc clean; build OK; dev Zotero starts and restores index. Not yet manually
  verified: menu after Cmd+W/reopen; "copies here" cell on the 2016 national survey rows.
- Uncommitted. Next: user answers decisions A–D in the Phase 3 doc §11 (D = build Tier 0
  linked-item matching first — recommended yes).

## 2026-09-17 Tier 0 — Zotero linked items (decision D = yes)

- `ScannedItem.linkedItems` from `getRelationsByPredicate("owl:sameAs")` resolved via
  `Zotero.URI.getURIItemLibraryKey` (sync, no DB); `"relations"` added to `loadDataTypes`.
  `ZoteroReadAPI.URI` now required; `toScannedItem(item, name, uri)` third arg required.
- `src/matching/links.ts`: `areLinked`, `linkKey`. Blocking adds `link:<lib>:<key>` blocks.
  Matcher: Tier 0 first, before D6 (user copy event outranks inference). `MatchOptions
  { ignoreLinkedItems }` for the oracle.
- Audit: `linkedPairs`, `linkedButUnmatched` (rules-only verdict ≠ match) → report section
  "Zotero linked items". design.md §8.0a; CLAUDE.md tier table.
- Dev DB (read-only copy): 1,862 owl:sameAs relations, 1,628 on regular items, ~838 resolve
  to an existing regular item in a library the account holds. Expect linkedPairs ≈ that.
- 69 tests. Built; dev Zotero restarted; audit NOT yet re-run live (needs GUI click).
  Persisted index predates Tier 0 — rerun audit to refresh.

## 2026-09-17 Tier 0 live result → corroborate-only redesign

- Live audit: 838 linked pairs; 21 rules-rejected. Of first 10: 5 STALE links (record
  repurposed after copy → different paper), 1 edition pair, 4 genuine rule misses (wrong DOI
  ×2, retyped ×1, BibTeX braces ×1). Tier 0-overrides-everything was a false-positive path.
- Redesign: link corroborates, never overrides. rules match → EXACT (Tier 0 first in
  evidence); rules deny/nothing → REVIEW with cause ("probably stale" if titles diverged,
  "wrong identifier or type" if titles agree). REVIEW edges never enter clusters.
- normalize: `{}` deleted before punctuation fold ([DIVERGES] recorded §7).
- Report oracle section lists up to 25, explains stale-vs-wrong-identifier.
- design.md §8.0a rewritten; CLAUDE.md tier row. 72 tests. Built; not re-run live yet.
- Remaining 11 of 21 unseen — rerun audit in dev Zotero and read full list.

## 2026-09-17 second live oracle run (20 review pairs) → two matcher fixes + one open policy

- Live: 838 linked, 20 review, works 3208→3228 (stale pairs no longer welded), diffs 131→114.
- DB inspection of the same-title review pairs found three patterns: (a) `document` vs
  report/book (Zotero's generic type; D6 fires); (b) corporate creator spelling variants;
  (c) data errors in one copy (year 1933/2023, IPBES SPM typed journalArticle, "Force").
- Fixed (b): `normalizeCorporateName` drops "(ACRONYM)" + connectives for fieldMode-1 or
  first-name-less multi-word creators; [DIVERGES] in §7. Acronym≠expansion still holds.
- Fixed: EDITION_MARKER now includes version|ver|v ("Open standards … Ver. 4.0" → review).
- OPEN policy (a): should `document` be a wildcard type compatible with any parent type?
  3 real same-work pairs blocked by D6. Not implemented pending user decision.
- 75 tests. Built, dev Zotero restarted; not re-run live.
- Decided 2026-09-17: `document` compatible with every parent type (specific type canonical);
  `document ↔ journalArticle` RELATED like preprint. Zero doc↔article same-title pairs in user
  data; 8 doc↔report/book. `canonicalTypeRank()` centralised in types.ts. 77 tests.
- Live run 3: 17 review (9 stale links, 4 data errors, 4 policy-related). Zero matcher gaps.
  Recorded in docs/validation-2026-09-17.md addendum. Matcher validation vs Tier 0 oracle: done.
