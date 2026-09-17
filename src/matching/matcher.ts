import { areLinked } from "./links.js";
import { normalizeItem } from "./normalize.js";
import { CANONICAL_TYPE_RANK } from "./types.js";
import type { MatchEvidence, MatchResult, NormalizedItem, ScannedItem, TitleRelation, TypeRelation } from "./types.js";

const RELATED_TYPE_PAIRS = new Set([
  "journalarticle|preprint",
  "conferencepaper|journalarticle",
  "book|thesis"
]);

export interface MatchOptions {
  /** Skip Tier 0 so the bibliographic rules alone decide; used to audit the matcher against Zotero's links. */
  ignoreLinkedItems?: boolean;
}

export function matchItems(leftInput: ScannedItem, rightInput: ScannedItem, options: MatchOptions = {}): MatchResult {
  return matchNormalizedItems(normalizeItem(leftInput), normalizeItem(rightInput), options);
}

export function matchNormalizedItems(left: NormalizedItem, right: NormalizedItem, options: MatchOptions = {}): MatchResult {
  if (!options.ignoreLinkedItems && areLinked(left, right)) return matchLinkedItems(left, right);
  return matchByRules(left, right);
}

/**
 * Tier 0 (§8.0a). Zotero recorded that one record was copied from the other. The relation
 * proves a copy *event*, not that the records still describe the same work: on real data
 * (2026-09-17) half the linked pairs the rules rejected had been repurposed into different
 * papers after copying. So the link corroborates, it never overrides a denial:
 *
 *   rules say match              → EXACT, link added as evidence
 *   rules deny or find nothing   → REVIEW, never NO MATCH (a stale link also breaks Zotero's
 *                                  own drag-copy, so the user should see it)
 */
function matchLinkedItems(left: NormalizedItem, right: NormalizedItem): MatchResult {
  const link: MatchEvidence = { rule: "Tier 0", detail: "Zotero linked items (owl:sameAs): one record was copied from the other." };
  const rules = matchByRules(left, right);
  if (rules.verdict === "match") return { ...rules, tier: "exact", evidence: [link, ...rules.evidence] };
  const diverged = rules.titleRelation === "substitution" || rules.titleRelation === "missing"
    ? "Titles no longer agree; the link is probably stale (one record was repurposed after copying)."
    : "Titles agree but the bibliographic rules do not; one record likely holds a wrong identifier or type.";
  return { ...rules, verdict: "review", tier: "review", evidence: [link, ...rules.evidence, { rule: "§8.0a", detail: `${diverged} Manual review required.` }] };
}

function matchByRules(left: NormalizedItem, right: NormalizedItem): MatchResult {
  const titleRelation = compareTitles(left, right);
  const typeRelation = compareTypes(left.itemType, right.itemType);
  const evidence: MatchEvidence[] = [];

  if (typeRelation === "incompatible") {
    return result("no-match", "none", [{ rule: "D6", detail: "Item types are incompatible." }], titleRelation, typeRelation);
  }

  const sharedIdentifiers = matchingIdentifiers(left, right);
  if (sharedIdentifiers.length > 0) {
    for (const identifier of sharedIdentifiers) evidence.push({ rule: "Tier 1", detail: `${identifier} identical.` });
    if (typeRelation === "related") {
      evidence.push({ rule: "§8.4", detail: `Related item types share an identifier; ${canonicalItemType(left.itemType, right.itemType)} is the canonical record.` });
    }
    return result("match", "exact", evidence, titleRelation, typeRelation);
  }

  const denial = denialEvidence(left, right);
  if (denial) return result("no-match", "none", [denial], titleRelation, typeRelation);

  if (typeRelation === "related") {
    if ((titleRelation === "equivalent" || titleRelation === "addition-only") && creatorsCompatible(left, right) && yearsCompatible(left, right)) {
      return result("related", "none", [
        { rule: "§8.4", detail: "Item types represent related publication forms." },
        { rule: "§7", detail: "Title, creators, and year support a related-work classification." }
      ], titleRelation, typeRelation);
    }
    return result("no-match", "none", [{ rule: "Tier 4", detail: "Related item types without same-work evidence." }], titleRelation, typeRelation);
  }

  if (titleRelation === "addition-only" && addedWords(left.titleWords, right.titleWords).some((word) => EDITION_MARKER.test(word))) {
    return result("review", "review", [{ rule: "§8.4", detail: "Titles differ only by an edition marker; editions are related works, not copies. Manual review required." }], titleRelation, typeRelation);
  }

  if (titleRelation === "equivalent" || titleRelation === "addition-only") {
    if (creatorsCompatible(left, right) && yearsCompatible(left, right)) {
      return result("match", "high", [
        { rule: "Tier 2", detail: `Title relation: ${titleRelation}.` },
        { rule: "§7", detail: "Creators compatible." },
        { rule: "§7", detail: "Years compatible." }
      ], titleRelation, typeRelation);
    }
  }

  if (titleRelation === "substitution" && likelyTypo(left.titleWords, right.titleWords) && creatorsCompatible(left, right) && yearsCompatible(left, right)) {
    return result("review", "review", [{ rule: "Tier 3", detail: "Near-identical substituted title word; manual review required." }], titleRelation, typeRelation);
  }

  const terminalEvidence = titleRelation === "substitution"
    ? { rule: "D7", detail: "Titles contain content-word substitutions and are not a review candidate." }
    : { rule: "Tier 4", detail: "No supported match evidence." };
  return result("no-match", "none", [terminalEvidence], titleRelation, typeRelation);
}

