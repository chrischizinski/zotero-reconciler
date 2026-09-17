import { describe, expect, it } from "vitest";
import { CoverageColumn, PLUGIN_ID, type ItemTreeColumnOption, type ItemTreeManagerAPI } from "../../src/zotero/coverageColumn.js";
import { WorkLookup, type IndexSnapshot } from "../../src/works/indexSnapshot.js";

const snapshot: IndexSnapshot = {
  schemaVersion: 1, scannedAt: "2026-09-17T12:00:00.000Z",
  libraries: [{ libraryID: 1, name: "My Library", version: 1 }, { libraryID: 2, name: "hdfw-book", version: 1 }, { libraryID: 3, name: "creel", version: 1 }],
  works: [{ id: "w", canonical: { libraryID: 1, itemKey: "A", version: 1 }, items: [{ libraryID: 1, itemKey: "A", version: 1 }, { libraryID: 2, itemKey: "B", version: 1 }, { libraryID: 3, itemKey: "C", version: 1 }] }]
};

function fakeManager() {
  const registered: ItemTreeColumnOption[] = [];
  const unregistered: string[] = [];
  let refreshes = 0;
  const manager: ItemTreeManagerAPI = {
    registerColumn: (option) => { registered.push(option); return `${option.pluginID}-${option.dataKey}`; },
    unregisterColumn: (key) => { unregistered.push(key); return true; },
    refreshColumns: () => { refreshes += 1; }
  };
  return { manager, registered, unregistered, refreshes: () => refreshes };
}

describe("Also in column (read-only coverage view)", () => {
  it("registers once in the main tree under the plugin ID and unregisters with the returned key", () => {
    const { manager, registered, unregistered } = fakeManager();
    const column = new CoverageColumn(manager, () => undefined);
    column.register();
    column.register();
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ dataKey: "alsoIn", label: "Also in", pluginID: PLUGIN_ID, enabledTreeIDs: ["main"] });
    column.unregister();
    expect(unregistered).toEqual([`${PLUGIN_ID}-alsoIn`]);
  });

  it("shows the other libraries holding the item's work, and nothing before an audit or for non-bibliographic rows", () => {
    let lookup: WorkLookup | undefined;
    const { manager } = fakeManager();
    const column = new CoverageColumn(manager, () => lookup);
    const row = (libraryID: number, key: string, regular = true) => ({ libraryID, key, isRegularItem: () => regular });
    expect(column.cellText(row(1, "A"))).toBe("");
    lookup = new WorkLookup(snapshot);
    expect(column.cellText(row(1, "A"))).toBe("creel, hdfw-book");
    expect(column.cellText(row(2, "B"))).toBe("My Library, creel");
    expect(column.cellText(row(1, "ZZZZ"))).toBe("");
    expect(column.cellText(row(1, "A", false))).toBe("");
  });

  it("repaints only when registered", () => {
    const { manager, refreshes } = fakeManager();
    const column = new CoverageColumn(manager, () => undefined);
    column.refresh();
    expect(refreshes()).toBe(0);
    column.register();
    column.refresh();
    expect(refreshes()).toBe(1);
  });
});
