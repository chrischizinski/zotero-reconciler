export interface ItemRef {
  libraryID: number;
  libraryName: string;
  itemKey: string;
  version: number;
}

export interface CreatorInput {
  lastName: string;
  firstName?: string;
  /** Zotero uses fieldMode 1 for a single-field (corporate) creator. */
  fieldMode?: 0 | 1;
}

export interface ItemFields {
  title?: string;
  date?: string;
  doi?: string;
  isbn?: string;
  issn?: string;
  extra?: string;
}

/** Another library's item that Zotero itself records as the same record (`owl:sameAs`). */
export interface LinkedRef {
  libraryID: number;
  itemKey: string;
}

export interface ScannedItem {
  ref: ItemRef;
  itemType: string;
  fields: ItemFields;
  creators: CreatorInput[];
  /**
   * Zotero "linked items": written by Zotero whenever a user copies an item between libraries
   * (drag-and-drop) and read back by its own duplicate-copy check. Tier 0 evidence (§8.0).
   */
  linkedItems?: readonly LinkedRef[];
}

export interface NormalizedIdentifiers {
  doi?: string;
  isbn13?: string;
  pmid?: string;
  pmcid?: string;
  arxiv?: string;
}

export type TitleRelation = "equivalent" | "addition-only" | "substitution" | "missing";
export type TypeRelation = "compatible" | "related" | "incompatible";
export type MatchVerdict = "match" | "review" | "related" | "no-match";
export type MatchTier = "exact" | "high" | "review" | "none";

export interface NormalizedItem extends ScannedItem {
  normalizedTitle: string;
  /** Content words in title order (function words removed). Order matters for ADDITION-ONLY. */
  titleWords: readonly string[];
  creatorKeys: readonly string[];
  year?: number;
  identifiers: NormalizedIdentifiers;
}

export interface MatchEvidence {
  rule: string;
  detail: string;
}

export interface MatchResult {
  verdict: MatchVerdict;
  tier: MatchTier;
  evidence: readonly MatchEvidence[];
  titleRelation: TitleRelation;
  typeRelation: TypeRelation;
}

/**
 * Ordering used when one work holds records of related item types (§8.4): the
 * published form is the canonical record. Lower rank wins.
 */
export const CANONICAL_TYPE_RANK: Readonly<Record<string, number>> = {
  journalarticle: 0,
  book: 1,
  conferencepaper: 2,
  thesis: 3,
  preprint: 4
};

/**
 * Zotero's generic catch-all type. Compatible with every parent type for matching (§8.4), and
 * always the least canonical record: a `document` copy of a report is a report.
 */
export const GENERIC_ITEM_TYPE = "document";

/** Lower is more canonical; unlisted specific types tie below the listed ones, `document` below all. */
export function canonicalTypeRank(itemType: string): number {
  const type = itemType.toLowerCase();
  if (type === GENERIC_ITEM_TYPE) return Number.MAX_SAFE_INTEGER;
  return CANONICAL_TYPE_RANK[type] ?? Number.MAX_SAFE_INTEGER - 1;
}
