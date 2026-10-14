# Phase 4 design — field-level metadata reconciliation

Status: design accepted 2026-10-14 (decisions A–G all as recommended, §12); slice 1 in progress. `design.md` §11–§18, §24–§27,
§37–§40, §42 (Phase 4) and §48 are the governing spec; this document turns them into an
implementable architecture, reuses the Phase 3 pipeline (`docs/phase3-write-safeguards.md`),
and records where the spec's assumptions did not survive contact with Zotero 10.0.6 source
(`omni.ja`, read 2026-10-14). Decisions needed before coding are in §12.

## 1. Big picture

Phases 1–3 find the same work across libraries and copy *missing items* into My Library.
Phase 4 handles the other half: the work is already in My Library, but its record there is
thinner or different from the group copies. Phase 4 lets the user copy selected **field
values** from a group copy onto the My Library item.

```text
Scholarly Work index  (Phase 1, precision-tuned)
        │  works with a My Library copy + ≥1 other copy, linked by a strong pair (§5)
        ▼
Difference Engine — per field, across all copies          (§11, §38)
        │  IDENTICAL / MISSING / DIFFERENT / CONFLICTING
        ▼
Proposal — only MISSING fields pre-ticked; everything else is the user's choice
        ▼
Preview → Confirm → Write → Log
                      │
                      ├─ re-read each target field; skip if it changed since preview (§6)
                      ├─ setField / setCreators on the My Library item
                      └─ save with undoAction  → Zotero's own ⌘Z can revert it
```

