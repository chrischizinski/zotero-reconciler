import { describe, expect, it } from "vitest";
import { FindCopiesCommand } from "../../src/zotero/findCopiesCommand.js";
import type { ZoteroItem } from "../../src/zotero/adapter.js";
import { IndexStore, type SnapshotFileSystem } from "../../src/zotero/indexStore.js";

function selectedItem(): ZoteroItem {
  return {
    libraryID: 1,
    key: "AAAA1111",
    version: 1,
    itemType: "journalArticle",
    isRegularItem: () => true,
    getField: (field) => field === "title" ? "Waterfowl harvest" : "",
    getCreators: () => [{ lastName: "Smith", firstName: "Jane" }]
  };
}

function menuHarness() {
  const elements = new Map<string, FakeElement>();
  const menu = new FakeElement(elements);
  const document = {
    getElementById: (id: string) => id === "zotero-itemmenu" ? menu : elements.get(id) ?? null,
    createXULElement: () => new FakeElement(elements)
  };
  return { document, elements, menu };
}

class FakeElement {
  id = "";
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();

  constructor(private readonly owner?: Map<string, FakeElement>) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.id) this.owner?.set(child.id, child);
    return child;
  }

  remove(): void {
    if (this.id) this.owner?.delete(this.id);
  }
}

