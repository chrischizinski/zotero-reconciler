# Phase 3 design — "Add Missing Items to My Library" write safeguards

Status: design only, 2026-09-17. No write code exists yet. `design.md` §25–28, §39–40,
§42 (Phase 3) and §48.1 are the governing spec; this document turns them into an
implementable architecture and records where the spec's assumptions did not survive
contact with Zotero 10.0.2 source (`omni.ja`, read 2026-09-17).

## 1. Big picture

Phases 1–2 answer "which works in my group libraries are absent from My Library?" and
modify nothing. Phase 3 lets the user act on that list by **copying** selected items into
My Library. It is the first code path that writes to Zotero, and it writes at the largest
scale the plugin ever will (one confirmation can create hundreds of items), so it is where
the safety pipeline (§25) is built and proven before any field-level reconciliation
(Phase 4) reuses it.

```text
Missing-from-My-Library list  (Phase 1, read-only, precision-tuned)
        │  user selects rows
        ▼
Recall re-check against My Library          (§48.1 — the one place recall beats precision)
        │  near-misses surfaced, user decides per row
        ▼
Preview  →  Confirm  →  Write  →  Log
                          │
                          ├─ clone item into My Library
                          ├─ add to the session's import collection
                          └─ record Zotero linked-item relation (owl:sameAs)
```

Nothing in the source library is touched. Nothing in My Library is edited. The only
mutation is *creation* of new items, and the only reversal is *trashing* those items.

## 2. What Zotero already provides (verified in 10.0.2 source)

