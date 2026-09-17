import { describe, expect, it } from "vitest";
import { IndexStore, type SnapshotFileSystem } from "../../src/zotero/indexStore.js";
import type { IndexSnapshot } from "../../src/works/indexSnapshot.js";

function fakeFs(files: Map<string, unknown> = new Map()) {
  const directories: string[] = [];
  const fs: SnapshotFileSystem = {
    exists: async (path) => files.has(path),
    readJSON: async (path) => { const value = files.get(path); if (value === "CORRUPT") throw new SyntaxError("Unexpected token"); return value; },
    writeJSON: async (path, value, options) => { expect(options?.tmpPath).toBe(`${path}.tmp`); files.set(path, JSON.parse(JSON.stringify(value))); },
    makeDirectory: async (path) => { directories.push(path); }
  };
  return { fs, files, directories };
}
const snapshot: IndexSnapshot = { schemaVersion: 1, scannedAt: "2026-09-17T12:00:00.000Z", libraries: [], works: [] };

describe("index store", () => {
  it("writes one JSON file in a plugin-owned folder under the data directory, atomically", async () => {
    const { fs, files, directories } = fakeFs();
    const store = IndexStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/"));
    expect(store.location).toBe("/data/zotero-library-reconciler/index.json");
    await store.save(snapshot);
    expect(directories).toEqual(["/data/zotero-library-reconciler"]);
    expect(files.get(store.location)).toEqual(snapshot);
    expect(await store.load()).toEqual(snapshot);
  });

  it("treats a missing, corrupt, or foreign file as no index rather than failing startup", async () => {
    const { fs, files } = fakeFs();
    const store = IndexStore.inDataDirectory(fs, "/data", (...parts) => parts.join("/"));
    expect(await store.load()).toBeUndefined();
    files.set(store.location, "CORRUPT");
    expect(await store.load()).toBeUndefined();
    files.set(store.location, { schemaVersion: 99 });
    expect(await store.load()).toBeUndefined();
  });
});
