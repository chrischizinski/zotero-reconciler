import { describe, expect, it } from "vitest";
import { compareRecords, type FieldRecord } from "../../src/comparison/differenceEngine.js";
import { executeFillPlan } from "../../src/write/fillExecutor.js";
import { applyFillPreview, fillPreviewModel, itemKeyOf, type FillPlan } from "../../src/write/fillPlan.js";
import { fillMissingPlan, type GatedSource, type ReconcilePlan } from "../../src/write/reconcilePlan.js";
import type { FieldUpdate, UpdateResult, WriteAPI } from "../../src/write/writeApi.js";

const MY = { libraryID: 1, libraryName: "My Library", itemKey: "MINE0001", version: 1 };
const TEXTBOOK = { libraryID: 2, libraryName: "Textbook", itemKey: "TEXT0001", version: 1 };
const WATERFOWL = { libraryID: 3, libraryName: "Waterfowl", itemKey: "WATR0001", version: 1 };
const NOW = new Date("2026-10-14T16:00:00Z");
const sources: GatedSource[] = [{ ref: TEXTBOOK, evidence: "EXACT — DOI" }, { ref: WATERFOWL, evidence: "HIGH — title, author, year" }];

function record(ref: FieldRecord["ref"], values: Record<string, string>): FieldRecord {
  return { ref, itemType: "journalArticle", fields: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { name, value }])), creators: [], validCreatorTypes: ["author"] };
}

function planFor(itemKey: string, fields = 1): ReconcilePlan {
  const names = ["issue", "volume", "pages"].slice(0, fields);
  return {
    target: { libraryID: 1, itemKey, title: `Item ${itemKey}` },
    edits: names.map((name) => ({ field: name, name, old: "", next: "4", class: "MISSING", source: { libraryID: 2, itemKey: "TEXT0001", libraryName: "Textbook" }, sourceName: name })),
    evidence: []
  } as ReconcilePlan;
}

function confirmed(items: ReconcilePlan[]): FillPlan {
  return applyFillPreview({ items }, { confirmed: true, checkedKeys: items.map(itemKeyOf) }, NOW)!;
}

function recordingAPI(answer: (update: FieldUpdate) => UpdateResult = () => ({ status: "written", stored: {} }), options: { batchThrows?: boolean; failKey?: string } = {}) {
  const batches: string[][] = [];
  const singles: string[] = [];
  const api = {
    userLibraryID: () => 1,
    library: (libraryID: number) => ({ libraryID, name: "My Library", editable: true }),
    updateFieldsBatch: async (updates: readonly FieldUpdate[]) => {
      batches.push(updates.map((update) => update.target.itemKey));
      if (options.batchThrows) throw new Error("chunk rolled back");
      return updates.map(answer);
    },
    updateFields: async (target: FieldUpdate["target"], writes: FieldUpdate["writes"], checks: FieldUpdate["checks"]) => {
      singles.push(target.itemKey);
      if (target.itemKey === options.failKey) throw new Error("setField: invalid field");
      return answer({ target, writes, checks });
    }
  } as unknown as WriteAPI;
  return { api, batches, singles };
}

describe("Fill Missing plan — exactly what Compare Copies pre-selects, nothing more (invariant 4)", () => {
  it("fills MISSING-and-agreed fields only: never a difference, a conflict, a field the sources lack, or an identifier", () => {
    const differences = compareRecords(
      record(MY, { issue: "", pages: "1-10", volume: "", DOI: "", ISBN: "", ISSN: "", place: "Lincoln", title: "Waterfowl harvest" }),
      [
        record(TEXTBOOK, { issue: "4", pages: "1021-1034", volume: "88", DOI: "10.1002/jwmg.99999", ISBN: "9780306406157", ISSN: "0022-541X", place: "", title: "Waterfowl harvest" }),
        record(WATERFOWL, { issue: "4", pages: "1021-1034", volume: "89", DOI: "10.1002/jwmg.99999", ISBN: "9780306406157", ISSN: "0022-541X", place: "", title: "Waterfowl harvest" })
      ]
    );
    const plan = fillMissingPlan({ libraryID: 1, itemKey: "MINE0001", title: "Waterfowl harvest" }, differences, sources);
    expect(plan.edits.map((edit) => [edit.field, edit.old, edit.next])).toEqual([["issue", "", "4"]]);
    expect(plan.confirmedAt).toBeUndefined();
  });
});

