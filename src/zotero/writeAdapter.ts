import { RECONCILABLE_FIELDS, type FieldValue, type RecordCreator } from "../comparison/differenceEngine.js";
import type { CopyOptions, FieldCheck, FieldUpdate, FieldWrite, LinkRemovalResult, LinkRestoreStatus, SourceItemState, UpdateResult, WritableLibrary, WriteAPI, WriteItemRef } from "../write/writeApi.js";

/**
 * THE ONLY FILE THAT MODIFIES ZOTERO DATA (Phase 3 invariant 1).
 *
 * Every mutation the plugin can perform is a method of `WriteAPI`, implemented here against
 * Zotero 10 objects, and nowhere else. `adapter.ts` stays read-only. Grep this file to audit
 * what the plugin can change: create a copy (with Zotero's own linked-item relation), create
 * an import collection, move items to the trash, (Phase 4) compare-and-swap an allowlist
 * of bibliographic fields on My Library items, and remove or restore one `owl:sameAs` link on a
 * My Library item (one item, or a chunk in one transaction).
 * Nothing else edits an existing item.
 *
 * Verified against Zotero 10.0.2 source (omni.ja, 2026-09-17): `Item.clone`,
 * `Item.addLinkedItem` (stores the relation on the user-library side, so a copy INTO My Library
 * leaves the source untouched), `Items.trashTx` (stages native undo `undo-action-trash`).
 */

export interface ZoteroWritableItem {
  id: number;
  libraryID: number;
  key: string;
  version: number;
  deleted: boolean;
  loadAllData(): Promise<void>;
  getLinkedItem(libraryID: number, bidirectional?: boolean): Promise<ZoteroWritableItem | false>;
  clone(libraryID: number, options?: { skipTags?: boolean }): ZoteroWritableItem;
  setCollections(collectionKeys: string[]): void;
  save(options?: { skipSelect?: boolean; skipDateModifiedUpdate?: boolean; undoAction?: string; undoActionArgs?: Record<string, unknown> }): Promise<unknown>;
  addLinkedItem(item: ZoteroWritableItem): Promise<boolean>;
  itemTypeID: number;
  getField(field: string): string;
  setField(field: string, value: string): boolean;
  getCreatorsJSON(): RecordCreator[];
  /** `strict`: throw on a creator type the item type lacks instead of silently using the primary type. */
  setCreators(creators: readonly RecordCreator[], options?: { strict?: boolean }): void;
  getRelationsByPredicate(predicate: string): string[];
  removeRelation(predicate: string, object: string): boolean;
  addRelation(predicate: string, object: string): boolean;
}

export interface ZoteroCollectionObject {
  /** Assigned on save. */
  id: number;
  key: string;
  name: string;
  libraryID: number;
  parentKey: string | false;
  saveTx(): Promise<unknown>;
}

export interface ZoteroWriteAPI {
  Libraries: {
    userLibraryID: number;
    get(libraryID: number): { libraryID: number; name: string; editable: boolean } | false;
  };
  Items: {
    getByLibraryAndKey(libraryID: number, key: string): ZoteroWritableItem | false;
    trashTx(ids: number[]): Promise<unknown>;
  };
  Collections: {
    getByLibrary(libraryID: number, recursive?: boolean): ZoteroCollectionObject[];
    getByParent(parentCollectionID: number, recursive?: boolean): ZoteroCollectionObject[];
  };
  Collection: new (params: { libraryID: number; name: string; parentKey?: string }) => ZoteroCollectionObject;
  DB: { executeTransaction<T>(fn: () => Promise<T>): Promise<T> };
  URI: { getURIItemLibraryKey(itemURI: string): { libraryID: number; key: string } | false };
  ItemFields: {
    getID(field: string): number | false;
    getName(fieldID: number): string | false;
    /** Base field of a type-specific field (the field itself if it is a base field); false if none. */
    getBaseIDFromTypeAndField(itemTypeID: number, field: string): number | false;
  };
}

/** Never written in any phase (design.md §12–§13), even if a caller asks. */
const NEVER_WRITTEN = new Set(["citationKey", "extra", "itemType", "dateAdded", "dateModified", "accessDate"]);
const RECONCILABLE: ReadonlySet<string> = new Set(RECONCILABLE_FIELDS);
/** The only relation the plugin ever removes or restores. */
const LINKED_ITEM_PREDICATE = "owl:sameAs";
/** Zotero's own Fluent label ("Edit Metadata"), so ⌘Z shows the familiar entry. */
const EDIT_UNDO_ACTION = "undo-action-edit-metadata";