What changes compared with Phase 3: Phase 3 only *created* items. Phase 4 is the first code
path that **modifies an existing record**, so the risk is no longer "a duplicate appears"
but "a correct value is overwritten". That is the false-positive harm §48 ranks highest, so
precision rules apply throughout (§48.1's recall inversion does *not* apply here).

What does not change: no item is created, deleted, merged or moved; source items are never
touched; tags, collections, notes, attachments, relations, `extra` and the citation key are
out of scope (§13).

## 2. What Zotero 10.0.6 provides (verified in source)

| Need | Zotero API | Notes |
|---|---|---|
| Edit a field | `item.setField(field, value)` then `item.save(opts)` | `setField` returns `false` when the value is unchanged. |
| Edit creators | `item.setCreators(array)` | Whole-list replacement. |
| Type-correct field for a base field | `Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, baseField)`, `isValidForType(fieldID, typeID)` | e.g. base `publicationTitle` is `bookTitle` on a book section, `proceedingsTitle` on a conference paper. |
| Native undo of field edits | `save({ undoAction: "undo-action-edit-metadata", undoActionArgs: { count } })` | **Covers fields and creators** (`Item._undoFieldMatches` handles `creators`, item-data fields, `itemTypeID`). The Fluent string `undo-action-edit-metadata` ships with Zotero — no plugin string needed. |
| Native undo staleness | `UndoHistory._apply` checks `matchesUndoSnapshot` *inside the same transaction* before reverting | Zotero refuses to undo over a value changed since. Our plugin undo copies this design (§8). |
| Detect a local edit | `clientDateModified` — updated on **every** local save (a DB column; not loaded onto item objects) | `version` is **not**: it changes only when sync assigns a new server version. |

### 2.1 Correction to `design.md` §40 (target version check)

§40 says: "verify that the target item's `version` still matches the version used during
comparison." In Zotero 10 the local `version` column only moves on sync
(`DataObject._saveData`: `version` is written only when explicitly changed; `synced=0` and
`clientDateModified` are what a local save updates). With auto-sync off — or between syncs
— a user can edit the target and its `version` stays the same. A version check would then
pass and the plugin would overwrite the user's fresh edit. This is exactly the harm §40
exists to prevent.

Phase 3 survived this because its §40 check was on the *source*, which only matters as a
"has this changed since I looked" hint. Phase 4 overwrites the *target*, so the check must
actually work. §6 replaces it with a field-value compare-and-swap, which is what Zotero's
own undo does.

### 2.2 Native undo limits (why the plugin log is still needed)

`Zotero.UndoHistory` is in-memory, capped at `undoHistory.steps` (default 100), and lost on
restart. One entry is one DB transaction. It answers "undo what I just did"; it cannot answer
"which library supplied this abstract three weeks ago" or "revert last Tuesday's session".
§26–§27 already require both; this confirms they serve different questions.

## 3. Scope

**Target: My Library only** (decision A, §12). Same rule as Phase 3, for three reasons:

1. §17 already makes My Library the canonical library by default.
2. Group writes affect other people's records and are where sync-time rejections happen.
   Zotero's client sees group editing as a simple yes/no. A server can be stricter
   (zotero.org may add finer permissions; the self-hosted altero server already has
   per-member `add` / `own` permissions that the client sees as plain *editable*), so a
   local write can pass §39's `editable` check and still be refused at sync — after the
   log says it succeeded.
3. Reconciling in one direction keeps the transaction log and undo simple.

**Sources:** any scanned library, including read-only ones (§39).

**Fields** (§12, filtered by §13):

```text
title  creators  abstractNote  publicationTitle  journalAbbreviation  volume  issue
pages  date  DOI  ISBN  ISSN  url  publisher  place  edition  language  rights
```

Compared via the **base field**, written to the target type's own field. A field that does
not exist on the target item's type is shown but **not offered**.

**Never reconciled, in any phase:** `itemType` (changing it silently drops fields — §12;
shown as a difference only), `citationKey` (§13), `extra` (§13; per-line merge no earlier
than Phase 7), `dateAdded`, `dateModified`, `accessDate`, tags, collections, relations,
notes, attachments.

## 4. Difference Engine (§11, §38)

Input: one target value (My Library) and N source values for one field. Values are compared
after normalization (same `normalize.ts` rules the matcher uses: case, whitespace,
punctuation, dashes, DOI/ISBN canonical forms). Raw values are always the ones shown and
written.

| Class | Rule | Default in preview | Why |
|---|---|---|---|
| `IDENTICAL` | every non-empty copy normalizes to the same value, and the target has it | not offered | nothing to do |
| `MISSING` | target empty; every source that has a value agrees | **ticked** — copy that value (except DOI/ISBN/ISSN: unticked, see below) | the §38 "safe recommendation" |
| `DIFFERENT` | target has a value; the sources agree with each other but not with the target | unticked; one alternative offered | the §38 "much less safe" case: one copy says 3, the others say 4 |
| `CONFLICTING` | the sources disagree with each other (≥2 different values) | unticked; user picks one, or none | there is no single alternative to recommend |

**Identifiers are never pre-selected** (decided 2026-10-14, after the slice 2 live report
showed many `DOI (missing)` rows). A missing DOI/ISBN/ISSN can only arise when the match did
not rest on that identifier (Tier 0 link or Tier 2 bibliographic), so the source value is
unverified; a wrong one copied into My Library misleads every later match (§46). Shown as
`MISSING` with a note, unticked.

`MISSING` and `CONFLICTING` are never collapsed (§38, CLAUDE.md). The spec lists all four
labels without defining `DIFFERENT` against `CONFLICTING`. The definitions above are a
proposal (decision B): both need review; the difference tells the user whether there is
one alternative value or several.

**Format-only differences** — raw values differ but normalize equal (`1021-1034` vs
`1021–1034`, `Journal of wildlife management` vs `Journal of Wildlife Management`): class
`IDENTICAL` with a "formatting differs" note, never offered (decision C). Copying
punctuation between records is noise, not reconciliation.
`normalizeText` maps *all* punctuation and symbols to spaces (good for titles, too blunt for
some fields: `C++` vs `C`). The engine therefore uses per-field comparators — DOI/ISBN/ISSN
canonical forms, pages/volume/issue compared on digits *and* separators, free text via
`normalizeText` — and the format-only note always shows both raw values, so a hidden
difference is still visible.

**Precision differences** — `date` `2024` vs `2024-05-03`, `pages` empty-end vs full range:
`DIFFERENT` with a note "source is more precise". Never ticked by default; the user decides.

**Creators** are one unit: the whole ordered list is compared and copied (decision E).
Comparison uses the matcher's creator normalization, so `Smith, J.` vs `Smith, Jane` is
reported as `DIFFERENT` (initials only), not `IDENTICAL`. Per-creator merging is deferred.

**Completeness, not correctness** (§18): the work header may say "Textbook has 3 fields
My Library lacks". It never says one copy is "correct".

## 5. Which pairs may reconcile (match-tier gate)

A source copy may supply values only if **the target and that source are directly matched**
at:

```text
Tier 0 corroborated → EXACT     ✓
Tier 1 exact identifier → EXACT ✓
Tier 2 strong bibliographic → HIGH ✓
Tier 3 POSSIBLE                  ✗  never (§8.1)
Tier 0 link but rules deny → REVIEW ✗
```

Being in the same cluster through a third item is **not** enough (decision F). A chain
`A ≈ B ≈ C` where `A↔C` were never compared directly is how a false positive spreads
metadata between unrelated works. The gate is applied when the plan is built and again when
the preview model is built (a source that fails the gate is shown greyed out with its
evidence, so the user can see why it is ignored).

## 6. Staleness: field-value compare-and-swap (replaces §40's version check)

The plan stores, for each field to write, the target's **raw value as shown in the preview**
(`expected`) and the value to write (`next`). Inside the write transaction, per target item:

```text
for each planned field:
    current = item.getField(field)            (or creators, as JSON)
    if current ≠ expected  → skip THIS ITEM (all its fields), reason "target changed"
if a source field no longer holds the previewed value, or the source is trashed → skip, reason "source changed"
otherwise setField / setCreators for every planned field, save with undoAction
```

- **Check and write share one transaction** — the same atomic pattern as Zotero's own undo
  (`UndoHistory._apply`). A sync cannot sneak in between.
- **Skip the whole item, not one field.** A partial update of one record from a preview the
  user no longer agrees with is worse than none; the item gets `[ Recompare ]`.
- **The source check** is a value compare too: each copied source field must still hold the
  value previewed, and the source must not be trashed. Reason: the log claims "value from
  Textbook item XYZ789". (Implementation note, 2026-10-14: `clientDateModified` is not loaded
  onto Zotero item objects, so a value check is both available and more precise than a
  timestamp.) Rare; skipping is cheap.
