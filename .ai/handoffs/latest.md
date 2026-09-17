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
