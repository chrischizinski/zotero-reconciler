import { parseLog, serializeLog, type LogEntry } from "../write/transactionLog.js";

/** The subset of Gecko's `IOUtils` the store needs; injected so tests need no filesystem. */
export interface LogFileSystem {
  readUTF8(path: string): Promise<string>;
  writeUTF8(path: string, text: string, options?: { mode?: "overwrite" | "appendOrCreate"; tmpPath?: string }): Promise<unknown>;
  makeDirectory(path: string, options?: { ignoreExisting?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * §26 transaction log: `<dataDir>/zotero-library-reconciler/transactions.jsonl`, append-only.
 * Same plugin-owned folder as the index; never touches zotero.sqlite. Appending is one write
 * of one line, so a crash mid-session loses at most the entry being written, never earlier ones.
 */
export class TransactionStore {
  constructor(private readonly fs: LogFileSystem, private readonly directory: string, private readonly path: string) {}

  static inDataDirectory(fs: LogFileSystem, dataDirectory: string, join: (...parts: string[]) => string): TransactionStore {
    const directory = join(dataDirectory, "zotero-library-reconciler");
    return new TransactionStore(fs, directory, join(directory, "transactions.jsonl"));
  }

  get location(): string {
    return this.path;
  }

  async append(entry: LogEntry): Promise<void> {
    await this.fs.makeDirectory(this.directory, { ignoreExisting: true });
    // "append" fails with NS_ERROR_FILE_NOT_FOUND on a missing file (seen live 2026-09-18); "appendOrCreate" creates it.
    await this.fs.writeUTF8(this.path, `${JSON.stringify(entry)}\n`, { mode: "appendOrCreate" });
  }

  /** Several entries in ONE write, so a session's log lands whole or (on a failed write) not at all. */
  async appendAll(entries: readonly LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.fs.makeDirectory(this.directory, { ignoreExisting: true });
    await this.fs.writeUTF8(this.path, serializeLog(entries), { mode: "appendOrCreate" });
  }

  /** Malformed lines are counted and skipped, never thrown: the log must stay readable after any single bad write. */
  async readAll(): Promise<{ entries: LogEntry[]; malformed: number }> {
    if (!(await this.fs.exists(this.path))) return { entries: [], malformed: 0 };
    return parseLog(await this.fs.readUTF8(this.path));
  }

  /** Rewrites the import, metadata or link entries that an undo reversed; the only non-append write, on a small file, via a temp path. */
  async markUndone(entryIDs: string | readonly string[], undoneAt: string): Promise<void> {
    const ids = new Set(typeof entryIDs === "string" ? [entryIDs] : entryIDs);
    const { entries } = await this.readAll();
    const updated = entries.map((entry) => ((entry.action === "import" || entry.action === "update_metadata" || entry.action === "remove_link") && ids.has(entry.id) ? { ...entry, undoneAt } : entry));
    await this.fs.writeUTF8(this.path, serializeLog(updated), { mode: "overwrite", tmpPath: `${this.path}.tmp` });
  }
}