function result(verdict: MatchResult["verdict"], tier: MatchResult["tier"], evidence: readonly MatchEvidence[], titleRelation: TitleRelation, typeRelation: TypeRelation): MatchResult {
  return { verdict, tier, evidence, titleRelation, typeRelation };
}

/**
 * An ISBN identifies a book, not a chapter: every bookSection of an edited volume carries the
 * same ISBN. Like Zotero's duplicate detector, ISBN is therefore identity only for `book` items.
 */
function matchingIdentifiers(left: NormalizedItem, right: NormalizedItem): string[] {
  const keys: (keyof NormalizedItem["identifiers"])[] = ["doi", "pmid", "pmcid", "arxiv"];
  if (left.itemType.toLowerCase() === "book" && right.itemType.toLowerCase() === "book") keys.push("isbn13");
  return keys.filter((key) => left.identifiers[key] && left.identifiers[key] === right.identifiers[key]);
}

/**
 * Denial rules D1–D6 (§8.0). Exported for whole-cluster checks (§8.2): a Tier 2 edge may
 * only union two clusters when no member pair across them is denied.
 */
export function denialEvidence(left: NormalizedItem, right: NormalizedItem): MatchEvidence | undefined {
  if (compareTypes(left.itemType, right.itemType) === "incompatible") return { rule: "D6", detail: "Item types are incompatible." };
  if (different(left.identifiers.doi, right.identifiers.doi)) return { rule: "D1", detail: "Normalized DOIs differ." };
  if (different(left.identifiers.isbn13, right.identifiers.isbn13)) return { rule: "D2", detail: "Canonical ISBN-13 values differ." };
  if (different(left.identifiers.pmid, right.identifiers.pmid)) return { rule: "D3", detail: "PMIDs differ." };
  if (left.year !== undefined && right.year !== undefined && Math.abs(left.year - right.year) > 1) return { rule: "D5", detail: "Publication years differ by more than one." };
  return undefined;
}

function different(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

/**
 * §8.3 with one tightening learned from real libraries: ADDITION-ONLY means the shorter title is
 * an ordered *prefix* of the longer one (title + subtitle, series suffix), not any word subset.
 * "The common carp" is a subset of "Using boat electrofishing … invasive common carp" but not
 * the same work.
 */
function compareTitles(left: NormalizedItem, right: NormalizedItem): TitleRelation {
  if (!left.normalizedTitle || !right.normalizedTitle) return "missing";
  if (sameMembers(left.titleWords, right.titleWords)) return "equivalent";
  if (properPrefix(left.titleWords, right.titleWords) || properPrefix(right.titleWords, left.titleWords)) return "addition-only";
  return "substitution";
}

/** Picks the published form among related item types (§8.4). Ties keep the left type. */
export function canonicalItemType(left: string, right: string): string {
  const rank = (type: string): number => CANONICAL_TYPE_RANK[type.toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  return rank(right) < rank(left) ? right : left;
}

function compareTypes(left: string, right: string): TypeRelation {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft === normalizedRight) return "compatible";
  return RELATED_TYPE_PAIRS.has([normalizedLeft, normalizedRight].sort().join("|")) ? "related" : "incompatible";
}

function creatorsCompatible(left: NormalizedItem, right: NormalizedItem): boolean {
  if (left.creatorKeys.length === 0 && right.creatorKeys.length === 0) return true;
  if (left.creatorKeys.length === 0 || right.creatorKeys.length === 0) return false;
  return left.creatorKeys.some((key) => right.creatorKeys.includes(key));
}

function yearsCompatible(left: NormalizedItem, right: NormalizedItem): boolean {
  return left.year === undefined || right.year === undefined || Math.abs(left.year - right.year) <= 1;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

/** One content word ("Introduction", "Discussion") is not enough title to be a prefix of anything. */
function properPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  return shorter.length >= 2 && shorter.length < longer.length && shorter.every((value, index) => value === longer[index]);
}

const EDITION_MARKER = /^(edition|ed|edn)$/;

/** The words the longer title adds beyond the shared prefix. */
function addedWords(left: readonly string[], right: readonly string[]): readonly string[] {
  return left.length > right.length ? left.slice(right.length) : right.slice(left.length);
}

function likelyTypo(left: readonly string[], right: readonly string[]): boolean {
  const leftOnly = left.filter((word) => !right.includes(word));
  const rightOnly = right.filter((word) => !left.includes(word));
  return leftOnly.length === 1 && rightOnly.length === 1 && levenshtein(leftOnly[0]!, rightOnly[0]!) <= 1;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + Number(left[i - 1] !== right[j - 1]));
      diagonal = above;
    }
  }
  return previous[right.length]!;
}
