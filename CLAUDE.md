# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Phase 1–2 read-only implementation in TypeScript (Zotero 10.0.x). `design.md` remains the
authoritative specification — read the relevant section before implementing anything; it
specifies what is deliberately excluded, and the exclusions are safety constraints, not
omissions. `design.md.bak` is a pre-safety-pass snapshot; do not edit it.

Commands (`just --list`):

```
just install     # npm install
just check       # tsc --noEmit + vitest run  — run before every checkpoint
just build       # esbuild bundle → dist/
just package     # build + zip dist/zotero-library-reconciler.xpi
just link-dev /abs/path/to/disposable-zotero-profile
```

Never link or install into a production Zotero profile without explicit user approval.
Resume notes live in `.ai/handoffs/latest.md`; update it when stopping.

## What the plugin does

Zotero treats My Library and each Group Library as independent databases. The same paper in three libraries is three unrelated items. The plugin identifies equivalent scholarly works across libraries, compares their bibliographic records, and offers safe tools to align them — **without merging libraries or deleting items**.

Central abstraction: a **Scholarly Work** is a derived, plugin-owned entity that groups N library-specific Zotero items representing the same intellectual object. It never replaces Zotero's items, and it must always be rebuildable from Zotero data (§10).

```
Scholarly Work
  ├── My Library      → item ABC123
  ├── Textbook Group  → item XYZ789
  └── Waterfowl Group → item QRS456
```

## Pipeline architecture

Every feature sits somewhere on one linear pipeline (§5). Know which stage you are editing:

```
Library Scanner → Normalization → Matching → Scholarly Work Index
  → Difference Engine → Reconciliation UI → Safe Write Engine
```

- **Scanner** (§6) enumerates user-selected libraries, pulls parent bibliographic items only (no attachments/notes/annotations), records item + library versions for incremental rescan.
- **Normalization** (§7) produces *temporary comparison values*. It must never write to Zotero records.
- **Matching** (§8) is the highest-risk component (see Safety below).
- **Difference Engine** (§11) classifies each field as `IDENTICAL | DIFFERENT | MISSING | CONFLICTING`. Missing and conflicting are different things and must not be collapsed (§38).
- **Write Engine** (§25) is the only component permitted to modify Zotero, and only via `SCAN → MATCH → COMPARE → PROPOSE → PREVIEW → CONFIRM → WRITE → LOG`.

## Safety constraints (non-negotiable)

These govern design decisions; violating one is a defect even if tests pass.

1. **False positives damage libraries; false negatives are inconvenient** (§48). Precision over recall. When uncertain → ask the user, never merge or overwrite.
2. **Never delete or replace a cross-library item because an equivalent exists elsewhere** (§24). Word/LibreOffice citations point at specific item identities; both items always survive. Only selected *fields* are copied.
3. **Tier 3 (fuzzy) matches are never reconciled automatically** (§8.1).
4. **No `SCAN → AUTOMATIC OVERWRITE` path** in the initial implementation (§25).
5. **Verify target item version before committing a write** (§40). If the item changed since the scan, offer `[ Recompare ]` rather than overwriting newer data.
6. **Read-only libraries** can be scanned, matched, compared, and copied *from* — never reconciliation targets (§39).
7. **Local-only by default** (§41). External metadata lookups (Crossref/PubMed/OpenAlex/DataCite) are optional and send identifiers or bibliographic queries only — never notes, annotations, or PDFs.

## Match tiers

Every relationship carries a confidence level and human-readable *evidence* explaining why two items matched (§9). The UI must never leave a user guessing.

| Tier | Criteria | Result |
|---|---|---|
| 0 | Zotero `owl:sameAs` linked-item relation (user copied one from the other) | corroborates: rules match → `EXACT`; rules deny → `REVIEW` (link may be stale) — never overrides a denial (§8.0a) |
| 1 | Exact persistent ID (DOI/PMID/arXiv; ISBN + compatible type) | `EXACT` — auto-reconcilable |
| 2 | Normalized title exact + first author compatible + year exact | `HIGH` — auto-reconcilable |
| 3 | Title similarity + author similarity + compatible year | `POSSIBLE` — manual review required |
| 4 | No match | unique in selected set (feeds "Missing from My Library") |

Author matching tolerates initial differences but stays conservative about surname differences (§7).

## Field scope

**Reconcilable** (§12): item type, title, creators, abstract, publication title, journal abbreviation, volume, issue, pages, date, DOI, ISBN, ISSN, URL, publisher, place, edition, language, rights, extra — handled per Zotero item type.

**Excluded by default** (§13, §21–23): collections, tags, notes, annotations, attachments, related items, dateAdded, dateModified. These are legitimately library-specific. Tags in particular are *not* bibliographic discrepancies. Attachments are audited, never synchronized.

## Performance model

Two-stage matching keeps fuzzy comparison off the hot path (§30): build hash indexes on normalized identifiers (`doiIndex`, `pmidIndex`, `isbnIndex`, `titleAuthorYearIndex`), resolve exact and strong matches, then run expensive fuzzy comparison only on the small unresolved remainder. Incremental rescan uses stored library/item versions so only changed records reprocess (§29).

## Build order

Development is phased so that detection is fully separated from modification (§42, §51). Phases 1–2 modify nothing; the MVP succeeds with **zero changes to the Zotero database** (§43–44).

```
Phase 1  Cross-library audit (read-only) — scanner, normalization, matchers, work index,
         "Missing from My Library" + metadata-difference reports, dashboard
Phase 2  "Find Copies in Other Libraries" item context-menu command (read-only) — the
         cheapest way to validate the matching engine on real libraries
Phase 3  Add missing items to My Library (copy, never move; dedicated import collection)
Phase 4  Field-level metadata reconciliation + transaction log + undo
Phase 5  Incremental monitoring (informational only)
Phase 6  External validation (Crossref/PubMed/DataCite/OpenAlex) as an extra comparison column
Phase 7  Opt-in tools for attachments, tags, notes, annotations
```

Do not implement write operations before the matching engine has been validated against real libraries.

## Conventions

- Target **Zotero 10.x** plugin APIs explicitly; do not carry over Zotero 6/7 patterns (§33).
- Layout follows §45 with two deliberate merges: normalization and blocking live under `src/matching/` (`normalize.ts`, `blocking.ts`, `matcher.ts`), and the scanner is `src/zotero/adapter.ts` (the only file that touches Zotero objects). `src/works/`, `src/comparison/`, `src/audit/`, `src/plugin/` as named. Say so if you diverge further.
- Zotero objects never leave `src/zotero/`; everything else operates on `ScannedItem` / `NormalizedItem` (`src/matching/types.ts`) so it is testable without Zotero.
- Dates: read `getField("date", true, true)` (multipart) so the year is the first four characters, as Zotero's own duplicate detector does.
- Plugin state (`works`, `work_items`, `matches`, `match_evidence`, `scan_state`, `transactions`, `preferences`) lives in plugin-owned storage, separate from Zotero bibliographic data (§32).
- Matching needs the strongest tests in the codebase. §46–47 enumerate required fixtures and edge cases — preprint vs. published, erratum, editions, same title/different authors, wrong DOI in one library, conference abstract vs. article. Each fixture encodes a *safety* expectation (`MATCH` / `NO AUTOMATIC MATCH` / `REVIEW`), so write the assertion against the tier, not just a boolean.
