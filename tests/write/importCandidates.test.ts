import { describe, expect, it } from "vitest";
import { auditCrossLibraries } from "../../src/audit/crossLibraryAudit.js";
import type { ScannedItem } from "../../src/matching/types.js";
import { importCandidates } from "../../src/write/importCandidates.js";

const MY = 1;
const GROUP = 2;

function item(libraryID: number, key: string, overrides: Partial<ScannedItem> & { fields?: ScannedItem["fields"] } = {}): ScannedItem {
  const { fields, ...rest } = overrides;
  return {
    ref: { libraryID, libraryName: libraryID === MY ? "My Library" : "creel", itemKey: key, version: 3 },
    itemType: "journalArticle",
    fields: { title: "Waterfowl harvest management under uncertainty", date: "2025", ...fields },
    creators: [{ lastName: "Lee", firstName: "S" }],
    ...rest
  };
}

const candidatesFor = (items: ScannedItem[]) => importCandidates(items, auditCrossLibraries(items, MY), MY);

describe("import candidates — the missing list decorated with the §48.1 recall re-check", () => {
  it("offers a work absent from My Library once, with no near-miss when My Library holds nothing like it", () => {
    const items = [item(GROUP, "G1"), item(MY, "M1", { fields: { title: "Something else entirely" }, creators: [{ lastName: "Other" }] })];
    const { candidates, alreadyPresent } = candidatesFor(items);
    expect(candidates.map(({ item: candidate, nearMisses }) => [candidate.ref.itemKey, nearMisses.length])).toEqual([["G1", 0]]);
    expect(alreadyPresent).toEqual([]);
  });

  it("attaches the near-miss the precision matcher denied (thesis vs article), so the row is un-ticked with evidence", () => {
    const items = [item(GROUP, "G1"), item(MY, "M1", { itemType: "thesis" })];
    const { candidates } = candidatesFor(items);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.nearMisses.map(({ reason, item: mine }) => [reason, mine.ref.itemKey])).toEqual([["same-title", "M1"]]);
  });

  it("widens blocking beyond the precision blocks: a same-title record with different creators is still found", () => {
    // Precision blocking needs a shared creator key (or both creatorless); recall must not.
    const items = [item(GROUP, "G1"), item(MY, "M1", { itemType: "report", creators: [{ lastName: "Waterfowl Council", fieldMode: 1 }] })];
    const { candidates } = candidatesFor(items);
    expect(candidates[0]?.nearMisses.map(({ reason }) => reason)).toEqual(["same-title"]);
  });

  it("does not compare against unrelated My Library records (identifier, opening words and creators all differ)", () => {
    const items = [item(GROUP, "G1"), item(MY, "M1", { fields: { title: "Fisheries economics of the Great Plains", date: "2025" }, creators: [{ lastName: "Nguyen" }] })];
    expect(candidatesFor(items).candidates[0]?.nearMisses).toEqual([]);
  });

  it("moves a work to alreadyPresent when the precision rules match a My Library record now (the index was stale)", () => {
    // Build the audit with My Library empty, then check against a My Library that has since received the copy.
    const groupOnly = [item(GROUP, "G1", { fields: { doi: "10.1/x" } })];
    const audit = auditCrossLibraries(groupOnly, MY);
    const nowInMyLibrary = [...groupOnly, item(MY, "M1", { fields: { doi: "10.1/x" } })];
    const { candidates, alreadyPresent } = importCandidates(nowInMyLibrary, audit, MY);
    expect(candidates).toEqual([]);
    expect(alreadyPresent.map(({ item: candidate, existing }) => [candidate.ref.itemKey, existing.ref.itemKey])).toEqual([["G1", "M1"]]);
  });

  it("offers a work held by two groups once, as its canonical item", () => {
    const items = [item(GROUP, "G1"), item(3, "H1", { ref: { libraryID: 3, libraryName: "other group", itemKey: "H1", version: 1 } })];
    const { candidates } = candidatesFor(items);
    expect(candidates).toHaveLength(1);
  });
});
