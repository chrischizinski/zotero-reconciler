import { describe, expect, it } from "vitest";
import { isCandidatePair } from "../../src/matching/blocking.js";
import { normalizeItem } from "../../src/matching/normalize.js";
import { auditLibraries, findCopies, toScannedItem, type ZoteroItem } from "../../src/zotero/adapter.js";
import { renderResult } from "../../src/zotero/findCopiesCommand.js";

/** Fake `Zotero.URI`: Zotero's item URIs are `http://zotero.org/{users/<id>|groups/<id>}/items/<key>`. */
const uri = {
  getURIItemLibraryKey: (itemURI: string) => {
    const match = itemURI.match(/^http:\/\/zotero\.org\/(users\/\d+|groups\/(\d+))\/items\/([A-Z0-9]{8})$/);
    if (!match) return false as const;
    // In this fake, group ID == library ID; the user library is 1.
    return { libraryID: match[2] ? Number(match[2]) : 1, key: match[3]! };
  }
};

function zoteroItem(overrides: Partial<ZoteroItem> & { fields?: Record<string, string> } = {}): ZoteroItem {
  const { fields = {}, ...itemOverrides } = overrides;
  return {
    getRelationsByPredicate: () => [],
    libraryID: 1,
    key: "AAAA1111",
    version: 2,
    itemType: "journalArticle",
    isRegularItem: () => true,
    getField: (field, unformatted) => field === "date" && unformatted ? fields.dateMultipart ?? fields.date ?? "" : fields[field] ?? "",
    getCreators: () => [{ lastName: "Smith", firstName: "Jane" }],
    ...itemOverrides
  };
}

