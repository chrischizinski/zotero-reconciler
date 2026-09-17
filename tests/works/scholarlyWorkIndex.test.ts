import { describe, expect, it } from "vitest";
import { matchItems } from "../../src/matching/matcher.js";
import type { MatchResult, ScannedItem } from "../../src/matching/types.js";
import { buildScholarlyWorkIndex, missingFromLibrary, type MatchPair } from "../../src/works/scholarlyWorkIndex.js";

const item = (libraryID: number, itemKey: string, fields: ScannedItem["fields"] = {}, itemType = "journalArticle"): ScannedItem => ({
  ref: { libraryID, libraryName: `Library ${libraryID}`, itemKey, version: 1 },
  itemType, fields: { title: "Mallard harvest", date: "2024", ...fields }, creators: [{ lastName: "Smith", firstName: "Jane" }]
});
const pair = (left: ScannedItem, right: ScannedItem, result: MatchResult = matchItems(left, right)): MatchPair => ({ left, right, result });
const keys = (work: { items: readonly ScannedItem[] }): string[] => work.items.map((entry) => entry.ref.itemKey);

describe("scholarly work index (§8.2 tier-restricted union)", () => {
  it("clusters confirmed matches and retains two items from the same library in one work", () => {
    const first = item(1, "A", { doi: "10.1/a" });
    const duplicate = item(1, "B", { doi: "10.1/a" });
    const groupCopy = item(2, "C", { doi: "10.1/a" });
    const singleton = item(3, "D", { title: "Goose harvest" });
    const index = buildScholarlyWorkIndex([first, duplicate, groupCopy, singleton], [pair(first, groupCopy), pair(duplicate, groupCopy)]);
    expect(index).toHaveLength(2);
    const work = index.find((entry) => entry.items.length === 3)!;
    expect(work.libraryIDs).toEqual([1, 2]);
    expect(work.confidence).toBe("exact");
    expect(index.find((entry) => entry.items.length === 1)?.confidence).toBeUndefined();
    expect(missingFromLibrary(index, 1)).toHaveLength(1);
  });

  it("never unions on a Tier 3 edge: A↔B Tier 1, B↔C review keeps C out of the cluster", () => {
    const a = item(1, "A", { doi: "10.1/a" });
    const b = item(2, "B", { doi: "10.1/a" });
    const c = item(3, "C", { title: "MaIlard harvest" });
    expect(matchItems(b, c).tier).toBe("review");
    const index = buildScholarlyWorkIndex([a, b, c], [pair(a, b), pair(b, c)]);
    expect(index.map(keys)).toEqual([["A", "B"], ["C"]]);
  });

  it("refuses a Tier 2 edge that a denial rule rejects against any existing member: C excluded when its DOI conflicts with A", () => {
    const a = item(1, "A", { doi: "10.1/x", extra: "PMID: 1" });
    const b = item(2, "B", { extra: "PMID: 1" });
    const c = item(3, "C", { doi: "10.1/y" });
    expect(matchItems(a, b).tier).toBe("exact");
    expect(matchItems(b, c).tier).toBe("high");
    expect(matchItems(a, c).evidence[0]).toMatchObject({ rule: "D1" });
    const index = buildScholarlyWorkIndex([a, b, c], [pair(b, c), pair(a, b)]);
    expect(index.map(keys)).toEqual([["A", "B"], ["C"]]);
    expect(index.map((work) => work.items.map((entry) => entry.fields.doi).filter(Boolean).length <= 1)).toEqual([true, true]);
  });

  it("records the weakest edge as the cluster confidence", () => {
    const a = item(1, "A", { doi: "10.1/a" });
    const b = item(2, "B", { doi: "10.1/a" });
    const c = item(3, "C");
    const index = buildScholarlyWorkIndex([a, b, c], [pair(a, b), pair(b, c)]);
    expect(index).toHaveLength(1);
    expect(index[0]?.confidence).toBe("high");
  });

  it("names the journal article canonical when a preprint shares its DOI", () => {
    const preprint = item(1, "P", { doi: "10.1/z" }, "preprint");
    const article = item(2, "J", { doi: "10.1/z" });
    const index = buildScholarlyWorkIndex([preprint, article], [pair(preprint, article)]);
    expect(index).toHaveLength(1);
    expect(index[0]?.canonical.ref.itemKey).toBe("J");
  });
});
