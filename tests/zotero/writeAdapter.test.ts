import { describe, expect, it } from "vitest";
import type { RecordCreator } from "../../src/comparison/differenceEngine.js";
import { sameValue, zoteroWriteAPI, type ZoteroWritableItem, type ZoteroWriteAPI } from "../../src/zotero/writeAdapter.js";

const MY = 1;
const GROUP = 2;
const JOURNAL_ARTICLE = 4;
const BOOK_SECTION = 5;

/** A Zotero item with just enough behaviour: fields valid for its type, setField throws otherwise. */
function fakeItem(libraryID: number, key: string, fields: Record<string, string>, creators: RecordCreator[] = [], itemTypeID = JOURNAL_ARTICLE) {
  const log: string[] = [];
  const state = { fields: { ...fields }, creators: [...creators], deleted: false };
  const item = {
    id: libraryID * 100 + key.length, libraryID, key, version: 7, itemTypeID,
    get deleted() { return state.deleted; },
    loadAllData: async () => undefined,
    getField: (name: string) => state.fields[name] ?? "",
    setField: (name: string, value: string) => {
      if (!(name in state.fields)) throw new Error(`'${name}' is not a valid field for type`);
      // Zotero strips newlines from single-line fields.
      state.fields[name] = name === "abstractNote" ? value : value.replace(/[\r\n]+/g, " ");
      log.push(`set:${name}`);
      return true;
    },
    getCreatorsJSON: () => state.creators,
    setCreators: (next: readonly RecordCreator[], options?: { strict?: boolean }) => { log.push(`creators:strict=${options?.strict}`); state.creators = [...next]; },
    save: async (options?: unknown) => { log.push(`save:${JSON.stringify(options)}`); },
  } as unknown as ZoteroWritableItem;
  return { item, state, log };
}

function harness(items: ReturnType<typeof fakeItem>[], hooks: { duringTransaction?: () => void } = {}) {
  const events: string[] = [];
  let inTransaction = false;
  const zotero = {
    Libraries: { userLibraryID: MY, get: () => false },
    Items: { getByLibraryAndKey: (libraryID: number, key: string) => items.find(({ item }) => item.libraryID === libraryID && item.key === key)?.item ?? false, trashTx: async () => undefined },
    Collections: { getByLibrary: () => [], getByParent: () => [] },
    Collection: class {},
    DB: {
      executeTransaction: async <T>(fn: () => Promise<T>) => {
        inTransaction = true; events.push("begin");
        hooks.duringTransaction?.();
        try { return await fn(); } finally { inTransaction = false; events.push("commit"); }
      }
    },
    ItemFields: {
      getID: (field: string) => ({ title: 1, issue: 2, bookTitle: 3, publicationTitle: 4, extra: 5, citationKey: 6 } as Record<string, number>)[field] ?? false,
      getName: (id: number) => ({ 4: "publicationTitle", 3: "bookTitle" } as Record<number, string>)[id] ?? false,
      getBaseIDFromTypeAndField: (_type: number, field: string) => field === "bookTitle" ? 4 : false
    }
  } as unknown as ZoteroWriteAPI;
  return { api: zoteroWriteAPI(zotero), events, inTransaction: () => inTransaction };
}