describe("Zotero read adapter", () => {
  it("maps a Zotero item without changing it", () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example", extra: "PMID: 123" } });
    expect(toScannedItem(source, "My Library", uri)).toMatchObject({
      ref: { libraryID: 1, libraryName: "My Library", itemKey: "AAAA1111", version: 2 },
      fields: { title: "Waterfowl harvest", doi: "10.1/example", extra: "PMID: 123" }
    });
  });

  it("reads Zotero linked-item relations into linkedItems and drops URIs that no longer resolve (§8.0)", () => {
    const source = zoteroItem({
      libraryID: 2, key: "BBBB2222",
      getRelationsByPredicate: (predicate) => predicate === "owl:sameAs"
        ? ["http://zotero.org/users/12345/items/AAAA1111", "http://zotero.org/groups/7/items/CCCC3333", "http://zotero.org/groups/999/items/not-a-key"]
        : []
    });
    expect(toScannedItem(source, "Group", uri).linkedItems).toEqual([{ libraryID: 1, itemKey: "AAAA1111" }, { libraryID: 7, itemKey: "CCCC3333" }]);
    expect(toScannedItem(zoteroItem(), "My Library", uri)).not.toHaveProperty("linkedItems");
  });

  it("reads the year from Zotero's multipart date, not the user-entered string (§7)", () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", date: "May 12, 2019", dateMultipart: "2019-05-12 May 12, 2019" } });
    const scanned = toScannedItem(source, "My Library", uri);
    expect(scanned.fields.date).toBe("2019-05-12 May 12, 2019");
    expect(normalizeItem(scanned).year).toBe(2019);
  });

  it("blocks unrelated records but preserves exact identifier candidates", () => {
    const source = normalizeItem(toScannedItem(zoteroItem({ fields: { title: "Waterfowl harvest", date: "2024", DOI: "10.1/example" } }), "My Library", uri));
    const exact = normalizeItem(toScannedItem(zoteroItem({ libraryID: 2, fields: { title: "Other title", DOI: "10.1/example" } }), "Group", uri));
    const unrelated = normalizeItem(toScannedItem(zoteroItem({ libraryID: 2, fields: { title: "Urban forestry", date: "2024" }, getCreators: () => [{ lastName: "Jones", firstName: "Alex" }] }), "Group", uri));
    expect(isCandidatePair(source, exact)).toBe(true);
    expect(isCandidatePair(source, unrelated)).toBe(false);
  });

  it("scans only other libraries and excludes non-bibliographic records", async () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const copy = zoteroItem({ libraryID: 2, key: "BBBB2222", fields: { title: "Different display title", DOI: "10.1/example" } });
    const attachment = zoteroItem({ libraryID: 2, isRegularItem: () => false });
    const result = await findCopies({
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library", libraryType: "user" }, { libraryID: 2, name: "Group", libraryType: "group" }] },
      Items: { getAll: async (libraryID) => libraryID === 2 ? [copy, attachment] : [source], loadDataTypes: async () => undefined },
      URI: uri
    }, source);

    expect(result).toMatchObject({ scannedLibraries: 1, scannedItems: 1 });
    expect(result.copies).toHaveLength(1);
    expect(result.copies[0]?.result).toMatchObject({ verdict: "match", tier: "exact" });
  });

  it("renders provenance and evidence rather than an unexplained verdict", async () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const copy = zoteroItem({ libraryID: 2, fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const result = await findCopies({
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library", libraryType: "user" }, { libraryID: 2, name: "Waterfowl Group", libraryType: "group" }] },
      Items: { getAll: async (libraryID) => libraryID === 2 ? [copy] : [source], loadDataTypes: async () => undefined },
      URI: uri
    }, source);
    expect(renderResult(result)).toContain("Waterfowl Group — MATCH");
    expect(renderResult(result)).toContain("doi identical");
  });

  it("renders actual differing values for a confirmed copy", async () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const copy = zoteroItem({ libraryID: 2, fields: { title: "Waterfowl harvest", DOI: "10.1/example" }, getCreators: () => [{ lastName: "Jones", firstName: "Alex" }] });
    const result = await findCopies({
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library", libraryType: "user" }, { libraryID: 2, name: "Waterfowl Group", libraryType: "group" }] },
      Items: { getAll: async (libraryID) => libraryID === 2 ? [copy] : [source], loadDataTypes: async () => undefined },
      URI: uri
    }, source);
    expect(renderResult(result)).toContain("Differences: creators (Smith, Jane → Jones, Alex)");
  });

  it("never scans feed libraries: RSS items are not bibliographic records (§6)", async () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const feedCopy = zoteroItem({ libraryID: 3, key: "FEED0001", fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const feedOnly = zoteroItem({ libraryID: 3, key: "FEED0002", fields: { title: "Some RSS headline", DOI: "10.1/rss" } });
    const api = {
      Libraries: {
        getAll: () => [
          { libraryID: 1, name: "My Library", libraryType: "user" },
          { libraryID: 2, name: "Group", libraryType: "group" },
          { libraryID: 3, name: "Journal RSS", libraryType: "feed" }
        ],
        userLibraryID: 1
      },
      Items: { getAll: async (libraryID: number) => libraryID === 3 ? [feedCopy, feedOnly] : libraryID === 1 ? [source] : [], loadDataTypes: async () => undefined },
      URI: uri
    };

    const copies = await findCopies(api, source);
    expect(copies).toMatchObject({ scannedLibraries: 1, scannedItems: 0 });

    const { audit } = await auditLibraries(api);
    expect(audit.works.map((work) => work.items.map((item) => item.ref.itemKey))).toEqual([["AAAA1111"]]);
    expect(audit.missingFromMyLibrary).toHaveLength(0);
  });

  it("loads field and creator data before reading any candidate: getAll() returns unloaded shells", async () => {
    const shells = new Map<string, { item: ZoteroItem; loaded: boolean }>();
    const shell = (libraryID: number, key: string, loaded: boolean): ZoteroItem => {
      const state = { loaded };
      const item: ZoteroItem = {
        libraryID, key, version: 1, itemType: "journalArticle",
        isRegularItem: () => true,
        getField: (field) => { if (!state.loaded) throw new Error(`UnloadedDataException: field '${field}' not set`); return field === "DOI" ? "10.1/example" : field === "title" ? "Waterfowl harvest" : ""; },
        getCreators: () => { if (!state.loaded) throw new Error("UnloadedDataException"); return [{ lastName: "Smith", firstName: "Jane" }]; },
        getRelationsByPredicate: () => { if (!state.loaded) throw new Error("UnloadedDataException"); return []; }
      };
      shells.set(key, { item, loaded: state.loaded });
      Object.defineProperty(state, "loaded", { get: () => shells.get(key)!.loaded, set: (value: boolean) => { shells.get(key)!.loaded = value; } });
      return item;
    };
    const source = shell(1, "AAAA1111", true); // the selected item is already loaded by the UI
    const api = {
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library", libraryType: "user" }, { libraryID: 2, name: "Group", libraryType: "group" }], userLibraryID: 1 },
      Items: {
        getAll: async (libraryID: number) => [libraryID === 1 ? source : shell(2, "BBBB2222", false)],
        loadDataTypes: async (items: ZoteroItem[], dataTypes: string[]) => {
          expect(dataTypes).toEqual(["itemData", "creators", "relations"]);
          for (const item of items) shells.get(item.key)!.loaded = true;
        }
      },
      URI: uri
    };
    const result = await findCopies(api, source);
    expect(result.copies).toHaveLength(1);
    shells.get("BBBB2222")!.loaded = false;
    const { audit } = await auditLibraries(api);
    expect(audit.confirmedPairs).toHaveLength(1);
  });
});
