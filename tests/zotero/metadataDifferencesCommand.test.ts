import { describe, expect, it } from "vitest";
import type { RecordCreator } from "../../src/comparison/differenceEngine.js";
import { MetadataDifferencesCommand, type DifferencesActions, type DifferencesWindowModel } from "../../src/zotero/metadataDifferencesCommand.js";
import type { ZoteroItem } from "../../src/zotero/adapter.js";

const MY = 1;
const GROUP = 2;
const DOI = "10.1002/jwmg.12345";
const FIELD_IDS: Record<string, number> = { title: 1, issue: 2, DOI: 3, date: 4 };

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

function harness(compare?: (item: ZoteroItem) => Promise<string>) {
  const events: string[] = [];
  const items = [
    zoteroItem(MY, "MINE0001", { title: "Waterfowl harvest", DOI, issue: "", date: "2024" }),
    zoteroItem(GROUP, "GRP00001", { title: "Waterfowl harvest", DOI, issue: "4", date: "2024" }),
    // Identical copies: compared, not listed.
    zoteroItem(MY, "MINE0002", { title: "Duck banding", DOI: "10.1/duck", issue: "2", date: "2020" }),
    zoteroItem(GROUP, "GRP00002", { title: "Duck banding", DOI: "10.1/duck", issue: "2", date: "2020" })
  ];
  const zotero = {
    debug: (message: string) => { events.push(`debug:${message}`); },
    getMainWindow: () => ({ document: { getElementById: () => null } } as unknown as Window),
    getActiveZoteroPane: () => ({ selectItem: async (id: number, options?: { inLibraryRoot?: boolean }) => { events.push(`select:${id}:${options?.inLibraryRoot}`); } }),
    Libraries: { userLibraryID: MY, getAll: () => [{ libraryID: MY, name: "My Library", libraryType: "user" }, { libraryID: GROUP, name: "Textbook", libraryType: "group" }] },
    Items: {
      getAll: async (libraryID: number) => items.filter((item) => item.libraryID === libraryID),
      loadDataTypes: async () => undefined,
      getByLibraryAndKey: (libraryID: number, key: string) => items.find((item) => item.libraryID === libraryID && item.key === key) ?? false,
      getIDFromLibraryAndKey: (libraryID: number, key: string) => items.findIndex((item) => item.libraryID === libraryID && item.key === key) + 100
    },
    URI: { getURIItemLibraryKey: () => false as const },
    ItemFields: { getID: (field: string) => FIELD_IDS[field] ?? false, getName: () => false as const, isValidForType: (id: number) => Object.values(FIELD_IDS).includes(id), getFieldIDFromTypeAndBase: () => false as const },
    CreatorTypes: { getTypesForItemType: () => [{ id: 1, name: "author" }] }
  };
  let opened: { model: DifferencesWindowModel; actions: DifferencesActions } | undefined;
  const command = new MetadataDifferencesCommand(zotero, {
    ...(compare ? { compare } : {}),
    openWindow: (model, actions) => { opened = { model, actions }; },
    show: (text) => { events.push(`show:${text}`); }
  });
  return { command, events, opened: () => opened };
}

describe("Metadata Differences command — read-only report over strong matches", () => {
  it("lists only items with something to offer; identical copies are counted but not listed", async () => {
    const { command, opened } = harness();
    const report = await command.run();
    expect(report?.compared).toBe(2);
    expect(opened()?.model.rows.map((row) => [row.itemKey, row.counts])).toEqual([["MINE0001", "1 missing · 0 different · 0 conflicting"]]);
  });

  it("without the Phase 4 write path there is no Compare action — the report cannot lead to a write", async () => {
    const { command, opened } = harness();
    await command.run();
    expect(opened()?.actions.compare).toBeUndefined();
    expect(opened()?.model.summary).toContain("Read-only");
  });

  it("Show selects the My Library item in its library root", async () => {
    const { command, events, opened } = harness();
    await command.run();
    opened()?.actions.select("MINE0001");
    expect(events).toContain("select:100:true");
  });

  it("Compare hands the My Library item to Compare Copies and shows its status", async () => {
    const compared: string[] = [];
    const { command, opened } = harness(async (item) => { compared.push(`${item.libraryID}:${item.key}`); return "Updated 1 field."; });
    await command.run();
    expect(await opened()?.actions.compare?.("MINE0001")).toBe("Updated 1 field.");
    expect(compared).toEqual(["1:MINE0001"]);
  });
});
