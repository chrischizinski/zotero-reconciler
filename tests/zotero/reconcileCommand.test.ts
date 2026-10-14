import { describe, expect, it } from "vitest";
import type { RecordCreator } from "../../src/comparison/differenceEngine.js";
import type { ReconcilePreviewModel, ReconcilePreviewResult } from "../../src/write/reconcilePlan.js";
import type { MetadataLogEntry, RevertLogEntry } from "../../src/write/transactionLog.js";
import type { FieldCheck, FieldWrite, UpdateResult, WriteAPI } from "../../src/write/writeApi.js";
import { ReconcileCommand } from "../../src/zotero/reconcileCommand.js";
import { TransactionStore, type LogFileSystem } from "../../src/zotero/transactionStore.js";

const MY = 1;
const GROUP = 2;
const DOI = "10.1002/jwmg.12345";
const FIELD_IDS: Record<string, number> = { title: 1, issue: 2, DOI: 3, date: 4, volume: 5, pages: 6, publicationTitle: 7 };

function zoteroItem(libraryID: number, key: string, fields: Record<string, string>, creators: RecordCreator[] = [{ creatorType: "author", lastName: "Smith", firstName: "Jane" }]) {
  return {
    libraryID, key, version: 3, itemType: "journalArticle", itemTypeID: 4,
    isRegularItem: () => true,
    getField: (field: string) => fields[field] ?? "",
    getCreators: () => creators.map(({ lastName, firstName }) => ({ lastName: lastName ?? "", ...(firstName ? { firstName } : {}) })),
    getCreatorsJSON: () => creators,
    getRelationsByPredicate: () => []
  };
}

