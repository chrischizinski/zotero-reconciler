import type { ScannedItem } from "../matching/types.js";
import type { NearMiss } from "./recallCheck.js";

/**
 * Phase 3 "Add Missing Items to My Library" — the PROPOSE / PREVIEW / CONFIRM stages of §25
 * as plain data. Nothing here touches Zotero; `importExecutor.ts` executes a confirmed plan
 * through `WriteAPI`, and refuses one that is not confirmed.
 */

export interface ImportSource {
  libraryID: number;
  libraryName: string;
  itemKey: string;
  /** Item version at plan time; the executor skips the row if it moved (§40). */
  version: number;
  title: string;
}

export type RowDecision = "import" | "skip";

export interface ImportRow {
  source: ImportSource;
  /** My Library records that look like this work under recall-favouring rules (§48.1). */
  nearMisses: readonly NearMiss[];
  decision: RowDecision;
}

export interface ImportPlan {
  /** Must be the user library in Phase 3 (docs/phase3-write-safeguards.md §2). */
  targetLibraryID: number;
  rows: readonly ImportRow[];
  /** Zotero's drag-copy default is to copy tags; §22 says tags are library-specific, so ours is off. */
  copyTags: boolean;
  createdAt: string;
  /** Set only by `confirmPlan`; the executor throws without it. */
  confirmedAt?: string;
}

/**
 * Default decision per row (§48.1): a work with no near-miss is imported; any near-miss
 * un-ticks the row so the user opts in after seeing the evidence.
 */
export function buildImportPlan(
  candidates: readonly { item: ScannedItem; nearMisses: readonly NearMiss[] }[],
  targetLibraryID: number,
  now: Date,
  options: { copyTags?: boolean } = {}
): ImportPlan {
  return {
    targetLibraryID,
    copyTags: options.copyTags ?? false,
    createdAt: now.toISOString(),
    rows: candidates.map(({ item, nearMisses }) => ({
      source: {
        libraryID: item.ref.libraryID,
        libraryName: item.ref.libraryName,
        itemKey: item.ref.itemKey,
        version: item.ref.version,
        title: item.fields.title ?? ""
      },
      nearMisses,
      decision: nearMisses.length === 0 ? "import" : "skip"
    }))
  };
}

/** Applies the user's per-row choices from the preview. Unknown keys are ignored. */
export function withDecisions(plan: ImportPlan, decisions: ReadonlyMap<string, RowDecision>): ImportPlan {
  return {
    ...plan,
    rows: plan.rows.map((row) => ({ ...row, decision: decisions.get(rowKey(row)) ?? row.decision }))
  };
}

/** The CONFIRM stage. Only a confirmed plan can reach the executor. */
export function confirmPlan(plan: ImportPlan, now: Date): ImportPlan {
  return { ...plan, confirmedAt: now.toISOString() };
}

export function rowKey(row: ImportRow): string {
  return `${row.source.libraryID}:${row.source.itemKey}`;
}

export function rowsToImport(plan: ImportPlan): readonly ImportRow[] {
  return plan.rows.filter((row) => row.decision === "import");
}