describe("updateFields — compare-and-swap inside one transaction (Phase 4 §6, invariant 5)", () => {
  it("writes every field and saves once with Zotero's Edit Metadata undo label", async () => {
    const target = fakeItem(MY, "MINE", { issue: "", title: "Waterfowl" });
    const result = await harness([target]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "issue", expected: "", next: "4" }], []);
    expect(result.status).toBe("written");
    expect(target.state.fields.issue).toBe("4");
    expect(target.log.filter((line) => line.startsWith("save"))).toEqual([`save:${JSON.stringify({ skipSelect: true, undoAction: "undo-action-edit-metadata", undoActionArgs: { count: 1 } })}`]);
  });

  it("a target field edited since the preview → nothing written, and the report names the field", async () => {
    const target = fakeItem(MY, "MINE", { issue: "3", title: "Waterfowl" });
    const result = await harness([target]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "title", expected: "Waterfowl", next: "Waterfowl harvest" }, { name: "issue", expected: "", next: "4" }], []);
    expect(result).toMatchObject({ status: "target-changed" });
    expect(result.detail).toContain("issue");
    expect(target.state.fields).toEqual({ issue: "3", title: "Waterfowl" });
    expect(target.log).toEqual([]);
  });

  it("the re-check runs inside the transaction: an edit landing as it opens is still caught", async () => {
    const target = fakeItem(MY, "MINE", { issue: "" });
    const { api } = harness([target], { duringTransaction: () => { target.state.fields.issue = "9"; } });
    const result = await api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "issue", expected: "", next: "4" }], []);
    expect(result.status).toBe("target-changed");
    expect(target.state.fields.issue).toBe("9");
  });

  it("a source value changed since the preview → nothing written, so the log never names a source that no longer says so", async () => {
    const target = fakeItem(MY, "MINE", { issue: "" });
    const source = fakeItem(GROUP, "SRC", { issue: "5" });
    const result = await harness([target, source]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "issue", expected: "", next: "4" }], [{ ref: { libraryID: GROUP, itemKey: "SRC" }, name: "issue", expected: "4" }]);
    expect(result.status).toBe("source-changed");
    expect(target.state.fields.issue).toBe("");
  });

  it("a trashed source → source-changed", async () => {
    const target = fakeItem(MY, "MINE", { issue: "" });
    const source = fakeItem(GROUP, "SRC", { issue: "4" });
    source.state.deleted = true;
    const result = await harness([target, source]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "issue", expected: "", next: "4" }], [{ ref: { libraryID: GROUP, itemKey: "SRC" }, name: "issue", expected: "4" }]);
    expect(result.status).toBe("source-changed");
  });

  it("returns the value Zotero actually stored, so a later undo compares against the truth", async () => {
    const target = fakeItem(MY, "MINE", { title: "" });
    const result = await harness([target]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "title", expected: "", next: "Waterfowl\nharvest" }], []);
    expect(result.stored).toEqual({ title: "Waterfowl harvest" });
  });

  it("creators are written with strict creator types (an editor must never become an author)", async () => {
    const target = fakeItem(MY, "MINE", {}, []);
    const next = [{ creatorType: "author", lastName: "Smith", firstName: "Jane" }];
    await harness([target]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "creators", expected: [], next }], []);
    expect(target.log[0]).toBe("creators:strict=true");
    expect(target.state.creators).toEqual(next);
  });
});

describe("updateFields — hard limits enforced in the adapter, not just the UI (invariant 1)", () => {
  it("refuses a target outside My Library before reading anything", async () => {
    const group = fakeItem(GROUP, "SRC", { issue: "" });
    await expect(harness([group]).api.updateFields({ libraryID: GROUP, itemKey: "SRC" }, [{ name: "issue", expected: "", next: "4" }], [])).rejects.toThrow("My Library");
    expect(group.log).toEqual([]);
  });

  it.each(["extra", "citationKey", "itemType", "dateAdded"])("refuses to write %s", async (name) => {
    const target = fakeItem(MY, "MINE", { [name]: "" });
    await expect(harness([target]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name, expected: "", next: "x" }], [])).rejects.toThrow("not reconcilable");
    expect(target.log).toEqual([]);
  });

  it("accepts a type-specific field whose base field is reconcilable (bookTitle → publicationTitle)", async () => {
    const target = fakeItem(MY, "MINE", { bookTitle: "" }, [], BOOK_SECTION);
    const result = await harness([target]).api.updateFields({ libraryID: MY, itemKey: "MINE" }, [{ name: "bookTitle", expected: "", next: "Waterfowl Management" }], []);
    expect(result.status).toBe("written");
  });

  it("a missing or trashed target is reported, not thrown", async () => {
    const result = await harness([]).api.updateFields({ libraryID: MY, itemKey: "GONE" }, [{ name: "issue", expected: "", next: "4" }], []);
    expect(result.status).toBe("target-missing");
  });
});

describe("sameValue — exact, not normalized: the check guards what the user saw", () => {
  it("strings compare exactly", () => {
    expect(sameValue("1021-1034", "1021–1034")).toBe(false);
  });

  it("creator lists ignore absent-vs-empty name parts but not order or type", () => {
    const a: RecordCreator[] = [{ creatorType: "author", lastName: "Smith", firstName: "" }];
    const b: RecordCreator[] = [{ creatorType: "author", lastName: "Smith" }];
    expect(sameValue(a, b)).toBe(true);
    expect(sameValue(a, [{ creatorType: "editor", lastName: "Smith" }])).toBe(false);
  });
});
