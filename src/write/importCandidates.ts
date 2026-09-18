import { normalizeItem } from "../matching/normalize.js";
import type { NormalizedItem, ScannedItem } from "../matching/types.js";
import type { CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import { recallCheck, type NearMiss } from "./recallCheck.js";

/**
 * Turns the audit's "Missing from My Library" list into import candidates decorated with the
 * §48.1 recall re-check. Pure: takes the scanned items the audit was built from, returns data
 * for `buildImportPlan` and the preview. One candidate per missing work — its canonical item,
 * so a work held by two groups is offered once.
 */

export interface ImportCandidate {
  item: ScannedItem;
  nearMisses: readonly NearMiss[];
}

export interface AlreadyPresent {
  item: ScannedItem;
  /** The My Library record the precision rules match now; the index that listed the work as missing was stale. */
  existing: ScannedItem;
}

export interface ImportCandidates {
  candidates: readonly ImportCandidate[];
  alreadyPresent: readonly AlreadyPresent[];
}

const IDENTIFIER_KEYS: (keyof NormalizedItem["identifiers"])[] = ["doi", "isbn13", "pmid", "pmcid", "arxiv"];
const OPENING_WORDS = 3;

export function importCandidates(items: readonly ScannedItem[], audit: CrossLibraryAudit, myLibraryID: number): ImportCandidates {
  const mine = items.filter((item) => item.ref.libraryID === myLibraryID).map(normalizeItem);
  const blocks = widenedBlocks(mine);
  const candidates: ImportCandidate[] = [];
  const alreadyPresent: AlreadyPresent[] = [];
  for (const work of audit.missingFromMyLibrary) {
    const candidate = normalizeItem(work.canonical);
    const result = recallCheck(candidate, blockedCandidates(candidate, mine, blocks));
    if (result.alreadyPresent) alreadyPresent.push({ item: work.canonical, existing: result.alreadyPresent });
    else candidates.push({ item: work.canonical, nearMisses: result.nearMisses });
  }
  return { candidates, alreadyPresent };
}

/**
 * Widened blocking (doc §5 step 3): the precision blocks would hide exactly the records the
 * recall check exists to find, so here a candidate shares a block on any identifier, the
 * first three title words, or any creator key — with no year filter. Recall beats precision
 * in this one place (§48.1); the cost is a few extra rule evaluations per candidate.
 */
function widenedBlocks(items: readonly NormalizedItem[]): ReadonlyMap<string, number[]> {
  const blocks = new Map<string, number[]>();
  items.forEach((item, index) => {
    for (const key of blockKeys(item)) {
      const block = blocks.get(key);
      if (block) block.push(index); else blocks.set(key, [index]);
    }
  });
  return blocks;
}

function blockKeys(item: NormalizedItem): string[] {
  const keys: string[] = [];
  for (const key of IDENTIFIER_KEYS) if (item.identifiers[key]) keys.push(`${key}:${item.identifiers[key]}`);
  if (item.titleWords.length >= OPENING_WORDS) keys.push(`open:${item.titleWords.slice(0, OPENING_WORDS).join(" ")}`);
  for (const creator of item.creatorKeys) keys.push(`creator:${creator}`);
  return keys;
}

function blockedCandidates(candidate: NormalizedItem, items: readonly NormalizedItem[], blocks: ReadonlyMap<string, number[]>): NormalizedItem[] {
  const indexes = new Set<number>();
  for (const key of blockKeys(candidate)) for (const index of blocks.get(key) ?? []) indexes.add(index);
  return [...indexes].sort((left, right) => left - right).map((index) => items[index]!);
}
