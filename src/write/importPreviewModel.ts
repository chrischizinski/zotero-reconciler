import type { AlreadyPresent } from "./importCandidates.js";
import { confirmPlan, rowKey, withDecisions, yearOf, type ImportPlan, type RowDecision } from "./importPlan.js";
import type { NearMiss, NearMissReason } from "./recallCheck.js";

/**
 * The PREVIEW / CONFIRM stages (§25) as data. `importPreview.xhtml` renders a `PreviewModel`
 * and hands back a `PreviewResult`; `applyPreview` turns that into a confirmed plan or
 * nothing. The window never sees the plan and cannot invent a row: only keys it was given
 * can be ticked.
 */

export interface PreviewRow {
  key: string;
  title: string;
  /** `journalArticle · 2024 · creel` */
  detail: string;
  checked: boolean;
  /** Already present in My Library (recall check found a match); cannot be ticked. */
  disabled: boolean;
  /** Near-miss evidence (§48.1) or the already-present explanation; one line each. */
  warnings: readonly string[];
}

export interface PreviewModel {
  targetName: string;
  summary: string;
  rows: readonly PreviewRow[];
  copyTags: boolean;
  /** Above this many ticked rows the window warns and asks for a second click: several smaller sessions are easier to review and undo. */
  largeSessionThreshold: number;
}

export const LARGE_SESSION_THRESHOLD = 250;

/** What the window returns. `confirmed: false` (Cancel or window closed) writes nothing. */
export interface PreviewResult {
  confirmed: boolean;
  checkedKeys: readonly string[];
  copyTags: boolean;
}

export function previewModel(plan: ImportPlan, alreadyPresent: readonly AlreadyPresent[], targetName: string): PreviewModel {
  const rows: PreviewRow[] = [
    ...plan.rows.map((row) => ({
      key: rowKey(row),
      title: row.source.title || "Untitled",
      detail: detailFor(row.source.libraryName, row.source.itemType, row.source.year),
      checked: row.decision === "import",
      disabled: false,
      warnings: row.nearMisses.map(describeNearMiss)
    })),
    ...alreadyPresent.map(({ item, existing }) => ({
      key: `${item.ref.libraryID}:${item.ref.itemKey}`,
      title: item.fields.title || "Untitled",
      detail: detailFor(item.ref.libraryName, item.itemType, yearOf(item)),
      checked: false,
      disabled: true,
      warnings: [`Already in My Library as "${existing.fields.title || "Untitled"}" (${yearOf(existing) ?? "no year"}); the index was out of date. Not importable.`]
    }))
  ];
  const flagged = plan.rows.filter((row) => row.nearMisses.length > 0).length;
  return {
    targetName,
    summary: summarize(plan.rows.length, flagged, alreadyPresent.length),
    rows,
    copyTags: plan.copyTags,
    largeSessionThreshold: LARGE_SESSION_THRESHOLD
  };
}

/** Cancel → nothing to execute. Otherwise every plan row is decided by the checkbox, then the plan is confirmed. */
export function applyPreview(plan: ImportPlan, result: PreviewResult, now: Date): ImportPlan | undefined {
  if (!result.confirmed) return undefined;
  const checked = new Set(result.checkedKeys);
  const decisions = new Map<string, RowDecision>(plan.rows.map((row) => [rowKey(row), checked.has(rowKey(row)) ? "import" : "skip"]));
  return confirmPlan({ ...withDecisions(plan, decisions), copyTags: result.copyTags }, now);
}

const REASON_TEXT: Record<NearMissReason, string> = {
  "shared-identifier": "Same identifier as",
  "same-title": "Same title as",
  "similar-title": "Similar title and shared author with",
  "same-opening-words": "Same opening words as"
};

export function describeNearMiss(nearMiss: NearMiss): string {
  const { item } = nearMiss;
  const year = yearOf(item);
  return `${REASON_TEXT[nearMiss.reason]} "${item.fields.title || "Untitled"}" (${item.itemType}${year ? `, ${year}` : ""}) in My Library. Not matched because: ${nearMiss.evidence}`;
}

function summarize(total: number, flagged: number, present: number): string {
  const parts = [`${total} work${total === 1 ? "" : "s"} found only in group libraries.`];
  if (flagged > 0) parts.push(`${flagged} ha${flagged === 1 ? "s" : "ve"} a possible copy in My Library and ${flagged === 1 ? "is" : "are"} unticked: read the evidence before ticking.`);
  if (present > 0) parts.push(`${present} ${present === 1 ? "is" : "are"} already in My Library and cannot be imported.`);
  parts.push("Ticked works are copied into My Library as new items; nothing is deleted or moved.");
  return parts.join(" ");
}

function detailFor(libraryName: string, itemType: string, year: string | undefined): string {
  return [itemType, ...(year ? [year] : []), libraryName].join(" \u00b7 ");
}
