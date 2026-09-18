import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK_SIZE, executeImportPlan, IMPORT_PARENT_COLLECTION, sessionNameFrom, type ImportProgress } from "../../src/write/importExecutor.js";
import { buildImportPlan, confirmPlan, type ImportPlan } from "../../src/write/importPlan.js";
import type { SourceItemState, WriteAPI, WriteItemRef } from "../../src/write/writeApi.js";
import type { ScannedItem } from "../../src/matching/types.js";

const MY = 1;
const GROUP = 2;

const item = (itemKey: string, version = 5): ScannedItem => ({
  ref: { libraryID: GROUP, libraryName: "creel", itemKey, version },
  itemType: "journalArticle", fields: { title: `Paper ${itemKey}`, date: "2024" }, creators: [{ lastName: "Smith", firstName: "J" }]
});

/** Records every call; behaviour per source key is scripted by the test. */
function fakeWriteAPI(script: {
  userLibraryID?: number;
  libraries?: Record<number, { name: string; editable: boolean }>;
  sources?: Record<string, SourceItemState | undefined>;
  linked?: Record<string, WriteItemRef>;
  failCopyFor?: string[];
} = {}) {
  const calls: string[] = [];
  const created: WriteItemRef[] = [];
  const api: WriteAPI = {
    userLibraryID: () => script.userLibraryID ?? MY,
    library: (id) => {
      const library = (script.libraries ?? { [MY]: { name: "My Library", editable: true }, [GROUP]: { name: "creel", editable: true } })[id];
      return library ? { libraryID: id, ...library } : undefined;
    },
    sourceItem: async (ref) => {
      calls.push(`source:${ref.itemKey}`);
      const sources = script.sources ?? {};
      return ref.itemKey in sources ? sources[ref.itemKey] : { version: 5, deleted: false };
    },
    linkedItemIn: async (ref) => { calls.push(`linked:${ref.itemKey}`); return (script.linked ?? {})[ref.itemKey]; },
    ensureImportCollection: async (libraryID, parent, session) => { calls.push(`collection:${libraryID}:${parent}/${session}`); return "COLL0001"; },
    copyItem: async (ref, options) => {
      calls.push(`copy:${ref.itemKey}:${options.collectionKey}:tags=${options.copyTags}`);
      if (script.failCopyFor?.includes(ref.itemKey)) throw new Error("save failed: disk full");
      const copy = { libraryID: options.targetLibraryID, itemKey: `NEW${ref.itemKey}` };
      created.push(copy);
      return copy;
    },
    // One transaction: any bad row rolls the chunk back and nothing is created.
    copyItems: async (refs, options) => {
      calls.push(`chunk:${refs.map((ref) => ref.itemKey).join(",")}:${options.collectionKey}:tags=${options.copyTags}`);
      if (refs.some((ref) => script.failCopyFor?.includes(ref.itemKey))) throw new Error("transaction rolled back: disk full");
      const copies = refs.map((ref) => ({ libraryID: options.targetLibraryID, itemKey: `NEW${ref.itemKey}` }));
      created.push(...copies);
      return copies;
    },
    trashItems: async (refs) => { calls.push(`trash:${refs.map((ref) => ref.itemKey).join(",")}`); }
  };
  return { api, calls, created };
}

const confirmedPlan = (keys: string[], overrides: Partial<ImportPlan> = {}): ImportPlan =>
  ({ ...confirmPlan(buildImportPlan(keys.map((key) => ({ item: item(key), nearMisses: [] })), MY, new Date("2026-09-17T19:32:00Z")), new Date("2026-09-17T19:32:08.000Z")), ...overrides });

