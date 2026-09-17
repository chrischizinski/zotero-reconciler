import { isCandidatePair } from "../matching/blocking.js";
import { matchNormalizedItems } from "../matching/matcher.js";
import { normalizeItem } from "../matching/normalize.js";
import { auditCrossLibraries, type CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import type { CreatorInput, MatchResult, ScannedItem } from "../matching/types.js";

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
}

/** Only user and group libraries hold bibliographic records (§6); `Zotero.Libraries.getAll()` also returns feeds. */
export function isBibliographicLibrary(library: ZoteroLibrary): boolean {
  return library.libraryType === "user" || library.libraryType === "group";
}

export interface ZoteroReadAPI {
  Libraries: { getAll(): ZoteroLibrary[]; userLibraryID?: number };
  Items: { getAll(libraryID: number, onlyTopLevel: boolean, includeDeleted: boolean): Promise<ZoteroItem[]> };
}

export async function auditLibraries(api: ZoteroReadAPI): Promise<CrossLibraryAudit> {
  const libraries = api.Libraries.getAll().filter(isBibliographicLibrary);
  const myLibraryID = api.Libraries.userLibraryID;
  if (myLibraryID === undefined) throw new Error("Zotero did not provide the My Library identifier.");
  const libraryItems = await Promise.all(libraries.map(async (library) => ({
    library,
    items: await api.Items.getAll(library.libraryID, true, false)
  })));
  const items = libraryItems.flatMap(({ library, items }) => items
    .filter(isEligibleItem)
    .map((item) => toScannedItem(item, library.name)));
  return auditCrossLibraries(items, myLibraryID);
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
    items: await api.Items.getAll(library.libraryID, true, false)
  })));

  const normalizedSource = normalizeItem(source);
  const blockedCandidates = libraryItems.flatMap(({ library, items }) => items
    .filter(isEligibleItem)
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
