import { describe, expect, it } from "vitest";
import type { RecordCreator } from "../../src/comparison/differenceEngine.js";
import type { FillPreviewModel, FillPreviewResult } from "../../src/write/fillPlan.js";
import type { MetadataLogEntry } from "../../src/write/transactionLog.js";
import type { FieldUpdate, UpdateResult, WriteAPI } from "../../src/write/writeApi.js";
import { FillMissingCommand } from "../../src/zotero/fillMissingCommand.js";
import { loadStrongComparisons } from "../../src/zotero/metadataDifferencesCommand.js";
import { TransactionStore, type LogFileSystem } from "../../src/zotero/transactionStore.js";

const MY = 1;
const GROUP = 2;
const FIELD_IDS: Record<string, number> = { title: 1, issue: 2, DOI: 3, date: 4, volume: 5 };

function zoteroItem(libraryID: number, key: string, fields: Record<string, string>) {
  const creators: RecordCreator[] = [{ creatorType: "author", lastName: "Smith", firstName: "Jane" }];
  return {
    libraryID, key, version: 3, itemType: "journalArticle", itemTypeID: 4,
    isRegularItem: () => true,
    getField: (field: string) => fields[field] ?? "",
    getCreators: () => [{ lastName: "Smith", firstName: "Jane" }],
    getCreatorsJSON: () => creators,
    getRelationsByPredicate: () => []
  };
}

interface Options {
  preview?: (model: FillPreviewModel) => FillPreviewResult;
  answer?: (update: FieldUpdate) => UpdateResult;
  items?: ReturnType<typeof zoteroItem>[];
  logFails?: boolean;
}

