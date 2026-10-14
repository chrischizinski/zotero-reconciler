import type { DifferenceClass, DifferenceField, FieldValue } from "../comparison/differenceEngine.js";
import type { ImportOutcome } from "./importExecutor.js";
import type { ReconcileOutcome, ReconcileStatus } from "./reconcileExecutor.js";
import type { FieldWrite, LinkRemovalResult, LinkRestoreStatus, UpdateStatus, WriteItemRef } from "./writeApi.js";

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

/** One field edit as logged (design.md §26): old, new as stored, and which library supplied it. */
export interface LoggedChange {
  field: DifferenceField;
  name: string;
  old: FieldValue;
  new: FieldValue;
  class: DifferenceClass;
  source: { libraryID: number; itemKey: string; libraryName: string };
}

/** Phase 4: one My Library item, edited (or not) in one transaction. */
export interface MetadataLogEntry {
  id: string;
  action: "update_metadata";
  confirmedAt: string;
  target: { libraryID: number; itemKey: string; title: string };
  status: ReconcileStatus;
  detail?: string;
  /** Present only when written. */
  changes: readonly LoggedChange[];
  /** Match evidence for each source library, so "why were these the same work?" stays answerable. */
  evidence: readonly string[];
  /** Fill Missing session this item belongs to; the session undo reverts every entry sharing it. Absent for Compare Copies. */
  session?: string;
  undoneAt?: string;
}

/** Plugin undo of a metadata entry; logged whether or not the revert could be applied. */
export interface RevertLogEntry {
  id: string;
  action: "revert_metadata";
  reverses: string;
  at: string;
  status: UpdateStatus | "failed";
  detail?: string;
}

/** docs/stale-link-removal.md: one `owl:sameAs` removal attempt, one line per pair, sharing a session. */
export interface LinkLogEntry {
  id: string;
  action: "remove_link";
  session: string;
  confirmedAt: string;
  target: { libraryID: number; itemKey: string; title: string };
  linked: { libraryID: number; itemKey: string; title: string; libraryName: string };
  status: LinkRemovalResult["status"] | "failed";
  /** The exact relation removed; the undo re-adds precisely this. Present only when removed. */
  uri?: string;
  detail?: string;
  /** Why the rules deny the pair, so "why did I remove this?" stays answerable. */
  evidence: readonly string[];
  undoneAt?: string;
}

export interface LinkRestoreLogEntry {
  id: string;
  action: "restore_link";
  reverses: string;
  at: string;
  status: LinkRestoreStatus | "failed";
}

export type LogEntry = ImportLogEntry | UndoLogEntry | MetadataLogEntry | RevertLogEntry | LinkLogEntry | LinkRestoreLogEntry;

/** What one link undo restores: every removed, un-undone entry of the latest link session. */
export function lastLinkSession(entries: readonly LogEntry[]): LinkLogEntry[] {
  const undoable = entries.filter((entry): entry is LinkLogEntry => entry.action === "remove_link" && entry.status === "removed" && entry.uri !== undefined && !entry.undoneAt);
  const last = undoable[undoable.length - 1];
  return last ? undoable.filter((entry) => entry.session === last.session) : [];
}

export function metadataLogEntry(outcome: ReconcileOutcome, id: string, session?: string): MetadataLogEntry {
  const { plan } = outcome;
  const written = outcome.status === "written";
  return {
    id,
    action: "update_metadata",
    confirmedAt: plan.confirmedAt ?? "",
    target: { libraryID: plan.target.libraryID, itemKey: plan.target.itemKey, title: plan.target.title },
    status: outcome.status,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    changes: written ? plan.edits.map((edit) => ({
      field: edit.field, name: edit.name, old: edit.old,
      new: outcome.stored?.[edit.name] ?? edit.next,
      class: edit.class, source: edit.source
    })) : [],
    evidence: plan.evidence,
    ...(session ? { session } : {})
  };
}

/**
 * What one plugin undo reverses: the latest un-undone written metadata entry and, if it came
 * from a Fill Missing session, every other un-undone written entry of that session.
 */
export function lastMetadataSession(entries: readonly LogEntry[]): MetadataLogEntry[] {
  const undoable = entries.filter((entry): entry is MetadataLogEntry => entry.action === "update_metadata" && entry.status === "written" && !entry.undoneAt && entry.changes.length > 0);
  const last = undoable[undoable.length - 1];
  if (!last) return [];
  return last.session ? undoable.filter((entry) => entry.session === last.session) : [last];
}

/** The reverse edit: restore `old` only where the field still holds what the session stored. */
export function revertWrites(entry: MetadataLogEntry): FieldWrite[] {
  return entry.changes.map((change) => ({ name: change.name, expected: change.new, next: change.old }));
}

export function revertLogEntry(entry: MetadataLogEntry, status: RevertLogEntry["status"], detail: string | undefined, id: string, at: Date): RevertLogEntry {
  return { id, action: "revert_metadata", reverses: entry.id, at: at.toISOString(), status, ...(detail ? { detail } : {}) };
}

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
      ...(row.status === "cancelled" ? { skipped: "cancelled: the session was cancelled before this row; nothing was written." } : {}),
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
  return typeof entry.id === "string" && ["import", "undo", "update_metadata", "revert_metadata", "remove_link", "restore_link"].includes(entry.action as string);
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