- Batch semantics are §40 unchanged: skip and continue, never abort the session for one
  stale item, never write it anyway. Counts shown are actuals.

Permission is re-checked once per session before the first write (My Library is always
editable, but the check stays so a later group target cannot skip it).

## 7. Pipeline → modules

| Stage | Module | Zotero access? | Output |
|---|---|---|---|
| SCAN / MATCH | existing `adapter.ts`, `crossLibraryAudit.ts`, index | read | works + pair verdicts |
| COMPARE | `src/zotero/adapter.ts` `readReconcilableFields(items)` (new, read-only) + `src/comparison/differenceEngine.ts` (new, pure; supersedes the 5-field `fieldComparator.ts`) | read for field load only | `WorkDifferences` per work |
| PROPOSE | `src/write/reconcilePlan.ts` | none | `ReconcilePlan` (target ref, per-field `expected`/`next`/source ref, tier evidence) |
| PREVIEW / CONFIRM | `src/plugin/reconcilePreview.xhtml` + `src/write/reconcilePreviewModel.ts` | none | user's per-field choices, `confirmedAt` |
| WRITE | `src/write/reconcileExecutor.ts` → `WriteAPI.updateFields` in `src/zotero/writeAdapter.ts` | **write — still the only mutating file** | `ReconcileOutcome` per item |
| LOG | existing `transactionLog.ts` / `transactionStore.ts`, new entry kind | file I/O | JSONL entry |

