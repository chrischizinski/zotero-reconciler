import { candidatePairs } from "../matching/blocking.js";
import { areLinked } from "../matching/links.js";
import { matchNormalizedItems } from "../matching/matcher.js";
import { normalizeItem } from "../matching/normalize.js";
import { compareBibliographicFields, type FieldDifference } from "../comparison/fieldComparator.js";
import type { ScannedItem } from "../matching/types.js";
import { buildScholarlyWorkIndex, missingFromLibrary, type MatchPair, type ScholarlyWork } from "../works/scholarlyWorkIndex.js";

export interface CrossLibraryAudit {
  comparedPairs: number;
  /** Pairs Zotero itself links (Tier 0). */
  linkedPairs: number;
  /**
   * Linked pairs the bibliographic rules alone would NOT match: each is a real false negative
   * of the matcher, since the user created the link (§8.0). Diagnostic, not a defect in the index.
   */
  linkedButUnmatched: readonly MatchPair[];
  confirmedPairs: readonly MatchPair[];
  works: readonly ScholarlyWork[];
  missingFromMyLibrary: readonly ScholarlyWork[];
  discrepancies: readonly WorkDiscrepancy[];
}

export interface WorkDiscrepancy {
  left: ScannedItem;
  right: ScannedItem;
  differences: readonly FieldDifference[];
}

export function auditCrossLibraries(items: readonly ScannedItem[], myLibraryID: number): CrossLibraryAudit {
  const normalized = items.map(normalizeItem);
  const pairs: MatchPair[] = [];
  const linkedButUnmatched: MatchPair[] = [];
  let linkedPairs = 0;
  for (const [leftIndex, rightIndex] of candidatePairs(normalized)) {
    const left = normalized[leftIndex]!;
    const right = normalized[rightIndex]!;
    if (left.ref.libraryID === right.ref.libraryID) continue;
    pairs.push({ left: items[leftIndex]!, right: items[rightIndex]!, result: matchNormalizedItems(left, right) });
    if (areLinked(left, right)) {
      linkedPairs += 1;
      const rulesOnly = matchNormalizedItems(left, right, { ignoreLinkedItems: true });
      if (rulesOnly.verdict !== "match") linkedButUnmatched.push({ left: items[leftIndex]!, right: items[rightIndex]!, result: rulesOnly });
    }
  }
  const confirmedPairs = pairs.filter((pair) => pair.result.verdict === "match");
  const works = buildScholarlyWorkIndex(items, confirmedPairs);
  const discrepancies = confirmedPairs.map(({ left, right }) => ({ left, right, differences: compareBibliographicFields(left, right) }))
    .filter(({ differences }) => differences.length > 0);
  return { comparedPairs: pairs.length, linkedPairs, linkedButUnmatched, confirmedPairs, works, missingFromMyLibrary: missingFromLibrary(works, myLibraryID), discrepancies };
}
