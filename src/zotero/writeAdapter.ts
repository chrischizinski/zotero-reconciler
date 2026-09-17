import type { CopyOptions, SourceItemState, WritableLibrary, WriteAPI, WriteItemRef } from "../write/writeApi.js";

/**
 * THE ONLY FILE THAT MODIFIES ZOTERO DATA (Phase 3 invariant 1).
 *
 * Every mutation the plugin can perform is a method of `WriteAPI`, implemented here against
 * Zotero 10 objects, and nowhere else. `adapter.ts` stays read-only. Grep this file to audit
 * what the plugin can change: create a copy (with Zotero's own linked-item relation), create
 * an import collection, move items to the trash. Nothing edits an existing item's fields.
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
  save(options?: { skipSelect?: boolean }): Promise<unknown>;
  addLinkedItem(item: ZoteroWritableItem): Promise<boolean>;
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
}

export function zoteroWriteAPI(zotero: ZoteroWriteAPI): WriteAPI {
  const item = (ref: WriteItemRef): ZoteroWritableItem | undefined => zotero.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey) || undefined;

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
      const source = item(ref);
      if (!source) throw new Error(`Source item ${ref.libraryID}:${ref.itemKey} no longer exists.`);
      await source.loadAllData();
      // Same sequence as Zotero's own drag-copy (collectionTree.js _copyItem), inside one
      // transaction so a saved copy without its link or collection cannot exist.
      return zotero.DB.executeTransaction(async () => {
        const copy = source.clone(options.targetLibraryID, { skipTags: !options.copyTags });
        copy.setCollections([options.collectionKey]);
        await copy.save({ skipSelect: true });
        await copy.addLinkedItem(source);
        return { libraryID: copy.libraryID, itemKey: copy.key };
      });
    },

    async trashItems(refs): Promise<void> {
      const ids = refs.map(item).flatMap((found) => (found && !found.deleted ? [found.id] : []));
      if (ids.length > 0) await zotero.Items.trashTx(ids);
    }
  };
}

async function findOrCreateCollection(zotero: ZoteroWriteAPI, libraryID: number, name: string, parent: ZoteroCollectionObject | undefined): Promise<ZoteroCollectionObject> {
  const siblings = parent ? zotero.Collections.getByParent(parent.id, false) : zotero.Collections.getByLibrary(libraryID, false);
  const existing = siblings.find((collection) => collection.name === name);
  if (existing) return existing;
  const created = new zotero.Collection({ libraryID, name, ...(parent ? { parentKey: parent.key } : {}) });
  await created.saveTx();
  return created;
}
