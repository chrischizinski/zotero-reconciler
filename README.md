# Zotero Library Reconciler

A Zotero 10 plugin that finds the same scholarly work across My Library and Group Libraries,
shows where the records disagree, and — eventually — offers safe, field-level tools to align
them. It never merges libraries and never deletes items.

> **Status: early, read-only.** The current build scans, matches, clusters, and reports.
> It writes nothing to Zotero. Do not expect import or reconciliation actions yet.

## The problem

Zotero treats My Library and each Group Library as independent databases. The same paper
in three libraries is three unrelated items with three copies of the metadata, which drift
apart over time. Zotero's built-in *Duplicate Items* view only looks within one library.

## What the plugin does

It derives a **Scholarly Work** — a plugin-owned grouping of the library-specific items that
represent one intellectual object — and answers three questions:

1. Which works exist in a group library but not in My Library?
2. Where do the records for one work disagree (title, creators, date, DOI, ISBN)?
3. Why does the plugin believe two records are the same work?

```
Scholarly Work
  ├── My Library      → item ABC123
  ├── Textbook Group  → item XYZ789
  └── Waterfowl Group → item QRS456
```

Every match carries a tier and human-readable evidence; the UI never leaves you guessing.

| Tier | Evidence | Verdict |
|---|---|---|
| 1 | Same DOI / PMID / PMCID / arXiv ID / ISBN-13 | `EXACT` |
| 2 | Equivalent title (content words), a shared creator, year within ±1 | `HIGH` |
| 3 | Near-identical title with a one-character word substitution | `REVIEW` — never automatic |
| — | Related publication forms (preprint ↔ article, thesis ↔ book) | `RELATED` — never merged |
| 4 | Nothing above | unique in the selected libraries |

Denial rules run first and always win: differing DOIs, ISBNs, or PMIDs, years more than one
apart, incompatible item types, or a substituted content word (`duck hunters` ≠
`goose hunters`) block a match no matter how much else agrees.

## Safety model

These are design constraints, not preferences. A change that violates one is a defect even
if the tests pass.

- **Precision over recall.** A false positive damages a library; a false negative is an
  inconvenience. When uncertain, ask the user.
- **Both items always survive.** Word and LibreOffice citations point at specific item
  identities, so nothing is ever deleted or replaced because a copy exists elsewhere.
- **Fuzzy matches are never reconciled automatically.**
- **Read-only libraries** can be scanned and copied *from*, never written to.
- **Local by default.** No external lookups unless explicitly enabled, and then only
  identifiers and bibliographic queries — never notes, annotations, or PDFs.
- Tags, notes, annotations, attachments, collections, and related items are
  library-specific by design and are excluded from comparison.

The full specification, including what is deliberately excluded and why, is in
[`design.md`](design.md).

## Current features

Right-click an item in Zotero:

- **Find Copies in Other Libraries** — scans every other library for the selected item and
  shows each candidate's library, verdict, evidence, and field differences.
- **Audit Cross-Library Coverage** — scans all libraries, clusters confirmed matches into
  works, and lists works absent from My Library plus matched pairs with metadata differences.

Both commands are read-only.

## Installation

Requires Zotero 10.0.x. There is no release yet; build from source:

```sh
git clone https://github.com/chrischizinski/zotero-reconciler.git
cd zotero-reconciler
just install
just check
just package       # → dist/zotero-library-reconciler.xpi
```

Then in Zotero: *Tools → Plugins → ⚙ → Install Plugin From File…* and choose the `.xpi`.

**Use a disposable Zotero profile while the plugin is pre-release.** The current build
cannot modify your data, but it has not yet been validated against real libraries. To point
a development profile at the build output without packaging:

```sh
just link-dev /absolute/path/to/disposable-zotero-profile
```

## Development

Prerequisites: Node 20+, [`just`](https://github.com/casey/just).

```sh
just check     # tsc --noEmit + vitest
just build     # esbuild bundle → dist/
just package   # build + zip the .xpi
```

Layout — every module sits on one linear pipeline:

```
src/zotero/adapter.ts        Scanner: the only file that touches Zotero objects
src/matching/normalize.ts    Temporary comparison values; never writes to Zotero
src/matching/blocking.ts     Hash blocks so only plausible pairs are compared
src/matching/matcher.ts      Denial rules, tiers, evidence
src/works/                   Scholarly Work index (tier-restricted union-find)
src/comparison/              Field-level difference engine
src/audit/                   Cross-library audit orchestration
src/zotero/findCopiesCommand.ts  Item-menu commands and read-only rendering
src/plugin/                  Bootstrap and runtime entry points
```

Matching has the strongest tests in the repository. `tests/matching/matcher.test.ts`
implements the fixture table from `design.md` §46; each fixture asserts the verdict **and**
the rule that produced it, so a case that passes for the wrong reason still fails.

## Roadmap

| Phase | Scope | Writes to Zotero? |
|---|---|---|
| 1 | Matching engine + Find Copies | no — **done** |
| 2 | Cross-library audit, clustering, missing-from-My-Library report | no — **done**, dashboard pending |
| 3 | Add missing items to My Library (copy, never move) | yes, additive only |
| 4 | Field-level metadata reconciliation with preview, transaction log, undo | yes, per-field, confirmed |
| 5 | Incremental monitoring | no |
| 6 | Optional external validation (Crossref / PubMed / OpenAlex / DataCite) | no |
| 7 | Opt-in tools for attachments, tags, notes | opt-in |

Phase 3 does not start until the matcher has been run against real libraries and every
disagreement with Zotero's own *Duplicate Items* view has been explained.

## License

Not yet chosen.