export function zoteroWriteAPI(zotero: ZoteroWriteAPI): WriteAPI {
  const item = (ref: WriteItemRef): ZoteroWritableItem | undefined => zotero.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey) || undefined;

  async function copyItems(refs: readonly WriteItemRef[], options: CopyOptions): Promise<WriteItemRef[]> {
    const sources = refs.map((ref) => {
      const source = item(ref);
      if (!source) throw new Error(`Source item ${ref.libraryID}:${ref.itemKey} no longer exists.`);
      return source;
    });
    for (const source of sources) await source.loadAllData();
    // Same sequence as Zotero's own drag-copy (collectionTree.js _copyItem, chunked per
    // transaction), inside one transaction so a saved copy without its link or collection
    // cannot exist and the chunk is all-or-nothing.
    return zotero.DB.executeTransaction(async () => {
      const copies: WriteItemRef[] = [];
      for (const source of sources) {
        const copy = source.clone(options.targetLibraryID, { skipTags: !options.copyTags });
        copy.setCollections([options.collectionKey]);
        await copy.save({ skipSelect: true });
        await copy.addLinkedItem(source);
        copies.push({ libraryID: copy.libraryID, itemKey: copy.key });
      }
      return copies;
    });
  }

  return {
    userLibraryID: () => zotero.Libraries.userLibraryID,

    library(libraryID): WritableLibrary | undefined {
      const library = zotero.Libraries.get(libraryID);
      return library ? { libraryID: library.libraryID, name: library.name, editable: library.editable } : undefined;
    },

    async sourceItem(ref): Promise<SourceItemState | undefined> {
      const source = item(ref);
      return source ? { version: source.version, deleted: source.deleted } : undefined;
    },

    async linkedItemIn(ref, libraryID): Promise<WriteItemRef | undefined> {
      const source = item(ref);
      if (!source) return undefined;
      await source.loadAllData();
      const linked = await source.getLinkedItem(libraryID, true);
      return linked ? { libraryID: linked.libraryID, itemKey: linked.key } : undefined;
    },

    async ensureImportCollection(libraryID, parentName, sessionName): Promise<string> {
      const parent = await findOrCreateCollection(zotero, libraryID, parentName, undefined);
      const session = await findOrCreateCollection(zotero, libraryID, sessionName, parent);
      return session.key;
    },

    async copyItem(ref, options: CopyOptions): Promise<WriteItemRef> {
      const [copy] = await copyItems([ref], options);
      return copy!;
    },

    copyItems,

    async trashItems(refs): Promise<void> {
      const ids = refs.map(item).flatMap((found) => (found && !found.deleted ? [found.id] : []));
      if (ids.length > 0) await zotero.Items.trashTx(ids);
    },

    async updateFields(ref, writes, checks): Promise<UpdateResult> {
      const [result] = await updateFieldsBatch([{ target: ref, writes, checks }]);
      return result!;
    },

    updateFieldsBatch,

    async removeLinkedRelations(removals): Promise<LinkRemovalResult[]> {
      for (const removal of removals) {
        if (removal.target.libraryID !== zotero.Libraries.userLibraryID) throw new Error("Links are removed from My Library items only.");
      }
      const targets = removals.map((removal) => item(removal.target));
      for (const target of targets) await target?.loadAllData();
      // Same pattern as updateFields: re-check and write in one transaction. Zotero stores a
      // My Library ↔ group link on the My Library item (DataObject._addLinkedObject) and saves
      // it with skipDateModifiedUpdate; we remove it the same way.
      return zotero.DB.executeTransaction(async () => {
        const found = removals.map((removal, index): LinkRemovalResult => {
          const target = targets[index];
          if (!target || target.deleted) return { status: "target-missing", detail: "The My Library item no longer exists or is in the trash." };
          const uri = target.getRelationsByPredicate(LINKED_ITEM_PREDICATE).find((candidate) => {
            const resolved = zotero.URI.getURIItemLibraryKey(candidate);
            return resolved && resolved.libraryID === removal.linked.libraryID && resolved.key === removal.linked.itemKey;
          });
          return uri ? { status: "removed", uri } : { status: "link-missing", detail: "The My Library item no longer carries this link." };
        });
        const count = found.filter((result) => result.status === "removed").length;
        for (const [index, result] of found.entries()) {
          if (result.status !== "removed") continue;
          targets[index]!.removeRelation(LINKED_ITEM_PREDICATE, result.uri);
          await targets[index]!.save({ skipSelect: true, skipDateModifiedUpdate: true, undoAction: EDIT_UNDO_ACTION, undoActionArgs: { count } });
        }
        return found;
      });
    },

    async restoreLinkedRelations(restores): Promise<LinkRestoreStatus[]> {
      for (const restore of restores) {
        if (restore.target.libraryID !== zotero.Libraries.userLibraryID) throw new Error("Links are restored on My Library items only.");
      }
      const targets = restores.map((restore) => item(restore.target));
      for (const target of targets) await target?.loadAllData();
      return zotero.DB.executeTransaction(async () => {
        const statuses = restores.map((restore, index): LinkRestoreStatus => {
          const target = targets[index];
          if (!target || target.deleted) return "target-missing";
          return target.getRelationsByPredicate(LINKED_ITEM_PREDICATE).includes(restore.uri) ? "already-present" : "restored";
        });
        const count = statuses.filter((status) => status === "restored").length;
        for (const [index, status] of statuses.entries()) {
          if (status !== "restored") continue;
          targets[index]!.addRelation(LINKED_ITEM_PREDICATE, restores[index]!.uri);
          await targets[index]!.save({ skipSelect: true, skipDateModifiedUpdate: true, undoAction: EDIT_UNDO_ACTION, undoActionArgs: { count } });
        }
        return statuses;
      });
    }
  };

  async function updateFieldsBatch(updates: readonly FieldUpdate[]): Promise<UpdateResult[]> {
    // Hard limits first, for every item, before anything is read or written (invariant 1).
    for (const update of updates) {
      if (update.target.libraryID !== zotero.Libraries.userLibraryID) throw new Error("Phase 4 edits My Library items only.");
    }
    const loaded = updates.map((update) => ({ update, target: item(update.target), sources: update.checks.map((check) => ({ check, source: item(check.ref) })) }));
    for (const { update, target } of loaded) {
      if (!target) continue;
      for (const write of update.writes) {
        if (!isReconcilable(zotero, target.itemTypeID, write.name)) throw new Error(`Field '${write.name}' is not reconcilable.`);
      }
    }
    for (const { target, sources } of loaded) {
      await target?.loadAllData();
      for (const { source } of sources) await source?.loadAllData();
    }

    // Re-check and write in one transaction, as Zotero's own undo does (UndoHistory._apply):
    // nothing can change between the comparison and the save. A stale item is skipped whole;
    // the others are still written. Every save in one transaction lands as ONE undo step
    // (UndoHistory batches per transaction; the last stageAction wins), so each save carries
    // the count of items the step covers.
    return zotero.DB.executeTransaction(async () => {
      const results: UpdateResult[] = loaded.map(({ update, target, sources }) => recheck(update, target, sources));
      const toWrite = loaded.filter((_, index) => results[index]!.status === "written");
      for (const { update, target } of toWrite) {
        for (const write of update.writes) applyValue(target!, write);
        await target!.save({ skipSelect: true, undoAction: EDIT_UNDO_ACTION, undoActionArgs: { count: toWrite.length } });
      }
      return loaded.map(({ update, target }, index) => {
        if (results[index]!.status !== "written") return results[index]!;
        const stored: Record<string, FieldValue> = {};
        for (const write of update.writes) stored[write.name] = readValue(target!, write.name);
        return { status: "written", stored };
      });
    });
  }
}

