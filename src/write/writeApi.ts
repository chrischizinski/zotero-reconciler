import type { FieldValue } from "../comparison/differenceEngine.js";

/**
 * The complete set of mutations the plugin can perform, as an interface (Phase 3 invariant 1,
 * docs/phase3-write-safeguards.md §4). `src/zotero/writeAdapter.ts` is the only
 * implementation that touches Zotero; tests use a recording fake. There is deliberately no
 * `erase` and no collection operation outside the import collection. The one field edit,
 * `updateFields` (Phase 4), is compare-and-swap on an allowlist of bibliographic fields of a
 * My Library item (docs/phase4-field-reconciliation.md §6, §10).
 */

export interface WriteItemRef {
  libraryID: number;
  itemKey: string;
}

export interface WritableLibrary {
  libraryID: number;
  name: string;
  editable: boolean;
}

/** What the executor needs to know about a source item immediately before copying it. */
export interface SourceItemState {
  version: number;
  /** In the trash. Trashed sources are skipped, as Zotero's own `getLinkedItem` ignores them. */
  deleted: boolean;
}

export interface CopyOptions {
  targetLibraryID: number;
  /** Key of the session import collection the copy is filed in. */
  collectionKey: string;
  copyTags: boolean;
}

/** One field to set on the target, only if it still holds `expected` (the value previewed). */
export interface FieldWrite {
  /** Item type's field name, or `creators` for the whole creator list. */
  name: string;
  expected: FieldValue;
  next: FieldValue;
}

/** A source field that must still hold the previewed value, so the log's "from X" stays true. */
export interface FieldCheck {
  ref: WriteItemRef;
  name: string;
  expected: FieldValue;
}

/** One item's compare-and-swap edit, as `updateFields` takes it. */
export interface FieldUpdate {
  target: WriteItemRef;
  writes: readonly FieldWrite[];
  checks: readonly FieldCheck[];
}

export type UpdateStatus = "written" | "target-changed" | "source-changed" | "target-missing";

export interface UpdateResult {
  status: UpdateStatus;
  /** Which field or item failed the re-check, for the report. */
  detail?: string;
  /**
   * On `written`: each field's value as Zotero stored it, keyed by name. Can differ from
   * `next` (Zotero strips newlines from single-line fields); the log and the undo use this.
   */
  stored?: Readonly<Record<string, FieldValue>>;
}

/** A Zotero `owl:sameAs` link from a My Library item to a group item. */
export interface LinkRemoval {
  target: WriteItemRef;
  linked: WriteItemRef;
}

/** `removed` carries the exact relation URI, so an undo can put back precisely what was taken. */
export type LinkRemovalResult =
  | { status: "removed"; uri: string }
  | { status: "link-missing" | "target-missing"; detail: string };

export interface LinkRestore {
  target: WriteItemRef;
  uri: string;
}

export type LinkRestoreStatus = "restored" | "already-present" | "target-missing";

export interface WriteAPI {
  /** The user library's ID; Phase 3 only ever imports into it. */
  userLibraryID(): number;
  library(libraryID: number): WritableLibrary | undefined;
  /** `undefined` when the item no longer exists. */
  sourceItem(ref: WriteItemRef): Promise<SourceItemState | undefined>;
  /** Zotero's own record of an existing copy (`owl:sameAs`, either direction). */
  linkedItemIn(ref: WriteItemRef, libraryID: number): Promise<WriteItemRef | undefined>;
  /** Finds or creates `parentName / sessionName` in the target library; returns the session collection key. */
  ensureImportCollection(libraryID: number, parentName: string, sessionName: string): Promise<string>;
  /**
   * `clone` → `save` → `addLinkedItem(source)` inside one transaction, filed in the collection.
   * Rejects if any step fails; a half-written row must not exist.
   */
  copyItem(source: WriteItemRef, options: CopyOptions): Promise<WriteItemRef>;
  /**
   * The same for a chunk of sources inside ONE transaction, all-or-nothing, results in input
   * order. Zotero's own drag-copy batches 100 per transaction so notifier work (item tree,
   * sync queue) is paid once per chunk; the executor retries a failed chunk row by row.
   */
  copyItems(sources: readonly WriteItemRef[], options: CopyOptions): Promise<WriteItemRef[]>;
  /** Session undo: moves the given items to the trash (recoverable), with an undo-history label. */
  trashItems(refs: readonly WriteItemRef[]): Promise<void>;
  /**
   * Phase 4: in ONE transaction, re-read every source check and every target field; if any
   * differs from what was previewed, write nothing and say which. Otherwise set all fields and
   * save once with Zotero's `undo-action-edit-metadata`. Throws on a target outside My Library
   * or a field outside the reconcilable allowlist.
   */
  updateFields(target: WriteItemRef, writes: readonly FieldWrite[], checks: readonly FieldCheck[]): Promise<UpdateResult>;
  /**
   * The same for a chunk of items inside ONE transaction (one ⌘Z step), results in input
   * order. Each item is re-checked on its own: a stale item is skipped (its status says why)
   * and the rest are written. Throws — writing nothing — on any target outside My Library or
   * field outside the allowlist, or if a save fails (the caller retries item by item).
   */
  updateFieldsBatch(updates: readonly FieldUpdate[]): Promise<UpdateResult[]>;
  /**
   * docs/stale-link-removal.md: in ONE transaction (one ⌘Z step), remove the `owl:sameAs`
   * relation from each My Library target to its linked item, only if it is still there.
   * Nothing else on the item changes and the linked item is never written. Throws on a
   * target outside My Library.
   */
  removeLinkedRelations(removals: readonly LinkRemoval[]): Promise<LinkRemovalResult[]>;
  /** Plugin undo: re-adds each relation only if absent (compare-and-swap in reverse). */
  restoreLinkedRelations(restores: readonly LinkRestore[]): Promise<LinkRestoreStatus[]>;
}
