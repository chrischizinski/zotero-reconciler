import type { CreatorInput, NormalizedIdentifiers, NormalizedItem, ScannedItem } from "./types.js";

const DOI_PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i;
const EXTRA_IDENTIFIER = /^\s*(PMID|PMCID|arXiv|DOI)\s*:\s*(.*?)\s*$/im;
const STOP_WORDS = new Set([
  "a", "an", "the", "of", "on", "in", "for", "and", "or", "to", "with", "from", "at", "by", "as"
]);

/**
 * Mirrors Zotero's punctuation/diacritic behavior, after removing title markup.
 * [DIVERGES] Unicode punctuation and symbols (curly quotes, en/em dashes) are folded to a
 * space as well; Zotero folds ASCII only, so `citizens’` and `citizens'` never agree there.
 */
export function normalizeText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[ !-/:-@[-`{-~]+|[\p{P}\p{S}]+/gu, " ")
    .trim()
    .toLowerCase();
}

export function normalizeDOI(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(DOI_PREFIX, "").trim().toLowerCase();
  return /^10\./.test(normalized) ? normalized : undefined;
}

export function normalizeISBN(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (cleaned.length === 13 && validISBN13(cleaned)) return cleaned;
  if (cleaned.length !== 10 || !validISBN10(cleaned)) return undefined;

  const prefix = `978${cleaned.slice(0, 9)}`;
  return `${prefix}${isbn13CheckDigit(prefix)}`;
}

function validISBN10(value: string): boolean {
  const sum = [...value].reduce((total, char, index) => {
    const digit = char === "X" ? 10 : Number(char);
    return total + digit * (10 - index);
  }, 0);
  return sum % 11 === 0;
}

function validISBN13(value: string): boolean {
  return isbn13CheckDigit(value.slice(0, 12)) === value[12];
}

function isbn13CheckDigit(prefix: string): string {
  const sum = [...prefix].reduce((total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

export function parseExtraIdentifiers(extra: string | undefined): Partial<NormalizedIdentifiers> {
  if (!extra) return {};
  const values: Partial<NormalizedIdentifiers> = {};
  for (const line of extra.split(/\r?\n/)) {
    const match = line.match(EXTRA_IDENTIFIER);
    if (!match) continue;
    const label = match[1]?.toLowerCase();
    const rawValue = match[2]?.trim();
    if (!label || !rawValue) continue;
    if (label === "pmid" && !values.pmid) values.pmid = rawValue.replace(/^PMID:\s*/i, "");
    if (label === "pmcid" && !values.pmcid) values.pmcid = rawValue.toUpperCase();
    if (label === "arxiv" && !values.arxiv) values.arxiv = rawValue.toLowerCase().replace(/^arxiv:/i, "");
    if (label === "doi" && !values.doi) {
      const doi = normalizeDOI(rawValue);
      if (doi) values.doi = doi;
    }
  }
  return values;
}

function creatorKey(creator: CreatorInput): string | undefined {
  const lastName = normalizeText(creator.lastName);
  if (!lastName) return undefined;
  if (creator.fieldMode === 1) return `corporate:${lastName}`;
  const firstInitial = normalizeText(creator.firstName ?? "").charAt(0);
  return `${lastName}:${firstInitial}`;
}

export function normalizeItem(item: ScannedItem): NormalizedItem {
  const extra = parseExtraIdentifiers(item.fields.extra);
  const title = normalizeText(item.fields.title ?? "");
  const creatorKeys = item.creators
    .map(creatorKey)
    .filter((key): key is string => key !== undefined)
    .sort();
  const yearText = item.fields.date?.match(/^(\d{4})/)?.[1];
  const year = yearText && yearText !== "0000" ? Number(yearText) : undefined;
  const nativeDOI = normalizeDOI(item.fields.doi);
  const isbn13 = normalizeISBN(item.fields.isbn);

  const normalized: NormalizedItem = {
    ...item,
    normalizedTitle: title,
    titleWords: title.split(" ").filter((word) => word && !STOP_WORDS.has(word)),
    creatorKeys,
    identifiers: {
      ...(extra.doi ? { doi: extra.doi } : {}),
      ...(extra.pmid ? { pmid: extra.pmid } : {}),
      ...(extra.pmcid ? { pmcid: extra.pmcid } : {}),
      ...(extra.arxiv ? { arxiv: extra.arxiv } : {}),
      ...(nativeDOI ? { doi: nativeDOI } : {}),
      ...(isbn13 ? { isbn13 } : {})
    }
  };
  if (year !== undefined) normalized.year = year;
  return normalized;
}
