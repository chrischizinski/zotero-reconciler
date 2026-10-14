import { LARGE_SESSION_THRESHOLD } from "./importPreviewModel.js";
import { display, type ReconcilePlan } from "./reconcilePlan.js";

/**
 * Phase 4 slice 3 — "Fill Missing Fields from Other Libraries…" PROPOSE → PREVIEW → CONFIRM
 * as data (docs/phase4-field-reconciliation.md §11). Each item's plan comes from
 * `fillMissingPlan`, so the batch writes exactly what Compare Copies would pre-select for that
 * item: My Library empty, every strong copy agrees, never an identifier. The window can only
 * untick items; it cannot add an item or a field.
 */

export interface FillPlan {
  /** One per My Library item, each with at least one edit. */
  items: readonly ReconcilePlan[];
  confirmedAt?: string;
}

export interface FillPreviewRow {
  key: string;
  title: string;
  /** `vs hdfw-book, Textbook` */
  detail: string;
  /** `issue: 4 (from hdfw-book)` — one per field to fill. */
  edits: readonly string[];
  checked: boolean;
}

export interface FillPreviewModel {
  summary: string;
  rows: readonly FillPreviewRow[];
  /** Above this many ticked items the window warns and asks for a second click. */
  largeSessionThreshold: number;
}

/** `confirmed: false` (Cancel or window closed) writes nothing. */
export interface FillPreviewResult {
  confirmed: boolean;
  checkedKeys: readonly string[];
}

export function itemKeyOf(plan: ReconcilePlan): string {
  return `${plan.target.libraryID}:${plan.target.itemKey}`;
}

export function fillPreviewModel(plan: FillPlan): FillPreviewModel {
  const fields = plan.items.reduce((sum, item) => sum + item.edits.length, 0);
  const items = plan.items.length;
  return {
    summary: [
      `${items} My Library item${items === 1 ? "" : "s"} can gain ${fields} field${fields === 1 ? "" : "s"}: My Library has no value, and every copy matched EXACT or HIGH in another library agrees on one.`,
      "Only empty fields are filled. Fields that differ or conflict, and identifiers (DOI, ISBN, ISSN), are never written here — use Compare Copies on the item for those.",
      "Each item is re-checked just before it is written; an item that changed since this list was made is skipped. Only My Library items change; the other copies are never edited."
    ].join("\n"),
    rows: plan.items.map((item) => ({
      key: itemKeyOf(item),
      title: item.target.title,
      detail: `vs ${[...new Set(item.edits.map((edit) => edit.source.libraryName))].join(", ")}`,
      edits: item.edits.map((edit) => `${edit.field}: ${display(edit.next)} (from ${edit.source.libraryName})`),
      checked: true
    })),
    largeSessionThreshold: LARGE_SESSION_THRESHOLD
  };
}

/** Cancel → nothing to execute. Otherwise the ticked items, each stamped with the session's confirmation. */
export function applyFillPreview(plan: FillPlan, result: FillPreviewResult, now: Date): FillPlan | undefined {
  if (!result.confirmed) return undefined;
  const confirmedAt = now.toISOString();
  const checked = new Set(result.checkedKeys);
  return { items: plan.items.filter((item) => checked.has(itemKeyOf(item))).map((item) => ({ ...item, confirmedAt })), confirmedAt };
}
