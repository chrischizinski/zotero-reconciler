import { areLinked, linkKey } from "./links.js";
import type { NormalizedItem } from "./types.js";

const IDENTIFIER_KEYS: (keyof NormalizedItem["identifiers"])[] = ["doi", "isbn13", "pmid", "pmcid", "arxiv"];

/**
 * Blocking (§8.5). Two records are candidates for pairwise matching when Zotero links them,
 * or they share a persistent identifier, or share a creator key within a compatible year, or
 * are both creatorless with the same normalized title. Records not sharing a block are never
 * compared.
 */
export function isCandidatePair(left: NormalizedItem, right: NormalizedItem): boolean {
  if (areLinked(left, right)) return true;
  if (IDENTIFIER_KEYS.some((key) => left.identifiers[key] && left.identifiers[key] === right.identifiers[key])) return true;
  if (left.year !== undefined && right.year !== undefined && Math.abs(left.year - right.year) > 1) return false;
  if (left.creatorKeys.length > 0 && right.creatorKeys.length > 0) {
    return left.creatorKeys.some((creator) => right.creatorKeys.includes(creator));
  }
  return left.creatorKeys.length === 0 && right.creatorKeys.length === 0 && left.normalizedTitle === right.normalizedTitle;
}

/**
 * Hash-join form of {@link isCandidatePair} over a whole item set. Returns index pairs
 * (left < right) whose records share at least one block; the year filter is applied
 * inside creator blocks so the result set equals a full pairwise `isCandidatePair` scan.
 */
export function candidatePairs(items: readonly NormalizedItem[]): [number, number][] {
  const blocks = new Map<string, number[]>();
  const add = (key: string, index: number): void => {
    const block = blocks.get(key);
    if (block) block.push(index); else blocks.set(key, [index]);
  };
  items.forEach((item, index) => {
    // A linked pair shares the block named after the link target, whichever side carries the relation.
    add(`link:${linkKey(item.ref)}`, index);
    for (const ref of item.linkedItems ?? []) add(`link:${linkKey(ref)}`, index);
    for (const key of IDENTIFIER_KEYS) if (item.identifiers[key]) add(`${key}:${item.identifiers[key]}`, index);
    for (const creator of item.creatorKeys) add(`creator:${creator}`, index);
    if (item.creatorKeys.length === 0 && item.normalizedTitle) add(`title:${item.normalizedTitle}`, index);
  });

  const seen = new Set<number>();
  const pairs: [number, number][] = [];
  for (const block of blocks.values()) {
    for (let i = 0; i < block.length; i += 1) {
      for (let j = i + 1; j < block.length; j += 1) {
        const left = Math.min(block[i]!, block[j]!);
        const right = Math.max(block[i]!, block[j]!);
        const id = left * items.length + right;
        if (seen.has(id) || !isCandidatePair(items[left]!, items[right]!)) continue;
        seen.add(id);
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}
