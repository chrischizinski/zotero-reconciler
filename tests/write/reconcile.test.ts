import { describe, expect, it } from "vitest";
import { compareRecords, type FieldRecord } from "../../src/comparison/differenceEngine.js";
import { executeReconcilePlan } from "../../src/write/reconcileExecutor.js";
import { applyReconcilePreview, reconcilePreviewModel, type GatedSource } from "../../src/write/reconcilePlan.js";
import { isLogEntry, metadataLogEntry, revertWrites } from "../../src/write/transactionLog.js";
import type { FieldCheck, FieldWrite, UpdateResult, WriteAPI } from "../../src/write/writeApi.js";

const MY = { libraryID: 1, libraryName: "My Library", itemKey: "MINE0001", version: 1 };
const TEXTBOOK = { libraryID: 2, libraryName: "Textbook", itemKey: "TEXT0001", version: 1 };
const WATERFOWL = { libraryID: 3, libraryName: "Waterfowl", itemKey: "WATR0001", version: 1 };
const NOW = new Date("2026-10-14T15:00:00Z");
const TARGET = { libraryID: 1, itemKey: "MINE0001", title: "Waterfowl harvest" };

function record(ref: FieldRecord["ref"], values: Record<string, string>): FieldRecord {
  const fields = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { name, value }]));
  return { ref, itemType: "journalArticle", fields, creators: [], validCreatorTypes: ["author"] };
}

const sources: GatedSource[] = [{ ref: TEXTBOOK, evidence: "Tier 1: DOI" }, { ref: WATERFOWL, evidence: "Tier 2: title, author, year" }];
// issue MISSING (agree), pages DIFFERENT, volume CONFLICTING, title IDENTICAL.
const differences = compareRecords(
  record(MY, { issue: "", pages: "1-10", volume: "", title: "Waterfowl harvest" }),
  [record(TEXTBOOK, { issue: "4", pages: "1021-1034", volume: "88", title: "Waterfowl harvest" }), record(WATERFOWL, { issue: "4", pages: "1021-1034", volume: "89", title: "Waterfowl harvest" })]
);

function recordingAPI(result: UpdateResult = { status: "written", stored: { issue: "4" } }) {
  const calls: { writes: readonly FieldWrite[]; checks: readonly FieldCheck[] }[] = [];
  const api = {
    userLibraryID: () => 1,
    library: (libraryID: number) => ({ libraryID, name: "My Library", editable: true }),
    updateFields: async (_target: unknown, writes: readonly FieldWrite[], checks: readonly FieldCheck[]) => { calls.push({ writes, checks }); return result; }
  } as unknown as WriteAPI;
  return { api, calls };
}

describe("Reconcile preview — only MISSING is pre-selected (invariant 4)", () => {
  it("defaults: MISSING → source value, DIFFERENT and CONFLICTING → keep My Library, IDENTICAL not offered", () => {
    const model = reconcilePreviewModel(TARGET.title, differences, sources);
    const byField = Object.fromEntries(model.rows.map((row) => [row.field, row]));
    expect(byField.issue).toMatchObject({ class: "MISSING", offerable: true, defaultChoice: 0 });
    expect(byField.pages).toMatchObject({ class: "DIFFERENT", offerable: true, defaultChoice: -1 });
    expect(byField.volume).toMatchObject({ class: "CONFLICTING", offerable: true, defaultChoice: -1 });
    expect(byField.volume?.choices).toHaveLength(2);
    expect(byField.title).toMatchObject({ class: "IDENTICAL", offerable: false });
  });

  it("Cancel → no plan, nothing to write", () => {
    expect(applyReconcilePreview(TARGET, differences, sources, { confirmed: false, choices: { issue: 0 } }, NOW)).toBeUndefined();
  });

  it("the window cannot smuggle in a choice for a non-offerable row or an out-of-range alternative", () => {
    const plan = applyReconcilePreview(TARGET, differences, sources, { confirmed: true, choices: { title: 0, volume: 7, issue: 0 } }, NOW);
    expect(plan?.edits.map((edit) => edit.field)).toEqual(["issue"]);
  });

  it("a confirmed plan records old, next, the source and the source's own field name", () => {
    const plan = applyReconcilePreview(TARGET, differences, sources, { confirmed: true, choices: { issue: 0, pages: 0 } }, NOW);
    expect(plan?.confirmedAt).toBe(NOW.toISOString());
    expect(plan?.edits).toEqual([
      { field: "issue", name: "issue", old: "", next: "4", class: "MISSING", source: { libraryID: 2, itemKey: "TEXT0001", libraryName: "Textbook" }, sourceName: "issue" },
      { field: "pages", name: "pages", old: "1-10", next: "1021-1034", class: "DIFFERENT", source: { libraryID: 2, itemKey: "TEXT0001", libraryName: "Textbook" }, sourceName: "pages" }
    ]);
  });
});

