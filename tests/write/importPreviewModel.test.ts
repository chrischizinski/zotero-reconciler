import { describe, expect, it } from "vitest";
import type { ScannedItem } from "../../src/matching/types.js";
import { buildImportPlan, rowKey } from "../../src/write/importPlan.js";
import { applyPreview, previewModel } from "../../src/write/importPreviewModel.js";

const item = (libraryID: number, itemKey: string, title = `Paper ${itemKey}`): ScannedItem => ({
  ref: { libraryID, libraryName: libraryID === 1 ? "My Library" : "creel", itemKey, version: 5 },
  itemType: "journalArticle", fields: { title, date: "2024-03-01 March 2024" }, creators: [{ lastName: "Smith" }]
});
const nearMiss = { item: item(1, "M", "Paper B"), reason: "same-title" as const, evidence: "Item types are incompatible (thesis vs journalArticle)." };
const NOW = new Date("2026-09-18T10:00:00Z");

const plan = () => buildImportPlan([{ item: item(2, "A"), nearMisses: [] }, { item: item(2, "B"), nearMisses: [nearMiss] }], 1, NOW);

describe("import preview model (PREVIEW / CONFIRM as data)", () => {
  it("renders plan rows with their default tick and the near-miss evidence the user must read before opting in", () => {
    const model = previewModel(plan(), [], "My Library");
    expect(model.rows.map(({ key, checked, disabled }) => [key, checked, disabled])).toEqual([["2:A", true, false], ["2:B", false, false]]);
    expect(model.rows[0]?.detail).toBe("journalArticle · 2024 · creel");
    expect(model.rows[1]?.warnings[0]).toMatch(/^Same title as "Paper B" \(journalArticle, 2024\) in My Library\. Not matched because: Item types are incompatible/);
    expect(model.summary).toMatch(/2 works found only in group libraries\. 1 has a possible copy/);
    expect(model.copyTags).toBe(false);
  });

  it("shows already-present works as disabled rows so the user learns the index was stale, without offering them", () => {
    const model = previewModel(plan(), [{ item: item(2, "C"), existing: item(1, "M2", "Paper C") }], "My Library");
    const present = model.rows.find((row) => row.key === "2:C");
    expect(present).toMatchObject({ checked: false, disabled: true });
    expect(present?.warnings[0]).toMatch(/Already in My Library as "Paper C" \(2024\)/);
    expect(model.summary).toMatch(/1 is already in My Library and cannot be imported/);
  });

  it("cancel yields no plan at all: nothing downstream can execute (invariant 9)", () => {
    expect(applyPreview(plan(), { confirmed: false, checkedKeys: ["2:A", "2:B"], copyTags: true }, NOW)).toBeUndefined();
  });

  it("confirm decides every row by its checkbox — un-ticking a default row skips it, ticking a flagged row imports it — and stamps confirmation", () => {
    const confirmed = applyPreview(plan(), { confirmed: true, checkedKeys: ["2:B", "9:UNKNOWN"], copyTags: true }, NOW);
    expect(confirmed?.rows.map((row) => [rowKey(row), row.decision])).toEqual([["2:A", "skip"], ["2:B", "import"]]);
    expect(confirmed?.copyTags).toBe(true);
    expect(confirmed?.confirmedAt).toBe("2026-09-18T10:00:00.000Z");
  });
});
