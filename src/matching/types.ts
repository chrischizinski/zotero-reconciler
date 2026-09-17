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

export interface ScannedItem {
  ref: ItemRef;
  itemType: string;
  fields: ItemFields;
  creators: CreatorInput[];
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