describe("Reconcile executor — preconditions before any write", () => {
  it("refuses an unconfirmed plan (invariant 6)", async () => {
    const { api, calls } = recordingAPI();
    await expect(executeReconcilePlan(api, { target: TARGET, edits: [], evidence: [] })).rejects.toThrow("unconfirmed");
    expect(calls).toHaveLength(0);
  });

  it("refuses a target outside My Library (decision A)", async () => {
    const { api, calls } = recordingAPI();
    await expect(executeReconcilePlan(api, { target: { ...TARGET, libraryID: 2 }, edits: [], evidence: [], confirmedAt: NOW.toISOString() })).rejects.toThrow("My Library");
    expect(calls).toHaveLength(0);
  });

  it("sends target expectations AND source re-checks: the source must still say what the log will claim", async () => {
    const plan = applyReconcilePreview(TARGET, differences, sources, { confirmed: true, choices: { issue: 0 } }, NOW)!;
    const { api, calls } = recordingAPI();
    const outcome = await executeReconcilePlan(api, plan);
    expect(outcome.status).toBe("written");
    expect(calls[0]?.writes).toEqual([{ name: "issue", expected: "", next: "4" }]);
    expect(calls[0]?.checks).toEqual([{ ref: { libraryID: 2, itemKey: "TEXT0001" }, name: "issue", expected: "4" }]);
  });

  it("a stale target is reported as such, not as success (invariant 7)", async () => {
    const plan = applyReconcilePreview(TARGET, differences, sources, { confirmed: true, choices: { issue: 0 } }, NOW)!;
    const outcome = await executeReconcilePlan(recordingAPI({ status: "target-changed", detail: "issue changed" }).api, plan);
    expect(outcome).toMatchObject({ status: "target-changed", detail: "issue changed" });
  });
});

describe("Metadata log entry and its undo", () => {
  it("logs the value Zotero stored, with its source library and the match evidence (§26)", async () => {
    const plan = applyReconcilePreview(TARGET, differences, sources, { confirmed: true, choices: { issue: 0 } }, NOW)!;
    const outcome = await executeReconcilePlan(recordingAPI({ status: "written", stored: { issue: "4" } }).api, plan);
    const entry = metadataLogEntry(outcome, "id-1");
    expect(isLogEntry(JSON.parse(JSON.stringify(entry)))).toBe(true);
    expect(entry.changes).toEqual([{ field: "issue", name: "issue", old: "", new: "4", class: "MISSING", source: { libraryID: 2, itemKey: "TEXT0001", libraryName: "Textbook" } }]);
    expect(entry.evidence).toEqual(["Textbook: Tier 1: DOI", "Waterfowl: Tier 2: title, author, year"]);
  });

  it("a skipped item logs no changes, so undo has nothing to revert", async () => {
    const plan = applyReconcilePreview(TARGET, differences, sources, { confirmed: true, choices: { issue: 0 } }, NOW)!;
    const outcome = await executeReconcilePlan(recordingAPI({ status: "target-changed" }).api, plan);
    expect(metadataLogEntry(outcome, "id-2").changes).toEqual([]);
  });

  it("undo restores old only where the field still holds what was written (invariant 10)", async () => {
    const plan = applyReconcilePreview(TARGET, differences, sources, { confirmed: true, choices: { issue: 0, pages: 0 } }, NOW)!;
    const outcome = await executeReconcilePlan(recordingAPI({ status: "written", stored: { issue: "4", pages: "1021-1034" } }).api, plan);
    expect(revertWrites(metadataLogEntry(outcome, "id-3"))).toEqual([
      { name: "issue", expected: "4", next: "" },
      { name: "pages", expected: "1021-1034", next: "1-10" }
    ]);
  });
});