function harness(options: Options = {}) {
  const events: string[] = [];
  const items = options.items ?? [
    // Issue empty in My Library and the DOI-matched copy has it → filled. Volume differs → never filled here.
    zoteroItem(MY, "MINE0001", { title: "Waterfowl harvest", DOI: "10.1002/jwmg.1", issue: "", volume: "8", date: "2024" }),
    zoteroItem(GROUP, "GRP00001", { title: "Waterfowl harvest", DOI: "10.1002/jwmg.1", issue: "4", volume: "9", date: "2024" }),
    // Only an identifier is missing (Tier 2 match): nothing to fill.
    zoteroItem(MY, "MINE0002", { title: "Duck banding returns in the central flyway", DOI: "", issue: "2", date: "2020" }),
    zoteroItem(GROUP, "GRP00002", { title: "Duck banding returns in the central flyway", DOI: "10.1/duck", issue: "2", date: "2020" })
  ];
  const zotero = {
    debug: (message: string) => { events.push(`debug:${message}`); },
    getMainWindow: () => ({ document: { getElementById: () => null } } as unknown as Window),
    Libraries: { userLibraryID: MY, getAll: () => [{ libraryID: MY, name: "My Library", libraryType: "user" }, { libraryID: GROUP, name: "Textbook", libraryType: "group" }] },
    Items: {
      getAll: async (libraryID: number) => items.filter((item) => item.libraryID === libraryID),
      loadDataTypes: async () => undefined,
      getByLibraryAndKey: (libraryID: number, key: string) => items.find((item) => item.libraryID === libraryID && item.key === key) ?? false
    },
    URI: { getURIItemLibraryKey: () => false as const },
    ItemFields: { getID: (field: string) => FIELD_IDS[field] ?? false, getName: () => false as const, isValidForType: (id: number) => Object.values(FIELD_IDS).includes(id), getFieldIDFromTypeAndBase: () => false as const },
    CreatorTypes: { getTypesForItemType: () => [{ id: 1, name: "author" }] }
  };

  const files = new Map<string, string>();
  const logPath = "/data/zotero-library-reconciler/transactions.jsonl";
  const fs: LogFileSystem = {
    exists: async (path) => files.has(path),
    readUTF8: async (path) => files.get(path) ?? "",
    makeDirectory: async () => undefined,
    writeUTF8: async (path, text, opts) => {
      if (options.logFails) throw new Error("disk full");
      events.push("log"); files.set(path, opts?.mode === "appendOrCreate" ? (files.get(path) ?? "") + text : text);
    }
  };
  const updates: FieldUpdate[] = [];
  const answer = options.answer ?? ((update: FieldUpdate) => ({ status: "written", stored: Object.fromEntries(update.writes.map((write) => [write.name, write.next])) }) as UpdateResult);
  const writeAPI = {
    userLibraryID: () => MY,
    library: (libraryID: number) => ({ libraryID, name: "My Library", editable: true }),
    updateFieldsBatch: async (batch: readonly FieldUpdate[]) => { events.push("write"); updates.push(...batch); return batch.map(answer); },
    updateFields: async () => { throw new Error("the batch path must be used"); }
  } as unknown as WriteAPI;

  const previews: FillPreviewModel[] = [];
  const shown: string[] = [];
  const command = new FillMissingCommand(zotero, {
    writeAPI,
    store: TransactionStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/")),
    now: () => new Date("2026-10-14T16:00:00Z"),
    openPreview: (model) => { events.push("preview"); previews.push(model); return options.preview?.(model) ?? { confirmed: false, checkedKeys: [] }; },
    openProgress: () => ({ update: () => undefined, cancelled: () => false, close: () => { events.push("progress-closed"); } }),
    show: (text) => { events.push("show"); shown.push(text); }
  });
  const entries = () => (files.get(logPath) ?? "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as MetadataLogEntry);
  return { command, events, updates, previews, shown, entries, zotero };
}

const acceptAll = (model: FillPreviewModel): FillPreviewResult => ({ confirmed: true, checkedKeys: model.rows.map((row) => row.key) });

describe("Fill Missing Fields — the batch path end to end", () => {
  it("proposes only the empty, agreed, non-identifier field; a differing volume and a missing DOI are never offered", async () => {
    const { command, previews, zotero } = harness();
    // Both pairs are strong matches, so the duck item's missing DOI really was a candidate and was excluded by policy.
    expect((await loadStrongComparisons(zotero)).targets.size).toBe(2);
    await command.run();
    expect(previews[0]?.rows.map((row) => [row.key, row.edits])).toEqual([["1:MINE0001", ["issue: 4 (from Textbook)"]]]);
  });

  it("Cancel writes nothing and logs nothing", async () => {
    const { command, events } = harness();
    expect(await command.run()).toBeUndefined();
    expect(events).not.toContain("write");
    expect(events).not.toContain("log");
  });

  it("confirm → writes, logs one entry per item with a shared session BEFORE showing the result (invariant 8)", async () => {
    const { command, events, updates, entries, shown } = harness({ preview: acceptAll });
    const outcome = await command.run();
    expect(outcome?.totals).toMatchObject({ itemsUpdated: 1, fieldsWritten: 1 });
    expect(updates[0]?.writes).toEqual([{ name: "issue", expected: "", next: "4" }]);
    expect(events.filter((event) => ["write", "progress-closed", "log", "show"].includes(event))).toEqual(["write", "progress-closed", "log", "show"]);
    const [entry] = entries();
    expect(entry).toMatchObject({ action: "update_metadata", status: "written", target: { itemKey: "MINE0001" }, changes: [{ field: "issue", old: "", new: "4" }] });
    expect(entry?.session).toBeDefined();
    expect(entry?.id.startsWith(entry!.session!)).toBe(true);
    expect(entry?.evidence[0]).toMatch(/^Textbook: EXACT/);
    expect(shown[0]).toContain("Filled 1 field in 1 My Library item; skipped 0, failed 0.");
  });

  it("a stale item is logged as skipped (no changes) and listed in the result", async () => {
    const { command, entries, shown } = harness({ preview: acceptAll, answer: () => ({ status: "target-changed", detail: "issue in My Library no longer holds the expected value." }) });
    await command.run();
    expect(entries()[0]).toMatchObject({ status: "target-changed", changes: [] });
    expect(shown[0]).toContain("Filled 0 fields in 0 My Library items; skipped 1");
    expect(shown[0]).toContain("Waterfowl harvest — changed in My Library since the list was made");
  });

  it("a failed log write is reported with the keys of the items that WERE changed", async () => {
    const { command, shown } = harness({ preview: acceptAll, logFails: true });
    await command.run();
    expect(shown[0]).toContain("WARNING: the transaction log could not be written");
    expect(shown[0]).toContain("1:MINE0001");
  });

  it("nothing to fill → a message, no preview", async () => {
    const items = [
      zoteroItem(MY, "MINE0002", { title: "Duck banding returns in the central flyway", DOI: "", issue: "2", date: "2020" }),
      zoteroItem(GROUP, "GRP00002", { title: "Duck banding returns in the central flyway", DOI: "10.1/duck", issue: "2", date: "2020" })
    ];
    const { command, events, shown } = harness({ items });
    expect(await command.run()).toBeUndefined();
    expect(events).not.toContain("preview");
    expect(shown[0]).toContain("Nothing to fill");
  });
});
