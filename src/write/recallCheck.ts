import { matchNormalizedItems } from "../matching/matcher.js";
import type { MatchResult, NormalizedItem, ScannedItem } from "../matching/types.js";

/**
 * §48.1 — the one place recall beats precision. The "Missing from My Library" list is built
 * from Tier 4 (no match), and a precision-tuned matcher deliberately leaves false negatives
 * there. Importing one creates a duplicate. So before import, look again at My Library with
 * the net cast wide and *show* the near-misses instead of deciding.
 *
 * Pure: operates on normalized items only, never on Zotero objects.
 */

export type NearMissReason = "shared-identifier" | "same-title" | "similar-title" | "same-opening-words";

export interface NearMiss {
  item: ScannedItem;
  reason: NearMissReason;
  /** The precision matcher's own explanation of why this was NOT a match — shown to the user. */
  evidence: string;
}

export interface RecallCheck {
  /** A My Library record the precision rules DO match now (the index was stale): import must not proceed. */
  alreadyPresent?: ScannedItem;
  nearMisses: readonly NearMiss[];
}

const IDENTIFIER_KEYS: (keyof NormalizedItem["identifiers"])[] = ["doi", "isbn13", "pmid", "pmcid", "arxiv"];
const OPENING_WORDS = 3;

export function recallCheck(candidate: NormalizedItem, myLibrary: readonly NormalizedItem[]): RecallCheck {
  const nearMisses: NearMiss[] = [];
  for (const mine of myLibrary) {
    const result = matchNormalizedItems(candidate, mine);
    if (result.verdict === "match") return { alreadyPresent: mine, nearMisses: [] };
    const reason = nearMissReason(candidate, mine, result);
    if (reason) nearMisses.push({ item: mine, reason, evidence: result.evidence.map(({ detail }) => detail).join(" ") });
  }
  return { nearMisses: nearMisses.sort((left, right) => REASON_RANK[left.reason] - REASON_RANK[right.reason]) };
}

const REASON_RANK: Record<NearMissReason, number> = { "shared-identifier": 0, "same-title": 1, "similar-title": 2, "same-opening-words": 3 };

/**
 * Widened rules, cheapest first. Denials (D1–D7) and type compatibility are deliberately
 * ignored here: they are exactly what hid the record from the precision pass.
 */
function nearMissReason(candidate: NormalizedItem, mine: NormalizedItem, result: MatchResult): NearMissReason | undefined {
  if (IDENTIFIER_KEYS.some((key) => candidate.identifiers[key] && candidate.identifiers[key] === mine.identifiers[key])) return "shared-identifier";
  if (result.titleRelation === "equivalent" || result.titleRelation === "addition-only") return "same-title";
  // A substituted title word plus the same year alone would flag every same-year paper; require an author.
  if (result.titleRelation === "substitution" && sharesCreator(candidate, mine)) return "similar-title";
  if (sameOpeningWords(candidate, mine) && (sharesCreator(candidate, mine) || sameYearWindow(candidate, mine))) return "same-opening-words";
  return undefined;
}

function sharesCreator(left: NormalizedItem, right: NormalizedItem): boolean {
  return left.creatorKeys.some((key) => right.creatorKeys.includes(key));
}

function sameYearWindow(left: NormalizedItem, right: NormalizedItem): boolean {
  return left.year !== undefined && right.year !== undefined && Math.abs(left.year - right.year) <= 1;
}

function sameOpeningWords(left: NormalizedItem, right: NormalizedItem): boolean {
  if (left.titleWords.length < OPENING_WORDS || right.titleWords.length < OPENING_WORDS) return false;
  return left.titleWords.slice(0, OPENING_WORDS).join(" ") === right.titleWords.slice(0, OPENING_WORDS).join(" ");
}
