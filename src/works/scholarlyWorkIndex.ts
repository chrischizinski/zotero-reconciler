import { denialEvidence } from "../matching/matcher.js";
import { normalizeItem } from "../matching/normalize.js";
import { canonicalTypeRank, type MatchResult, type MatchTier, type ScannedItem } from "../matching/types.js";

export interface MatchPair {
  left: ScannedItem;
  right: ScannedItem;
  result: MatchResult;
}

export interface ScholarlyWork {
  id: string;
  items: readonly ScannedItem[];
  libraryIDs: readonly number[];
  /** The published form when related item types share a work (§8.4); otherwise the first item. */
  canonical: ScannedItem;
  /** Weakest edge used to build the cluster (§8.2). Absent for singletons. */
  confidence?: MatchTier;
}

const TIER_STRENGTH: Record<MatchTier, number> = { exact: 0, high: 1, review: 2, none: 3 };

/**
 * Tier-restricted union-find (§8.2). Tier 1 edges union freely; a Tier 2 edge unions only
 * when no member of one cluster is denied (D1–D6) against any member of the other, so one
 * record with a wrong DOI cannot weld two works together. Tier 3 edges never union.
 */
export function buildScholarlyWorkIndex(items: readonly ScannedItem[], pairs: readonly MatchPair[]): readonly ScholarlyWork[] {
  const normalized = items.map(normalizeItem);
  const parent = items.map((_, index) => index);
  const members = new Map(items.map((_, index) => [index, [index]]));
  const weakest = new Map<number, MatchTier>();
  const byRef = new Map(items.map((item, index) => [refKey(item), index]));
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));

  const edges = pairs
    .filter((pair) => pair.result.verdict === "match" && (pair.result.tier === "exact" || pair.result.tier === "high"))
    .sort((left, right) => TIER_STRENGTH[left.result.tier] - TIER_STRENGTH[right.result.tier]);

  for (const edge of edges) {
    const left = byRef.get(refKey(edge.left));
    const right = byRef.get(refKey(edge.right));
    if (left === undefined || right === undefined) continue;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) continue;
    const leftMembers = members.get(leftRoot)!;
    const rightMembers = members.get(rightRoot)!;
    if (edge.result.tier === "high" && clustersDenied(normalized, leftMembers, rightMembers)) continue;

    parent[rightRoot] = leftRoot;
    members.set(leftRoot, [...leftMembers, ...rightMembers]);
    members.delete(rightRoot);
    weakest.set(leftRoot, weakerTier(edge.result.tier, weakest.get(leftRoot), weakest.get(rightRoot)));
    weakest.delete(rightRoot);
  }

  return [...members.entries()].map(([root, indices]) => {
    const sorted = indices.map((index) => items[index]!).sort((left, right) => refKey(left).localeCompare(refKey(right)));
    const confidence = weakest.get(root);
    return {
      id: sorted.map(refKey).join("|"),
      items: sorted,
      libraryIDs: [...new Set(sorted.map((item) => item.ref.libraryID))].sort((left, right) => left - right),
      canonical: canonicalItem(sorted),
      ...(confidence ? { confidence } : {})
    };
  });
}

export function missingFromLibrary(index: readonly ScholarlyWork[], libraryID: number): readonly ScholarlyWork[] {
  return index.filter((work) => !work.libraryIDs.includes(libraryID));
}

function clustersDenied(normalized: readonly ReturnType<typeof normalizeItem>[], left: readonly number[], right: readonly number[]): boolean {
  return left.some((a) => right.some((b) => denialEvidence(normalized[a]!, normalized[b]!) !== undefined));
}

function weakerTier(...tiers: (MatchTier | undefined)[]): MatchTier {
  return tiers.filter((tier): tier is MatchTier => tier !== undefined)
    .reduce((weakestSoFar, tier) => TIER_STRENGTH[tier] > TIER_STRENGTH[weakestSoFar] ? tier : weakestSoFar);
}

function canonicalItem(sorted: readonly ScannedItem[]): ScannedItem {
  return sorted.reduce((best, item) => canonicalTypeRank(item.itemType) < canonicalTypeRank(best.itemType) ? item : best);
}

function refKey(item: ScannedItem): string {
  return `${item.ref.libraryID}:${item.ref.itemKey}`;
}
