import { rowsToImport, type ImportPlan, type ImportRow } from "./importPlan.js";
import type { WriteAPI, WriteItemRef } from "./writeApi.js";

/**
 * The WRITE stage of §25 for Phase 3. Pure orchestration over `WriteAPI`: every decision the
 * user could disagree with was made before this runs (`ImportPlan`), and every guard here is a
 * re-check of something that may have changed since PREVIEW (§40).
 *
 * Batch semantics (§40): per-row re-checks immediately before the chunk that writes the row,
 * skip on stale, never abort the session for one row, never write a stale row; abort *before
 * the first write* only for session-wide conditions (unconfirmed plan, wrong or read-only
 * target). Scale: rows are written in chunks of one transaction each (as Zotero's own
 * drag-copy does); a chunk that fails is retried row by row so one bad row costs only itself.
 * Cancellation is honoured between chunks, never inside a transaction.
 */

export type SkipReason = "stale-source" | "source-missing" | "already-present";

export type RowOutcome =
  | { row: ImportRow; status: "created"; created: WriteItemRef }
  | { row: ImportRow; status: "skipped"; reason: SkipReason; detail: string }
  | { row: ImportRow; status: "failed"; error: string }
  | { row: ImportRow; status: "cancelled" };

export interface ImportTotals {
  created: number;
  skippedStale: number;
  skippedMissing: number;
  skippedExisting: number;
  failed: number;
  /** Rows not attempted because the user cancelled; nothing was written for them. */
  cancelled: number;
}

export interface ImportOutcome {
  plan: ImportPlan;
  /** Set when nothing was written because a session-wide guard failed. */
  aborted?: string;
  collectionKey?: string;
  rows: readonly RowOutcome[];
  totals: ImportTotals;
}

export const IMPORT_PARENT_COLLECTION = "Reconciler Imports";
/** Rows per transaction. Zotero uses 100 for its own copies; smaller keeps a retry after a chunk failure cheap. */
export const DEFAULT_CHUNK_SIZE = 25;

export interface ImportProgress {
  /** Rows attempted so far (created, skipped or failed), out of the ticked rows. */
  done: number;
  total: number;
}

export interface ExecutorOptions {
  /** Session collection name; defaults to the confirmation timestamp. */
  sessionName?: string;
  chunkSize?: number;
  onProgress?: (progress: ImportProgress) => void;
  /** Polled between chunks; true stops the session, remaining rows are reported as cancelled. */
  shouldCancel?: () => boolean;
}

export async function executeImportPlan(api: WriteAPI, plan: ImportPlan, options: ExecutorOptions = {}): Promise<ImportOutcome> {
  if (!plan.confirmedAt) throw new Error("Refusing to execute an unconfirmed import plan.");

  const target = api.library(plan.targetLibraryID);
  const abort = (reason: string): ImportOutcome => ({ plan, aborted: reason, rows: [], totals: emptyTotals() });
  if (!target) return abort(`Target library ${plan.targetLibraryID} is not available.`);
  if (plan.targetLibraryID !== api.userLibraryID()) return abort(`Phase 3 imports only into My Library; ${target.name} is a group library.`);
  if (!target.editable) return abort(`${target.name} is read-only.`);

  const collectionKey = await api.ensureImportCollection(plan.targetLibraryID, IMPORT_PARENT_COLLECTION, options.sessionName ?? sessionNameFrom(plan.confirmedAt));
  const ticked = rowsToImport(plan);
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const rows: RowOutcome[] = [];
  for (let start = 0; start < ticked.length; start += chunkSize) {
    if (options.shouldCancel?.()) {
      for (const row of ticked.slice(start)) rows.push({ row, status: "cancelled" });
      break;
    }
    rows.push(...(await importChunk(api, plan, ticked.slice(start, start + chunkSize), collectionKey)));
    options.onProgress?.({ done: rows.length, total: ticked.length });
  }
  return { plan, collectionKey, rows, totals: tally(rows) };
}

/** Re-checks every row of the chunk, writes the eligible ones in one transaction, and falls back to row-by-row if that transaction fails. */
async function importChunk(api: WriteAPI, plan: ImportPlan, chunk: readonly ImportRow[], collectionKey: string): Promise<RowOutcome[]> {
  const checked = await Promise.all(chunk.map(async (row) => ({ row, skipped: await precheck(api, plan, row) })));
  const eligible = checked.filter(({ skipped }) => !skipped).map(({ row }) => row);
  const copyOptions = { targetLibraryID: plan.targetLibraryID, collectionKey, copyTags: plan.copyTags };

  let written = new Map<ImportRow, RowOutcome>();
  if (eligible.length > 0) {
    try {
      const created = await api.copyItems(eligible.map(refOf), copyOptions);
      written = new Map(eligible.map((row, index) => [row, { row, status: "created", created: created[index]! } satisfies RowOutcome]));
    } catch {
      // One bad row rolled the chunk back; find it by writing the rows one at a time.
      for (const row of eligible) {
        try {
          written.set(row, { row, status: "created", created: await api.copyItem(refOf(row), copyOptions) });
        } catch (error) {
          written.set(row, { row, status: "failed", error: String(error) });
        }
      }
    }
  }
  return checked.map(({ row, skipped }) => skipped ?? written.get(row)!);
}

/** The §40 re-checks, immediately before the chunk that would write the row. Returns the skip outcome, or undefined when the row may be written. */
async function precheck(api: WriteAPI, plan: ImportPlan, row: ImportRow): Promise<RowOutcome | undefined> {
  try {
    const state = await api.sourceItem(refOf(row));
    if (!state) return { row, status: "skipped", reason: "source-missing", detail: "The source item no longer exists." };
    if (state.deleted) return { row, status: "skipped", reason: "source-missing", detail: "The source item is in the trash." };
    if (state.version !== row.source.version) {
      return { row, status: "skipped", reason: "stale-source", detail: `The source item changed after the scan (version ${row.source.version} → ${state.version}). Recompare before importing.` };
    }
    const existing = await api.linkedItemIn(refOf(row), plan.targetLibraryID);
    if (existing) return { row, status: "skipped", reason: "already-present", detail: `Zotero already links this item to ${existing.itemKey} in the target library.` };
    return undefined;
  } catch (error) {
    return { row, status: "failed", error: String(error) };
  }
}

function refOf(row: ImportRow): WriteItemRef {
  return { libraryID: row.source.libraryID, itemKey: row.source.itemKey };
}

function tally(rows: readonly RowOutcome[]): ImportTotals {
  const totals = emptyTotals();
  for (const outcome of rows) {
    if (outcome.status === "created") totals.created += 1;
    else if (outcome.status === "failed") totals.failed += 1;
    else if (outcome.status === "cancelled") totals.cancelled += 1;
    else if (outcome.reason === "stale-source") totals.skippedStale += 1;
    else if (outcome.reason === "source-missing") totals.skippedMissing += 1;
    else totals.skippedExisting += 1;
  }
  return totals;
}

function emptyTotals(): ImportTotals {
  return { created: 0, skippedStale: 0, skippedMissing: 0, skippedExisting: 0, failed: 0, cancelled: 0 };
}

/** `Reconciler Imports / 2026-09-17 14:32` — readable in Zotero's collection tree. */
export function sessionNameFrom(confirmedAt: string): string {
  return confirmedAt.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "");
}
