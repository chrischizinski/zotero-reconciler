import { describe, expect, it } from "vitest";
import type { LinkPreviewModel, LinkPreviewResult } from "../../src/write/linkRepair.js";
import type { LinkLogEntry, LinkRestoreLogEntry } from "../../src/write/transactionLog.js";
import type { LinkRemoval, LinkRemovalResult, LinkRestore, LinkRestoreStatus, WriteAPI } from "../../src/write/writeApi.js";
import { LinkRepairCommand } from "../../src/zotero/linkRepairCommand.js";
import { TransactionStore, type LogFileSystem } from "../../src/zotero/transactionStore.js";

const MY = 1;
const GROUP = 5;
const GROUP_URI = "http://zotero.org/groups/55/items/GRP00001";

function zoteroItem(libraryID: number, key: string, fields: Record<string, string>, links: string[] = []) {
  return {
    libraryID, key, version: 3, itemType: "journalArticle",
    isRegularItem: () => true,
    getField: (field: string) => fields[field] ?? "",
    getCreators: () => [{ lastName: "Wszola", firstName: "Lyndsie" }],
    getRelationsByPredicate: (predicate: string) => (predicate === "owl:sameAs" ? links : [])
  };
}

interface Options {
  preview?: (model: LinkPreviewModel) => LinkPreviewResult;
  remove?: (removals: readonly LinkRemoval[]) => LinkRemovalResult[];
  restore?: (restores: readonly LinkRestore[]) => LinkRestoreStatus[];
  confirm?: boolean;
}

function harness(options: Options = {}) {
  const events: string[] = [];
  const items = [
    zoteroItem(MY, "MINE0001", { title: "Use and expenditures on public access hunting lands", date: "2020", DOI: "10.1016/j.jort.2019.100256" }, [GROUP_URI]),
    zoteroItem(GROUP, "GRP00001", { title: "Public access for pheasant hunters: understanding an emerging need", date: "2020", DOI: "10.1002/jwmg.21785" })
  ];
  const zotero = {
    debug: () => undefined,
    getMainWindow: () => ({ document: { getElementById: () => null } } as unknown as Window),
    Libraries: { userLibraryID: MY, getAll: () => [{ libraryID: MY, name: "My Library", libraryType: "user" }, { libraryID: GROUP, name: "hdfw-book", libraryType: "group" }] },
    Items: { getAll: async (libraryID: number) => items.filter((item) => item.libraryID === libraryID), loadDataTypes: async () => undefined },
    URI: { getURIItemLibraryKey: (uri: string) => (uri === GROUP_URI ? { libraryID: GROUP, key: "GRP00001" } : false as const) }
  };
  const files = new Map<string, string>();
  const logPath = "/data/zotero-library-reconciler/transactions.jsonl";
  const fs: LogFileSystem = {
    exists: async (path) => files.has(path),
    readUTF8: async (path) => files.get(path) ?? "",
    makeDirectory: async () => undefined,
    writeUTF8: async (path, text, opts) => { events.push("log"); files.set(path, opts?.mode === "appendOrCreate" ? (files.get(path) ?? "") + text : text); }
  };
  const calls: unknown[] = [];
  const writeAPI = {
    userLibraryID: () => MY,
    removeLinkedRelations: async (removals: readonly LinkRemoval[]) => { events.push("remove"); calls.push(removals); return options.remove?.(removals) ?? removals.map(() => ({ status: "removed", uri: GROUP_URI })); },
    restoreLinkedRelations: async (restores: readonly LinkRestore[]) => { events.push("restore"); calls.push(restores); return options.restore?.(restores) ?? restores.map(() => "restored"); }
  } as unknown as WriteAPI;
  const shown: string[] = [];
  const command = new LinkRepairCommand(zotero, {
    writeAPI,
    store: TransactionStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/")),
    now: () => new Date("2026-10-14T18:00:00Z"),
    refreshIndex: async () => { events.push("refresh"); },
    openPreview: (model) => { events.push("preview"); return options.preview?.(model) ?? { confirmed: false, checkedKeys: [] }; },
    confirm: () => options.confirm ?? false,
    show: (text) => { events.push("show"); shown.push(text); }
  });
  const entries = () => (files.get(logPath) ?? "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LinkLogEntry | LinkRestoreLogEntry);
  return { command, events, calls, shown, entries };
}

const tickAll = (model: LinkPreviewModel): LinkPreviewResult => ({ confirmed: true, checkedKeys: model.rows.map((row) => row.key) });

describe("Review Outdated Zotero Links — end to end", () => {
  it("Cancel removes nothing and logs nothing", async () => {
    const { command, events } = harness();
    expect(await command.run()).toBeUndefined();
    expect(events).toEqual(["preview"]);
  });

  it("a ticked pair: removes the link on the My Library item, logs the exact URI BEFORE the result, refreshes the index", async () => {
    const { command, events, calls, entries, shown } = harness({ preview: tickAll });
    await command.run();
    expect(calls[0]).toEqual([{ target: { libraryID: MY, itemKey: "MINE0001" }, linked: { libraryID: GROUP, itemKey: "GRP00001" } }]);
    expect(events).toEqual(["preview", "remove", "log", "refresh", "show"]);
    expect(entries()[0]).toMatchObject({ action: "remove_link", status: "removed", uri: GROUP_URI, target: { itemKey: "MINE0001" }, linked: { itemKey: "GRP00001", libraryName: "hdfw-book" } });
    expect(shown[0]).toContain("Removed 1 of 1 Zotero link");
  });

  it("a link already gone at write time is logged as such, not as removed, and nothing is refreshed", async () => {
    const { command, events, entries, shown } = harness({ preview: tickAll, remove: (removals) => removals.map(() => ({ status: "link-missing", detail: "The My Library item no longer carries this link." })) });
    await command.run();
    expect(entries()[0]).toMatchObject({ status: "link-missing" });
    expect(entries()[0]).not.toHaveProperty("uri");
    expect(events).not.toContain("refresh");
    expect(shown[0]).toContain("Removed 0 of 1");
  });

  it("undo restores the logged URI, logs it, and marks the removal undone; a second undo finds nothing", async () => {
    const h = harness({ preview: tickAll, confirm: true });
    await h.command.run();
    await h.command.undoLast();
    expect(h.calls[1]).toEqual([{ target: { libraryID: MY, itemKey: "MINE0001" }, uri: GROUP_URI }]);
    const removal = h.entries().find((entry): entry is LinkLogEntry => entry.action === "remove_link");
    expect(removal?.undoneAt).toBe("2026-10-14T18:00:00.000Z");
    expect(h.entries().find((entry) => entry.action === "restore_link")).toMatchObject({ status: "restored", reverses: removal?.id });
    await h.command.undoLast();
    expect(h.shown.at(-1)).toBe("No link removal to undo.");
  });

  it("undo without confirmation writes nothing", async () => {
    const h = harness({ preview: tickAll, confirm: false });
    await h.command.run();
    await h.command.undoLast();
    expect(h.events).not.toContain("restore");
  });
});
