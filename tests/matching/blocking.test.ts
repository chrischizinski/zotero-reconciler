import { describe, expect, it } from "vitest";
import { candidatePairs, isCandidatePair } from "../../src/matching/blocking.js";
import { normalizeItem } from "../../src/matching/normalize.js";
import type { ScannedItem } from "../../src/matching/types.js";

const item = (itemKey: string, fields: ScannedItem["fields"], creators: ScannedItem["creators"] = [{ lastName: "Smith", firstName: "Jane" }]): ScannedItem => ({
  ref: { libraryID: 1, libraryName: "L", itemKey, version: 1 }, itemType: "journalArticle", fields, creators
});

describe("blocking (§8.5)", () => {
  it("produces exactly the pairs a full pairwise candidate scan would, without comparing every pair", () => {
    const items = [
      item("A", { title: "Mallard harvest", date: "2024", doi: "10.1/a" }),
      item("B", { title: "Other title", date: "1990", doi: "10.1/a" }, [{ lastName: "Zed", firstName: "Q" }]),
      item("C", { title: "Goose harvest", date: "2023" }),
      item("D", { title: "Goose harvest", date: "2020" }),
      item("E", { title: "Anonymous report", date: "2024" }, []),
      item("F", { title: "Anonymous report", date: "2024" }, []),
      item("G", { title: "Other anonymous report", date: "2024" }, [])
    ].map(normalizeItem);
    const expected: [number, number][] = [];
    for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) if (isCandidatePair(items[i]!, items[j]!)) expected.push([i, j]);
    const sortPairs = (pairs: [number, number][]): [number, number][] => [...pairs].sort((l, r) => l[0] - r[0] || l[1] - r[1]);
    expect(sortPairs(candidatePairs(items))).toEqual(sortPairs(expected));
    expect(expected).toEqual([[0, 1], [0, 2], [4, 5]]);
  });
});
