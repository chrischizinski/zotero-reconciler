import type { FillPlan } from "./fillPlan.js";
import { DEFAULT_CHUNK_SIZE } from "./importExecutor.js";
import { fieldUpdate, type ReconcileOutcome } from "./reconcileExecutor.js";
import type { ReconcilePlan } from "./reconcilePlan.js";
import type { FieldUpdate, UpdateResult, WriteAPI } from "./writeApi.js";

/**
 * Phase 4 slice 3 WRITE. Same batch semantics as Phase 3 (§40): items are written in chunks,
 * one transaction (one ⌘Z step) each; every item is re-checked inside its chunk's transaction
 * and a stale one is skipped while the rest are written; a chunk that throws is retried item
 * by item so one bad item costs only itself; Cancel is honoured between chunks, never inside
 * a transaction. Session-wide guards (unconfirmed, not My Library) fail before any write.
 */

export type FillItemOutcome = ReconcileOutcome | { plan: ReconcilePlan; status: "cancelled" };

export interface FillTotals {
  itemsUpdated: number;
  fieldsWritten: number;
  skippedTargetChanged: number;
  skippedSourceChanged: number;
  skippedMissing: number;
  failed: number;
  /** Not attempted because the user cancelled; nothing was written for them. */
  cancelled: number;
}

export interface FillOutcome {
  plan: FillPlan;
  /** Set when nothing was written because a session-wide guard failed. */
  aborted?: string;
  items: readonly FillItemOutcome[];
  totals: FillTotals;
}

export interface FillProgress {
  done: number;
  total: number;
}

export interface FillExecutorOptions {
  chunkSize?: number;
  onProgress?: (progress: FillProgress) => void;
  shouldCancel?: () => boolean;
}

export async function executeFillPlan(api: WriteAPI, plan: FillPlan, options: FillExecutorOptions = {}): Promise<FillOutcome> {
  // Invariant 6: no path to a write without the user's confirmation, for the session and every item.
  if (!plan.confirmedAt || plan.items.some((item) => !item.confirmedAt)) throw new Error("Refusing to execute an unconfirmed fill plan.");
  // Invariant 1 (decision A): My Library only. The adapter refuses too; this fails before any read.
  if (plan.items.some((item) => item.target.libraryID !== api.userLibraryID())) throw new Error("Phase 4 edits My Library items only.");
  if (!api.library(api.userLibraryID())?.editable) return { plan, aborted: "My Library is not editable.", items: [], totals: emptyTotals() };

  const items = plan.items.filter((item) => item.edits.length > 0);
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const outcomes: FillItemOutcome[] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    if (options.shouldCancel?.()) {
      for (const item of items.slice(start)) outcomes.push({ plan: item, status: "cancelled" });
      break;
    }
    outcomes.push(...(await fillChunk(api, items.slice(start, start + chunkSize))));
    options.onProgress?.({ done: outcomes.length, total: items.length });
  }
  return { plan, items: outcomes, totals: tally(outcomes) };
}

async function fillChunk(api: WriteAPI, chunk: readonly ReconcilePlan[]): Promise<ReconcileOutcome[]> {
  const results = await writeChunk(api, chunk.map(fieldUpdate));
  return chunk.map((plan, index) => {
    const result = results[index]!;
    return { plan, status: result.status, ...(result.detail ? { detail: result.detail } : {}), ...("stored" in result && result.stored ? { stored: result.stored } : {}) };
  });
}

export type ChunkResult = UpdateResult | { status: "failed"; detail: string };

/**
 * One chunk in one transaction; if the transaction throws (it rolled back whole), retry item by
 * item so one bad item costs only itself. Shared by the fill and by the session undo.
 */
export async function writeChunk(api: WriteAPI, updates: readonly FieldUpdate[]): Promise<ChunkResult[]> {
  try {
    return await api.updateFieldsBatch(updates);
  } catch {
    const results: ChunkResult[] = [];
    for (const { target, writes, checks } of updates) {
      try {
        results.push(await api.updateFields(target, writes, checks));
      } catch (error) {
        results.push({ status: "failed", detail: String(error) });
      }
    }
    return results;
  }
}

function tally(outcomes: readonly FillItemOutcome[]): FillTotals {
  const totals = emptyTotals();
  for (const outcome of outcomes) {
    if (outcome.status === "written") { totals.itemsUpdated += 1; totals.fieldsWritten += outcome.plan.edits.length; }
    else if (outcome.status === "target-changed") totals.skippedTargetChanged += 1;
    else if (outcome.status === "source-changed") totals.skippedSourceChanged += 1;
    else if (outcome.status === "target-missing") totals.skippedMissing += 1;
    else if (outcome.status === "cancelled") totals.cancelled += 1;
    else totals.failed += 1;
  }
  return totals;
}

function emptyTotals(): FillTotals {
  return { itemsUpdated: 0, fieldsWritten: 0, skippedTargetChanged: 0, skippedSourceChanged: 0, skippedMissing: 0, failed: 0, cancelled: 0 };
}
