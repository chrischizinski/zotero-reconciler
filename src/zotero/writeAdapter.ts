import { RECONCILABLE_FIELDS, type FieldValue, type RecordCreator } from "../comparison/differenceEngine.js";
import type { CopyOptions, FieldWrite, SourceItemState, UpdateResult, WritableLibrary, WriteAPI, WriteItemRef } from "../write/writeApi.js";

/**
 * THE ONLY FILE THAT MODIFIES ZOTERO DATA (Phase 3 invariant 1).
 *
 * Every mutation the plugin can perform is a method of `WriteAPI`, implemented here against
 * Zotero 10 objects, and nowhere else. `adapter.ts` stays read-only. Grep this file to audit
 * what the plugin can change: create a copy (with Zotero's own linked-item relation), create
 * an import collection, move items to the trash, and (Phase 4) compare-and-swap an allowlist
 * of bibliographic fields on a My Library item. Nothing else edits an existing item.
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
  save(options?: { skipSelect?: boolean; undoAction?: string; undoActionArgs?: Record<string, unknown> }): Promise<unknown>;
  addLinkedItem(item: ZoteroWritableItem): Promise<boolean>;
  itemTypeID: number;
  getField(field: string): string;
  setField(field: string, value: string): boolean;
  getCreatorsJSON(): RecordCreator[];
  /** `strict`: throw on a creator type the item type lacks instead of silently using the primary type. */
  setCreators(creators: readonly RecordCreator[], options?: { strict?: boolean }): void;
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
      if (ref.libraryID !== zotero.Libraries.userLibraryID) throw new Error("Phase 4 edits My Library items only.");
      const target = item(ref);
      if (!target || target.deleted) return { status: "target-missing", detail: "The My Library item no longer exists or is in the trash." };
      for (const write of writes) {
        if (!isReconcilable(zotero, target.itemTypeID, write.name)) throw new Error(`Field '${write.name}' is not reconcilable.`);
      }
      const sources = checks.map((check) => ({ check, source: item(check.ref) }));
      await target.loadAllData();
      for (const { source } of sources) await source?.loadAllData();

      // Re-check and write in one transaction, as Zotero's own undo does (UndoHistory._apply):
      // nothing can change between the comparison and the save.
      return zotero.DB.executeTransaction(async () => {
        for (const { check, source } of sources) {
          if (!source || source.deleted) return { status: "source-changed", detail: `The source item ${check.ref.libraryID}:${check.ref.itemKey} was deleted or trashed.` };
          if (!sameValue(readValue(source, check.name), check.expected)) return { status: "source-changed", detail: `${check.name} in the source item no longer holds the expected value.` };
        }
        for (const write of writes) {
          if (!sameValue(readValue(target, write.name), write.expected)) return { status: "target-changed", detail: `${write.name} in My Library no longer holds the expected value.` };
        }
        for (const write of writes) applyValue(target, write);
        await target.save({ skipSelect: true, undoAction: EDIT_UNDO_ACTION, undoActionArgs: { count: 1 } });
        const stored: Record<string, FieldValue> = {};
        for (const write of writes) stored[write.name] = readValue(target, write.name);
        return { status: "written", stored };
      });
    }
  };
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
