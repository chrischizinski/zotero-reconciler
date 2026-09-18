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
/** Jaccard overlap of content words for `similar-title`; below this, same-author papers are just different papers. */
const SIMILAR_TITLE_OVERLAP = 0.5;
/** Or at most this many words differ in total (a typo or one swapped word), whatever the overlap. */
const SIMILAR_TITLE_MAX_DIFFERING_WORDS = 2;

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
  // "substitution" is anything not equivalent or prefix, so alone it names every other paper by the
  // same author (live 2026-09-18: 306 of 557 rows flagged, one work drew six unrelated same-author
  // hits). Require the titles to actually overlap, plus a shared author.
  if (result.titleRelation === "substitution" && sharesCreator(candidate, mine) && titlesOverlap(candidate, mine)) return "similar-title";
  if (sameOpeningWords(candidate, mine) && (sharesCreator(candidate, mine) || sameYearWindow(candidate, mine))) return "same-opening-words";
  return undefined;
}

function titlesOverlap(left: NormalizedItem, right: NormalizedItem): boolean {
  const leftWords = new Set(left.titleWords);
  const rightWords = new Set(right.titleWords);
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = leftWords.size + rightWords.size - shared;
  if (union === 0) return false;
  const differing = union - shared;
  return differing <= SIMILAR_TITLE_MAX_DIFFERING_WORDS || shared / union >= SIMILAR_TITLE_OVERLAP;
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
