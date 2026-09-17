import { describe, expect, it } from "vitest";
import { auditCrossLibraries } from "../../src/audit/crossLibraryAudit.js";
import type { ScannedItem } from "../../src/matching/types.js";

const item = (libraryID: number, itemKey: string, title: string, doi?: string): ScannedItem => ({
  ref: { libraryID, libraryName: libraryID === 1 ? "My Library" : "Group", itemKey, version: 1 },
  itemType: "journalArticle", fields: { title, date: "2024", ...(doi ? { doi } : {}) }, creators: [{ lastName: "Smith", firstName: "Jane" }]
});

describe("cross-library audit", () => {
  it("clusters confirmed copies and identifies group-only works", () => {
    const mine = item(1, "A", "Mallard harvest", "10.1/a");
    const copy = item(2, "B", "Mallard harvest", "10.1/a");
    const groupOnly = item(2, "C", "Goose harvest", "10.1/c");
    const audit = auditCrossLibraries([mine, copy, groupOnly], 1);
    expect(audit.confirmedPairs).toHaveLength(1);
    expect(audit.missingFromMyLibrary).toHaveLength(1);
    expect(audit.missingFromMyLibrary[0]?.items[0]?.fields.title).toBe("Goose harvest");
  });

  it("reports Zotero-linked pairs the bibliographic rules alone would miss, as matcher false negatives (§8.0 oracle)", () => {
    const mine = item(1, "A", "Mallard harvest", "10.1/a");
    const found = item(2, "B", "Mallard harvest", "10.1/a");
    const missedByRules: ScannedItem = { ...item(2, "C", "Retitled after copying"), creators: [{ lastName: "Other" }], linkedItems: [{ libraryID: 1, itemKey: "A" }] };
    const audit = auditCrossLibraries([mine, found, missedByRules], 1);
    expect(audit.linkedPairs).toBe(1);
    expect(audit.linkedButUnmatched.map(({ right }) => right.ref.itemKey)).toEqual(["C"]);
    // The link still counts as a match in the index: all three are one work.
    expect(audit.works).toHaveLength(1);
    expect(audit.works[0]?.items.map((i) => i.ref.itemKey).sort()).toEqual(["A", "B", "C"]);
  });
});
