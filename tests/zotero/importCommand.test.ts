import { describe, expect, it } from "vitest";
import type { ZoteroItem } from "../../src/zotero/adapter.js";
import { ImportCommand, renderOutcome, renderUndoPrompt } from "../../src/zotero/importCommand.js";
import { TransactionStore, type LogFileSystem } from "../../src/zotero/transactionStore.js";
import type { PreviewModel, PreviewResult } from "../../src/write/importPreviewModel.js";
import type { ImportLogEntry } from "../../src/write/transactionLog.js";
import type { WriteAPI, WriteItemRef } from "../../src/write/writeApi.js";

const MY = 1;
const GROUP = 2;

function zoteroItem(libraryID: number, key: string, title: string, extra: Partial<ZoteroItem> = {}): ZoteroItem {
  return {
    libraryID, key, version: 4, itemType: "journalArticle",
    isRegularItem: () => true,
    getField: (field) => field === "title" ? title : field === "date" ? "2024" : "",
    getCreators: () => [{ lastName: "Smith", firstName: "J" }],
    getRelationsByPredicate: () => [],
    ...extra
  };
}

/** Every piece the command touches, recorded. `preview` scripts the user's answer in the modal window. */
function harness(options: { preview?: (model: PreviewModel) => PreviewResult; confirmUndo?: boolean; log?: string; groupItems?: ZoteroItem[]; myItems?: ZoteroItem[] } = {}) {
  const events: string[] = [];
  const files = new Map<string, string>();
  if (options.log) files.set("/data/zotero-library-reconciler/transactions.jsonl", options.log);
  const fs: LogFileSystem = {
    exists: async (path) => files.has(path),
    readUTF8: async (path) => files.get(path) ?? "",
    makeDirectory: async () => undefined,
    writeUTF8: async (path, text, opts) => {
      events.push(`log:${opts?.mode ?? "overwrite"}`);
      files.set(path, opts?.mode === "appendOrCreate" ? (files.get(path) ?? "") + text : text);
    }
  };
  const store = TransactionStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/"));

  const writeAPI: WriteAPI = {
    userLibraryID: () => MY,
    library: (id) => id === MY ? { libraryID: MY, name: "My Library", editable: true } : { libraryID: id, name: "creel", editable: true },
    sourceItem: async () => ({ version: 4, deleted: false }),
    linkedItemIn: async () => undefined,
    ensureImportCollection: async () => { events.push("collection"); return "COLL0001"; },
    copyItem: async (ref): Promise<WriteItemRef> => { events.push(`copy:${ref.itemKey}`); return { libraryID: MY, itemKey: `NEW${ref.itemKey}` }; },
    trashItems: async (refs) => { events.push(`trash:${refs.map((ref) => ref.itemKey).join(",")}`); }
  };

  const groupItems = options.groupItems ?? [zoteroItem(GROUP, "G1", "Only in the group"), zoteroItem(GROUP, "G2", "Also only in the group")];
  // A different author: a same-author short title would (correctly) be a recall near-miss and un-tick the rows.
  const myItems = options.myItems ?? [zoteroItem(MY, "M1", "Already mine", { getCreators: () => [{ lastName: "Nguyen" }] })];
  const zotero = {
    debug: (message: string) => { events.push(`debug:${message}`); },
    getMainWindow: () => ({ document: { getElementById: () => null } } as unknown as Window),
    Libraries: { userLibraryID: MY, getAll: () => [{ libraryID: MY, name: "My Library", libraryType: "user" }, { libraryID: GROUP, name: "creel", libraryType: "group" }] },
    Items: { getAll: async (libraryID: number) => libraryID === MY ? myItems : groupItems, loadDataTypes: async () => undefined },
    URI: { getURIItemLibraryKey: () => false as const }
  };

  const shown: { title: string; text: string }[] = [];
  const previews: PreviewModel[] = [];
  const command = new ImportCommand(zotero, {
    writeAPI, store,
    now: () => new Date("2026-09-18T10:00:00Z"),
    refreshIndex: async () => { events.push("refresh"); },
    openPreview: (model) => { previews.push(model); events.push("preview"); return options.preview?.(model) ?? { confirmed: false, checkedKeys: [], copyTags: false }; },
    confirm: () => { events.push("confirm"); return options.confirmUndo ?? false; },
    show: (text, title) => { events.push(`show:${title}`); shown.push({ title, text }); }
  });
  return { command, events, shown, previews, files, logText: () => files.get("/data/zotero-library-reconciler/transactions.jsonl") ?? "" };
}

