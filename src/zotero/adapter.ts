import { isCandidatePair } from "../matching/blocking.js";
import { matchNormalizedItems } from "../matching/matcher.js";
import { normalizeItem } from "../matching/normalize.js";
import { auditCrossLibraries, type CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import { RECONCILABLE_FIELDS, type FieldRecord, type RecordCreator, type RecordField, type ReconcilableField } from "../comparison/differenceEngine.js";
import type { CreatorInput, ItemRef, LinkedRef, MatchResult, ScannedItem } from "../matching/types.js";
import type { LibraryVersion } from "../works/indexSnapshot.js";

export interface ZoteroCreator {
  lastName: string;
  firstName?: string;
  fieldMode?: 0 | 1;
}

export interface ZoteroItem {
  libraryID: number;
  key: string;
  version: number;
  itemType: string;
  isRegularItem(): boolean;
  /** `unformatted` returns Zotero's stored multipart date (`YYYY-MM-DD original`) instead of the user string. */
  getField(field: string, unformatted?: boolean, includeBaseMapped?: boolean): string;
  getCreators(): ZoteroCreator[];
  /** Object URIs of related items for a predicate; requires the `relations` data type to be loaded. */
  getRelationsByPredicate(predicate: string): string[];
}

export interface ZoteroLibrary {
  libraryID: number;
  name: string;
  /** `user` | `group` | `feed`. Feeds hold RSS items, not bibliographic records. */
  libraryType: string;
  /** Zotero's per-library sync version; bumps on any change in the library. */
  libraryVersion?: number;
}

/** Only user and group libraries hold bibliographic records (§6); `Zotero.Libraries.getAll()` also returns feeds. */
export function isBibliographicLibrary(library: ZoteroLibrary): boolean {
  return library.libraryType === "user" || library.libraryType === "group";
}

export interface ZoteroReadAPI {
  Libraries: { getAll(): ZoteroLibrary[]; userLibraryID?: number };
  Items: {
    getAll(libraryID: number, onlyTopLevel: boolean, includeDeleted: boolean): Promise<ZoteroItem[]>;
    /** Bulk-loads field and creator rows; `getAll()` returns shells and `getField()` throws until loaded. */
    loadDataTypes(items: ZoteroItem[], dataTypes: string[]): Promise<void>;
  };
  /** `Zotero.URI`: resolves an item URI to its library and key without touching the database. */
  URI: { getURIItemLibraryKey(itemURI: string): { libraryID: number; key: string } | false };
  /** Read-only query for the local-change fingerprint; absent in tests that do not need it. */
  DB?: { valueQueryAsync(sql: string, params: unknown[]): Promise<unknown> };
}

/**
 * Item count | latest clientDateModified, per library. Any local save, trash or erase changes
 * it, including edits not yet synced (which leave `libraryVersion` alone). Read-only.
 */
const LOCAL_CHANGE_SQL = "SELECT COUNT(*) || '|' || IFNULL(MAX(clientDateModified), '') FROM items WHERE libraryID = ?";

async function localChange(api: ZoteroReadAPI, libraryID: number): Promise<string | undefined> {
  if (!api.DB) return undefined;
  const value = await api.DB.valueQueryAsync(LOCAL_CHANGE_SQL, [libraryID]);
  return typeof value === "string" ? value : undefined;
}

async function libraryVersions(api: ZoteroReadAPI, libraries: readonly ZoteroLibrary[]): Promise<LibraryVersion[]> {
  return Promise.all(libraries.map(async (library) => {
    const fingerprint = await localChange(api, library.libraryID);
    return { libraryID: library.libraryID, name: library.name, version: library.libraryVersion ?? 0, ...(fingerprint !== undefined ? { localChange: fingerprint } : {}) };
  }));
}

/** The data types `toScannedItem` reads. Loaded per library in one query each, skipping already-loaded items. */
const SCAN_DATA_TYPES = ["itemData", "creators", "relations"];

/** Zotero's predicate for "this item is a copy of that item in another library" (`Zotero.Relations.linkedObjectPredicate`). */
export const LINKED_ITEM_PREDICATE = "owl:sameAs";

async function loadedRegularItems(api: ZoteroReadAPI, libraryID: number): Promise<ZoteroItem[]> {
  const items = (await api.Items.getAll(libraryID, true, false)).filter(isEligibleItem);
  await api.Items.loadDataTypes(items, SCAN_DATA_TYPES);
  return items;
}

export interface LibraryAuditResult {
  audit: CrossLibraryAudit;
  /** The libraries scanned, with their versions at scan time, for snapshot staleness (§29). */
  libraries: readonly LibraryVersion[];
  /** Every scanned item, so Phase 3's recall re-check can look at My Library again without a second scan. */
  items: readonly ScannedItem[];
  myLibraryID: number;
}

export async function auditLibraries(api: ZoteroReadAPI): Promise<LibraryAuditResult> {
  const libraries = api.Libraries.getAll().filter(isBibliographicLibrary);
  const myLibraryID = api.Libraries.userLibraryID;
  if (myLibraryID === undefined) throw new Error("Zotero did not provide the My Library identifier.");
  // Fingerprint BEFORE reading items: an edit landing mid-scan then makes the snapshot look stale, never fresh.
  const versions = await libraryVersions(api, libraries);
  const libraryItems = await Promise.all(libraries.map(async (library) => ({
    library,
    items: await loadedRegularItems(api, library.libraryID)
  })));
  const items = libraryItems.flatMap(({ library, items }) => items.map((item) => toScannedItem(item, library.name, api.URI)));
  return {
    audit: auditCrossLibraries(items, myLibraryID),
    libraries: versions,
    items,
    myLibraryID
  };
}

export async function currentLibraryVersions(api: ZoteroReadAPI): Promise<readonly LibraryVersion[]> {
  return libraryVersions(api, api.Libraries.getAll().filter(isBibliographicLibrary));
}

export interface CopyMatch {
  item: ScannedItem;
  result: MatchResult;
}

export interface FindCopiesResult {
  source: ScannedItem;
  copies: readonly CopyMatch[];
  scannedLibraries: number;
  scannedItems: number;
}

export function isEligibleItem(item: ZoteroItem): boolean {
  return item.isRegularItem();
}

export function toScannedItem(item: ZoteroItem, libraryName: string, uri: ZoteroReadAPI["URI"]): ScannedItem {
  if (!isEligibleItem(item)) throw new Error("Only regular bibliographic items can be reconciled.");
  const linkedItems = linkedRefs(item, uri);
  const title = item.getField("title");
  // Zotero's duplicate detector reads the multipart form so the year is always the first four characters (§7).
  const date = item.getField("date", true, true);
  const doi = item.getField("DOI");
  const isbn = item.getField("ISBN");
  const issn = item.getField("ISSN");
  const extra = item.getField("extra");
  return {
    ref: { libraryID: item.libraryID, libraryName, itemKey: item.key, version: item.version },
    itemType: item.itemType,
    fields: {
      ...(title ? { title } : {}),
      ...(date ? { date } : {}),
      ...(doi ? { doi } : {}),
      ...(isbn ? { isbn } : {}),
      ...(issn ? { issn } : {}),
      ...(extra ? { extra } : {})
    },
    creators: item.getCreators().map(toCreatorInput),
    ...(linkedItems.length > 0 ? { linkedItems } : {})
  };
}

/** Tier 0 evidence (§8.0). URIs that no longer resolve to a known library are dropped, as Zotero's own `getLinkedItem` does. */
function linkedRefs(item: ZoteroItem, uri: ZoteroReadAPI["URI"]): LinkedRef[] {
  const refs: LinkedRef[] = [];
  for (const itemURI of item.getRelationsByPredicate(LINKED_ITEM_PREDICATE)) {
    const resolved = uri.getURIItemLibraryKey(itemURI);
    if (resolved) refs.push({ libraryID: resolved.libraryID, itemKey: resolved.key });
  }
  return refs;
}

export async function findCopies(api: ZoteroReadAPI, sourceItem: ZoteroItem): Promise<FindCopiesResult> {
  const libraries = api.Libraries.getAll().filter(isBibliographicLibrary);
  const sourceLibrary = libraries.find((library) => library.libraryID === sourceItem.libraryID);
  if (!sourceLibrary) throw new Error(`The source library ${sourceItem.libraryID} is unavailable or is not a user or group library.`);

  const source = toScannedItem(sourceItem, sourceLibrary.name, api.URI);
  const candidateLibraries = libraries.filter((library) => library.libraryID !== sourceItem.libraryID);
  const libraryItems = await Promise.all(candidateLibraries.map(async (library) => ({
    library,
    items: await loadedRegularItems(api, library.libraryID)
  })));

  const normalizedSource = normalizeItem(source);
  const blockedCandidates = libraryItems.flatMap(({ library, items }) => items
    .map((item) => normalizeItem(toScannedItem(item, library.name, api.URI)))
    .filter((candidate) => isCandidatePair(normalizedSource, candidate)));
  const copies = blockedCandidates
    .map((item) => ({ item, result: matchNormalizedItems(normalizedSource, item) }))
    .filter(({ result }) => result.verdict === "match" || result.verdict === "review" || result.verdict === "related");

  return {
    source,
    copies,
    scannedLibraries: candidateLibraries.length,
    scannedItems: blockedCandidates.length
  };
}

function toCreatorInput(creator: ZoteroCreator): CreatorInput {
  return {
    lastName: creator.lastName,
    ...(creator.firstName ? { firstName: creator.firstName } : {}),
    ...(creator.fieldMode !== undefined ? { fieldMode: creator.fieldMode } : {})
  };
}

/** What Phase 4's field reader needs beyond the scan: type-aware field names and full creator JSON. */
export interface ZoteroFieldItem extends ZoteroItem {
  itemTypeID: number;
  getCreatorsJSON(): RecordCreator[];
}

export interface ZoteroFieldReadAPI {
  Items: {
    getByLibraryAndKey(libraryID: number, key: string): ZoteroFieldItem | false;
    loadDataTypes(items: ZoteroItem[], dataTypes: string[]): Promise<void>;
  };
  ItemFields: {
    getID(field: string): number | false;
    getName(fieldID: number): string | false;
    isValidForType(fieldID: number, itemTypeID: number): boolean;
    /** The type-specific field for a base field (`bookTitle` for `publicationTitle` on a book section); false if none. */
    getFieldIDFromTypeAndBase(itemTypeID: number, baseField: string): number | false;
  };
  CreatorTypes: { getTypesForItemType(itemTypeID: number): { id: number; name: string }[] };
}

/**
 * Phase 4 COMPARE-time read (docs/phase4-field-reconciliation.md §7): every reconcilable
 * field of one item, under its own type's field name, plus creators with their types. Read
 * only for the items being compared, so the library scan stays as cheap as it is.
 */
export async function readFieldRecord(api: ZoteroFieldReadAPI, ref: Omit<ItemRef, "version">): Promise<FieldRecord | undefined> {
  const item = api.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey);
  if (!item || !item.isRegularItem()) return undefined;
  await api.Items.loadDataTypes([item], ["itemData", "creators"]);
  const fields: Partial<Record<ReconcilableField, RecordField>> = {};
  for (const base of RECONCILABLE_FIELDS) {
    const name = fieldNameFor(api, item.itemTypeID, base);
    if (name) fields[base] = readField(item, base, name);
  }
  return {
    ref: { ...ref, version: item.version },
    itemType: item.itemType,
    fields,
    creators: item.getCreatorsJSON(),
    validCreatorTypes: api.CreatorTypes.getTypesForItemType(item.itemTypeID).map((type) => type.name)
  };
}

/** The base field itself if valid for the type, else the type's mapped field, else none (field absent on this type). */
function fieldNameFor(api: ZoteroFieldReadAPI, itemTypeID: number, base: ReconcilableField): string | undefined {
  const baseID = api.ItemFields.getID(base);
  if (baseID && api.ItemFields.isValidForType(baseID, itemTypeID)) return base;
  const mapped = api.ItemFields.getFieldIDFromTypeAndBase(itemTypeID, base);
  return mapped ? api.ItemFields.getName(mapped) || undefined : undefined;
}

function readField(item: ZoteroFieldItem, base: ReconcilableField, name: string): RecordField {
  const value = item.getField(name);
  if (base !== "date" || !value) return { name, value };
  // Multipart `2024-05-03 May 3, 2024`: the SQL part compares dates written differently (§4).
  const sql = item.getField(name, true, true).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(sql) ? { name, value, key: sql } : { name, value };
}
