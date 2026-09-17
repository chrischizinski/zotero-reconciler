import { isIndexSnapshot, type IndexSnapshot } from "../works/indexSnapshot.js";

/** The subset of Gecko's `IOUtils` the store needs; injected so tests need no filesystem. */
export interface SnapshotFileSystem {
  readJSON(path: string): Promise<unknown>;
  writeJSON(path: string, value: unknown, options?: { tmpPath?: string }): Promise<unknown>;
  makeDirectory(path: string, options?: { ignoreExisting?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * Persists the index as one JSON file under the Zotero data directory, in a plugin-owned
 * folder (§32). Never touches zotero.sqlite.
 */
export class IndexStore {
  constructor(private readonly fs: SnapshotFileSystem, private readonly directory: string, private readonly path: string) {}

  static inDataDirectory(fs: SnapshotFileSystem, dataDirectory: string, join: (...parts: string[]) => string): IndexStore {
    const directory = join(dataDirectory, "zotero-library-reconciler");
    return new IndexStore(fs, directory, join(directory, "index.json"));
  }

  get location(): string {
    return this.path;
  }

  /** Returns undefined when absent or unreadable; a corrupt snapshot is treated as absent, never thrown. */
  async load(): Promise<IndexSnapshot | undefined> {
    if (!(await this.fs.exists(this.path))) return undefined;
    try {
      const value = await this.fs.readJSON(this.path);
      return isIndexSnapshot(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async save(snapshot: IndexSnapshot): Promise<void> {
    await this.fs.makeDirectory(this.directory, { ignoreExisting: true });
    await this.fs.writeJSON(this.path, snapshot, { tmpPath: `${this.path}.tmp` });
  }
}