describe("Add Missing Items command — the only path to the write engine (§25 in order)", () => {
  it("previews every group-only work and, on Cancel, performs no write and writes no log", async () => {
    const { command, events, previews } = harness();
    expect(await command.run()).toBeUndefined();
    expect(previews[0]?.rows.map((row) => [row.title, row.checked])).toEqual([["Only in the group", true], ["Also only in the group", true]]);
    expect(events).toEqual(["preview"]);
  });

  it("on confirm writes only the ticked rows, logs BEFORE showing the result (invariant 8), then refreshes the index", async () => {
    const { command, events, shown, logText } = harness({ preview: () => ({ confirmed: true, checkedKeys: ["2:G2"], copyTags: false }) });
    const outcome = await command.run();
    expect(outcome?.totals).toMatchObject({ created: 1, failed: 0 });
    expect(events).toEqual(["preview", "collection", "copy:G2", "log:appendOrCreate", "refresh", "show:Add Missing Items"]);
    expect(shown[0]?.text).toMatch(/^Created 1 item in My Library/);
    const entry = JSON.parse(logText().trim()) as ImportLogEntry;
    expect(entry.action).toBe("import");
    expect(entry.rows.map((row) => [row.source.itemKey, row.created?.itemKey])).toEqual([["G2", "NEWG2"]]);
  });

  it("confirm with nothing ticked writes nothing and says so", async () => {
    const { command, events } = harness({ preview: () => ({ confirmed: true, checkedKeys: [], copyTags: false }) });
    expect(await command.run()).toBeUndefined();
    expect(events).toEqual(["preview", "show:Add Missing Items"]);
  });

  it("reports actual counts, not plan size: a stale row is listed as skipped", () => {
    const text = renderOutcome({
      plan: { targetLibraryID: MY, rows: [], copyTags: false, createdAt: "", confirmedAt: "" },
      collectionKey: "C",
      rows: [{ row: { source: { libraryID: GROUP, libraryName: "creel", itemKey: "G1", version: 1, title: "Moved", itemType: "book" }, nearMisses: [], decision: "import" }, status: "skipped", reason: "stale-source", detail: "changed" }],
      totals: { created: 0, skippedStale: 1, skippedMissing: 0, skippedExisting: 0, failed: 0 }
    }, "Logged.");
    expect(text).toMatch(/Created 0 items[^\n]*skipped 1, failed 0/);
    expect(text).toMatch(/• Moved — skipped: changed/);
  });
});

const importEntry = (id: string, undone = false): ImportLogEntry => ({
  id, action: "import", confirmedAt: "2026-09-17T19:32:08.000Z", target: { libraryID: MY, collectionKey: "C" },
  rows: [{ source: { libraryID: GROUP, itemKey: "G1", version: 4, title: "Imported paper" }, created: { libraryID: MY, itemKey: "NEWG1" } }],
  totals: { created: 1, skippedStale: 0, skippedMissing: 0, skippedExisting: 0, failed: 0 },
  ...(undone ? { undoneAt: "2026-09-17T20:00:00.000Z" } : {})
});

describe("Undo Last Import Session — trash, never erase; log the undo; mark the import undone", () => {
  it("does nothing without a confirmation", async () => {
    const { command, events } = harness({ log: `${JSON.stringify(importEntry("imp-1"))}\n`, confirmUndo: false });
    await command.undoLast();
    expect(events).toEqual(["confirm"]);
  });

  it("trashes exactly the created refs of the latest un-undone session, appends an undo entry, then marks the import", async () => {
    const log = `${JSON.stringify(importEntry("imp-1"))}\n${JSON.stringify(importEntry("imp-2", true))}\n`;
    const { command, events, logText } = harness({ log, confirmUndo: true });
    await command.undoLast();
    expect(events).toEqual(["confirm", "trash:NEWG1", "log:appendOrCreate", "log:overwrite", "refresh", "show:Undo Last Import"]);
    const entries = logText().trim().split("\n").map((line) => JSON.parse(line) as { action: string; id: string; reverses?: string; undoneAt?: string });
    expect(entries.find((entry) => entry.action === "undo")?.reverses).toBe("imp-1");
    expect(entries.find((entry) => entry.id === "imp-1")?.undoneAt).toBe("2026-09-18T10:00:00.000Z");
  });

  it("says so when every session is already undone", async () => {
    const { command, events, shown } = harness({ log: `${JSON.stringify(importEntry("imp-1", true))}\n`, confirmUndo: true });
    await command.undoLast();
    expect(events).toEqual(["show:Undo Last Import"]);
    expect(shown[0]?.text).toMatch(/No import session to undo/);
  });

  it("the prompt names the count, the time and the titles, and says items go to the trash", () => {
    const text = renderUndoPrompt(importEntry("imp-1"));
    expect(text).toMatch(/Move the 1 item imported on 2026-09-17 19:32:08 UTC to the trash\?/);
    expect(text).toMatch(/• Imported paper/);
  });
});
