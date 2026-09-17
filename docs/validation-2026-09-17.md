# Matcher validation against real libraries — 2026-09-17

Phase 1 exit criterion (`design.md` §42): run the matcher on real libraries and explain
every disagreement with Zotero's own *Duplicate Items* view.

## Method

- Pulled every top-level, non-trashed item from the local Zotero 10.0.2 API
  (`localhost:23119/api`): My Library (2,677 bibliographic items) and seven group
  libraries (1,472). Nothing was installed in Zotero; nothing was written.
- Ported `chrome/content/zotero/xpcom/duplicates.js` (`_findDuplicates`) faithfully as the
  oracle: book-only ISBN-13 equality, bare-DOI uppercase equality, or exact normalized-title
  equality with DOI / ISBN / ±1-year denials and any-creator `(lastName, firstInitial)`
  agreement; unrestricted transitive union.
- Ran our pipeline (`normalize → candidatePairs → matchNormalizedItems →
  buildScholarlyWorkIndex`) within each library, expanded both to item pairs, and diffed.
- Harness lives outside the repo (scratch); it is ~150 lines over the public `src/` API.

## Defects found and fixed

| Symptom (before) | Cause | Fix |
|---|---|---|
| 210 Tier 1 matches among 21 chapters of one edited volume | ISBN treated as identity for any item type | ISBN is Tier 1 only when both items are `book` (Zotero's rule) |
| `The common carp` matched four different carp papers by the same author; hub welded them into one work | ADDITION-ONLY defined as word *subset* | ADDITION-ONLY requires an ordered *prefix* of ≥ 2 content words |
| `Introduction` matched `An introduction to Indian reserved water rights` | one-word prefix | same |
| `X` matched `X, second edition` | edition marker treated as subtitle | edition marker in the added words → `review` (§8.4) |
| `Pennsylvania’s` vs `Pennsylvania's` went to Tier 3 review | Unicode punctuation not folded | fold `\p{P}\p{S}` to space (`[DIVERGES]` from Zotero) |

## Result after fixes (within-library, vs. Zotero oracle)

| Library | Items | Zotero pairs | Ours | Agree | Zotero-only | Ours-only |
|---|---|---|---|---|---|---|
| My Library | 2,677 | 19 | 38 | 16 | 3 | 22 |
| Group A (edited-book project) | 1,111 | 0 | 16 | 0 | 0 | 16 |
| Six smaller groups | 361 | 0 | 0 | 0 | 0 | 0 |

**Zotero-only (3)** — all D6: `book` ↔ `bookSection` sharing a chapter DOI (data error in the
book record), `conferencePaper` ↔ `thesis` sharing a DOI, `journalArticle` ↔ `thesis` with the
same title. Zotero has no item-type rule; we refuse by design (§8.4). Whether `thesis` ↔
`journalArticle` should be RELATED rather than incompatible is an open design question.

**Ours-only (38)** — each pair inspected by hand:
- 19 × EQUIVALENT after folding typographic quotes/dashes (`’` vs `'`, `–` vs `-`,
  `—` vs ` — `). Genuine duplicates Zotero cannot see.
- 19 × ADDITION-ONLY prefix: truncated titles (`Pheasant responses to U.S` vs the full
  title), missing subtitles (`Governing the commons`), series suffixes (`Psychometric theory
  (McGraw-Hill series in psychology)`), and three copies of one report with differently
  truncated titles. In several the longer-titled copy carries the DOI the other lacks.
  Genuine duplicates.

No unexplained disagreement remains.

## Cross-library audit (all 4,149 items, 3,487 candidate pairs, 0.06 s)

| Verdict | Pairs |
|---|---|
| no-match D7 (content-word substitution) | 897 |
| no-match D6 (incompatible types) | 836 |
| match Tier 2 | 724 |
| no-match D1 (DOIs differ) | 650 |
| match Tier 1 | 236 |
| no-match Tier 4 | 94 |
| no-match D2 (ISBNs differ) | 40 |
| related §8.4 | 5 |
| review §8.4 edition marker | 4 |
| review Tier 3 typo | 1 |

Works: 3,229 (861 multi-item; 219 exact-confidence, 642 high). 564 works absent from My
Library. 114 matched pairs with field-level differences, dominated by creator name form
(`Vaske, J.J.` vs `Vaske, Jerry J.`) and DOI present on one side only.

All 5 RELATED pairs are `conferencePaper` ↔ `journalArticle` with identical titles. All 5
review candidates are real ambiguities (`dcience` typo; four edition pairs).

## In-Zotero confirmation (same day)

Run in a disposable profile (`reconciler-dev`, isolated data directory, metadata-only sync
of the same eight libraries). Both item-menu commands worked; the audit reported the same
3,487 / 3,229 / 564 / 114 as the offline harness, so the live `Zotero.Item` adapter path is
equivalent to the API-JSON path.

Two defects found only by contact with real `Zotero.Item` objects, both fixed:

- `Zotero.Items.getAll()` returns unloaded shells; `getField()` throws
  `UnloadedDataException` until `Zotero.Items.loadDataTypes(items, ["itemData", "creators"])`.
- Zotero 7+ ignores `chrome.manifest` for bootstrapped plugins; chrome URLs must be
  registered from `bootstrap.js` via `amIAddonManagerStartup.registerChrome`.

`alert()` was replaced by a resizable report window (`chrome/content/report.xhtml`) — a
library-sized audit does not fit a modal alert.
