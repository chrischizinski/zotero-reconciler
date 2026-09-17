import { describe, expect, it } from "vitest";
import { isCandidatePair } from "../../src/matching/blocking.js";
import { normalizeItem } from "../../src/matching/normalize.js";
import { findCopies, toScannedItem, type ZoteroItem } from "../../src/zotero/adapter.js";
import { renderResult } from "../../src/zotero/findCopiesCommand.js";

function zoteroItem(overrides: Partial<ZoteroItem> & { fields?: Record<string, string> } = {}): ZoteroItem {
  const { fields = {}, ...itemOverrides } = overrides;
  return {
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
    expect(toScannedItem(source, "My Library")).toMatchObject({
      ref: { libraryID: 1, libraryName: "My Library", itemKey: "AAAA1111", version: 2 },
      fields: { title: "Waterfowl harvest", doi: "10.1/example", extra: "PMID: 123" }
    });
  });

  it("reads the year from Zotero's multipart date, not the user-entered string (§7)", () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", date: "May 12, 2019", dateMultipart: "2019-05-12 May 12, 2019" } });
    const scanned = toScannedItem(source, "My Library");
    expect(scanned.fields.date).toBe("2019-05-12 May 12, 2019");
    expect(normalizeItem(scanned).year).toBe(2019);
  });

  it("blocks unrelated records but preserves exact identifier candidates", () => {
    const source = normalizeItem(toScannedItem(zoteroItem({ fields: { title: "Waterfowl harvest", date: "2024", DOI: "10.1/example" } }), "My Library"));
    const exact = normalizeItem(toScannedItem(zoteroItem({ libraryID: 2, fields: { title: "Other title", DOI: "10.1/example" } }), "Group"));
    const unrelated = normalizeItem(toScannedItem(zoteroItem({ libraryID: 2, fields: { title: "Urban forestry", date: "2024" }, getCreators: () => [{ lastName: "Jones", firstName: "Alex" }] }), "Group"));
    expect(isCandidatePair(source, exact)).toBe(true);
    expect(isCandidatePair(source, unrelated)).toBe(false);
  });

  it("scans only other libraries and excludes non-bibliographic records", async () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const copy = zoteroItem({ libraryID: 2, key: "BBBB2222", fields: { title: "Different display title", DOI: "10.1/example" } });
    const attachment = zoteroItem({ libraryID: 2, isRegularItem: () => false });
    const result = await findCopies({
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library" }, { libraryID: 2, name: "Group" }] },
      Items: { getAll: async (libraryID) => libraryID === 2 ? [copy, attachment] : [source] }
    }, source);

    expect(result).toMatchObject({ scannedLibraries: 1, scannedItems: 1 });
    expect(result.copies).toHaveLength(1);
    expect(result.copies[0]?.result).toMatchObject({ verdict: "match", tier: "exact" });
  });

  it("renders provenance and evidence rather than an unexplained verdict", async () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const copy = zoteroItem({ libraryID: 2, fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const result = await findCopies({
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library" }, { libraryID: 2, name: "Waterfowl Group" }] },
      Items: { getAll: async (libraryID) => libraryID === 2 ? [copy] : [source] }
    }, source);
    expect(renderResult(result)).toContain("Waterfowl Group — MATCH");
    expect(renderResult(result)).toContain("doi identical");
  });

  it("renders actual differing values for a confirmed copy", async () => {
    const source = zoteroItem({ fields: { title: "Waterfowl harvest", DOI: "10.1/example" } });
    const copy = zoteroItem({ libraryID: 2, fields: { title: "Waterfowl harvest", DOI: "10.1/example" }, getCreators: () => [{ lastName: "Jones", firstName: "Alex" }] });
    const result = await findCopies({
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library" }, { libraryID: 2, name: "Waterfowl Group" }] },
      Items: { getAll: async (libraryID) => libraryID === 2 ? [copy] : [source] }
    }, source);
    expect(renderResult(result)).toContain("Differences: creators (Smith, Jane → Jones, Alex)");
  });
});
