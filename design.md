# Zotero Library Reconciler

**Architecture & Design Specification**  
**Target:** Zotero 10  
**Status:** Concept / Initial Architecture  
**Last updated:** September 2026

---

## 1. Purpose

Zotero treats **My Library** and each **Group Library** as independent libraries. When the same scholarly work occurs in multiple libraries, the corresponding Zotero items are independent records.

As a result:

- bibliographic metadata can diverge between libraries;
- corrections made in one library do not propagate to another;
- duplicate detection does not operate across libraries;
- references added directly to Group Libraries may never enter a user's My Library;
- determining which references occur in which libraries requires manual comparison; and
- deleting or replacing Group Library items can break relationships with existing Zotero citations in documents.

The **Zotero Library Reconciler** addresses this problem without attempting to merge Zotero libraries.

Its core principle is:

> **Identify equivalent scholarly works across Zotero libraries, compare their bibliographic records, and provide safe tools for bringing those records into alignment while preserving the independence of each Zotero item.**

The plugin should distinguish between:

1. **bibliographic identity**, which often should be consistent across libraries; and
2. **project-specific information**, which often should remain library-specific.

---

# 2. Design Goals

The plugin should:

1. Detect equivalent scholarly works across My Library and Group Libraries.
2. Identify works present in Group Libraries but absent from My Library.
3. Identify differences in bibliographic metadata between equivalent items.
4. Allow users to reconcile metadata selectively.
5. Preserve existing Zotero item identities.
6. Preserve existing Zotero document citation links.
7. Leave project-specific metadata untouched by default.
8. Provide clear provenance for every proposed change.
9. Avoid destructive operations wherever possible.
10. Scale to large Zotero libraries.
11. Support Zotero 10.
12. Provide a useful read-only auditing mode before any write operations are enabled.

---

# 3. Non-Goals

The initial plugin should **not**:

- merge Zotero libraries;
- automatically delete cross-library duplicates;
- replace Group Library items with My Library items;
- automatically merge notes;
- automatically merge annotations;
- automatically merge collections;
- automatically merge tags;
- automatically synchronize attachments;
- modify existing Word/LibreOffice document citations;
- assume that My Library always contains the best metadata;
- continuously synchronize all libraries in the background.

These operations introduce substantially greater risk and should remain outside the initial scope.

---

# 4. Core Concept

The plugin should distinguish between a **Zotero Item** and a **Scholarly Work**.

A Zotero item is library-specific.

For example:

```text
My Library
    Item A
        key: ABC123

Textbook Group
    Item B
        key: XYZ789

Waterfowl Group
    Item C
        key: QRS456
```

All three items may represent:

```text
Smith, J. et al. (2024)
10.1234/example.2024.001
```

The plugin therefore introduces a conceptual entity:

```text
Scholarly Work
    ├── My Library → Item A
    ├── Textbook Group → Item B
    └── Waterfowl Group → Item C
```

The Scholarly Work does **not** replace Zotero's items.

It is simply the plugin's representation of the relationship among equivalent items.

---

# 5. High-Level Architecture

```text
┌─────────────────────────────────────────────┐
│                 Zotero 10                   │
│                                             │
│  My Library      Group A       Group B      │
│      │               │             │        │
└──────┼───────────────┼─────────────┼────────┘
       │               │             │
       └───────────────┼─────────────┘
                       ▼
              ┌─────────────────┐
              │ Library Scanner │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Normalization   │
              │ Engine          │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Matching Engine │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Scholarly Work  │
              │ Index           │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Difference      │
              │ Engine          │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Reconciliation  │
              │ Interface       │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Safe Write      │
              │ Engine          │
              └─────────────────┘
```

---

# 6. Major Components

## 6.1 Library Scanner

The Library Scanner retrieves eligible items from selected Zotero libraries.

### Responsibilities

- enumerate available libraries;
- distinguish My Library from Group Libraries;
- obtain library IDs;
- retrieve parent bibliographic items;
- exclude attachments, notes, and annotations from initial matching;
- **exclude trashed items.** Zotero's own duplicate detection filters every query with
  `itemID NOT IN (SELECT itemID FROM deletedItems)`. Items sitting in a Group Library's
  trash would otherwise be counted as scholarly works, inflate the "missing from My Library"
  total, and be offered for import. Note also that trashing and deleting are distinct
  events for §29's incremental scan: a trashed item still exists and can be restored;
- retain relationships between parent and child items;
- record item keys and version information;
- support incremental rescanning.

### User selection

Users should be able to choose which libraries participate:

```text
Libraries to compare

☑ My Library
☑ Human Dimensions Textbook
☑ Waterfowl Project
☐ Graduate Student Project
☑ Creel Survey Project
```

The plugin should not assume that every accessible Group Library should participate.

---

# 7. Normalization Engine

Metadata must be normalized before matching.

Normalization should **not modify Zotero records**. It creates temporary comparison values.

> **Normative basis.** The rules below are taken from Zotero's own duplicate-detection
> implementation (`chrome/content/zotero/xpcom/duplicates.js`, `normalizeString()`), so that
> this plugin never disagrees with Zotero's built-in Duplicate Items view about whether two
> records are the same work. Divergences from Zotero are marked **[DIVERGES]** and justified.

## Canonical string normalization

Apply to titles and creator names before any comparison:

```text
1. Unicode NFKD; strip combining marks (Zotero: Zotero.Utilities.removeDiacritics)
2. Replace ASCII punctuation runs with a single space:  /[ !-/:-@[-`{-~]+/g → " "
3. Trim
4. Lowercase
```

This is byte-for-byte Zotero's `normalizeString()`. It makes `Long-term` and `Long term`
identical, and `Mallards.` and `mallards` identical, without removing meaningful words.

**[DIVERGES]** Zotero folds ASCII punctuation only. Typographic apostrophes, quotation marks
and en/em dashes (`Pennsylvania’s`, `human–coyote`) survive its normalization, so the same
title pasted from two sources never agrees. Fold all Unicode punctuation and symbols
(`\p{P}`, `\p{S}`) to a space as well. Validation against a 2,677-item library found 19
duplicate pairs Zotero misses for exactly this reason (2026-09-17).

**[DIVERGES]** Zotero does not strip HTML markup. Zotero titles may contain `<i>`, `<sub>`,
and `<sup>`. Strip tags before step 1, or a formatted title will never match its plain
equivalent.

## DOI

Input:

```text
https://doi.org/10.1002/jwmg.12345
doi:10.1002/jwmg.12345
10.1002/JWMG.12345
```

Normalized:

```text
10.1002/jwmg.12345
```

Rules:

```text
1. Strip leading proxy prefixes: https://doi.org/, http://dx.doi.org/, doi:
2. Trim
3. Case-fold (DOI suffixes are case-insensitive per the DOI Handbook)
4. Accept only values matching ^10\.
```

**[DIVERGES]** Zotero case-folds to **upper**case and matches only raw values that already
begin with `10.` (SQL `LIKE '10.%'`) — it does not strip proxy prefixes. This plugin must
strip prefixes, because §7's stated goal is to match `https://doi.org/10.…` against
`10.…`, which Zotero currently treats as two different values. Fold to lowercase for
display consistency; the direction does not matter provided it is applied uniformly.

## ISBN

Clean and canonicalize to **ISBN-13** before comparison (Zotero: `Zotero.Utilities.toISBN13`).
An ISBN-10 and its ISBN-13 form are the same book and must compare equal.

Input:

```text
0-306-40615-2
978-0-306-40615-7
```

Normalized:

```text
9780306406157
```

Rules:

```text
1. Clean punctuation and validate the check digit (Zotero: Zotero.Utilities.cleanISBN)
2. Convert a valid ISBN-10 to ISBN-13 (Zotero: Zotero.Utilities.toISBN13)
3. Treat an invalid or unparseable value as absent, never as a raw identifier
```

## Titles

Potential normalization:

```text
Effects of Harvest Regulations on Waterfowl Hunters
```

becomes:

```text
effects of harvest regulations on waterfowl hunters
```

Normalization may include:

- lowercase;
- Unicode normalization;
- whitespace normalization;
- punctuation normalization;
- HTML markup removal.

