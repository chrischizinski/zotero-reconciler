import { rowsToImport, type ImportPlan, type ImportRow } from "./importPlan.js";
import type { WriteAPI, WriteItemRef } from "./writeApi.js";

/**
 * The WRITE stage of §25 for Phase 3. Pure orchestration over `WriteAPI`: every decision the
 * user could disagree with was made before this runs (`ImportPlan`), and every guard here is a
 * re-check of something that may have changed since PREVIEW (§40).
 *
 * Batch semantics (§40): per-row re-checks, skip on stale, never abort the session for one
 * row, never write a stale row; abort *before the first write* only for session-wide
 * conditions (unconfirmed plan, wrong or read-only target).
 */

export type SkipReason = "stale-source" | "source-missing" | "already-present";

export type RowOutcome =
  | { row: ImportRow; status: "created"; created: WriteItemRef }
  | { row: ImportRow; status: "skipped"; reason: SkipReason; detail: string }
  | { row: ImportRow; status: "failed"; error: string };

export interface ImportOutcome {
  plan: ImportPlan;
  /** Set when nothing was written because a session-wide guard failed. */
  aborted?: string;
  collectionKey?: string;
  rows: readonly RowOutcome[];
  totals: { created: number; skippedStale: number; skippedMissing: number; skippedExisting: number; failed: number };
}

export const IMPORT_PARENT_COLLECTION = "Reconciler Imports";

export interface ExecutorOptions {
  /** Session collection name; defaults to the confirmation timestamp. */
  sessionName?: string;
}

export async function executeImportPlan(api: WriteAPI, plan: ImportPlan, options: ExecutorOptions = {}): Promise<ImportOutcome> {
  if (!plan.confirmedAt) throw new Error("Refusing to execute an unconfirmed import plan.");

  const target = api.library(plan.targetLibraryID);
  const abort = (reason: string): ImportOutcome => ({ plan, aborted: reason, rows: [], totals: emptyTotals() });
  if (!target) return abort(`Target library ${plan.targetLibraryID} is not available.`);
  if (plan.targetLibraryID !== api.userLibraryID()) return abort(`Phase 3 imports only into My Library; ${target.name} is a group library.`);
  if (!target.editable) return abort(`${target.name} is read-only.`);

  const collectionKey = await api.ensureImportCollection(plan.targetLibraryID, IMPORT_PARENT_COLLECTION, options.sessionName ?? sessionNameFrom(plan.confirmedAt));
  const rows: RowOutcome[] = [];
  for (const row of rowsToImport(plan)) rows.push(await importRow(api, plan, row, collectionKey));
  return { plan, collectionKey, rows, totals: tally(rows) };
}

async function importRow(api: WriteAPI, plan: ImportPlan, row: ImportRow, collectionKey: string): Promise<RowOutcome> {
  const ref: WriteItemRef = { libraryID: row.source.libraryID, itemKey: row.source.itemKey };
  try {
    const state = await api.sourceItem(ref);
    if (!state) return { row, status: "skipped", reason: "source-missing", detail: "The source item no longer exists." };
    if (state.deleted) return { row, status: "skipped", reason: "source-missing", detail: "The source item is in the trash." };
    if (state.version !== row.source.version) {
      return { row, status: "skipped", reason: "stale-source", detail: `The source item changed after the scan (version ${row.source.version} → ${state.version}). Recompare before importing.` };
    }
    const existing = await api.linkedItemIn(ref, plan.targetLibraryID);
    if (existing) return { row, status: "skipped", reason: "already-present", detail: `Zotero already links this item to ${existing.itemKey} in the target library.` };

    const created = await api.copyItem(ref, { targetLibraryID: plan.targetLibraryID, collectionKey, copyTags: plan.copyTags });
    return { row, status: "created", created };
  } catch (error) {
    return { row, status: "failed", error: String(error) };
  }
}

function tally(rows: readonly RowOutcome[]): ImportOutcome["totals"] {
  const totals = emptyTotals();
  for (const outcome of rows) {
    if (outcome.status === "created") totals.created += 1;
    else if (outcome.status === "failed") totals.failed += 1;
    else if (outcome.reason === "stale-source") totals.skippedStale += 1;
    else if (outcome.reason === "source-missing") totals.skippedMissing += 1;
    else totals.skippedExisting += 1;
  }
  return totals;
}

function emptyTotals(): ImportOutcome["totals"] {
  return { created: 0, skippedStale: 0, skippedMissing: 0, skippedExisting: 0, failed: 0 };
}

/** `Reconciler Imports / 2026-09-17 14:32` — readable in Zotero's collection tree. */
export function sessionNameFrom(confirmedAt: string): string {
  return confirmedAt.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "");
}
