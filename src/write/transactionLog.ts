import type { ImportOutcome } from "./importExecutor.js";
import type { WriteItemRef } from "./writeApi.js";

/**
 * §26 transaction log entries for Phase 3, as data. Append-only JSONL on disk
 * (`src/zotero/transactionStore.ts`). Native undo does not cover item creation (§27
 * correction), so this log is the undo mechanism: "undo this session" trashes every
 * `created` ref of an import entry.
 */

export interface LoggedRow {
  source: { libraryID: number; itemKey: string; version: number; title: string };
  created?: WriteItemRef;
  skipped?: string;
  failed?: string;
}

export interface ImportLogEntry {
  id: string;
  action: "import";
  confirmedAt: string;
  target: { libraryID: number; collectionKey?: string };
  rows: readonly LoggedRow[];
  totals: ImportOutcome["totals"];
  /** Set (by rewriting this line) when an `undo` entry reverses it. */
  undoneAt?: string;
}

export interface UndoLogEntry {
  id: string;
  action: "undo";
  /** The import entry reversed. */
  reverses: string;
  at: string;
  trashed: readonly WriteItemRef[];
}

export type LogEntry = ImportLogEntry | UndoLogEntry;

export function importLogEntry(outcome: ImportOutcome, id: string): ImportLogEntry {
  const { plan } = outcome;
  return {
    id,
    action: "import",
    confirmedAt: plan.confirmedAt ?? "",
    target: { libraryID: plan.targetLibraryID, ...(outcome.collectionKey ? { collectionKey: outcome.collectionKey } : {}) },
    rows: outcome.rows.map((row) => ({
      source: { libraryID: row.row.source.libraryID, itemKey: row.row.source.itemKey, version: row.row.source.version, title: row.row.source.title },
      ...(row.status === "created" ? { created: row.created } : {}),
      ...(row.status === "skipped" ? { skipped: `${row.reason}: ${row.detail}` } : {}),
      ...(row.status === "failed" ? { failed: row.error } : {})
    })),
    totals: outcome.totals
  };
}

/** Items a session undo would trash: everything this entry created. */
export function createdRefs(entry: ImportLogEntry): readonly WriteItemRef[] {
  return entry.rows.flatMap((row) => (row.created ? [row.created] : []));
}

export function undoLogEntry(entry: ImportLogEntry, trashed: readonly WriteItemRef[], id: string, at: Date): UndoLogEntry {
  return { id, action: "undo", reverses: entry.id, at: at.toISOString(), trashed };
}

/** `2026-09-17T19:32:11.004Z-3f9a` — sortable, unique enough for a single user's log. */
export function logEntryID(now: Date, random: () => number = Math.random): string {
  return `${now.toISOString()}-${Math.floor(random() * 0xffff).toString(16).padStart(4, "0")}`;
}

export function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<LogEntry>;
  return typeof entry.id === "string" && (entry.action === "import" || entry.action === "undo");
}

/** One JSON object per line; malformed lines are dropped rather than failing the whole log (§40: fail loud elsewhere, not on read). */
export function parseLog(text: string): { entries: LogEntry[]; malformed: number } {
  const entries: LogEntry[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLogEntry(parsed)) entries.push(parsed); else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { entries, malformed };
}

export function serializeLog(entries: readonly LogEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : "");
}
