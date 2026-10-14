import type { Alternative, DifferenceClass, DifferenceField, FieldDifference, FieldValue, RecordCreator } from "../comparison/differenceEngine.js";
import type { ItemRef } from "../matching/types.js";
import type { WriteItemRef } from "./writeApi.js";

/**
 * Phase 4 PROPOSE → PREVIEW → CONFIRM (§25) for one My Library item, as data
 * (docs/phase4-field-reconciliation.md §7). `reconcilePreview.xhtml` renders a
 * `ReconcilePreviewModel` and returns a `ReconcilePreviewResult`; `applyReconcilePreview`
 * turns that into a confirmed plan or nothing. The window can only pick among the
 * alternatives it was given, and only on offerable rows.
 */

/** A source copy that passed the pair gate (§5), with its match evidence for the preview and log. */
export interface GatedSource {
  ref: ItemRef;
  evidence: string;
}

export interface PreviewChoice {
  /** Index into the difference's alternatives. */
  index: number;
  label: string;
}

export interface ReconcilePreviewRow {
  field: DifferenceField;
  class: DifferenceClass;
  targetDisplay: string;
  choices: readonly PreviewChoice[];
  /** -1 = keep My Library's value. Only MISSING-in-target defaults to a source value (invariant 4). */
  defaultChoice: number;
  /** Offerable rows have a select; others show why not. */
  offerable: boolean;
  notes: readonly string[];
}

export interface ReconcilePreviewModel {
  title: string;
  summary: string;
  sources: readonly { label: string; evidence: string }[];
  rows: readonly ReconcilePreviewRow[];
}

/** `confirmed: false` (Cancel or closed) writes nothing. `choices` maps field → alternative index (-1 keep). */
export interface ReconcilePreviewResult {
  confirmed: boolean;
  choices: Readonly<Record<string, number>>;
}

export interface FieldEdit {
  field: DifferenceField;
  /** Target item type's field name (`creators` for the creator list). */
  name: string;
  old: FieldValue;
  next: FieldValue;
  class: DifferenceClass;
  source: { libraryID: number; itemKey: string; libraryName: string };
  /** Source field name and value as previewed; re-checked at write time (§6). */
  sourceName: string;
}

export interface ReconcilePlan {
  target: WriteItemRef & { title: string };
  edits: readonly FieldEdit[];
  evidence: readonly string[];
  confirmedAt?: string;
}

export function reconcilePreviewModel(title: string, differences: readonly FieldDifference[], sources: readonly GatedSource[]): ReconcilePreviewModel {
  const rows = differences.map(previewRow);
  const offerable = rows.filter((row) => row.offerable).length;
  const ticked = rows.filter((row) => row.defaultChoice >= 0).length;
  return {
    title,
    summary: `${sources.length} matched cop${sources.length === 1 ? "y" : "ies"} in other libraries. ${offerable} field${offerable === 1 ? "" : "s"} can be updated in My Library; ${ticked} pre-selected because My Library has no value and every other copy agrees. Differences and conflicts are left as they are unless you choose a value. Only the My Library item changes; the other copies are never edited.`,
    sources: sources.map(({ ref, evidence }) => ({ label: ref.libraryName, evidence })),
    rows
  };
}

function previewRow(difference: FieldDifference): ReconcilePreviewRow {
  const offerable = difference.targetName !== undefined && difference.notOffered === undefined && difference.alternatives.length > 0;
  const missingInTarget = difference.class === "MISSING" && difference.missingIn === "target";
  return {
    field: difference.field,
    class: difference.class,
    targetDisplay: display(difference.targetValue) || "—",
    choices: difference.alternatives.map((alternative, index) => ({ index, label: choiceLabel(alternative) })),
    defaultChoice: offerable && missingInTarget ? 0 : -1,
    offerable,
    notes: [...difference.notes, ...(difference.notOffered ? [`Not offered: ${difference.notOffered}.`] : [])]
  };
}

/** Cancel → no plan. Otherwise only offerable rows with an in-range choice become edits. */
export function applyReconcilePreview(
  target: WriteItemRef & { title: string },
  differences: readonly FieldDifference[],
  sources: readonly GatedSource[],
  result: ReconcilePreviewResult,
  now: Date
): ReconcilePlan | undefined {
  if (!result.confirmed) return undefined;
  const edits: FieldEdit[] = [];
  for (const difference of differences) {
    const index = result.choices[difference.field];
    if (index === undefined || index < 0) continue;
    const alternative = difference.alternatives[index];
    const row = previewRow(difference);
    if (!row.offerable || !alternative || difference.targetName === undefined) continue;
    const source = alternative.sources[0]!;
    edits.push({
      field: difference.field,
      name: difference.targetName,
      old: difference.targetValue,
      next: alternative.value,
      class: difference.class,
      source: { libraryID: source.libraryID, itemKey: source.itemKey, libraryName: source.libraryName },
      sourceName: alternative.sourceName
    });
  }
  return {
    target,
    edits,
    evidence: sources.map(({ ref, evidence }) => `${ref.libraryName}: ${evidence}`),
    confirmedAt: now.toISOString()
  };
}

function choiceLabel(alternative: Alternative): string {
  const from = [...new Set(alternative.sources.map((source) => source.libraryName))].join(", ");
  return `${display(alternative.value)} — from ${from}`;
}

export function display(value: FieldValue): string {
  if (typeof value === "string") return value;
  return value.map(creatorDisplay).join("; ");
}

function creatorDisplay(creator: RecordCreator): string {
  const name = creator.name ?? [creator.lastName, creator.firstName].filter(Boolean).join(", ");
  return creator.creatorType === "author" ? name : `${name} (${creator.creatorType})`;
}