Fields beyond the six the scanner reads today are loaded at COMPARE time, only for the items
being compared (`loadDataTypes` is already called during the scan, so `getField` is cheap).
The full scan stays as fast as it is.

`writeAdapter.ts` gains exactly one capability:

```ts
/** Compare-and-swap field edit on an existing My Library item, inside one transaction.
 *  Rejects any field outside RECONCILABLE_FIELDS (citationKey, extra, itemType → throw). */
updateFields(target: WriteItemRef, edits: readonly FieldEdit[], source: SourceGuard,
             undo: { count: number }): Promise<"written" | "target-changed" | "source-changed">;
updateFieldsBatch(updates)  // the same for a chunk of 25 items in one transaction (one ⌘Z step);
                            // each item re-checked on its own, a stale one skipped, the rest written
```

The allowlist is enforced **in the adapter**, not just in the UI. A bug upstream must not be
able to write `extra` or the citation key.

## 8. Undo

Two levels, as §27 requires:

1. **Native ⌘Z** — every save carries `undoAction: "undo-action-edit-metadata"`. One
   transaction = one ⌘Z step: a single-work edit is one step; a batch of 25 items is one step.
   Zotero declines to undo over later edits.
2. **Plugin "Undo Last Reconciliation Session…"** (Tools menu, next to the import undo) —
   built from the log, with the same compare-and-swap in reverse: restore `old` only where
   the field still holds the `new` value the session wrote. Fields edited since then, or
   already reverted with ⌘Z, are skipped and listed. The revert itself is saved with an
   `undoAction`, so it is undoable too. Survives restarts; reaches past the 100-step native
   cap.

## 9. Transaction log entry

Same file (`<dataDir>/zotero-library-reconciler/transactions.jsonl`), new `action`:

```json
{
  "id": "2026-10-20T15:02:11.004Z-7c1e",
  "action": "update_metadata",
  "confirmedAt": "2026-10-20T15:02:08.000Z",
  "items": [
    { "target": { "libraryID": 1, "key": "ABC123" },
      "changes": {
        "issue": { "old": "", "new": "4",
                   "source": { "libraryID": 6, "key": "XYZ789" }, "class": "MISSING" },
        "pages": { "old": "", "new": "1021–1034",
                   "source": { "libraryID": 6, "key": "XYZ789" }, "class": "MISSING" } },
      "evidence": "Tier 1: DOI 10.1002/jwmg.12345" },
    { "target": { "libraryID": 1, "key": "DEF456" }, "skipped": "target-changed" }
  ],
  "totals": { "itemsUpdated": 1, "fieldsWritten": 2, "skippedTargetChanged": 1,
              "skippedSourceChanged": 0, "failed": 0 },
  "undoneAt": null
}
```

**Implementation note (slice 3, 2026-10-14):** a batch session is logged as one
`update_metadata` line *per attempted item* (the same shape Compare Copies writes), all
sharing a `session` id and written in one append; IDs are `<session>-<index>` (a 4-hex random
suffix alone collides at a few hundred items). Cancelled items are not logged (nothing was
attempted). "Undo Last Metadata Update…" reverts the latest entry, or every un-undone written
entry of its session, in chunks of 25 with the same compare-and-swap; only items actually
restored are marked undone. This reuses the per-item entry, undo and `markUndone` unchanged
instead of adding a nested entry kind.

Creators are logged as JSON arrays in `old`/`new`. Invariant 8 from Phase 3 carries over:
the log line is written before the result window, and a failed log write is reported, not
hidden.

## 10. Invariants (each becomes a test)

1. **Field edits only, on My Library items only.** `updateFields` rejects a non-user-library
   target and any field outside the allowlist (`citationKey`, `extra`, `itemType`,
   `dateAdded` … → throw). No create, trash, erase, tag, collection or relation call.
2. **Sources are never written.** Source `version`/`clientDateModified` are equal before and
   after a session (live-checked in the DB, as in Phase 3).