function harness(options: { myFields?: Record<string, string>; groupFields?: Record<string, string>; selectedLibrary?: number; preview?: (model: ReconcilePreviewModel) => ReconcilePreviewResult; update?: UpdateResult; confirm?: boolean; log?: string } = {}) {
  const events: string[] = [];
  const mine = zoteroItem(MY, "MINE0001", options.myFields ?? { title: "Waterfowl harvest", DOI, issue: "", date: "2024" });
  const group = zoteroItem(GROUP, "GRP00001", options.groupFields ?? { title: "Waterfowl harvest", DOI, issue: "4", date: "2024" });
  const selected = options.selectedLibrary === GROUP ? group : mine;
  const items = [mine, group];
  const zotero = {
    debug: (message: string) => { events.push(`debug:${message}`); },
    getActiveZoteroPane: () => ({ getSelectedItems: () => [selected] }),
    getMainWindow: () => ({ document: { getElementById: () => null } } as unknown as Window),
    Libraries: { userLibraryID: MY, getAll: () => [{ libraryID: MY, name: "My Library", libraryType: "user" }, { libraryID: GROUP, name: "Textbook", libraryType: "group" }] },
    Items: {
      getAll: async (libraryID: number) => items.filter((item) => item.libraryID === libraryID),
      loadDataTypes: async () => undefined,
      getByLibraryAndKey: (libraryID: number, key: string) => items.find((item) => item.libraryID === libraryID && item.key === key) ?? false
    },
    URI: { getURIItemLibraryKey: () => false as const },
    ItemFields: {
      getID: (field: string) => FIELD_IDS[field] ?? false,
      getName: () => false as const,
      isValidForType: (fieldID: number) => Object.values(FIELD_IDS).includes(fieldID),
      getFieldIDFromTypeAndBase: () => false as const
    },
    CreatorTypes: { getTypesForItemType: () => [{ id: 1, name: "author" }, { id: 2, name: "editor" }] }
  };

  const files = new Map<string, string>();
  const logPath = "/data/zotero-library-reconciler/transactions.jsonl";
  if (options.log) files.set(logPath, options.log);
  const fs: LogFileSystem = {
    exists: async (path) => files.has(path),
    readUTF8: async (path) => files.get(path) ?? "",
    makeDirectory: async () => undefined,
    writeUTF8: async (path, text, opts) => { events.push(`log:${opts?.mode}`); files.set(path, opts?.mode === "appendOrCreate" ? (files.get(path) ?? "") + text : text); }
  };
  const updates: { target: unknown; writes: readonly FieldWrite[]; checks: readonly FieldCheck[] }[] = [];
  const writeAPI = {
    userLibraryID: () => MY,
    library: (libraryID: number) => ({ libraryID, name: "My Library", editable: true }),
    updateFields: async (target: unknown, writes: readonly FieldWrite[], checks: readonly FieldCheck[]) => update(target, writes, checks),
    updateFieldsBatch: async (batch: readonly { target: unknown; writes: readonly FieldWrite[]; checks: readonly FieldCheck[] }[]) => batch.map(({ target, writes, checks }) => update(target, writes, checks))
  } as unknown as WriteAPI;
  function update(target: unknown, writes: readonly FieldWrite[], checks: readonly FieldCheck[]) {
    events.push("update"); updates.push({ target, writes, checks });
    return options.update ?? { status: "written", stored: Object.fromEntries(writes.map((write) => [write.name, write.next])) };
  }

  const previews: ReconcilePreviewModel[] = [];
  const shown: string[] = [];
  const command = new ReconcileCommand(zotero, {
    writeAPI,
    store: TransactionStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/")),
    now: () => new Date("2026-10-14T15:00:00Z"),
    openPreview: (model) => { events.push("preview"); previews.push(model); return options.preview?.(model) ?? { confirmed: false, choices: {} }; },
    confirm: () => { events.push("confirm"); return options.confirm ?? false; },
    show: (text) => { events.push("show"); shown.push(text); }
  });
  const entries = () => (files.get(logPath) ?? "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as MetadataLogEntry | RevertLogEntry);
  return { command, events, updates, previews, shown, entries };
}

const acceptDefaults = (model: ReconcilePreviewModel): ReconcilePreviewResult => ({ confirmed: true, choices: Object.fromEntries(model.rows.map((row) => [row.field, row.defaultChoice])) });

describe("Compare Copies — only My Library items, only strong matches", () => {
  it("refuses a group-library selection: Phase 4 never edits a group (decision A)", async () => {
    const { command, events, shown } = harness({ selectedLibrary: GROUP });
    expect(await command.run()).toBeUndefined();
    expect(events).not.toContain("preview");
    expect(shown[0]).toContain("Only My Library items");
  });

  it("a copy that is only a REVIEW candidate supplies nothing and is listed with its evidence (§5)", async () => {
    // Same title and author, different DOIs: the matcher denies, so there is no strong pair.
    const { command, events, shown } = harness({ groupFields: { title: "Waterfowl harvest", DOI: "10.9999/other", issue: "4", date: "2024" } });
    expect(await command.run()).toBeUndefined();
    expect(events).not.toContain("preview");
    expect(shown[0]).toContain("No copy in another library is a strong enough match");
  });

  it("nothing different → a report, not an empty preview", async () => {
    const { command, events, shown } = harness({ groupFields: { title: "Waterfowl harvest", DOI, issue: "", date: "2024" } });
    await command.run();
    expect(events).not.toContain("preview");
    expect(shown[0]).toContain("Nothing to update");
  });
});

describe("Compare Copies — §25 in order: preview, confirm, write, log, then show", () => {
  it("Cancel writes nothing and logs nothing", async () => {
    const { command, events } = harness();
    await command.run();
    expect(events).toContain("preview");
    expect(events).not.toContain("update");
    expect(events.some((event) => event.startsWith("log"))).toBe(false);
  });

  it("confirm with the defaults writes the MISSING issue, logs BEFORE showing the result", async () => {
    const { command, events, updates, entries } = harness({ preview: acceptDefaults });
    const outcome = await command.run();
    expect(outcome?.status).toBe("written");
    expect(updates[0]?.writes).toEqual([{ name: "issue", expected: "", next: "4" }]);
    expect(updates[0]?.checks).toEqual([{ ref: { libraryID: GROUP, itemKey: "GRP00001" }, name: "issue", expected: "4" }]);
    expect(events.filter((event) => ["preview", "update", "log:appendOrCreate", "show"].includes(event))).toEqual(["preview", "update", "log:appendOrCreate", "show"]);
    const [entry] = entries() as MetadataLogEntry[];
    expect(entry).toMatchObject({ action: "update_metadata", status: "written", target: { libraryID: MY, itemKey: "MINE0001" } });
    expect(entry?.evidence[0]).toContain("EXACT");
  });

  it("a stale target is logged as skipped and the report says nothing was written", async () => {
    const { command, shown, entries } = harness({ preview: acceptDefaults, update: { status: "target-changed", detail: "issue changed in My Library since the preview." } });
    await command.run();
    expect((entries()[0] as MetadataLogEntry).changes).toEqual([]);
    expect(shown[0]).toContain("Nothing was written");
  });
});

describe("Undo Last Metadata Update — compare-and-swap in reverse, logged either way", () => {
  const written: MetadataLogEntry = {
    id: "2026-10-14T15:00:00.000Z-0001", action: "update_metadata", confirmedAt: "2026-10-14T15:00:00.000Z",
    target: { libraryID: MY, itemKey: "MINE0001", title: "Waterfowl harvest" }, status: "written",
    changes: [{ field: "issue", name: "issue", old: "", new: "4", class: "MISSING", source: { libraryID: GROUP, itemKey: "GRP00001", libraryName: "Textbook" } }],
    evidence: []
  };

  it("does nothing without confirmation", async () => {
    const { command, events } = harness({ log: `${JSON.stringify(written)}\n` });
    expect(await command.undoLast()).toBeUndefined();
    expect(events).not.toContain("update");
  });

  it("restores old only where the field still holds the written value, logs the revert and marks the entry undone", async () => {
    const { command, updates, entries } = harness({ log: `${JSON.stringify(written)}\n`, confirm: true });
    const revert = await command.undoLast();
    expect(revert?.map((entry) => entry.status)).toEqual(["written"]);
    expect(updates[0]?.writes).toEqual([{ name: "issue", expected: "4", next: "" }]);
    expect(updates[0]?.checks).toEqual([]);
    const logged = entries();
    expect(logged.find((entry) => entry.action === "update_metadata")?.undoneAt).toBe("2026-10-14T15:00:00.000Z");
    expect(logged.find((entry) => entry.action === "revert_metadata")).toMatchObject({ reverses: written.id, status: "written" });
  });

  it("a Fill Missing session is undone as a whole: every item of the last session, nothing older", async () => {
    const older = { ...written, id: "older" };
    const sessionItem = (key: string, index: number): MetadataLogEntry => ({ ...written, id: `fill-${index}`, session: "fill", target: { libraryID: MY, itemKey: key, title: key } });
    const log = [older, sessionItem("MINE0002", 0), sessionItem("MINE0003", 1)].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const { command, updates, entries, shown } = harness({ log, confirm: true });
    const reverts = await command.undoLast();
    expect(reverts?.map((entry) => entry.reverses)).toEqual(["fill-0", "fill-1"]);
    expect(updates.map((update) => (update.target as { itemKey: string }).itemKey)).toEqual(["MINE0002", "MINE0003"]);
    const metadata = entries().filter((entry): entry is MetadataLogEntry => entry.action === "update_metadata");
    expect(metadata.map((entry) => [entry.id, entry.undoneAt !== undefined])).toEqual([["older", false], ["fill-0", true], ["fill-1", true]]);
    // Revert IDs are unique within the session (a random suffix alone collides at a few hundred items).
    expect(new Set(reverts?.map((entry) => entry.id)).size).toBe(2);
    expect(shown[0]).toBe("Restored 2 of 2 items.");
  });

  it("a field edited since the update → nothing restored, revert logged, entry NOT marked undone", async () => {
    const { command, shown, entries } = harness({ log: `${JSON.stringify(written)}\n`, confirm: true, update: { status: "target-changed", detail: "issue changed" } });
    await command.undoLast();
    expect(entries().find((entry) => entry.action === "update_metadata")?.undoneAt).toBeUndefined();
    expect(entries().find((entry) => entry.action === "revert_metadata")).toMatchObject({ status: "target-changed" });
    expect(shown[0]).toContain("Nothing was restored");
  });
});
