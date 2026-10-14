import { compareRecords, type DifferenceClass, type DifferenceField, type FieldRecord } from "../comparison/differenceEngine.js";
import { isPreselected } from "../write/reconcilePlan.js";
import type { ItemRef, MatchResult } from "../matching/types.js";
import type { MatchPair } from "../works/scholarlyWorkIndex.js";

/**
 * Phase 4 slice 2 — "Metadata Differences in My Library" (docs/phase4-field-reconciliation.md
 * §11). Read-only. For every My Library item with at least one DIRECT strong match (EXACT or
 * HIGH, the §5 gate Compare Copies uses) in another library, counts the fields Compare Copies
 * would offer. It never writes and never pre-selects anything; it tells the user which items
 * are worth opening. Compare Copies recomputes from current data when opened, so it — not this
 * report — is authoritative at write time.
 */

export interface FieldSummary {
  field: DifferenceField;
  class: DifferenceClass;
  /** Fill Missing would write it (`isPreselected`); a missing identifier is false. */
  fillable: boolean;
}

export interface ItemDifferenceSummary {
  target: ItemRef;
  title: string;
  /** Libraries of the strong-match copies compared. */
  sourceLibraries: readonly string[];
  /** My Library empty, every copy agrees (identifiers included). */
  missing: number;
  /** Of those, what Compare Copies pre-selects and Fill Missing writes: identifiers excluded (`isPreselected`). */
  fillable: number;
  different: number;
  conflicting: number;
  /** Offerable fields only; format-only, MISSING-in-sources and not-offered rows are left out. */
  fields: readonly FieldSummary[];
}

export interface MetadataDifferenceReport {
  /** My Library items that have at least one strong match elsewhere. */
  compared: number;
  /** Those with at least one offerable field, most fillable first. */
  items: readonly ItemDifferenceSummary[];
  /** Records the reader could not load (deleted since the scan); reported, never silently dropped. */
  unreadable: number;
}

export function strongPair(pair: MatchPair): boolean {
  return pair.result.verdict === "match" && (pair.result.tier === "exact" || pair.result.tier === "high");
}

export interface StrongPartner {
  ref: ItemRef;
  result: MatchResult;
}

/** Each My Library item → the other-library items it is directly and strongly matched to, with the match. */
export function strongPartnersOfMyLibrary(pairs: readonly MatchPair[], myLibraryID: number): Map<string, { target: ItemRef; partners: StrongPartner[] }> {
  const byTarget = new Map<string, { target: ItemRef; partners: StrongPartner[] }>();
  for (const pair of pairs.filter(strongPair)) {
    for (const [mine, other] of [[pair.left, pair.right], [pair.right, pair.left]] as const) {
      if (mine.ref.libraryID !== myLibraryID || other.ref.libraryID === myLibraryID) continue;
      const key = refKey(mine.ref);
      const entry = byTarget.get(key) ?? { target: mine.ref, partners: [] };
      if (!entry.partners.some((partner) => refKey(partner.ref) === refKey(other.ref))) entry.partners.push({ ref: other.ref, result: pair.result });
      byTarget.set(key, entry);
    }
  }
  return byTarget;
}

export function metadataDifferenceReport(
  pairs: readonly MatchPair[],
  myLibraryID: number,
  records: ReadonlyMap<string, FieldRecord>,
  titleOf: (ref: ItemRef) => string
): MetadataDifferenceReport {
  const items: ItemDifferenceSummary[] = [];
  let unreadable = 0;
  const targets = strongPartnersOfMyLibrary(pairs, myLibraryID);
  for (const { target, partners } of targets.values()) {
    const targetRecord = records.get(refKey(target));
    const sources = partners.flatMap(({ ref }) => records.get(refKey(ref)) ?? []);
    if (!targetRecord || sources.length === 0) { unreadable += 1; continue; }
    const offered = compareRecords(targetRecord, sources)
      .filter((difference) => difference.targetName !== undefined && !difference.notOffered && difference.alternatives.length > 0);
    const fields = offered.map((difference) => ({ field: difference.field, class: difference.class, fillable: isPreselected(difference) }));
    if (fields.length === 0) continue;
    items.push({
      target,
      title: titleOf(target),
      sourceLibraries: [...new Set(sources.map((source) => source.ref.libraryName))],
      missing: fields.filter((field) => field.class === "MISSING").length,
      fillable: fields.filter((field) => field.fillable).length,
      different: fields.filter((field) => field.class === "DIFFERENT").length,
      conflicting: fields.filter((field) => field.class === "CONFLICTING").length,
      fields
    });
  }
  items.sort((a, b) => b.fillable - a.fillable || (b.different + b.conflicting) - (a.different + a.conflicting) || a.title.localeCompare(b.title));
  return { compared: targets.size, items, unreadable };
}

/** `HIGH — Titles match. First authors match. …`: the match evidence as one line, for previews and the log. */
export function describeMatch(result: MatchResult): string {
  return `${result.tier.toUpperCase()} — ${result.evidence.map(({ detail }) => detail).join(" ")}`;
}

export function refKey(ref: Pick<ItemRef, "libraryID" | "itemKey">): string {
  return `${ref.libraryID}:${ref.itemKey}`;
}
