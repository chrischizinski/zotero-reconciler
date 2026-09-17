import { describe, expect, it } from "vitest";
import { compareBibliographicFields } from "../../src/comparison/fieldComparator.js";
import type { ScannedItem } from "../../src/matching/types.js";

const item = (fields: ScannedItem["fields"], creators: ScannedItem["creators"] = [{ lastName: "Smith", firstName: "Jane" }]): ScannedItem => ({
  ref: { libraryID: 1, libraryName: "My Library", itemKey: "A", version: 1 }, itemType: "journalArticle", fields, creators
});

describe("bibliographic field comparison", () => {
  it("ignores normalized equivalents and reports substantive drift", () => {
    const differences = compareBibliographicFields(
      item({ title: "Mallard Harvest", date: "2024-01-01", doi: "10.1/Example" }),
      item({ title: "Mallard harvest.", date: "2024", doi: "10.1/example", isbn: "0-306-40615-2" }, [{ lastName: "Jones", firstName: "Alex" }])
    );
    expect(differences.map(({ field }) => field)).toEqual(["creators"]);
  });
});