Normalization should **not** remove meaningful words.

## Authors

Normalize:

```text
Smith, John A.
Smith, J. A.
John A. Smith
```

into a representation suitable for comparison.

Author matching should tolerate differences in initials while remaining conservative about surname differences.

Concrete rule, following Zotero:

```text
creator key = (normalized lastName, first character of normalized firstName)
```

Two records' creator lists are **compatible** when they share **at least one** creator key.

Notes:

- Zotero compares *any* creator, not specifically the first author. Requiring the *first*
  author to match is stricter than Zotero and will split works whose creator order differs
  between libraries (common when one record was imported from a database that reorders or
  truncates authors). Prefer Zotero's any-creator rule; see §8.
- Single-field-mode creators (corporate authors such as `U.S. Fish and Wildlife Service`)
  have no first name. Zotero sets the initial to `false`/`""`; compare on the normalized
  full string only. Two corporate authors match only on exact normalized equality.
- **Both records have no creators → treat as compatible.** One has creators and the other
  has none → **not** compatible. (Both are Zotero's behaviour.)

## Dates

Extract the publication year as the first four characters of the `date` field, and of every
field based on `date` for the item type.

Years are compared with a **±1 tolerance** (Zotero: `Math.abs(yearA - yearB) > 1` rejects).
This absorbs the common online-first/print-year split. A missing year on either side is not
evidence against a match; it simply contributes nothing.

## Identifiers

Normalize where appropriate:

- DOI
- PMID
- PMCID
- ISBN
- arXiv ID

**Implementation constraint:** Zotero has no native PMID, PMCID, or arXiv field. These live
as line-structured entries inside the free-text `extra` field:

```text
PMID: 38472910
PMCID: PMC10998812
```

The normalization engine must therefore parse `extra` line-by-line (`CSL Variable: Value`)
to extract them. This is the same structure that makes `extra` unsafe to reconcile as an
opaque string — see §13.

---

# 8. Matching Engine

Matching is the most important component of the system.

False-positive matches are more dangerous than missed matches.

The system should therefore favor **precision over recall**.

## 8.0 Denial rules (evaluated first, and they win)

Every positive criterion in §8.1 is a conjunction of *agreements*. Agreement alone is not
sufficient: two records can agree on title, author, and year and still be different works.
The matcher must therefore evaluate **denial rules** before any positive rule, and a denial
is absolute — no accumulation of positive evidence overrides it.

```text
D1. Both records have a DOI and the normalized DOIs differ        → NOT A MATCH
D2. Both records have an ISBN and the canonical ISBN-13s differ   → NOT A MATCH
D3. Both records have a PMID and the PMIDs differ                 → NOT A MATCH
D5. Both records have a year and |yearA − yearB| > 1              → NOT A MATCH
D6. Item types are incompatible (§8.4)                            → NOT A MATCH
D7. Titles differ by content-word substitution (§8.3)             → NO AUTOMATIC MATCH
```

D1, D2, and D5 are Zotero's own denial rules, applied in exactly this position.
D3 follows the denial-rule construction used by Metta, a published and evaluated biomedical
deduplication system that reported **zero** false-positive assignments on 6,265 records where
EndNote produced 14.

**ISSN is not a denial rule.** A journal can have distinct print and electronic ISSNs, and
two copies of the same article may legitimately record different ones. Compare ISSNs as
metadata differences (§11), but do not let them veto an otherwise well-supported item match.

Note the asymmetry that makes denial rules safe: *"both present and different"* denies,
while *"one present, one absent"* does not. A record missing a DOI is not evidence of
anything.

**Scope.** Denial rules apply to the bibliographic paths (Tier 2 and Tier 3). An exact
persistent-identifier match (Tier 1) is the identifier agreeing with itself and is not
subject to D1–D5 — but it *is* subject to D6.

## 8.0a Tier 0 — Zotero linked items (added 2026-09-17)

Zotero already records cross-library equivalence. Every drag-and-drop of an item into another
library runs `item.clone(targetLibraryID)` and then `newItem.addLinkedItem(item)`, which
stores an `owl:sameAs` relation on the copy; `getLinkedItem()` reads it back so a second
drag reuses the existing copy instead of creating another (`collectionTree.js`,
Zotero 10.0.2). These relations are **user actions, not inferences**.

```text
Tier 0  Either record carries owl:sameAs → the other     → EXACT, evidence "Tier 0"
```

Tier 0 is evaluated before every denial rule, **including D6**: a linked copy whose type the
user later changed is still the record they copied. It is the only rule that outranks a
denial, and it does so because the evidence is not bibliographic agreement but a recorded
copy event. The relation is stored on the copy only, so the check is direction-agnostic.

Two consequences:

- **Oracle.** Every linked pair the Tier 1–3 rules would *not* match is a real matcher false
  negative; the audit reports them (`linkedButUnmatched`) as a standing validation against
  the user's own data. Expect a long tail here: users retitle or retype copies over time.
- **Phase 3 obligation.** An import must write the same relation
  (`docs/phase3-write-safeguards.md` §2), so that Zotero's own drag logic and this plugin's
  next scan both recognise the copy.

Scanner cost: one extra data type (`relations`) in `loadDataTypes`; resolution through
`Zotero.URI.getURIItemLibraryKey` is synchronous and touches no database. URIs that point at
libraries no longer in the account resolve to nothing and are dropped, as Zotero does.

## 8.1 Match Hierarchy

### Tier 1 — Exact persistent identifier

Very high confidence.

Examples:

```text
DOI exact match
PMID exact match
arXiv ID exact match
ISBN, both items of type book
```

An ISBN identifies a *volume*. Every `bookSection` of an edited book carries the same ISBN,
so ISBN is identity only when both records are `book` — Zotero's own rule. Validation
(2026-09-17): 21 chapters of one volume produced 210 false Tier 1 matches before this
restriction. ISBN still participates in D2 and in blocking for any item type.

Example:

```text
My Library:
10.1002/jwmg.12345

Group Library:
https://doi.org/10.1002/jwmg.12345
```

Result:

```text
EXACT MATCH
```

---

### Tier 2 — Strong bibliographic match

Used when no persistent identifier is available.

Potential criteria:

```text
title relation = EQUIVALENT or ADDITION-ONLY (§8.3)
AND
creators = compatible (at least one creator key in common, or both creatorless; §7)
AND
years = compatible (within ±1 when both are present; §7)
AND
no denial rule applies (§8.0)
```

Result:

```text
HIGH-CONFIDENCE MATCH
```

---

### Tier 3 — Probable fuzzy match

Potential criteria:

```text
title similarity > threshold
AND
author similarity > threshold
AND
year compatible
```

Result:

```text
POSSIBLE MATCH — REVIEW REQUIRED
```

The plugin should never automatically reconcile a Tier 3 match.

---

### Tier 4 — No match

The item is considered unique within the selected libraries.

This is especially important for identifying:

> Items occurring in Group Libraries that do not occur in My Library.

Tier 4 is *absence of evidence*, not evidence of absence. §15 and §48 explain why this
distinction is safety-critical for the "Missing from My Library" feature.

---

## 8.2 From pairwise matches to Scholarly Works (clustering)

§8.1 produces **pairwise** verdicts. §10 requires an **N-way** Scholarly Work. The rule
connecting them is a design decision with direct false-positive consequences, and must be
stated explicitly rather than left to the implementation.

Zotero builds duplicate sets with a **Disjoint Set Forest** (union-find) and unions
transitively: if A matches B and B matches C, then A, B and C form one set. Zotero can
afford unrestricted transitivity because *every* rule it unions on is high-confidence —
it has no fuzzy tier at all.

This plugin does have a fuzzy tier, and transitivity plus fuzziness is how a single bad edge
silently merges two distinct works. The rule is therefore **tier-restricted union-find**:

```text
Tier 1 edges   → union freely (identifier identity is transitive)
Tier 2 edges   → union ONLY IF the merged cluster violates no denial rule
                 against any existing member (not just the matched pair)
Tier 3 edges   → NEVER union. Recorded as a proposal against a cluster,
                 surfaced for review, and discarded on rescan if unconfirmed.
```

The Tier 2 condition is what prevents edge-chaining: before absorbing an item, re-run
D1–D6 between the candidate and **every** member of the target cluster, not merely the
item it matched. One record with a wrong DOI can then join nothing, instead of welding two
clusters together.

### Cluster invariants

```text
- A cluster MUST NOT contain two members with different non-empty DOIs.
- A cluster MAY contain more than one item from the same library.
- A cluster's confidence = the WEAKEST edge used to build it, not the strongest.
```

The second invariant matters: the same library can legitimately hold two records for one
work (My Library's own duplicates). §32's `work_items` therefore has no uniqueness
constraint on `(work_id, library_id)`, and the coverage matrix (§36) must render a cell
holding 2+ items distinctly from a cell holding exactly 1. Before reporting a work as
"missing from My Library", the plugin should also check whether My Library holds an
*internal* duplicate that the cross-library pass did not surface.

## 8.3 Title comparison

Character-level similarity is not sufficient, and the threshold most commonly cited in the
literature fails this specification's own test fixture.

Metta calibrated longest-common-subsequence similarity, `LCS(A,B) / MIN_LEN(A,B)`, at a
**0.8** threshold, having found empirically that 0.7 introduced errors. Measured against
§46's required-negative fixture after canonical normalization:

| Pair | LCS/MIN_LEN | Levenshtein ratio | §46 requires |
|---|---|---|---|
| `…on duck hunters` vs `…on goose hunters` | **0.913** | **0.903** | NO AUTOMATIC MATCH |
| `Effects of Harvest…` vs `effects of harvest…` | 1.000 | 1.000 | MATCH |
| `Long-term trends…` vs `Long term trends…` | 1.000 | 1.000 | MATCH |

Both scalar metrics place the forbidden pair far above the published threshold. Any
threshold low enough to reject 0.913 would also reject legitimate typo and OCR variants.
**Scalar string similarity cannot express the distinction this specification requires.**

The distinction is lexical, not metric. Compare **content-word sets** after canonical
normalization, with a stoplist of *function words only* (`a`, `an`, `the`, `of`, `on`, `in`,
`for`, `and`, `or`, `to`, `with`, `from`, `at`, `by`, `as`) — never topic words:

```text
A = content words of title A
B = content words of title B

A == B                    → EQUIVALENT
A is an ordered prefix    → ADDITION-ONLY  (subtitle, series suffix)
  of B, or B of A, and      Treat as equivalent for MATCHING;
  the prefix has ≥ 2 words  record the difference as a reconcilable field difference.
  … unless the added words  → REVIEW. Editions are related works (§8.4), not copies.
  contain an edition marker
otherwise (SUBSTITUTION)  → NO AUTOMATIC MATCH. Route to review with the
                            disagreeing words shown as evidence.
```

**Prefix, not subset.** An earlier draft defined ADDITION-ONLY as any word subset. Real
libraries broke it immediately: `The common carp` ⊂ `Using boat electrofishing to estimate
the abundance of invasive common carp` (same author, adjacent years) and `Introduction` ⊂
every chapter title starting with that word. Title + subtitle is an *ordered* relation; a
subset test admits any short title as a hub that welds a whole author-year block into one
cluster. The two-word minimum blocks one-word chapter titles.

Verified against the fixtures:

| Pair | Classification | Correct? |
|---|---|---|
| duck ↔ goose hunters | SUBSTITUTION `[duck] ↔ [goose]` | ✓ blocked |
| capitalization only | EQUIVALENT | ✓ matched |
| `Long-term` ↔ `Long term` | EQUIVALENT | ✓ matched |
| `Harvest of mallards` ↔ `Harvest of Mallards.` | EQUIVALENT | ✓ matched |
| `A Review of X` ↔ `Review of X` | EQUIVALENT | ✓ matched |
| title ↔ title + subtitle | ADDITION-ONLY | ✓ matched, difference flagged |
| `The common carp` ↔ `Using boat electrofishing … common carp` | SUBSTITUTION (not a prefix) | ✓ blocked |
| `Introduction` ↔ `An introduction to …` | SUBSTITUTION (one-word prefix) | ✓ blocked |
| `X` ↔ `X, second edition` | ADDITION-ONLY + edition marker | ✓ review |
| `annual report 2019` ↔ `annual report 2020` | SUBSTITUTION `[2019] ↔ [2020]` | ✓ blocked |

The last row is the case scalar similarity most reliably gets wrong: two different annual
reports score ≈0.97 character-similarity and are not the same work.

Character similarity retains one job — catching typos and OCR damage *within* a
SUBSTITUTION verdict. A substitution whose disagreeing words are themselves near-identical
(`Waterfowl` ↔ `WaterfowI`, l/I confusion) is a Tier 3 review candidate rather than a flat
rejection. It is never an automatic match.

## 8.4 Item-type compatibility

Referenced by Tier 1, D6, and several §47 edge cases; defined here once.

The operative external constraint: **Zotero cannot merge items of different item types.**
Its merge dialog refuses with *"Merged items must all be of the same item type."* Since this
plugin does not merge, it is not bound by that restriction for *matching* — but it is bound
for anything it hands to Zotero's own merge, and users will reasonably expect consistency.

```text
SAME type                                    → compatible
preprint ↔ journalArticle                    → RELATED, never an automatic match  (§47)
conferencePaper ↔ journalArticle             → RELATED, never an automatic match  (§47)
bookSection ↔ book                           → NOT compatible (part vs. whole)
book ↔ book, different edition field         → RELATED, never an automatic match
report ↔ journalArticle                      → NOT compatible
dataset ↔ journalArticle                     → NOT compatible  (§47: shared titles)
thesis ↔ book                                → RELATED, never an automatic match
thesis ↔ journalArticle                      → NOT compatible  (decision 2026-09-17: a thesis
                                               and the article derived from it are different
                                               works, even with identical title/author/year)
anything ↔ attachment / note / annotation    → excluded from matching entirely  (§6)
```

**RELATED** is a third verdict alongside MATCH and NO MATCH: the plugin is confident the two
records concern the same intellectual content but they are not interchangeable bibliographic
records. A RELATED pair must never be placed in one Scholarly Work cluster and must never
have metadata copied between its members — the correct action is Zotero's own *Related
Items* link, which §13 already excludes from reconciliation.

**Shared persistent identifier across RELATED types (decision, 2026-09-17).** When two
records of RELATED types share a DOI/PMID/arXiv ID, they are the same work and match at
Tier 1; the type difference is reported as evidence, not a denial. Within such a work the
**published form is the canonical record** — `journalArticle` over `preprint` or
`conferencePaper`, `book` over `thesis` — and any future field copy runs from the canonical
record outward, never onto it. Without a shared identifier the RELATED rule above is
unchanged: title/creator/year agreement alone never clusters related types.

Preprint↔published is the highest-volume RELATED case. Crossref carries this relationship
explicitly as `is-preprint-of` (deposited on the preprint) and `has-preprint` (deposited on
the article). When external validation is enabled (§19), these relations resolve the
question authoritatively instead of heuristically, and should be preferred over any
title/author inference.

**These two decisions are one user's policy, not universal truth (noted 2026-09-17).** Another
user may want a thesis and its derived article treated as one work, or may want a
preprint↔article DOI match to stop at REVIEW. Both are candidates for a *matching policy*
preference (§32 `preferences`):

```text
relatedTypesSharingIdentifier : "match" (default) | "review"
thesisArticle                 : "incompatible" (default) | "review"
```

Constraints when this is built: defaults must reproduce today's behaviour; the persisted index
records the policy it was built under and a policy change marks it stale (§29) so the column
and reports never mix policies; policy can only *loosen toward REVIEW or tighten* — no setting
may turn a REVIEW verdict into an automatic match. Deferred until a preferences pane exists
(Phase 4, alongside reconciliation settings); the matcher already isolates both rules in
`canonicalItemType` / D6 so the switch is local.

## 8.5 Blocking

§30's funnel assumes identifier matching resolves ~87% of items, leaving a fuzzy candidate
set small enough to compare pairwise. That assumption holds for journal-article-heavy
libraries and fails for books, reports, theses, and grey literature, where DOI coverage is
far lower. Without blocking, the unresolved remainder is compared O(n²): 5,000 unresolved
items is 12.5 million comparisons.

The unresolved set must therefore be partitioned before pairwise comparison. Metta blocks on
**publication year** as a hash join, handling the ~0.1% of year-less records separately at
the end. Because §7 compares years with ±1 tolerance, blocking on year alone would miss
legitimate cross-year pairs, so each record is placed in the blocks for `year-1`, `year`,
and `year+1`.

```text
Block key       = publication year (record enters blocks y-1, y, y+1)
Secondary key   = first normalized creator surname, where present
No-year records = compared only against each other, plus creator-surname blocks
```

Records are compared only within a shared block. This is the difference between a scan that
finishes and one that does not.

---

# 9. Match Confidence

Every relationship should have a transparent confidence classification.

Example:

```text
EXACT
DOI identical

HIGH
Title relation + compatible creator + compatible year

MEDIUM
Title similarity + author similarity + year

LOW
Potential relationship requiring manual review
```

The UI should display **why** two items were matched.

Example:

```text
Match confidence: EXACT

Evidence:
✓ DOI identical
✓ publication year identical
✓ creator key shared
✓ normalized titles equivalent
```

Users should never have to guess why the plugin considers two items equivalent.

---

# 10. Scholarly Work Index

After matching, the plugin creates an internal index.

Example:

```yaml
work:
  canonical_identifier: "doi:10.1002/jwmg.12345"

  instances:
    - library_id: 1
      library_name: "My Library"
      item_key: "ABC123"

    - library_id: 27
      library_name: "HD Textbook"
      item_key: "XYZ789"

    - library_id: 42
      library_name: "Waterfowl"
      item_key: "QRS456"
```

This index should be considered **derived data**.

It must always be possible to rebuild it from Zotero.

---

# 11. Difference Engine

Once equivalent records have been identified, their bibliographic fields are compared.

Example:

| Field | My Library | Textbook Group | Waterfowl Group |
|---|---|---|---|
| Title | Smith et al... | Smith et al... | Smith et al... |
| Journal | JWM | Journal of Wildlife Management | Journal of Wildlife Management |
| Volume | 88 | 88 | 88 |
| Issue | — | 4 | 4 |
| Pages | — | 1021–1034 | 1021–1034 |
| DOI | identical | identical | identical |

The engine should classify fields as:

```text
IDENTICAL
DIFFERENT
MISSING
CONFLICTING
```

---

# 12. Fields Eligible for Reconciliation

Version 1 should focus on bibliographic metadata.

Recommended fields include:

- item type;
- title;
- creators;
- abstract;
- publication title;
- journal abbreviation;
- volume;
- issue;
- pages;
- date;
- DOI;
- ISBN;
- ISSN;
- URL;
- publisher;
- place;
- edition;
- language;
- rights.

Fields should be handled according to Zotero item type.

**`item type` is listed above but must not be reconciled in v1.** Changing an item type in
Zotero discards fields that do not exist on the destination type. That is a silent,
irreversible data loss on the target record, which contradicts §25. Report item-type
disagreement as a difference; never offer to resolve it automatically.

**`extra` is deliberately absent from this list** — see §13.

---

# 13. Fields Excluded by Default

The following should **not** be automatically reconciled:

- collections;
- tags;
- notes;
- annotations;
- attachments;
- related items;
- date added;
- date modified;
- **citation key**;
- **extra**.

These are often intentionally library-specific.

Future versions could provide explicit tools for comparing some of these fields.

## Citation key — hard exclusion

Zotero 8 introduced a **native citation key field**, migrating keys out of `extra`, where
Better BibTeX had previously stored them as a `Citation Key: smith2024` line. In Zotero 10
the field is first-class and syncs across devices.

Copying a citation key from one library to another creates two items claiming the same key.
Every downstream LaTeX/Markdown/Pandoc document keyed on it then resolves ambiguously. This
is the same class of harm §24 exists to prevent — the difference is that §24 protects
Zotero's own Word/LibreOffice citation links, while this protects citation keys, which
§24 does not currently mention.

Citation key is therefore **never** reconcilable, not even manually, and not in any later
phase.

## Extra — structured, not free text

`extra` looks like a free-text field and is not one. Zotero parses it line-by-line as
`CSL Variable: Value` and recognizes at minimum:

```text
PMID:  PMCID:  Status:  Submitted:  Original Date:  Original Title:
Director:  Editorial Director:  Illustrator:  Event Date:  Event Place:  DOI:
```

plus arbitrary user content and plugin directives (`tex.*`).

Reconciling `extra` as an opaque string therefore silently destroys whichever of these the
target record held — including the PMID the matcher itself depends on (§7). If `extra` is
ever reconciled, it must be diffed and merged **per line, keyed on the variable name**,
never wholesale. Excluded in v1; revisit no earlier than Phase 7.

---

# 14. Reconciliation Interface

The primary interface should be a dashboard.

Example:

```text
Zotero Library Reconciler
──────────────────────────────────────────

Libraries scanned:       8
Bibliographic items:     12,481
Scholarly works:         9,742

Cross-library works:     2,108
Metadata conflicts:        347
Missing from My Library:   623
Possible matches:           41
```

Primary views:

```text
Overview
Missing from My Library
Metadata Differences
Possible Matches
Library Coverage
```

---

# 15. Missing from My Library

This should be a major first-class feature.

Example:

```text
623 scholarly works occur in Group Libraries
but do not occur in My Library.
```

Table:

| Work | Found In | Identifier | Action |
|---|---|---|---|
| Smith 2024 | Textbook | DOI | Add |
| Jones 2021 | Waterfowl | DOI | Add |
| Lee 2025 | Textbook + Creel | DOI | Add |

Actions:

```text
[ Add Selected to My Library ]
[ Add All Exact Matches ]
```

The plugin should **copy** records rather than move them.

Existing Group Library items remain untouched.

---

# 16. Metadata Reconciliation

Selecting a work should show all copies side-by-side.

Example:

```text
Smith et al. 2024
DOI: 10.1002/jwmg.12345
```

| Field | My Library | Textbook |
|---|---|---|
| Title | identical | identical |
| Journal | JWM | Journal of Wildlife Management |
| Volume | 88 | 88 |
| Issue | — | 4 |
| Pages | — | 1021–1034 |

Possible actions:

```text
← Use Textbook value
→ Use My Library value
```

At the record level:

```text
[ Update My Library from Textbook ]

[ Update Textbook from My Library ]
```

The user should be able to preview all proposed changes before committing them.

---

# 17. Canonical Library

Users should optionally be able to designate a preferred library.

Default:

```text
Canonical library: My Library
```

This means:

> When multiple equivalent records differ, prefer My Library when suggesting values.

It does **not** mean:

> Automatically overwrite other libraries.

The canonical library influences recommendations only.

---

# 18. Best-Available Metadata

A future enhancement could determine which record appears most complete.

For example:

```text
My Library
DOI ✓
Issue —
Pages —
Abstract —

Textbook
DOI ✓
Issue ✓
Pages ✓
Abstract ✓
```

The plugin could report:

```text
Textbook contains 3 bibliographic fields
missing from My Library.
```

It should not claim that the Textbook copy is objectively "correct."

Completeness and correctness are different concepts.

---

# 19. External Metadata Validation

A later version could optionally validate records against authoritative external sources.

Potential sources:

- Crossref;
- PubMed;
- DataCite;
- OpenAlex;
- Library of Congress;
- ISBN metadata services.

Architecture:

```text
Zotero copies
      │
      ▼
Cross-library comparison
      │
      ▼
External metadata lookup
      │
      ▼
Proposed canonical metadata
```

External metadata should always be shown as another source rather than silently replacing Zotero metadata.

Example:

| Field | My Library | Group | Crossref |
|---|---|---|---|
| Issue | — | 4 | 4 |
| Pages | — | 1021–1034 | 1021–1034 |

This provides stronger evidence for reconciliation.

---

# 20. Attachments

Attachments should initially be **audited but not synchronized**.

Useful reporting:

```text
Smith 2024

My Library:
✓ PDF

Textbook:
✓ PDF
✓ Supplemental material

Waterfowl:
No attachments
```

Potential future actions:

```text
[ Copy PDF to My Library ]
[ Copy Supplemental Material ]
```

Attachment copying should never occur automatically.

---

# 21. Notes and Annotations

Notes and annotations should remain library-specific by default.

The plugin could report their existence:

```text
My Library
2 notes
14 annotations

Textbook
1 note
6 annotations
```

But it should not attempt to determine which notes are canonical.

Future functionality could allow explicit copying.

---

# 22. Tags

Tags are especially ambiguous.

Example:

```text
My Library:
waterfowl
human dimensions
harvest

Textbook:
chapter-7
box-7-2
needs-citation
```

Both sets may be correct.

Therefore:

> Tags should not be considered bibliographic discrepancies.

A future comparison view may allow users to inspect or copy tags manually.

---

# 23. Collections

Collections should remain entirely library-specific.

No reconciliation should occur.

A copied item added to My Library could optionally be placed in a dedicated collection:

```text
Library Reconciler Imports
    ├── From HD Textbook
    ├── From Waterfowl
    └── From Creel Survey
```

This would make large consolidation operations reversible and auditable.

---

# 24. Existing Zotero Citations

This is a critical safety constraint.

Existing Zotero citations in Word, LibreOffice, or other supported documents may refer to specific Zotero item identities.

Therefore the plugin must:

> **Never delete or replace a cross-library Zotero item merely because an equivalent item exists elsewhere.**

Instead:

```text
My Library item
      │
      │ equivalent scholarly work
      │
Group Library item
```

Both continue to exist.

Only selected metadata fields are copied between them.

---

# 25. Write Safety

Every write operation should follow:

```text
SCAN
  ↓
MATCH
  ↓
COMPARE
  ↓
PROPOSE
  ↓
PREVIEW
  ↓
CONFIRM
  ↓
WRITE
  ↓
LOG
```

There should be no:

```text
SCAN → AUTOMATIC OVERWRITE
```

in the initial implementation.

---

# 26. Transaction Log

Every modification should be logged.

Example:

```yaml
timestamp: 2026-09-15T14:32:11
action: update_metadata

target:
  library: My Library
  item: ABC123

source:
  library: HD Textbook
  item: XYZ789

changes:
  issue:
    old: null
    new: "4"

  pages:
    old: null
    new: "1021-1034"
```

The log should support:

- auditing;
- troubleshooting;
- potential undo;
- identifying which library supplied a value.

---

# 27. Undo

Where Zotero's API permits it, write operations should integrate with Zotero's undo system.

**Zotero 10 permits it.** The release that this plugin targets added batch editing with undo
support and, explicitly, *"plugins can opt their operations into undo history."* The
mechanism is an argument on save:

```javascript
await item.saveTx({
    undoAction: 'undo-action-edit-metadata',
    undoActionArgs: { count: 1 }
});
```

and, when saving several objects inside one transaction:

```javascript
Zotero.UndoHistory.stageAction(action, args);
```

This removes the main argument for deferring undo to a later phase: native undo is now an
argument passed to a call the plugin already has to make, not a subsystem it has to build.
Every write, from the first one shipped, should carry an `undoAction`.

**Correction (2026-09-17, from Zotero 10.0.2 source).** `Zotero.UndoHistory` "only tracks
modifications to existing objects": `DataObject.save()` stages a change only when the object
is not new. Native undo therefore covers Phase 4 field edits but **not** Phase 3 item
creation. Phase 3 session undo is plugin-owned — trash the items recorded in the transaction
log (trashing *is* a tracked modification, so that step gets an `undoAction`). See
`docs/phase3-write-safeguards.md` §2.1 and §7.

The plugin's own transaction log (§26) remains necessary and is not made redundant by this.
Native undo is a session-scoped stack that a user can exhaust, walk past, or lose on
restart; the transaction log answers "which library supplied this value, three weeks ago"
and survives indefinitely. They serve different questions — ship both.

For example:

```text
Reconciliation Session
September 15, 2026 · 2:32 PM

347 items modified

[ Undo Session ]
```

---

# 28. Dry-Run Mode

The first release should support a completely read-only mode.

Example:

```text
Analyze Libraries
```

rather than:

```text
Synchronize Libraries
```

The output would identify:

```text
623 missing from My Library
347 metadata discrepancies
41 possible duplicates
2,108 works occurring in multiple libraries
```

No Zotero data would be changed.

This mode alone would provide substantial value.

---

# 29. Incremental Scanning

Large Zotero installations should not require complete rescanning every time.

The plugin should record:

- library versions;
- item versions;
- last scan timestamp.

Then:

```text
Initial scan:
12,481 items

Next scan:
143 items changed
37 items added
12 items deleted
```

Only changed records need to be reprocessed.

---

# 30. Performance Strategy

For large libraries:

1. Retrieve minimal identifying metadata first.
2. Normalize identifiers.
3. Build hash maps for exact identifiers.
4. Resolve exact matches.
5. Only perform fuzzy matching on unmatched records.

Example:

```text
12,481 items
     ↓
DOI/PMID/ISBN matching
     ↓
10,900 resolved
     ↓
1,581 unresolved
     ↓
Title/author/year matching
     ↓
1,420 resolved
     ↓
161 candidates for fuzzy comparison
```

Expensive fuzzy comparisons should therefore involve only a small subset of the library.

---

# 31. Matching Data Structures

Possible in-memory indexes:

```text
doiIndex:
    DOI → [item references]

pmidIndex:
    PMID → [item references]

isbnIndex:
    ISBN → [item references]

titleAuthorYearIndex:
    normalized composite key → [item references]
```

Example:

```javascript
doiIndex.get("10.1002/jwmg.12345")
```

could return:

```text
[
  { libraryID: 1, itemKey: "ABC123" },
  { libraryID: 27, itemKey: "XYZ789" },
  { libraryID: 42, itemKey: "QRS456" }
]
```

---

# 32. Plugin Data Storage

Plugin-specific data should remain separate from Zotero bibliographic data wherever possible.

Potential local database tables:

```text
works
work_items
matches
match_evidence
scan_state
transactions
preferences
```

Conceptually:

```text
works
─────
work_id

work_items
──────────
work_id
library_id
item_key
match_confidence

scan_state
──────────
library_id
last_library_version
last_scan

transactions
────────────
transaction_id
timestamp
action
source_item
target_item
before
after
```

---

# 33. Zotero 10 Integration

The plugin should use Zotero's current plugin architecture and APIs rather than relying on deprecated Zotero 6/7 interfaces.

Major integration points include:

- Zotero library enumeration;
- Zotero item APIs;
- collection APIs;
- item save/update operations;
- Zotero notifications;
- library/item version information;
- Zotero preference storage;
- Zotero 10 multiple-selection behavior.

Compatibility should explicitly target:

```text
Zotero 10.x
```

rather than assuming compatibility from older Zotero plugin APIs.

## Zotero 10 specifics

Zotero 10.0 was released 17 August 2026; 10.0.2 is current as of September 2026. The
following are confirmed against Zotero's developer documentation for this release.

### Selection getters — plural, and required

Zotero 10 added multi-selection of collections, saved searches, and libraries. Singular
getters are superseded:

```text
ZoteroPane.getSelectedCollections()
ZoteroPane.getSelectedLibraryIDs()        ← new
ZoteroPane.getSelectedSavedSearches()
CollectionTree#getSelectedCollections()
CollectionTree#getSelectedLibraryIDs()    ← new
CollectionTree#getSelectedSearches()
```

The plural getters return arrays and are safe under any selection. Singular getters such as
`CollectionTree#getSelectedSearch()` no longer throw on a single-row selection, which means
code built on them will appear to work and then silently read only the first of several
selected libraries. Use the plural forms exclusively.

This directly enables §34's "Compare Selected Libraries" entry point:
`getSelectedLibraryIDs()` is the whole feature.

### Undo history

See §27 — `saveTx({ undoAction, undoActionArgs })` and `Zotero.UndoHistory.stageAction()`.

### Local API write support

Zotero 10's local API (`/api/`) now accepts write requests. Responses carry a
`Zotero-Server-ID` header which must be cached and returned on subsequent requests to
confirm identity. Relevant only if any part of the plugin is driven out-of-process; the
in-process item APIs remain the primary path, and the safety model in §25 assumes them.

---

# 34. User Entry Points

Potential entry points:

## Tools menu

```text
Tools
    Library Reconciler...
```

## Library context menu

If multiple libraries are selected:

```text
Compare Selected Libraries
```

Zotero 10's support for multiple selected libraries makes this particularly attractive.

## Item context menu

For a selected item:

```text
Find Copies in Other Libraries
```

This could provide a very useful lightweight feature independent of the full dashboard.

---

# 35. "Find Copies" Feature

A single-item operation could be one of the first implemented features.

Example:

User right-clicks:

```text
Smith et al. 2024
```

and selects:

```text
Find Copies in Other Libraries
```

Result:

```text
Found in:

✓ My Library
✓ HD Textbook
✓ Waterfowl Project
— Creel Survey
```

Then:

```text
[ Compare Metadata ]
```

This feature provides an excellent way to test the matching engine before building full-library reconciliation.

---

# 36. Library Coverage View

The plugin could provide a matrix showing how scholarly works are distributed.

Example:

| Work | My Library | Textbook | Waterfowl | Creel |
|---|:---:|:---:|:---:|:---:|
| Smith 2024 | ✓ | ✓ | ✓ | |
| Jones 2022 | ✓ | ✓ | | |
| Lee 2025 | | ✓ | ✓ | |
| Brown 2019 | ✓ | | | ✓ |

This could reveal unexpected gaps in My Library or project libraries.

---

# 37. Conflict Resolution

Conflicts should be handled at two levels.

## Field level

```text
Issue

My Library: —
Textbook:   4
Waterfowl:  4

Suggested:
4

Reason:
Two copies contain the same non-empty value.
```

## Record level

```text
Use metadata from:

○ My Library
● Textbook
○ Waterfowl

[ Preview Changes ]
```

Suggestions must always remain suggestions until confirmed.

---

# 38. Automatic Recommendations

Safe recommendations may be possible when:

```text
My Library field = empty
AND
all other copies containing that field agree
```

Example:

```text
My Library:
Issue = —

Textbook:
Issue = 4

Waterfowl:
Issue = 4
```

Recommendation:

```text
Add issue "4" to My Library.
```

Much less safe:

```text
My Library:
Issue = 3

Textbook:
Issue = 4

Waterfowl:
Issue = 4
```

Result:

```text
CONFLICT — REVIEW REQUIRED
```

The plugin should distinguish **missing information** from **contradictory information**.

---

# 39. Permission Handling

Group Library permissions vary.

The plugin must determine whether each library is:

```text
READ/WRITE
READ ONLY
```

Read-only libraries can participate fully in:

- scanning;
- matching;
- comparison;
- copying information *from* the library.

They cannot be reconciliation targets.

The UI should make this explicit.

---

# 40. Error Handling

Potential errors include:

- Zotero sync occurring during reconciliation;
- item deleted since scan;
- library permissions changed;
- target item modified since comparison;
- attachment unavailable;
- network failure for external validation.

Before committing a change, the plugin should verify that the target item's version still matches the version used during comparison.

If not:

```text
This item changed after the reconciliation scan.

[ Recompare ]
```

rather than overwriting newer data.

## Batch semantics

The version check above is described per item, but §27 shows sessions of 347 items. The
behaviour of a partially-failing session must be specified, or it will be decided
accidentally by whoever writes the loop.

```text
Per item:   re-check version immediately before write
On stale:   SKIP that item, continue the session
Never:      abort the whole session, or write the stale item anyway
After:      report every skipped item explicitly, with a [ Recompare ] action
```

A session is deliberately **not** atomic. Rolling back 346 correct writes because one item
changed would be a worse outcome than skipping one. But a partially-applied session that
reports itself as "347 items modified" is a silent failure — the count shown must be the
count actually written, with skips listed separately and never folded into a success total.

Permission is re-checked at the same point: a group library that was read/write at scan time
may be read-only by write time (§39).

---

# 41. Privacy

Core reconciliation should operate entirely on local Zotero data.

External metadata validation should be:

- optional;
- clearly indicated;
- **disabled by default**, without qualification. Group libraries routinely contain
  unpublished, embargoed, or under-review work, and the user who enables a lookup is not
  always the person who contributed the record. Opt-in is the only defensible default;
- limited to identifiers or bibliographic queries necessary for validation.

No notes, annotations, or PDFs should ever be sent to external metadata services.

---

# 42. Development Phases

> **Ordering note.** §35 describes "Find Copies" as *"one of the first implemented
> features"* and *"an excellent way to test the matching engine before building full-library
> reconciliation"* — but §42 placed it in Phase 2 and §51 at step 8, in both cases after the
> full dashboard. That builds the entire reporting surface on an unvalidated matcher. The
> phases below put Find Copies first. It exercises scanner, normalization, matching, and
> evidence display end-to-end on one item, where a wrong answer is visible in a second and
> costs nothing.

## Phase 1 — Matching engine + Find Copies

**Read only.**

Implement:

- enumerate libraries;
- scan bibliographic items (excluding trashed items, §6);
- normalization engine (§7);
- denial rules (§8.0);
- exact DOI/PMID/ISBN matching;
- title + author + year matching, using the content-word rule (§8.3);
- item-type compatibility (§8.4);
- match evidence display (§9);

```text
Right click item
→ Find Copies in Other Libraries
```

### Deliverable

A user can answer, for any single item:

> Where else does this work exist, and why does the plugin believe those records are the
> same work?

### Exit criterion

Do not start Phase 2 until the matcher has been run against real libraries and its
disagreements with Zotero's own Duplicate Items view have each been explained. An
unexplained disagreement is a bug in one of the two, and it is cheaper to find it here.

**Met 2026-09-17** — see `docs/validation-2026-09-17.md`. A faithful port of
`duplicates.js` was run beside the matcher on 4,149 items across eight libraries; every
disagreement is accounted for by a documented `[DIVERGES]` rule or a fixed defect.

---

## Phase 2 — Cross-Library Audit

**Read only.**

Implement:

- clustering into the Scholarly Work index (§8.2);
- blocking (§8.5);
- identify works missing from My Library;
- identify metadata differences;
- dashboard;
- export reconciliation report.

No Zotero data modifications.

### Deliverable

A user can answer:

> What scholarly works occur across my Zotero libraries, where do they occur, and where do their records disagree?

---

## Phase 3 — Add Missing Items to My Library

Implement:

```text
[ Add Selected to My Library ]
```

Safeguards:

- exact/high-confidence matches only;
- **recall-favouring re-check against My Library before import (§48.1)**;
- preview;
- dedicated import collection;
- transaction log;
- **session undo** — `undoAction` on every write (§27), plus "remove everything imported in
  this session" via the dedicated import collection.

Undo belongs here, not in Phase 4. This is the first phase that writes, and it writes at the
largest scale the plugin ever operates at — a single confirmation can add hundreds of items.
Shipping the highest-volume write before the ability to reverse it inverts the risk ordering
that governs every other part of this design. Native undo does **not** cover item creation
(§27 correction), so the import collection + transaction log *are* the undo mechanism, not
a convenience. Every import also records Zotero's own `owl:sameAs` linked-item relation so a
later manual drag does not create a second copy.

Architecture, invariants and open decisions: `docs/phase3-write-safeguards.md`.

---

## Phase 4 — Metadata Reconciliation

Implement:

- field-level comparison;
- source selection;
- target selection;
- preview;
- write operations;
- transaction logging;
- undo.

---

## Phase 5 — Incremental Monitoring

Implement:

- item/library version tracking;
- rescan only changed records;
- optional notification:

```text
17 cross-library discrepancies detected
since your last scan.
```

This should remain informational rather than automatically modifying records.

---

## Phase 6 — External Validation

Optional integrations:

- Crossref;
- PubMed;
- DataCite;
- OpenAlex.

Use external metadata as an additional comparison source.

---

## Phase 7 — Extended Content

Potentially add explicit tools for:

- attachments;
- tags;
- notes;
- annotations.

These should remain opt-in and manually controlled.

---

# 43. Minimum Viable Product

The MVP should be deliberately narrow.

### MVP features

```text
✓ Zotero 10 support
✓ My Library + Group Library scanning
✓ DOI matching
✓ PMID matching
✓ ISBN matching
✓ title/creator/year matching, including addition-only title variants
✓ cross-library Scholarly Work index
✓ missing-from-My-Library report
✓ bibliographic discrepancy report
✓ match confidence/evidence
✓ read-only operation
```

The MVP does **not need to modify Zotero at all**.

That dramatically reduces development risk.

---

# 44. MVP Success Criteria

The MVP succeeds if a user with multiple Zotero libraries can determine:

1. Which scholarly works occur in multiple libraries?
2. Which works occur in Group Libraries but not My Library?
3. Which copies contain conflicting bibliographic metadata?
4. Why did the plugin decide two items represent the same work?
5. Which matches require human review?

with **zero changes to the underlying Zotero database**.

---

# 45. Proposed Repository Structure

```text
zotero-library-reconciler/
│
├── src/
│   ├── scanner/
│   │   ├── libraryScanner.ts
│   │   └── itemScanner.ts
│   │
│   ├── normalization/
│   │   ├── doi.ts
│   │   ├── title.ts
│   │   ├── creators.ts
│   │   └── identifiers.ts
│   │
│   ├── matching/
│   │   ├── exactMatcher.ts
│   │   ├── bibliographicMatcher.ts
│   │   ├── fuzzyMatcher.ts
│   │   └── matchEvidence.ts
│   │
│   ├── works/
│   │   └── scholarlyWorkIndex.ts
│   │
│   ├── comparison/
│   │   ├── fieldComparator.ts
│   │   └── recordComparator.ts
│   │
│   ├── reconciliation/
│   │   ├── proposalEngine.ts
│   │   ├── writeEngine.ts
│   │   └── transactionLog.ts
│   │
│   ├── ui/
│   │   ├── dashboard/
│   │   ├── compare/
│   │   └── preferences/
│   │
│   └── zotero/
│       ├── api.ts
│       ├── notifications.ts
│       └── permissions.ts
│
├── tests/
│   ├── normalization/
│   ├── matching/
│   ├── comparison/
│   └── fixtures/
│
├── docs/
│   ├── architecture.md
│   ├── matching.md
│   └── safety.md
│
├── manifest.json
├── package.json
└── README.md
```

---

# 46. Testing Strategy

Matching requires especially strong tests.

Each fixture asserts a **verdict** (`MATCH` / `RELATED` / `REVIEW` / `NO MATCH`) and the
**rule that produced it**, not a boolean. A fixture that passes for the wrong reason — a
denial rule firing where a title rule should have — is a latent regression, because the
rule that should have caught it is untested.

Required regression fixtures, with the rule each one pins:

| Fixture | Expected | Rule under test |
|---|---|---|
| `10.1002/jwmg.12345` vs `https://doi.org/10.1002/JWMG.12345` | MATCH (Tier 1) | §7 DOI normalization |
| ISBN-10 vs its ISBN-13 form | MATCH (Tier 1) | §7 ISBN-13 canonicalization |
| Same title/author, DOIs differ | NO MATCH | §8.0 D1 |
| Same article, print ISSN vs eISSN | MATCH (Tier 2, if other evidence agrees) | §8.0 ISSN is not a denial |
| Same title/author, years 2019 vs 2020 | MATCH (Tier 2) | §7 ±1 year tolerance |
| Same title/author, years 2019 vs 2022 | NO MATCH | §8.0 D5 |
| `…duck hunters` vs `…goose hunters` | NO MATCH | §8.3 SUBSTITUTION |
| `annual report 2019` vs `annual report 2020` | NO MATCH | §8.3 SUBSTITUTION |
| Title vs title + subtitle | MATCH, difference flagged | §8.3 ADDITION-ONLY |
| `Long-term` vs `Long term` | MATCH | §7 punctuation → space |
| `Mallards.` vs `mallards` | MATCH | §7 trim/case |
| Creator order differs between libraries | MATCH | §7 any-creator rule |
| Corporate author, exact string | MATCH | §7 single-field-mode |
| Corporate author, abbreviated | NO MATCH | §7 single-field-mode |
| Both records creatorless, titles equal | MATCH | §7 creatorless rule |
| One creatorless, one with creators | NO MATCH | §7 creatorless rule |
| preprint vs journalArticle, same title | RELATED | §8.4 |
| conferencePaper vs journalArticle | RELATED | §8.4 |
| bookSection vs its parent book | NO MATCH | §8.4 |
| dataset vs article, shared title | NO MATCH | §8.4 |
| A↔B Tier 1, B↔C Tier 3 | C excluded from cluster | §8.2 tier-restricted union |
| A↔B Tier 1, C Tier 2 but DOI conflicts with A | C excluded | §8.2 whole-cluster denial |
| Two items, same library, same DOI | one cluster, 2 instances | §8.2 cluster invariants |
| Trashed group item, matches My Library item | absent from all reports | §6 |
| Item whose PMID lives only in `extra` | MATCH on PMID | §7 `extra` parsing |

The clustering fixtures matter most and are easiest to omit: they are the only ones that
test the step between a pairwise verdict and a Scholarly Work, which is where a single bad
edge becomes a corrupted cluster.

Additional fixtures:

### Exact DOI

```text
10.1002/jwmg.12345
https://doi.org/10.1002/jwmg.12345
```

Expected:

```text
MATCH
```

### Same title, different capitalization

Expected:

```text
MATCH
```

### Same title, different year

Expected:

```text
REVIEW or NO MATCH
```

### Similar titles, different papers

Example:

```text
Effects of harvest regulations on duck hunters

Effects of harvest regulations on goose hunters
```

Expected:

```text
NO AUTOMATIC MATCH
```

### Missing DOI in one library

Expected:

```text
match through bibliographic evidence
```

### Incorrect DOI

Expected:

```text
identifier conflict
```

### Conference paper versus journal article with similar title

Expected:

```text
NO AUTOMATIC MATCH
```

### Preprint versus published article

Expected:

```text
RELATED / REVIEW
```

rather than automatically assuming they are identical.

---

# 47. Important Edge Cases

The design should explicitly consider:

- preprint versus published paper;
- early-online versus final publication;
- corrected article;
- erratum;
- translated editions;
- book editions;
- chapters appearing in multiple editions;
- conference abstract versus journal article;
- identical titles by different authors;
- title changes between online-first and final publication;
- DOI entered incorrectly in one library;
- duplicate DOI metadata;
- corporate authors;
- missing publication dates;
- datasets sharing titles with papers;
- reports without persistent identifiers.

---

# 48. Guiding Safety Principle

The fundamental safety principle should be:

> **False negatives are inconvenient. False positives can damage a library.**

Therefore:

```text
When uncertain → ask the user.
```

not:

```text
When uncertain → merge or overwrite.
```

## 48.1 Where this principle inverts

The principle above is stated for *reconciliation*, where a false positive copies metadata
between unrelated works. For one feature it points the wrong way, and that feature is
Phase 3.

**Missing from My Library (§15) is built from Tier 4 — "no match found."** A matcher tuned
for precision deliberately produces false negatives. Each false negative is a work that
*is* in My Library but was not recognized, so it appears on the missing list, and Phase 3
offers to import it. The import succeeds and My Library gains a duplicate of something it
already held.

```text
Reconciliation path:   false positive → wrong metadata copied   (precision matters)
Import path:           false NEGATIVE → duplicate created       (recall matters)
```

Same matcher, opposite risk direction. The two must therefore be tuned differently:

```text
DETECTION  (is this the same work? may I copy a field?)   → favour precision
IMPORT     (is this genuinely absent from My Library?)    → favour recall
```

Before any item is imported, re-check it against My Library with **recall-favouring**
settings — fuzzy tier enabled, denial rules relaxed to warnings, blocking widened — and
surface the near-misses rather than suppressing them:

```text
Lee 2025 — no match in My Library

   ⚠ 3 similar items exist in My Library:
       Lee 2025  "Waterfowl harvest management"      (title: ADDITION-ONLY)
       Lee 2024  "Waterfowl harvest management"      (year differs by 1)
       Lee, S. 2025 "Waterfowl harvest mgmt."        (title: SUBSTITUTION)

   [ Import anyway ]   [ Skip — already present ]   [ Compare ]
```

A user who imports 623 items and receives 40 duplicates has been handed exactly the manual
cleanup this plugin exists to remove. Note also that Zotero's own Duplicate Items view will
not necessarily catch them afterwards: it applies the rules in §7–§8.0, and the near-misses
that slipped past a precision-tuned matcher are frequently the same ones Zotero's matcher
misses.

---

# 49. Product Philosophy

Library Reconciler should not attempt to turn Zotero's independent libraries into a single synchronized database.

Instead, it should acknowledge that independent libraries are useful.

A Group Library may legitimately contain:

- project-specific notes;
- project-specific tags;
- collaborative annotations;
- different attachments;
- different collection structures.

What should be shared is the **identity and bibliographic description of the scholarly work**, when appropriate.

The architecture therefore follows:

```text
Independent Zotero Items
          │
          ▼
Shared Scholarly Identity
          │
          ▼
Compare
          │
          ▼
Reconcile selectively
```

rather than:

```text
Independent Zotero Items
          │
          ▼
Force everything to become identical
```

---

# 50. Long-Term Vision

A mature Library Reconciler could give Zotero a conceptual layer currently missing from its library model:

> **The same scholarly work can exist as multiple independent Zotero items while Zotero understands that those items represent the same intellectual object.**

That would enable functionality beyond reconciliation:

```text
Find this paper everywhere

Compare metadata everywhere

Show which projects use this paper

Find papers missing from My Library

Identify the most complete metadata

Audit PDFs across libraries

Identify annotation locations

Track cross-library use

Validate bibliographic metadata

Copy selected metadata safely
```

without destroying the independence of Group Libraries.

The plugin's central abstraction—the **Scholarly Work Index**—is therefore potentially more valuable than synchronization itself.

---

# 51. Recommended Initial Development Path

The safest and most useful development sequence is:

```text
 1. Build Zotero 10 library scanner  (trash-filtered)
           ↓
 2. Build normalization engine                        §7
           ↓
 3. Build denial rules                                §8.0
           ↓
 4. Build exact identifier matcher
           ↓
 5. Build title/author/year matcher                   §8.3, §8.4
           ↓
 6. Add Find Copies command                           §35
           ↓
 7. VALIDATE MATCHING ON REAL LIBRARIES               ← gate
    reconcile every disagreement with Zotero's
    own Duplicate Items view before continuing
           ↓
 8. Build blocking                                    §8.5
           ↓
 9. Build Scholarly Work index (clustering)           §8.2
           ↓
10. Produce Missing from My Library report            §15
           ↓
11. Produce Metadata Differences report               §11
           ↓
12. Only then implement write operations,
    with undo attached to the first one                §27
```

Steps 6 and 7 moved ahead of the index and the reports. Find Copies exercises the entire
detection path on a single item, which is the cheapest place to discover that the matcher is
wrong; every later step inherits its verdicts, and a clustering bug found at step 9 is a
matching bug that should have been caught at step 7.

The key architectural decision is to **separate detection from modification**.

A reliable cross-library audit engine is useful by itself and provides the foundation for every subsequent reconciliation feature.

---

## Summary

Zotero Library Reconciler should be built around three principles:

**Identity without merging.**  
Recognize that separate Zotero items can represent the same scholarly work.

**Comparison before synchronization.**  
Expose differences and provenance before changing anything.

**Conservative modification.**  
Preserve Zotero item identities, existing citation links, project-specific metadata, and user control.

The first version should therefore be a **read-only Zotero 10 cross-library auditing tool**. Once its matching engine has demonstrated high reliability, controlled metadata reconciliation can be layered onto that foundation.
---

# 52. Sources for Normative Rules

Every threshold, tolerance, and denial rule in §§6–8 is taken from an existing
implementation or a published evaluation rather than chosen for this document. Recorded here
so that a future change can be checked against its origin.

## Zotero's own duplicate detection

`chrome/content/zotero/xpcom/duplicates.js` — the authority for §7's normalization and for
D1, D2, D5. Adopted because a plugin that disagrees with Zotero's built-in Duplicate Items
view about what constitutes the same work will produce contradictory advice inside the same
application.

Taken directly:

```text
normalizeString()   NFKD + strip diacritics, /[ !-/:-@[-`{-~]+/g → " ", trim, lowercase
DOI                 trim + case-fold; Zotero filters SQL LIKE '10.%'
ISBN                Zotero.Utilities.toISBN13() before comparison
year                Math.abs(yearA - yearB) > 1  → reject
creators            match on (lastName, firstInitial); ANY creator, not the first
                    both creatorless → match; one creatorless → no match
trash               every query filtered by NOT IN (SELECT itemID FROM deletedItems)
clustering          Zotero.DisjointSetForest, unrestricted transitive union
```

Deliberate divergences, each justified at its point of use:

```text
§7   strip DOI proxy prefixes (Zotero does not)
§7   strip HTML markup from titles (Zotero does not)
§8.2 tier-restricted union (Zotero unions transitively without restriction —
     safe there only because Zotero has no fuzzy tier)
§8.3 content-word comparison (Zotero requires exact normalized title equality)
```

The §8.2 divergence is the important one. Zotero's unrestricted transitivity is correct
*for Zotero*, because every edge it unions on is high-confidence. Introducing a fuzzy tier
without restricting transitivity is what turns one bad edge into a merged cluster.

## Metta (Oxford *Database*, `10.1093/database/bat086`)

A rule-based deduplicator for biomedical bibliographic records; source of the denial-rule
construction itself, D3's PMID treatment, and the year-blocking strategy.

Metta's ISSN condition is intentionally **not** adopted as a denial rule here: a single
article can legitimately be represented with its journal's print ISSN in one record and
electronic ISSN in another (§8.0).

```text
denial rules     differing PMID / DOI / ISSN → not duplicates, evaluated before positives
similarity       LCS(A,B) / MIN_LEN(A,B), threshold 0.8
                 (0.7 was tested and produced errors)
blocking         partition by publication year, hash join;
                 year-less records (~0.1%) handled separately at the end
evaluation       6,265 records: 0 false positives, vs 14 for EndNote on the same set
```

**The 0.8 threshold is cited but not adopted.** Measured against this specification's own
required-negative fixture (§46), the forbidden `duck`/`goose` pair scores 0.913 by
LCS/MIN_LEN and 0.903 by Levenshtein ratio — both comfortably above 0.8. The rule in §8.3
is content-word set comparison instead, verified against seven fixtures. Metta's threshold
is retained only for the narrow typo/OCR case described at the end of §8.3.

This is the one place where the published state of the art was measured and found
insufficient for a requirement this specification imposes.

## Zotero 10 platform

Released 17 August 2026; 10.0.2 current as of September 2026. From Zotero's release notes
and *Zotero 10 for Developers*:

```text
undo            saveTx({ undoAction, undoActionArgs });
                Zotero.UndoHistory.stageAction() within a transaction
selection       plural getters: getSelectedCollections(), getSelectedLibraryIDs(),
                getSelectedSavedSearches(); singular forms no longer throw on
                single selection and will silently read only the first row
local API       /api/ accepts writes; Zotero-Server-ID header must be cached
merge           items of different types cannot be merged:
                "Merged items must all be of the same item type"
citation key    native field since Zotero 8, migrated out of Extra; syncs
```

## Identifier standards

```text
DOI Handbook / Crossref   DOI suffixes are case-insensitive; proxy prefixes are not
                          part of the identifier
Crossref relations        is-preprint-of (on the preprint) /
                          has-preprint (on the article) — authoritative resolution
                          of the preprint↔published case in §8.4 and §47
Zotero Extra field        parsed line-wise as "CSL Variable: Value"; recognized
                          variables include PMID, PMCID, Status, Submitted,
                          Original Date, Original Title, Event Date, Event Place, DOI
```

## Verification

The §8.3 classification rule and the similarity measurements in the table above were
computed against the §46 fixtures rather than estimated. Any change to the stoplist,
the normalization order, or the classification rule must be re-checked against the full
fixture table in §46 before it is adopted.
