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
});
