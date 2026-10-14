import { describe, expect, it } from "vitest";
import { auditCrossLibraries } from "../../src/audit/crossLibraryAudit.js";
import type { ScannedItem } from "../../src/matching/types.js";
import { createSnapshot, isIndexSnapshot, staleLibraries, WorkLookup } from "../../src/works/indexSnapshot.js";

const item = (libraryID: number, itemKey: string, title: string, doi?: string): ScannedItem => ({
  ref: { libraryID, libraryName: `L${libraryID}`, itemKey, version: 7 },
  itemType: "journalArticle", fields: { title, date: "2024", ...(doi ? { doi } : {}) }, creators: [{ lastName: "Smith", firstName: "Jane" }]
});
const libraries = [{ libraryID: 1, name: "My Library", version: 100 }, { libraryID: 2, name: "Group", version: 55 }, { libraryID: 3, name: "Other", version: 9 }];
const audit = auditCrossLibraries([item(1, "A", "Mallard harvest", "10.1/a"), item(2, "B", "Mallard harvest", "10.1/a"), item(3, "C", "Goose harvest")], 1);
const snapshot = createSnapshot(audit, libraries, new Date("2026-09-17T12:00:00Z"));

describe("index snapshot (§10 derived data, §32 plugin-owned storage)", () => {
  it("stores references and versions only — no bibliographic fields — so it is always rebuildable", () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.scannedAt).toBe("2026-09-17T12:00:00.000Z");
    expect(JSON.stringify(snapshot)).not.toContain("Mallard");
    const work = snapshot.works.find((entry) => entry.items.length === 2)!;
    expect(work.items).toEqual([{ libraryID: 1, itemKey: "A", version: 7 }, { libraryID: 2, itemKey: "B", version: 7 }]);
    expect(work.confidence).toBe("exact");
    expect(work.canonical).toEqual({ libraryID: 1, itemKey: "A", version: 7 });
    expect(isIndexSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
    expect(isIndexSnapshot({ schemaVersion: 2 })).toBe(false);
  });

  it("answers 'also in' with the other libraries holding the work, and nothing for unique or unknown items", () => {
    const lookup = new WorkLookup(snapshot);
    expect(lookup.alsoIn(1, "A")).toEqual(["Group"]);
    expect(lookup.alsoIn(2, "B")).toEqual(["My Library"]);
    expect(lookup.alsoIn(3, "C")).toEqual([]);
    expect(lookup.alsoIn(9, "ZZZZ")).toEqual([]);
  });

  it("flags libraries whose version moved, plus libraries added or removed since the scan", () => {
    expect(staleLibraries(snapshot, libraries)).toEqual([]);
    const current = [{ libraryID: 1, name: "My Library", version: 101 }, { libraryID: 2, name: "Group", version: 55 }, { libraryID: 4, name: "New", version: 1 }];
    expect(staleLibraries(snapshot, current).map((library) => library.libraryID)).toEqual([1, 4, 3]);
  });

  it("an unsynced local edit leaves the sync version alone but moves the fingerprint → stale (same root cause as §40)", () => {
    const withPrint = createSnapshot(audit, libraries.map((library) => ({ ...library, localChange: "10|2026-10-14 14:00:00" })), new Date("2026-10-14T14:00:00Z"));
    const edited = libraries.map((library) => ({ ...library, localChange: library.libraryID === 1 ? "10|2026-10-14 14:34:55" : "10|2026-10-14 14:00:00" }));
    expect(staleLibraries(withPrint, edited).map((library) => library.libraryID)).toEqual([1]);
    expect(staleLibraries(withPrint, libraries.map((library) => ({ ...library, localChange: "10|2026-10-14 14:00:00" })))).toEqual([]);
  });

  it("a snapshot written before fingerprints existed cannot prove it is current → stale once", () => {
    expect(staleLibraries(snapshot, libraries.map((library) => ({ ...library, localChange: "1|x" }))).map((library) => library.libraryID)).toEqual([1, 2, 3]);
  });

  it("no fingerprint available now (e.g. no DB access) → falls back to the version check alone", () => {
    expect(staleLibraries(snapshot, libraries)).toEqual([]);
  });
});