/** The §6 compare-and-swap for one item; `written` here means "may be written". */
function recheck(update: FieldUpdate, target: ZoteroWritableItem | undefined, sources: readonly { check: FieldCheck; source: ZoteroWritableItem | undefined }[]): UpdateResult {
  if (!target || target.deleted) return { status: "target-missing", detail: "The My Library item no longer exists or is in the trash." };
  for (const { check, source } of sources) {
    if (!source || source.deleted) return { status: "source-changed", detail: `The source item ${check.ref.libraryID}:${check.ref.itemKey} was deleted or trashed.` };
    if (!sameValue(readValue(source, check.name), check.expected)) return { status: "source-changed", detail: `${check.name} in the source item no longer holds the expected value.` };
  }
  for (const write of update.writes) {
    if (!sameValue(readValue(target, write.name), write.expected)) return { status: "target-changed", detail: `${write.name} in My Library no longer holds the expected value.` };
  }
  return { status: "written" };
}

function isReconcilable(zotero: ZoteroWriteAPI, itemTypeID: number, name: string): boolean {
  if (name === "creators") return true;
  if (NEVER_WRITTEN.has(name)) return false;
  if (RECONCILABLE.has(name)) return true;
  const baseID = zotero.ItemFields.getID(name) ? zotero.ItemFields.getBaseIDFromTypeAndField(itemTypeID, name) : false;
  const base = baseID ? zotero.ItemFields.getName(baseID) : false;
  return !!base && RECONCILABLE.has(base);
}

function readValue(target: ZoteroWritableItem, name: string): FieldValue {
  return name === "creators" ? target.getCreatorsJSON() : target.getField(name);
}

function applyValue(target: ZoteroWritableItem, write: FieldWrite): void {
  if (write.name === "creators") target.setCreators(write.next as readonly RecordCreator[], { strict: true });
  else target.setField(write.name, write.next as string);
}

/** Exact comparison: a raw string, or the creator list field by field (Zotero's JSON omits empty parts). */
export function sameValue(current: FieldValue, expected: FieldValue): boolean {
  if (typeof expected === "string" || typeof current === "string") return current === expected;
  const key = (creators: readonly RecordCreator[]) => JSON.stringify(creators.map((creator) => [creator.creatorType, creator.name ?? null, creator.lastName ?? "", creator.firstName ?? ""]));
  return key(current) === key(expected);
}

async function findOrCreateCollection(zotero: ZoteroWriteAPI, libraryID: number, name: string, parent: ZoteroCollectionObject | undefined): Promise<ZoteroCollectionObject> {
  const siblings = parent ? zotero.Collections.getByParent(parent.id, false) : zotero.Collections.getByLibrary(libraryID, false);
  const existing = siblings.find((collection) => collection.name === name);
  if (existing) return existing;
  const created = new zotero.Collection({ libraryID, name, ...(parent ? { parentKey: parent.key } : {}) });
  await created.saveTx();
  return created;
}
