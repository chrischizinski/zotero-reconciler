# Remove Outdated Zotero Link — design note (decision P1, 2026-10-14)

Status: **accepted direction, not built.** A small slice, after the current work.

## Problem

Zotero records `owl:sameAs` when an item is copied between libraries and reads it back
(`Item.getLinkedItem`) to decide that a copy already exists. When a record is later
repurposed into a different paper, the link stays. On the user's data 8 linked pairs
(audit #1 #2 #4 #7 #11 #14 #16 #17, 2026-10-14) now describe different works:

- the matcher already refuses them (Tier 0 corroborates, never overrides: REVIEW, §8.0a);
- but the group item can never reach My Library: our import skips it as `already-present`
  (8 skips in the 2026-09-18 run) and Zotero's own drag-copy treats it as already copied;
- Zotero has no UI to see or remove an `owl:sameAs` relation, so the user cannot fix it.

## Proposal

Tools menu: **"Review Outdated Zotero Links…"** (behind a new pref,
`extensions.zotero-library-reconciler.enableLinkRepair`, absent ⇒ off).

```
audit → linked pairs the rules deny AND whose titles diverged (SUBSTITUTION/missing)
  → preview: both records side by side + evidence, one checkbox per pair, unticked
  → confirm → remove the relation from the My Library item (CAS: only if still present)
  → log → result → undo
```

- **Only "titles diverged" pairs are offered.** "Titles agree but rules deny" (a wrong DOI or
  type in one copy) means the link is probably right and the *data* is wrong; those stay
  in the audit for a hand fix.
- **Nothing pre-ticked.** Removing a link is a judgment about two records; the user ticks
  each pair.
- **Never a group write.** For a My Library ↔ group pair Zotero stores the relation on the My
  Library item (`DataObject._addLinkedObject`, omni.ja 10.0.6), so `writeAdapter` removes it
  there with `removeRelation(owl:sameAs, groupItemURI)` and one save. If the relation is
  found on the group side instead, the pair is skipped and listed (Phase 4 decision A: no
  group targets).
- **Only `owl:sameAs` to that one URI.** No other relation, field, tag or collection.

## Safety

| Invariant | How |
|---|---|
| CAS inside the transaction | re-read relations; remove only if the exact `[owl:sameAs, uri]` is still there, else skip `link-changed` |
| Native undo | save with an `undoAction`; Zotero's undo snapshots `relations` (undoHistory.js), so ⌘Z restores the link |
| Plugin undo | log `{ target, uri }`; undo re-adds the relation only if absent (CAS in reverse) |
| Allowlist in the adapter | the new `WriteAPI.removeLinkedRelation(target, uri)` rejects any predicate but `owl:sameAs` and any non-My-Library target |
| Counts are actuals | removed / skipped / failed listed separately |

## Consequence after removal

The group item becomes importable by Add Missing Items (its recall check still runs, so a
genuine same-work copy is still caught by title/identifier near-miss evidence). Zotero's
drag-copy also works again. The removal syncs to zotero.org like any item edit.

## Open before building

- Which `undoAction` label: Zotero has no "remove link" string; reuse
  `undo-action-edit-metadata` (closest existing Fluent id) unless a better one exists.
- Live check on the dev profile: remove one link, confirm `getLinkedItem` returns false,
  ⌘Z restores it, the group item's row is unchanged in the DB.
