import { describe, expect, it } from "vitest";
import type { ImportOutcome } from "../../src/write/importExecutor.js";
import { buildImportPlan, confirmPlan, rowKey, withDecisions } from "../../src/write/importPlan.js";
import { createdRefs, importLogEntry, logEntryID, parseLog, undoLogEntry, type ImportLogEntry, type LogEntry } from "../../src/write/transactionLog.js";
import { TransactionStore, type LogFileSystem } from "../../src/zotero/transactionStore.js";
import type { ScannedItem } from "../../src/matching/types.js";

const item = (itemKey: string): ScannedItem => ({
  ref: { libraryID: 2, libraryName: "creel", itemKey, version: 5 },
  itemType: "journalArticle", fields: { title: `Paper ${itemKey}`, date: "2024" }, creators: [{ lastName: "Smith" }]
});
const nearMiss = { item: item("M"), reason: "same-title" as const, evidence: "Item types are incompatible." };

describe("import plan (PROPOSE / PREVIEW / CONFIRM as data)", () => {
  it("imports clean rows by default and un-ticks any row with a near-miss so the user opts in (§48.1)", () => {
    const plan = buildImportPlan([{ item: item("A"), nearMisses: [] }, { item: item("B"), nearMisses: [nearMiss] }], 1, new Date("2026-09-17T19:00:00Z"));
    expect(plan.rows.map((row) => row.decision)).toEqual(["import", "skip"]);
    expect(plan.copyTags).toBe(false);
    expect(plan.confirmedAt).toBeUndefined();
    expect(plan.rows[0]?.source).toEqual({ libraryID: 2, libraryName: "creel", itemKey: "A", version: 5, title: "Paper A", itemType: "journalArticle", year: "2024" });
  });

  it("applies the user's choices and stamps confirmation separately from creation", () => {
    const plan = buildImportPlan([{ item: item("A"), nearMisses: [] }, { item: item("B"), nearMisses: [nearMiss] }], 1, new Date("2026-09-17T19:00:00Z"));
    const chosen = withDecisions(plan, new Map([[rowKey(plan.rows[1]!), "import"], [rowKey(plan.rows[0]!), "skip"]]));
    expect(chosen.rows.map((row) => row.decision)).toEqual(["skip", "import"]);
    const confirmed = confirmPlan(chosen, new Date("2026-09-17T19:05:00Z"));
    expect(confirmed.confirmedAt).toBe("2026-09-17T19:05:00.000Z");
    expect(confirmed.createdAt).toBe("2026-09-17T19:00:00.000Z");
  });
});

function outcomeFixture(): ImportOutcome {
  const plan = confirmPlan(buildImportPlan([{ item: item("A"), nearMisses: [] }, { item: item("B"), nearMisses: [] }, { item: item("C"), nearMisses: [] }], 1, new Date("2026-09-17T19:00:00Z")), new Date("2026-09-17T19:05:00Z"));
  const [a, b, c] = plan.rows;
  return {
    plan, collectionKey: "COLL0001",
    rows: [
      { row: a!, status: "created", created: { libraryID: 1, itemKey: "NEWA" } },
      { row: b!, status: "skipped", reason: "stale-source", detail: "changed" },
      { row: c!, status: "failed", error: "disk full" }
    ],
    totals: { created: 1, skippedStale: 1, skippedMissing: 0, skippedExisting: 0, failed: 1, cancelled: 0 }
  };
}

describe("transaction log (§26) — the Phase 3 undo mechanism, since native undo skips creations", () => {
  it("records actual per-row outcomes and totals, and exposes exactly the created refs for a session undo", () => {
    const entry = importLogEntry(outcomeFixture(), "2026-09-17T19:05:01.000Z-0001");
    expect(entry).toMatchObject({ action: "import", confirmedAt: "2026-09-17T19:05:00.000Z", target: { libraryID: 1, collectionKey: "COLL0001" } });
    expect(entry.rows.map((row) => Object.keys(row).filter((key) => key !== "source"))).toEqual([["created"], ["skipped"], ["failed"]]);
    expect(entry.rows[1]?.skipped).toMatch(/^stale-source: /);
    expect(entry.totals.created).toBe(1);
    expect(createdRefs(entry)).toEqual([{ libraryID: 1, itemKey: "NEWA" }]);
    const undo = undoLogEntry(entry, createdRefs(entry), "undo-1", new Date("2026-09-18T08:00:00Z"));
    expect(undo).toEqual({ id: "undo-1", action: "undo", reverses: entry.id, at: "2026-09-18T08:00:00.000Z", trashed: [{ libraryID: 1, itemKey: "NEWA" }] });
  });

  it("parses JSONL leniently: one bad line is counted, the rest survive", () => {
    const good = importLogEntry(outcomeFixture(), "id-1");
    const text = `${JSON.stringify(good)}\nnot json\n{"id":"x","action":"bogus"}\n\n${JSON.stringify(good)}\n`;
    const { entries, malformed } = parseLog(text);
    expect(entries).toHaveLength(2);
    expect(malformed).toBe(2);
    expect(logEntryID(new Date("2026-09-17T19:05:01.004Z"), () => 0.25)).toBe("2026-09-17T19:05:01.004Z-3fff");
  });

  it("store appends one line per entry and marks an import undone by rewriting only that entry", async () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const fs: LogFileSystem = {
      exists: async (path) => files.has(path),
      readUTF8: async (path) => files.get(path) ?? "",
      makeDirectory: async () => undefined,
      writeUTF8: async (path, text, options) => {
        writes.push(options?.mode ?? "overwrite");
        files.set(path, options?.mode === "appendOrCreate" ? (files.get(path) ?? "") + text : text);
      }
    };
    const store = TransactionStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/"));
    expect(store.location).toBe("/data/zotero-library-reconciler/transactions.jsonl");
    expect(await store.readAll()).toEqual({ entries: [], malformed: 0 });

    const first = importLogEntry(outcomeFixture(), "imp-1");
    const second: ImportLogEntry = { ...first, id: "imp-2" };
    await store.append(first);
    await store.append(second);
    expect(writes).toEqual(["appendOrCreate", "appendOrCreate"]);
    expect(files.get(store.location)?.split("\n").filter(Boolean)).toHaveLength(2);

    await store.markUndone("imp-1", "2026-09-18T08:00:00.000Z");
    const { entries } = await store.readAll();
    const byID = Object.fromEntries(entries.map((entry: LogEntry) => [entry.id, entry]));
    expect((byID["imp-1"] as ImportLogEntry).undoneAt).toBe("2026-09-18T08:00:00.000Z");
    expect((byID["imp-2"] as ImportLogEntry).undoneAt).toBeUndefined();
    expect(writes.at(-1)).toBe("overwrite");
  });
});
