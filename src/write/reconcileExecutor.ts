import type { FieldValue } from "../comparison/differenceEngine.js";
import type { ReconcilePlan } from "./reconcilePlan.js";
import type { FieldUpdate, UpdateStatus, WriteAPI } from "./writeApi.js";

/**
 * Phase 4 WRITE for one My Library item (docs/phase4-field-reconciliation.md §6, §10). The
 * executor decides nothing about values: it checks the plan's preconditions and hands the
 * whole item to `WriteAPI.updateFields`, which re-checks and writes in one transaction.
 */

export type ReconcileStatus = UpdateStatus | "nothing-chosen" | "aborted" | "failed";

export interface ReconcileOutcome {
  plan: ReconcilePlan;
  status: ReconcileStatus;
  detail?: string;
  /** On `written`: values as Zotero stored them, by field name. */
  stored?: Readonly<Record<string, FieldValue>>;
}

export async function executeReconcilePlan(api: WriteAPI, plan: ReconcilePlan): Promise<ReconcileOutcome> {
  // Invariant 6: no path to a write without the user's confirmation.
  if (!plan.confirmedAt) throw new Error("Refusing to execute an unconfirmed reconciliation plan.");
  // Invariant 1 (decision A): My Library only. The adapter refuses too; this fails before any read.
  if (plan.target.libraryID !== api.userLibraryID()) throw new Error("Phase 4 edits My Library items only.");
  if (plan.edits.length === 0) return { plan, status: "nothing-chosen" };
  if (!api.library(plan.target.libraryID)?.editable) return { plan, status: "aborted", detail: "My Library is not editable." };

  try {
    const { target, writes, checks } = fieldUpdate(plan);
    const result = await api.updateFields(target, writes, checks);
    return { plan, status: result.status, ...(result.detail ? { detail: result.detail } : {}), ...(result.stored ? { stored: result.stored } : {}) };
  } catch (error) {
    return { plan, status: "failed", detail: String(error) };
  }
}

/** Target expectations (the values previewed) AND source re-checks (the source must still say what the log will claim). */
export function fieldUpdate(plan: ReconcilePlan): FieldUpdate {
  return {
    target: { libraryID: plan.target.libraryID, itemKey: plan.target.itemKey },
    writes: plan.edits.map((edit) => ({ name: edit.name, expected: edit.old, next: edit.next })),
    checks: plan.edits.map((edit) => ({ ref: { libraryID: edit.source.libraryID, itemKey: edit.source.itemKey }, name: edit.sourceName, expected: edit.next }))
  };
}
