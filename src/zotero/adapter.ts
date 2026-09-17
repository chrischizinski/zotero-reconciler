import { isCandidatePair } from "../matching/blocking.js";
import { matchNormalizedItems } from "../matching/matcher.js";
import { normalizeItem } from "../matching/normalize.js";
import { auditCrossLibraries, type CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import type { CreatorInput, MatchResult, ScannedItem } from "../matching/types.js";
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
}

/** The data types `toScannedItem` reads. Loaded per library in one query each, skipping already-loaded items. */
const SCAN_DATA_TYPES = ["itemData", "creators"];

async function loadedRegularItems(api: ZoteroReadAPI, libraryID: number): Promise<ZoteroItem[]> {
  const items = (await api.Items.getAll(libraryID, true, false)).filter(isEligibleItem);
  await api.Items.loadDataTypes(items, SCAN_DATA_TYPES);
  return items;
}

export interface LibraryAuditResult {
  audit: CrossLibraryAudit;
  /** The libraries scanned, with their versions at scan time, for snapshot staleness (§29). */
  libraries: readonly LibraryVersion[];
}

export async function auditLibraries(api: ZoteroReadAPI): Promise<LibraryAuditResult> {
  const libraries = api.Libraries.getAll().filter(isBibliographicLibrary);
  const myLibraryID = api.Libraries.userLibraryID;
  if (myLibraryID === undefined) throw new Error("Zotero did not provide the My Library identifier.");
  const libraryItems = await Promise.all(libraries.map(async (library) => ({
    library,
    items: await loadedRegularItems(api, library.libraryID)
  })));
  const items = libraryItems.flatMap(({ library, items }) => items.map((item) => toScannedItem(item, library.name)));
  return {
    audit: auditCrossLibraries(items, myLibraryID),
    libraries: libraries.map((library) => ({ libraryID: library.libraryID, name: library.name, version: library.libraryVersion ?? 0 }))
  };
}

export function currentLibraryVersions(api: ZoteroReadAPI): readonly LibraryVersion[] {
  return api.Libraries.getAll().filter(isBibliographicLibrary)
    .map((library) => ({ libraryID: library.libraryID, name: library.name, version: library.libraryVersion ?? 0 }));
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

export function toScannedItem(item: ZoteroItem, libraryName: string): ScannedItem {
  if (!isEligibleItem(item)) throw new Error("Only regular bibliographic items can be reconciled.");
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
    creators: item.getCreators().map(toCreatorInput)
  };
}

export async function findCopies(api: ZoteroReadAPI, sourceItem: ZoteroItem): Promise<FindCopiesResult> {
  const libraries = api.Libraries.getAll().filter(isBibliographicLibrary);
  const sourceLibrary = libraries.find((library) => library.libraryID === sourceItem.libraryID);
  if (!sourceLibrary) throw new Error(`The source library ${sourceItem.libraryID} is unavailable or is not a user or group library.`);

  const source = toScannedItem(sourceItem, sourceLibrary.name);
  const candidateLibraries = libraries.filter((library) => library.libraryID !== sourceItem.libraryID);
  const libraryItems = await Promise.all(candidateLibraries.map(async (library) => ({
    library,
    items: await loadedRegularItems(api, library.libraryID)
  })));

  const normalizedSource = normalizeItem(source);
  const blockedCandidates = libraryItems.flatMap(({ library, items }) => items
    .map((item) => normalizeItem(toScannedItem(item, library.name)))
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