describe("Find Copies command", () => {
  it("registers once and removes its item-menu entry during shutdown", () => {
    const harness = menuHarness();
    const command = new FindCopiesCommand({
      debug: () => undefined,
      getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
      getMainWindow: () => ({ document: harness.document } as unknown as Window),
      Libraries: { getAll: () => [] },
      Items: { getAll: async () => [], loadDataTypes: async () => undefined }
    });

    command.register();
    command.register();
    const entry = harness.elements.get("zotero-library-reconciler-find-copies");
    expect(entry?.attributes.get("label")).toBe("Find Copies in Other Libraries");
    expect(harness.elements.get("zotero-library-reconciler-audit")?.attributes.get("label")).toBe("Audit Cross-Library Coverage");
    expect(harness.elements).toHaveLength(2);

    command.unregister();
    expect(harness.elements).toHaveLength(0);
  });

  it("keeps menu entries per main window so closing one window does not strip the other", () => {
    // macOS lets the main window close and reopen; Zotero fires onMainWindowLoad/Unload per window.
    const first = menuHarness();
    const second = menuHarness();
    const command = new FindCopiesCommand({
      debug: () => undefined,
      getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
      getMainWindow: () => ({ document: first.document } as unknown as Window),
      Libraries: { getAll: () => [] },
      Items: { getAll: async () => [], loadDataTypes: async () => undefined }
    });
    const firstWindow = { document: first.document } as unknown as Window;
    const secondWindow = { document: second.document } as unknown as Window;

    command.register(firstWindow);
    command.register(secondWindow);
    expect(first.elements).toHaveLength(2);
    expect(second.elements).toHaveLength(2);

    command.unregister(firstWindow);
    expect(first.elements).toHaveLength(0);
    expect(second.elements).toHaveLength(2);

    command.unregister();
    expect(second.elements).toHaveLength(0);
  });

  it("shows an explicit selection instruction instead of scanning an ambiguous selection", async () => {
    const harness = menuHarness();
    const dialogs: { url: string; args: { title: string; text: string } }[] = [];
    const command = new FindCopiesCommand({
      debug: () => undefined,
      getActiveZoteroPane: () => ({ getSelectedItems: () => [selectedItem(), selectedItem()] }),
      getMainWindow: () => ({
        document: harness.document,
        openDialog: (url: string, _name: string, _features: string, args: { title: string; text: string }) => dialogs.push({ url, args })
      } as unknown as Window),
      Libraries: { getAll: () => [] },
      Items: { getAll: async () => [], loadDataTypes: async () => undefined }
    });

    await command.run();
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.url).toBe("chrome://zotero-library-reconciler/content/report.xhtml");
    expect(dialogs[0]?.args.text).toBe("Select one bibliographic item, then choose Find Copies in Other Libraries.");
  });

  it("persists the index after an audit and restores it at startup", async () => {
    const files = new Map<string, unknown>();
    const fs: SnapshotFileSystem = {
      exists: async (path) => files.has(path),
      readJSON: async (path) => files.get(path),
      writeJSON: async (path, value) => { files.set(path, JSON.parse(JSON.stringify(value))); },
      makeDirectory: async () => undefined
    };
    const store = IndexStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/"));
    const dialogs: string[] = [];
    const debug: string[] = [];
    const mine = { ...selectedItem(), getField: (field: string) => field === "title" ? "Waterfowl harvest" : field === "DOI" ? "10.1/x" : "" };
    const copy = { ...mine, libraryID: 2, key: "BBBB2222" };
    const zotero = {
      debug: (message: string) => debug.push(message),
      getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
      getMainWindow: () => ({ document: menuHarness().document, openDialog: (_u: string, _n: string, _f: string, args: { text: string }) => dialogs.push(args.text) } as unknown as Window),
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library", libraryType: "user", libraryVersion: 10 }, { libraryID: 2, name: "Group", libraryType: "group", libraryVersion: 3 }], userLibraryID: 1 },
      Items: { getAll: async (libraryID: number) => libraryID === 1 ? [mine] : [copy], loadDataTypes: async () => undefined }
    };

    const first = new FindCopiesCommand(zotero, { store, now: () => new Date("2026-09-17T12:00:00Z") });
    expect(await first.restoreIndex()).toBeUndefined();
    await first.runAudit();
    expect(dialogs[0]).toContain("Index of 1 works saved to /data/zotero-library-reconciler/index.json");
    expect(first.workLookup?.alsoIn(1, "AAAA1111")).toEqual(["Group"]);

    const second = new FindCopiesCommand(zotero, { store });
    const restored = await second.restoreIndex();
    expect(restored?.scannedAt).toBe("2026-09-17T12:00:00.000Z");
    expect(restored?.libraries).toEqual([{ libraryID: 1, name: "My Library", version: 10 }, { libraryID: 2, name: "Group", version: 3 }]);
    expect(second.workLookup?.alsoIn(2, "BBBB2222")).toEqual(["My Library"]);
    expect(debug.at(-1)).toContain("Restored index of 1 works");
    expect(debug.at(-1)).toContain("0 libraries have changed");
  });

  it("offers a rescan at startup when a library changed since the snapshot, and keeps the old index if declined", async () => {
    const snapshot = { schemaVersion: 1 as const, scannedAt: "2026-09-01T08:00:00.000Z", libraries: [{ libraryID: 1, name: "My Library", version: 10 }, { libraryID: 2, name: "Group", version: 3 }], works: [] };
    const files = new Map<string, unknown>([["/data/zotero-library-reconciler/index.json", snapshot]]);
    const fs: SnapshotFileSystem = {
      exists: async (path) => files.has(path), readJSON: async (path) => files.get(path),
      writeJSON: async (path, value) => { files.set(path, JSON.parse(JSON.stringify(value))); }, makeDirectory: async () => undefined
    };
    const store = IndexStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/"));
    const prompts: string[] = [];
    const dialogs: string[] = [];
    let answer = false;
    const zotero = {
      debug: () => undefined,
      getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
      getMainWindow: () => ({ document: menuHarness().document, openDialog: (_u: string, _n: string, _f: string, args: { text: string }) => dialogs.push(args.text) } as unknown as Window),
      Libraries: { getAll: () => [{ libraryID: 1, name: "My Library", libraryType: "user", libraryVersion: 10 }, { libraryID: 2, name: "Group", libraryType: "group", libraryVersion: 4 }], userLibraryID: 1 },
      Items: { getAll: async () => [], loadDataTypes: async () => undefined }
    };
    const options = { store, now: () => new Date("2026-09-17T12:00:00Z"), confirmRescan: (message: string) => { prompts.push(message); return answer; } };

    await new FindCopiesCommand(zotero, options).restoreIndex();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("2026-09-01 08:00:00 UTC");
    expect(prompts[0]).toContain("this library has changed: Group");
    expect(dialogs).toHaveLength(0);
    expect((files.get(store.location) as { scannedAt: string }).scannedAt).toBe("2026-09-01T08:00:00.000Z");

    answer = true;
    await new FindCopiesCommand(zotero, options).restoreIndex();
    expect(dialogs).toHaveLength(1);
    expect((files.get(store.location) as { scannedAt: string }).scannedAt).toBe("2026-09-17T12:00:00.000Z");

    prompts.length = 0;
    await new FindCopiesCommand(zotero, options).restoreIndex();
    expect(prompts).toHaveLength(0);
  });
});