3. **Only strong, direct pairs supply values** (§5). Tier 3 / REVIEW / transitive → not in
   the plan.
4. **Only `MISSING` is pre-ticked, and never an identifier (DOI/ISBN/ISSN).** `DIFFERENT` / `CONFLICTING` require a user click per
   field; there is no "accept all differences" button.
5. **Compare-and-swap inside the transaction** (§6); a stale item is skipped whole and listed
   with `[ Recompare ]`.
6. **No unconfirmed plan reaches `updateFields`** (`confirmedAt` required; executor throws).
7. **Counts are actuals**; skips are listed separately, never folded into a success total.
8. **Log before result window**; log failure is shown with the affected item keys.
9. **Every save carries `undoAction`.**
10. **Plugin undo is compare-and-swap too**: never restores `old` over a value the session did
    not write.

## 11. Delivery slices

| Slice | Content | Why first / later |
|---|---|---|
| 1 | Difference Engine (pure) + **"Compare Copies…"** on one My Library item (item context menu): side-by-side table, per-field source choice, preview, write, log, native undo, plugin session undo | Smallest write surface: one item, user looks at every field. Validates CAS, undo and the log on real data before any batch. |
| 2 | Audit report "Metadata Differences" view lists works by class counts, opens slice 1's window per work | Read-only; makes slice 1 reachable at scale. |
| 3 | **"Fill Missing Fields from Other Libraries…"** batch (Tools menu): `MISSING` only, chunked (25), progress + cancel, soft cap — Phase 3 slice 3 machinery reused | The scale path. Only after slice 1 has been live-validated. |

Each slice behind a startup pref, as in Phase 3:
`extensions.zotero-library-reconciler.enableReconcile` (absent ⇒ off).

**Live validation** (before slice 3): dev profile, auto-sync off. Edit one target field by
hand between preview and confirm → expect `target-changed` skip. ⌘Z after a write → fields
restored. Plugin undo after ⌘Z → "already reverted" skip. DB check that source rows did not
change.

## 12. Decisions needed before coding

| # | Question | Options | Consequence | Recommendation |
|---|---|---|---|---|
| A | Which libraries can be targets? | (1) My Library only; (2) any editable library | (2) writes other people's records, needs a per-library log/undo story, and can be rejected at sync by server-side permissions the client cannot see | **(1)**; group targets a later, opt-in phase |
| B | `DIFFERENT` vs `CONFLICTING` | (1) as §4: DIFFERENT = one alternative, CONFLICTING = sources disagree; (2) collapse to one "review" class | (2) hides whether there is one candidate value or several | **(1)** |
| C | Format-only differences | (1) IDENTICAL + note, not offered; (2) offered as DIFFERENT | (2) floods the preview with dash/case rows | **(1)** |
| D | Staleness check | (1) field-value CAS in-transaction, target and source; (2) target `clientDateModified`; (3) `version` (spec) | (3) misses unsynced edits — unsafe. (2) is safe but also trips on unrelated tag/collection edits | **(1)** |
| E | Creators | (1) whole list as one unit; (2) per-creator merge | (2) needs creator alignment and invites partial author lists | **(1)** |
| F | Pair evidence | (1) direct target↔source EXACT/HIGH; (2) any member of the same cluster | (2) lets one bad link spread values across a cluster | **(1)** |
| G | First slice | (1) single-work Compare Copies; (2) batch Fill Missing first | (2) is the bigger win but the larger blast radius for the first in-place edit the plugin ever makes | **(1)** |

Decided 2026-10-14: A (1), B (1), C (1), D (1), E (1), F (1), G (1).

## 13. Deferred (not Phase 4)

- Group-library targets (decision A).
- `extra` per-line merge (§13 → Phase 7). `itemType` changes (never).
- Writing an `owl:sameAs` link between matched items that lack one — a relation edit, useful
  for the 8 stale/missing links from the 2026-09-18 audit; separate design.
- External validation column (§19 → Phase 6).
- Per-creator merge (decision E).