describe("Fill Missing preview — items can only be unticked", () => {
  it("lists every item ticked, with each field and its source", () => {
    const model = fillPreviewModel({ items: [planFor("A", 2), planFor("B")] });
    expect(model.rows.map((row) => [row.key, row.checked, row.edits])).toEqual([
      ["1:A", true, ["issue: 4 (from Textbook)", "volume: 4 (from Textbook)"]],
      ["1:B", true, ["issue: 4 (from Textbook)"]]
    ]);
    expect(model.summary).toContain("3 fields");
    expect(model.largeSessionThreshold).toBe(250);
  });

  it("Cancel → no plan", () => {
    expect(applyFillPreview({ items: [planFor("A")] }, { confirmed: false, checkedKeys: ["1:A"] }, NOW)).toBeUndefined();
  });

  it("unticked items are dropped; an unknown key cannot add an item; every kept item carries the confirmation", () => {
    const plan = applyFillPreview({ items: [planFor("A"), planFor("B")] }, { confirmed: true, checkedKeys: ["1:B", "1:EVIL"] }, NOW)!;
    expect(plan.items.map((item) => [item.target.itemKey, item.confirmedAt])).toEqual([["B", NOW.toISOString()]]);
  });
});

describe("Fill Missing executor — §40 batch semantics", () => {
  it("refuses an unconfirmed plan before any write (invariant 6)", async () => {
    const { api, batches } = recordingAPI();
    await expect(executeFillPlan(api, { items: [planFor("A")], confirmedAt: NOW.toISOString() })).rejects.toThrow("unconfirmed");
    expect(batches).toEqual([]);
  });

  it("refuses the whole session if any item is outside My Library (decision A)", async () => {
    const { api, batches } = recordingAPI();
    const plan = confirmed([planFor("A"), { ...planFor("G"), target: { libraryID: 2, itemKey: "G", title: "G" } }]);
    await expect(executeFillPlan(api, plan)).rejects.toThrow("My Library");
    expect(batches).toEqual([]);
  });

  it("writes in chunks of 25, one transaction each, and reports progress per chunk", async () => {
    const { api, batches } = recordingAPI();
    const progress: number[] = [];
    const outcome = await executeFillPlan(api, confirmed(Array.from({ length: 30 }, (_, i) => planFor(`K${i}`))), { onProgress: (p) => progress.push(p.done) });
    expect(batches.map((batch) => batch.length)).toEqual([25, 5]);
    expect(progress).toEqual([25, 30]);
    expect(outcome.totals).toMatchObject({ itemsUpdated: 30, fieldsWritten: 30 });
  });

  it("Cancel stops between chunks; the rest are reported as cancelled, never written", async () => {
    const { api, batches } = recordingAPI();
    let chunks = 0;
    const outcome = await executeFillPlan(api, confirmed(Array.from({ length: 30 }, (_, i) => planFor(`K${i}`))), { onProgress: () => { chunks += 1; }, shouldCancel: () => chunks >= 1 });
    expect(batches).toHaveLength(1);
    expect(outcome.totals).toMatchObject({ itemsUpdated: 25, cancelled: 5 });
  });

  it("a stale item is skipped and counted separately; counts are actuals, not the plan size (invariant 7)", async () => {
    const { api } = recordingAPI((update) => (update.target.itemKey === "B" ? { status: "target-changed", detail: "issue changed" } : { status: "written", stored: {} }));
    const outcome = await executeFillPlan(api, confirmed([planFor("A", 2), planFor("B", 3), planFor("C")]));
    expect(outcome.totals).toEqual({ itemsUpdated: 2, fieldsWritten: 3, skippedTargetChanged: 1, skippedSourceChanged: 0, skippedMissing: 0, failed: 0, cancelled: 0 });
  });

  it("sends source re-checks with every item, so the log's 'from Textbook' stays true", async () => {
    const seen: FieldUpdate[] = [];
    const { api } = recordingAPI((update) => { seen.push(update); return { status: "written", stored: {} }; });
    await executeFillPlan(api, confirmed([planFor("A")]));
    expect(seen[0]?.checks).toEqual([{ ref: { libraryID: 2, itemKey: "TEXT0001" }, name: "issue", expected: "4" }]);
  });

  it("a chunk that throws is retried item by item: one bad item costs only itself", async () => {
    const { api, singles } = recordingAPI(undefined, { batchThrows: true, failKey: "B" });
    const outcome = await executeFillPlan(api, confirmed([planFor("A"), planFor("B"), planFor("C")]));
    expect(singles).toEqual(["A", "B", "C"]);
    expect(outcome.items.map((item) => item.status)).toEqual(["written", "failed", "written"]);
    expect(outcome.totals).toMatchObject({ itemsUpdated: 2, failed: 1 });
  });
});