| Need | Zotero API | Notes |
|---|---|---|
| Copy a regular item to another library | `Zotero.Item.prototype.clone(libraryID, { skipTags })` then `newItem.save()` | Same call Zotero's own drag-to-group uses (`collectionTree.js` `_copyItem`). Copies fields + creators; tags optional; collections/relations never cross libraries. |
| Remember that two items across libraries are "the same" | `newItem.addLinkedItem(sourceItem)` → `owl:sameAs` relation | Zotero writes this on every drag between libraries and checks it (`getLinkedItem`) before creating a second copy. **Every Phase 3 import must write it**, so a later manual drag does not duplicate our import, and so our own rescan clusters the pair at Tier 0 (see §6). |
| Detect an existing copy before creating one | `item.getLinkedItem(targetLibraryID, /*bidirectional*/ true)` | Cheap, exact, and independent of our matcher. Runs first in the recall re-check. |
| Library permissions (§39) | `Zotero.Libraries.get(id).editable`, `.filesEditable`, `.isGroup` | Target must be `editable`; sources may be read-only. |
| Reverse a creation | `Zotero.Items.trashTx(ids)` | Moves to Zotero trash (recoverable for the user's trash-retention window). Trashing an existing item is a modification, so it *is* natively undoable. |
| Native undo (§27) | `save({ undoAction, undoActionArgs })` → `Zotero.UndoHistory.stageAction` | **Only for modifications of existing objects.** `DataObject.save()` calls `stageChange` only when `!env.isNew` (`dataObject.js`), and `undoHistory.js` states "Only tracks modifications to existing objects." |

### 2.1 Correction to `design.md` §27 / §42 Phase 3

The spec says Zotero 10's native undo makes session undo for Phase 3 "close to zero" cost.
That is true for **Phase 4** (field edits on existing items) and **false for Phase 3**
(new items are never staged). Phase 3 undo therefore has to be the plugin's own, built on
two things Zotero does give us: the per-session import collection and the trash. See §7.

## 3. Pipeline → modules

`design.md` §25 mandates `SCAN → MATCH → COMPARE → PROPOSE → PREVIEW → CONFIRM → WRITE → LOG`.
Concretely:

| Stage | Module (new unless noted) | Zotero access? | Output |
|---|---|---|---|
| SCAN / MATCH | existing `adapter.ts`, `crossLibraryAudit.ts` | read | `IndexSnapshot`, `missingFromMyLibrary` |
| COMPARE | `src/write/recallCheck.ts` | none (operates on `NormalizedItem`) | `NearMiss[]` per candidate |
| PROPOSE | `src/write/importPlan.ts` | none | `ImportPlan` — pure data, serialisable |
| PREVIEW | `src/plugin/importPreview.xhtml` + `src/write/importPreviewModel.ts` | none | user's per-row decisions |
| CONFIRM | same window | none | `ImportPlan` with `confirmedAt`, only rows marked `import` |
| WRITE | `src/zotero/writeAdapter.ts` | **write — the only file allowed to** | `ImportOutcome` (created / skipped / failed per row) |
| LOG | `src/write/transactionLog.ts` + `src/zotero/transactionStore.ts` | file I/O only | appended JSONL entry |

Two rules carry over from Phases 1–2 and become stricter:

- `src/zotero/adapter.ts` stays read-only. Writes get their own file, `writeAdapter.ts`,
  so a reviewer can `grep` one file for every mutation the plugin can perform.
- Everything outside `src/zotero/` is pure and testable without Zotero. The plan is
  data; the write adapter *executes* a plan and never decides anything.

## 4. Invariants (each becomes a test)

1. **Creation only.** `writeAdapter` exposes `createItemCopy` and `trashItems`. No
   `setField` on an existing item, no `erase`, no collection changes outside the import
   collection. Enforced by the interface — there is nothing else to call.
2. **Target is My Library or an editable library the user chose; never a read-only
   library** (§39). Re-checked immediately before each write, not just at plan time.
3. **Source untouched.** The source item's version is read before and after the session
   and must be equal, except for the `owl:sameAs` relation Zotero adds to the *new* item
   (relations are stored on the subject; `addLinkedItem` is called on `newItem`).
4. **Stale source → skip, never write** (§40). If `sourceItem.version !== plan.sourceVersion`
   at write time, the row is skipped and reported with `[ Recompare ]`. The session
   continues.
5. **Existing linked copy → skip** even if the user ticked the row: `getLinkedItem` is the
   final gate inside the write loop, because a sync may have delivered a copy since PREVIEW.
6. **Every created item is in the session import collection and has an `owl:sameAs` link
   to its source**, or the row is reported as failed. Both happen inside one
   `Zotero.DB.executeTransaction` per row so a half-written row cannot exist.
7. **Counts are actuals** (§40 batch semantics). The completion report shows
   `created / skipped-stale / skipped-existing / failed` from `ImportOutcome`, never from
   the plan size.
8. **The transaction log entry is written before the success dialog is shown**, and if the
   log write fails the dialog says so — an import the plugin cannot account for is a
   reportable defect, not a silent success.
9. **No path from the missing list to `createItemCopy` without a `confirmedAt`
   timestamp on the plan.** `writeAdapter.execute(plan)` throws on an unconfirmed plan.
10. **Tier 3 / REVIEW rows never enter a plan as `import`** (§8.1); they may appear in the
    preview only as near-miss warnings on other rows.

## 5. Recall re-check (§48.1), concretely

Input: one candidate item (normalized) + all My Library normalized items + the existing
blocking indexes. Steps, in order, cheapest first:

1. `getLinkedItem(myLibraryID, true)` — exact; if found the row is `already-present`
   and cannot be imported (invariant 5).
2. Exact-identifier hits (DOI/PMID/arXiv/ISBN) in My Library **ignoring type
   compatibility and D-rules** — reported as near-miss with the denial evidence attached
   ("same DOI, type differs: report vs journalArticle").
3. Widened title blocking: first 3 normalized title words *or* first author surname + year
   ±1, then Tier 3 similarity with the threshold lowered by a fixed margin. Each hit is a
   near-miss with its evidence string (`ADDITION-ONLY`, `year differs by 1`, …).

The output never changes the *precision* index; it only decorates rows in the import
preview. Default row state:

```text
no near-miss                       → ticked   (import)
near-miss with shared identifier   → unticked (already present?)  — user must opt in
near-miss on title/author only     → unticked                    — user must opt in
linked item exists                 → disabled (already present)
```

## 6. Tier 0 — Zotero linked items as match evidence (read-only, can ship before Phase 3)

Zotero's `owl:sameAs` relations are user-asserted equivalences created by every
drag-between-libraries. They are:

- **a Tier 0 match** (`EXACT`, evidence `"Zotero linked item"`) — stronger than a DOI,
  because the user created it deliberately;
- **ground truth for validating the matcher**: every linked pair the matcher does *not*
  find is a real false negative; every matcher pair that contradicts a link is worth a
  look. This is a better oracle than `duplicates.js` for cross-library behaviour.

Scanner change: read `item.getRelationsByPredicate("owl:sameAs")` into `ScannedItem`
(URIs, resolved to `{libraryID, key}` by the adapter). Matcher: Tier 0 before Tier 1.
Recommended to build first, because Phase 3 both depends on it (invariant 5, 6) and
produces it.

## 7. Session undo without native undo

Since new items are not on Zotero's undo stack (§2.1):

- Each session creates a subcollection `Reconciler Imports / 2026-09-17 14:32` in the
  target library; every created item is added to it (§42 "dedicated import collection").
- The transaction log entry lists the created `{libraryID, key}` pairs and the
  collection key.
- **"Undo this import session"** = `Zotero.Items.trashTx(keys from the log entry)` +
  optionally trash the now-empty session collection. Items go to the trash, not erased;
  the user can still restore individual ones.
- Trashing *is* a modification of existing items, so it runs with
  `undoAction: "zotero-library-reconciler-undo-import"` and Zotero's ⌘Z can reverse the
  reversal. Fluent string must be registered by the plugin.
- Because a user may have edited an imported item before undoing, the undo preview lists
  items whose `version` moved since import and un-ticks them by default.

## 8. Transaction log

Location: `<dataDir>/zotero-library-reconciler/transactions.jsonl` — append-only, one
JSON object per line, same directory as `index.json`. JSONL rather than SQLite for the
same reason as the index: no query load, easy to inspect, easy to copy into a bug report.

```json
{
  "id": "2026-09-17T19:32:11.004Z-3f9a",
  "action": "import",
  "confirmedAt": "2026-09-17T19:32:08.000Z",
  "target": { "libraryID": 1, "collectionKey": "K7Q2M9AB" },
  "rows": [
    { "source": { "libraryID": 3, "key": "XYZ789", "version": 4412 },
      "created": { "libraryID": 1, "key": "ABC123" },
      "nearMisses": [] },
    { "source": { "libraryID": 3, "key": "QRS456", "version": 4300 },
      "skipped": "stale-source", "seenVersion": 4302 }
  ],
  "totals": { "created": 1, "skippedStale": 1, "skippedExisting": 0, "failed": 0 },
  "undoneAt": null
}
```

`undo` writes its own entry referencing the import `id` and sets `undoneAt` on the
original (rewrite of that one line is acceptable; the file is small).

## 9. Failure semantics (§40 applied)

| Condition | Where detected | Behaviour |
|---|---|---|
| Target library read-only | plan build **and** write loop | plan refuses; write loop aborts the whole session before any write (permission is session-wide, unlike item staleness) |
| Source item version changed | write loop, per row | skip row, continue, report `[ Recompare ]` |
| Source item deleted / trashed | write loop, per row | skip row, report |
| Linked copy now exists | write loop, per row | skip row as `already-present` |
| `save()` throws | inside per-row transaction | transaction rolls back; row `failed` with error text; continue |
| Log write fails | after loop | success dialog replaced by warning listing created keys so the user can find them |
| Sync starts mid-session | not detectable reliably | per-row version check is the defence; no global lock attempted |

## 10. Testing strategy

- `WriteAPI` interface in `src/zotero/writeAdapter.ts` with exactly the methods in
  invariant 1; tests use a fake that records calls and can be told to throw / report a
  moved version on the Nth row.
- Fixture plans encode safety expectations the way matcher fixtures do:
  `STALE → SKIPPED`, `LINKED → ALREADY_PRESENT`, `UNCONFIRMED → THROWS`,
  `READ_ONLY_TARGET → ABORT_BEFORE_FIRST_WRITE`.
- Recall re-check fixtures reuse §46–47 edge cases with the opposite assertion: the pairs
  the precision matcher must *not* match (erratum, thesis↔article, conference abstract)
  must *appear as near-misses* here.
- Live validation before enabling the menu item by default: import into the **dev
  profile's** My Library only, with metadata-only sync (already the dev setup), then
  confirm in the real client's Duplicate Items view that nothing new appears.

## 11. Decisions needed before coding

| # | Question | Options | Consequence | Recommendation |
|---|---|---|---|---|
| A | Copy child attachments on import? | (1) metadata only; (2) copy stored files too | (2) needs `filesEditable`, disk space, `Zotero.Attachments.copyAttachmentToLibrary`, and turns a metadata tool into a file-sync tool (§20 says attachments are audited, never synchronised) | **(1)** for Phase 3; attachments stay Phase 7 opt-in |
| B | Copy tags on import? | (1) skip; (2) copy; (3) checkbox in preview | §22: tags are library-specific; Zotero's own drag defaults to copying them | **(1)** default, with (3) as a preview checkbox off by default — cheap, and matches Zotero's drag dialog |
| C | Import collection layout | (1) one flat `Reconciler Imports`; (2) parent + per-session subcollection | (2) makes "undo this session" and "what did I import last Tuesday" trivial | **(2)** |
| D | Build Tier 0 (linked items) first? | (1) yes, as a Phase 2.5 read-only change; (2) fold into Phase 3 | (1) gives a free matcher oracle now and simplifies Phase 3 invariants | **(1)** |

Items A–C have conventional defaults; if you say nothing I take the recommendations.
D changes the order of work, so it needs a yes/no.
