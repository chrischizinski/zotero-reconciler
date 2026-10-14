import { describe, expect, it } from "vitest";
import type { RecordCreator } from "../../src/comparison/differenceEngine.js";
import { sameValue, zoteroWriteAPI, type ZoteroWritableItem, type ZoteroWriteAPI } from "../../src/zotero/writeAdapter.js";

const MY = 1;
const GROUP = 2;
const JOURNAL_ARTICLE = 4;
const BOOK_SECTION = 5;

/** A Zotero item with just enough behaviour: fields valid for its type, setField throws otherwise. */
function fakeItem(libraryID: number, key: string, fields: Record<string, string>, creators: RecordCreator[] = [], itemTypeID = JOURNAL_ARTICLE, relations: string[] = []) {
  const log: string[] = [];
  const state = { fields: { ...fields }, creators: [...creators], deleted: false, relations: [...relations] };
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
    getRelationsByPredicate: (predicate: string) => (predicate === "owl:sameAs" ? [...state.relations] : []),
    removeRelation: (predicate: string, object: string) => { log.push(`remove:${predicate}:${object}`); state.relations = state.relations.filter((uri) => uri !== object); return true; },
    addRelation: (predicate: string, object: string) => { log.push(`add:${predicate}:${object}`); state.relations.push(object); return true; },
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
    URI: { getURIItemLibraryKey: (uri: string) => { const match = /groups\/(\d+)\/items\/(\w+)$/.exec(uri); return match ? { libraryID: Number(match[1]), key: match[2]! } : false; } },
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

describe("updateFieldsBatch — one transaction per chunk, each item re-checked on its own (slice 3)", () => {
  const issue = (key: string) => ({ target: { libraryID: MY, itemKey: key }, writes: [{ name: "issue", expected: "", next: "4" }], checks: [] });

  it("one stale item is skipped whole; the others in the chunk are still written, in one transaction", async () => {
    const a = fakeItem(MY, "A", { issue: "" });
    const stale = fakeItem(MY, "BB", { issue: "3" });
    const c = fakeItem(MY, "CCC", { issue: "" });
    const { api, events } = harness([a, stale, c]);
    const results = await api.updateFieldsBatch([issue("A"), issue("BB"), issue("CCC")]);
    expect(results.map((result) => result.status)).toEqual(["written", "target-changed", "written"]);
    expect([a.state.fields.issue, stale.state.fields.issue, c.state.fields.issue]).toEqual(["4", "3", "4"]);
    expect(stale.log).toEqual([]);
    expect(events).toEqual(["begin", "commit"]);
  });

  it("every save carries the count of items the single ⌘Z step covers (Zotero keeps the last label of a transaction)", async () => {
    const items = [fakeItem(MY, "A", { issue: "" }), fakeItem(MY, "BB", { issue: "9" }), fakeItem(MY, "CCC", { issue: "" })];
    await harness(items).api.updateFieldsBatch([issue("A"), issue("BB"), issue("CCC")]);
    const saves = items.flatMap(({ log }) => log.filter((line) => line.startsWith("save")));
    expect(saves).toEqual(Array(2).fill(`save:${JSON.stringify({ skipSelect: true, undoAction: "undo-action-edit-metadata", undoActionArgs: { count: 2 } })}`));
  });

  it("one target outside My Library anywhere in the chunk → throws before anything is written", async () => {
    const a = fakeItem(MY, "A", { issue: "" });
    const group = fakeItem(GROUP, "SRC", { issue: "" });
    const { api, events } = harness([a, group]);
    await expect(api.updateFieldsBatch([issue("A"), { ...issue("SRC"), target: { libraryID: GROUP, itemKey: "SRC" } }])).rejects.toThrow("My Library");
    expect(a.log).toEqual([]);
    expect(events).toEqual([]);
  });

  it("one disallowed field anywhere in the chunk → throws before anything is written", async () => {
    const a = fakeItem(MY, "A", { issue: "" });
    const b = fakeItem(MY, "BB", { extra: "" });
    const { api, events } = harness([a, b]);
    await expect(api.updateFieldsBatch([issue("A"), { target: { libraryID: MY, itemKey: "BB" }, writes: [{ name: "extra", expected: "", next: "x" }], checks: [] }])).rejects.toThrow("not reconcilable");
    expect(a.log).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a missing item is reported in its slot, not thrown", async () => {
    const a = fakeItem(MY, "A", { issue: "" });
    const results = await harness([a]).api.updateFieldsBatch([issue("GONE"), issue("A")]);
    expect(results.map((result) => result.status)).toEqual(["target-missing", "written"]);
  });
});

describe("removeLinkedRelations / restoreLinkedRelations — one owl:sameAs on a My Library item (docs/stale-link-removal.md)", () => {
  const GROUP_URI = "http://zotero.org/groups/2/items/SRC";
  const OTHER_URI = "http://zotero.org/groups/3/items/KEEP";
  const removal = { target: { libraryID: MY, itemKey: "MINE" }, linked: { libraryID: GROUP, itemKey: "SRC" } };

  it("removes exactly that relation, saved like Zotero saves links, and returns the URI for the undo", async () => {
    const target = fakeItem(MY, "MINE", { title: "Mine" }, [], JOURNAL_ARTICLE, [GROUP_URI, OTHER_URI]);
    const source = fakeItem(GROUP, "SRC", { title: "Theirs" });
    const { api, events } = harness([target, source]);
    expect(await api.removeLinkedRelations([removal])).toEqual([{ status: "removed", uri: GROUP_URI }]);
    expect(target.state.relations).toEqual([OTHER_URI]);
    expect(target.state.fields).toEqual({ title: "Mine" });
    expect(target.log).toEqual([`remove:owl:sameAs:${GROUP_URI}`, `save:${JSON.stringify({ skipSelect: true, skipDateModifiedUpdate: true, undoAction: "undo-action-edit-metadata", undoActionArgs: { count: 1 } })}`]);
    expect(source.log).toEqual([]);
    expect(events).toEqual(["begin", "commit"]);
  });

  it("a link already gone (or never on this side) → link-missing, nothing saved", async () => {
    const target = fakeItem(MY, "MINE", {}, [], JOURNAL_ARTICLE, [OTHER_URI]);
    const results = await harness([target]).api.removeLinkedRelations([removal]);
    expect(results[0]?.status).toBe("link-missing");
    expect(target.log).toEqual([]);
  });

  it("refuses a group target before anything is read", async () => {
    const group = fakeItem(GROUP, "SRC", {}, [], JOURNAL_ARTICLE, ["http://zotero.org/users/1/items/MINE"]);
    const { api, events } = harness([group]);
    await expect(api.removeLinkedRelations([{ target: { libraryID: GROUP, itemKey: "SRC" }, linked: { libraryID: MY, itemKey: "MINE" } }])).rejects.toThrow("My Library");
    expect(events).toEqual([]);
  });

  it("restore re-adds the exact URI only if absent: never a duplicate relation", async () => {
    const absent = fakeItem(MY, "MINE", {}, [], JOURNAL_ARTICLE, []);
    const present = fakeItem(MY, "BACK", {}, [], JOURNAL_ARTICLE, [GROUP_URI]);
    const statuses = await harness([absent, present]).api.restoreLinkedRelations([{ target: { libraryID: MY, itemKey: "MINE" }, uri: GROUP_URI }, { target: { libraryID: MY, itemKey: "BACK" }, uri: GROUP_URI }]);
    expect(statuses).toEqual(["restored", "already-present"]);
    expect(absent.state.relations).toEqual([GROUP_URI]);
    expect(present.state.relations).toEqual([GROUP_URI]);
    expect(present.log).toEqual([]);
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