describe("import executor (§25 WRITE stage, §40 batch semantics)", () => {
  it("refuses an unconfirmed plan before touching the API (invariant 9)", async () => {
    const { api, calls } = fakeWriteAPI();
    const plan = buildImportPlan([{ item: item("A"), nearMisses: [] }], MY, new Date());
    await expect(executeImportPlan(api, plan)).rejects.toThrow(/unconfirmed/);
    expect(calls).toEqual([]);
  });

  it("aborts before the first write when the target is not My Library or is read-only (§39, invariant 2)", async () => {
    const group = fakeWriteAPI();
    const toGroup = await executeImportPlan(group.api, confirmedPlan(["A"], { targetLibraryID: GROUP }));
    expect(toGroup.aborted).toMatch(/only into My Library/);
    expect(group.calls).toEqual([]);

    const readOnly = fakeWriteAPI({ libraries: { [MY]: { name: "My Library", editable: false } } });
    const outcome = await executeImportPlan(readOnly.api, confirmedPlan(["A"]));
    expect(outcome.aborted).toMatch(/read-only/);
    expect(readOnly.calls).toEqual([]);
    expect(outcome.totals.created).toBe(0);
  });

  it("re-checks each row immediately before writing: stale, missing, trashed and already-linked rows are skipped, the rest continue (§40)", async () => {
    const { api, calls, created } = fakeWriteAPI({
      sources: { STALE: { version: 6, deleted: false }, GONE: undefined, TRASH: { version: 5, deleted: true } },
      linked: { LINKED: { libraryID: MY, itemKey: "EXIST" } },
      failCopyFor: ["BOOM"]
    });
    const outcome = await executeImportPlan(api, confirmedPlan(["OK1", "STALE", "GONE", "TRASH", "LINKED", "BOOM", "OK2"]));

    expect(outcome.aborted).toBeUndefined();
    expect(outcome.totals).toEqual({ created: 2, skippedStale: 1, skippedMissing: 2, skippedExisting: 1, failed: 1, cancelled: 0 });
    expect(created.map((ref) => ref.itemKey)).toEqual(["NEWOK1", "NEWOK2"]);
    // Skipped rows never reach a write. The chunk transaction fails on BOOM and rolls back, so the
    // eligible rows are retried one at a time: the bad row costs only itself.
    expect(calls.filter((call) => call.startsWith("chunk:")).map((call) => call.split(":")[1])).toEqual(["OK1,BOOM,OK2"]);
    expect(calls.filter((call) => call.startsWith("copy:")).map((call) => call.split(":")[1])).toEqual(["OK1", "BOOM", "OK2"]);
    const byKey = Object.fromEntries(outcome.rows.map((row) => [row.row.source.itemKey, row]));
    expect(byKey.STALE).toMatchObject({ status: "skipped", reason: "stale-source", detail: expect.stringMatching(/5 → 6/) });
    expect(byKey.GONE).toMatchObject({ status: "skipped", reason: "source-missing" });
    expect(byKey.TRASH).toMatchObject({ status: "skipped", reason: "source-missing", detail: expect.stringMatching(/trash/) });
    expect(byKey.LINKED).toMatchObject({ status: "skipped", reason: "already-present", detail: expect.stringMatching(/EXIST/) });
    expect(byKey.BOOM).toMatchObject({ status: "failed", error: expect.stringMatching(/disk full/) });
  });

  it("files every copy in a per-session collection under the parent, named from the confirmation time, tags off by default", async () => {
    const { api, calls } = fakeWriteAPI();
    const outcome = await executeImportPlan(api, confirmedPlan(["A"]));
    expect(outcome.collectionKey).toBe("COLL0001");
    expect(calls[0]).toBe(`collection:${MY}:${IMPORT_PARENT_COLLECTION}/2026-09-17 19:32`);
    expect(calls).toContain("chunk:A:COLL0001:tags=false");
    expect(sessionNameFrom("2026-09-17T19:32:08.000Z")).toBe("2026-09-17 19:32");
  });

  it("never touches rows the user left un-ticked", async () => {
    const { api, calls } = fakeWriteAPI();
    const plan = confirmedPlan(["A", "B"]);
    const withSkip: ImportPlan = { ...plan, rows: plan.rows.map((row) => (row.source.itemKey === "B" ? { ...row, decision: "skip" } : row)) };
    const outcome = await executeImportPlan(api, withSkip);
    expect(calls.some((call) => call.endsWith(":B") || call.includes(":B:"))).toBe(false);
    expect(outcome.rows.map((row) => row.row.source.itemKey)).toEqual(["A"]);
  });

  it("writes in chunks of one transaction each, reports progress per chunk, and re-checks rows just before their own chunk (§40)", async () => {
    const versions: Record<string, number> = {};
    const { api, calls } = fakeWriteAPI();
    api.sourceItem = async (ref) => { calls.push(`source:${ref.itemKey}`); return { version: versions[ref.itemKey] ?? 5, deleted: false }; };
    const progress: ImportProgress[] = [];
    const plan = confirmedPlan(["A", "B", "C", "D", "E"]);
    // D goes stale while chunk 1 is being written; a session-start check would have missed it.
    api.copyItems = new Proxy(api.copyItems, { apply: (target, thisArg, args: [WriteItemRef[], never]) => { versions.D = 9; return Reflect.apply(target, thisArg, args); } });
    const outcome = await executeImportPlan(api, plan, { chunkSize: 2, onProgress: (p) => progress.push(p) });
    expect(calls.filter((call) => call.startsWith("chunk:")).map((call) => call.split(":")[1])).toEqual(["A,B", "C", "E"]);
    expect(progress).toEqual([{ done: 2, total: 5 }, { done: 4, total: 5 }, { done: 5, total: 5 }]);
    expect(outcome.rows.map((row) => [row.row.source.itemKey, row.status])).toEqual([["A", "created"], ["B", "created"], ["C", "created"], ["D", "skipped"], ["E", "created"]]);
    expect(DEFAULT_CHUNK_SIZE).toBe(25);
  });

  it("honours cancel between chunks, never mid-chunk: later rows are reported as cancelled with nothing written", async () => {
    const { api, calls, created } = fakeWriteAPI();
    let cancelled = false;
    const outcome = await executeImportPlan(api, confirmedPlan(["A", "B", "C", "D"]), {
      chunkSize: 2,
      onProgress: () => { cancelled = true; },
      shouldCancel: () => cancelled
    });
    expect(calls.filter((call) => call.startsWith("chunk:")).map((call) => call.split(":")[1])).toEqual(["A,B"]);
    expect(created.map((ref) => ref.itemKey)).toEqual(["NEWA", "NEWB"]);
    expect(outcome.rows.map((row) => [row.row.source.itemKey, row.status])).toEqual([["A", "created"], ["B", "created"], ["C", "cancelled"], ["D", "cancelled"]]);
    expect(outcome.totals).toMatchObject({ created: 2, cancelled: 2, failed: 0 });
  });
});
