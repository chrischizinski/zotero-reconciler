/**
 * The complete set of mutations the plugin can perform, as an interface (Phase 3 invariant 1,
 * docs/phase3-write-safeguards.md §4). `src/zotero/writeAdapter.ts` is the only
 * implementation that touches Zotero; tests use a recording fake. There is deliberately no
 * `setField`, no `erase`, and no collection operation outside the import collection.
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
}
