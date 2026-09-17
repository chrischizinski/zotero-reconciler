import { parseLog, serializeLog, type ImportLogEntry, type LogEntry } from "../write/transactionLog.js";

/** The subset of Gecko's `IOUtils` the store needs; injected so tests need no filesystem. */
export interface LogFileSystem {
  readUTF8(path: string): Promise<string>;
  writeUTF8(path: string, text: string, options?: { mode?: "overwrite" | "append"; tmpPath?: string }): Promise<unknown>;
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
    await this.fs.writeUTF8(this.path, `${JSON.stringify(entry)}\n`, { mode: "append" });
  }

  /** Malformed lines are counted and skipped, never thrown: the log must stay readable after any single bad write. */
  async readAll(): Promise<{ entries: LogEntry[]; malformed: number }> {
    if (!(await this.fs.exists(this.path))) return { entries: [], malformed: 0 };
    return parseLog(await this.fs.readUTF8(this.path));
  }

  /** Rewrites the one import entry that an undo reversed; the only non-append write, on a small file, via a temp path. */
  async markUndone(importID: string, undoneAt: string): Promise<void> {
    const { entries } = await this.readAll();
    const updated = entries.map((entry) => (entry.action === "import" && entry.id === importID ? { ...entry, undoneAt } satisfies ImportLogEntry : entry));
    await this.fs.writeUTF8(this.path, serializeLog(updated), { mode: "overwrite", tmpPath: `${this.path}.tmp` });
  }
}
