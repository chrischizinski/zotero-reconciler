import { normalizeDOI, normalizeISBN, normalizeText } from "../matching/normalize.js";
import type { ItemRef } from "../matching/types.js";

/**
 * Phase 4 Difference Engine (design.md §11, §38; docs/phase4-field-reconciliation.md §4).
 * Pure: compares one target record (My Library) with N source records field by field and
 * classifies each field. It decides nothing about writing; the preview model turns the
 * classes into default choices and the user confirms.
 */

/**
 * Reconcilable fields by Zotero BASE field name (§12 minus `itemType`, `extra`). A record
 * carries each under its own item type's field name (e.g. base `publicationTitle` is
 * `bookTitle` on a book section), so values compare by base field and are written by name.
 */
export const RECONCILABLE_FIELDS = [
  "title", "abstractNote", "publicationTitle", "journalAbbreviation", "volume", "issue", "pages",
  "date", "DOI", "ISBN", "ISSN", "url", "publisher", "place", "edition", "language", "rights"
] as const;

export type ReconcilableField = (typeof RECONCILABLE_FIELDS)[number];
/** `creators` is compared and copied as one unit (decision E). */
export type DifferenceField = ReconcilableField | "creators";

/** Zotero's API JSON creator shape (`Item.getCreatorsJSON`): either `name` or `lastName`/`firstName`. */
export interface RecordCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export type FieldValue = string | readonly RecordCreator[];

export interface RecordField {
  /** This item type's field name for the base field. */
  name: string;
  /** Raw value as Zotero returns it; `""` when the field is valid but empty. */
  value: string;
  /** Comparison key supplied by the reader where raw text is misleading (dates: `2024-05-03`, `2024-00-00`). */
  key?: string;
}

/** One item's reconcilable fields, read at COMPARE time (not by the scan). */
export interface FieldRecord {
  ref: ItemRef;
  itemType: string;
  /** Absent base field → that field does not exist on this item type. */
  fields: Partial<Record<ReconcilableField, RecordField>>;
  creators: readonly RecordCreator[];
  /** Creator types this item's type accepts; a list with any other type is not offered. */
  validCreatorTypes: readonly string[];
}

export type DifferenceClass = "IDENTICAL" | "MISSING" | "DIFFERENT" | "CONFLICTING";

export interface Alternative {
  /** Raw value from the first source holding it; what would be written. */
  value: FieldValue;
  /** Every source whose value compares equal to this one. */
  sources: readonly ItemRef[];
  /** This item type's field name in the first source (for the source re-check). */
  sourceName: string;
}

export interface FieldDifference {
  field: DifferenceField;
  class: DifferenceClass;
  /** For MISSING: which side lacks the value. Only `target` is offerable. */
  missingIn?: "target" | "sources";
  /** Target's field name, or undefined when the field does not exist on the target's type. */
  targetName?: string;
  targetValue: FieldValue;
  /** Values that differ from the target's, grouped; empty for IDENTICAL and MISSING-in-sources. */
  alternatives: readonly Alternative[];
  /** Why the field cannot be written, if it cannot. */
  notOffered?: string;
  /** Format-only or precision notes, shown with the row. */
  notes: readonly string[];
}

export function compareRecords(target: FieldRecord, sources: readonly FieldRecord[]): FieldDifference[] {
  const differences: FieldDifference[] = [];
  for (const field of RECONCILABLE_FIELDS) {
    const difference = compareField(field, target, sources);
    if (difference) differences.push(difference);
  }
  const creators = compareCreators(target, sources);
  if (creators) differences.push(creators);
  return differences;
}

interface Candidate {
  value: FieldValue;
  key: string;
  raw: string;
  ref: ItemRef;
  sourceName: string;
}

function compareField(field: ReconcilableField, target: FieldRecord, sources: readonly FieldRecord[]): FieldDifference | undefined {
  const targetField = target.fields[field];
  const candidates: Candidate[] = sources.flatMap((source) => {
    const sourceField = source.fields[field];
    if (!sourceField || !sourceField.value.trim()) return [];
    return [{ value: sourceField.value, key: fieldKey(field, sourceField), raw: sourceField.value, ref: source.ref, sourceName: sourceField.name }];
  });
  const targetValue = targetField?.value ?? "";
  const targetKey = targetField && targetValue.trim() ? fieldKey(field, targetField) : undefined;
  const notOffered = targetField ? undefined : `${target.itemType} has no ${field} field`;
  return classify(field, targetField?.name, targetValue, targetValue, targetKey, candidates, notOffered, precisionNote(field));
}

function compareCreators(target: FieldRecord, sources: readonly FieldRecord[]): FieldDifference | undefined {
  const candidates: Candidate[] = sources.flatMap((source) => source.creators.length === 0 ? [] : [{
    value: source.creators, key: creatorsKey(source.creators), raw: JSON.stringify(source.creators), ref: source.ref, sourceName: "creators"
  }]);
  const targetKey = target.creators.length > 0 ? creatorsKey(target.creators) : undefined;
  const difference = classify("creators", "creators", target.creators, JSON.stringify(target.creators), targetKey, candidates, undefined, () => undefined);
  if (!difference) return undefined;
  // A list holding a creator type the target's item type lacks would be silently converted
  // (`setCreator` falls back to the primary type), turning an editor into an author.
  const valid = new Set(target.validCreatorTypes);
  const invalid = difference.alternatives.some((alternative) => (alternative.value as readonly RecordCreator[]).some((creator) => !valid.has(creator.creatorType)));
  return invalid && difference.alternatives.length > 0
    ? { ...difference, notOffered: `a creator type is not valid for ${target.itemType}` }
    : difference;
}

function classify(
  field: DifferenceField,
  targetName: string | undefined,
  targetValue: FieldValue,
  targetRaw: string,
  targetKey: string | undefined,
  candidates: readonly Candidate[],
  notOffered: string | undefined,
  precision: (a: string, b: string) => string | undefined
): FieldDifference | undefined {
  const base = { field, ...(targetName ? { targetName } : {}), targetValue, ...(notOffered ? { notOffered } : {}) };
  if (candidates.length === 0) {
    if (targetKey === undefined) return undefined; // empty everywhere: nothing to show
    return { ...base, class: "MISSING", missingIn: "sources", alternatives: [], notes: [] };
  }

  const groups = groupByKey(candidates);
  const others = [...groups.values()].filter((group) => group[0]!.key !== targetKey);
  const alternatives = others.map(toAlternative);

  if (targetKey === undefined) {
    return { ...base, class: groups.size === 1 ? "MISSING" : "CONFLICTING", ...(groups.size === 1 ? { missingIn: "target" as const } : {}), alternatives, notes: [] };
  }

  if (others.length === 0) {
    const formatOnly = candidates.some((candidate) => candidate.raw !== targetRaw);
    return { ...base, class: "IDENTICAL", alternatives: [], notes: formatOnly ? [`Formatting differs only: ${describeRaw(candidates, targetRaw)}`] : [] };
  }

  const notes = others.flatMap((group) => {
    const note = precision(targetKey, group[0]!.key);
    return note ? [note] : [];
  });
  // Sources that disagree with each other leave no single alternative to recommend.
  return { ...base, class: groups.size > 1 ? "CONFLICTING" : "DIFFERENT", alternatives, notes };
}

function groupByKey(candidates: readonly Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.key);
    if (group) group.push(candidate); else groups.set(candidate.key, [candidate]);
  }
  return groups;
}

function toAlternative(group: readonly Candidate[]): Alternative {
  return { value: group[0]!.value, sources: group.map((candidate) => candidate.ref), sourceName: group[0]!.sourceName };
}

function describeRaw(candidates: readonly Candidate[], targetRaw: string): string {
  const variants = [...new Set(candidates.map((candidate) => candidate.raw).filter((raw) => raw !== targetRaw))];
  return `My Library "${truncate(targetRaw)}" vs ${variants.map((raw) => `"${truncate(raw)}"`).join(", ")}`;
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/**
 * Per-field comparison keys (§4). `normalizeText` maps all punctuation to spaces — right for
 * titles, too blunt for numbers (`3(4)` vs `34`) and identifiers — so each field picks its own.
 */
function fieldKey(field: ReconcilableField, record: RecordField): string {
  const value = record.value;
  switch (field) {
    case "DOI": return normalizeDOI(value) ?? normalizeText(value);
    case "ISBN": return normalizeISBN(value) ?? normalizeText(value);
    case "ISSN": return value.toUpperCase().replace(/[^0-9X]/g, "");
    case "date": return record.key ?? value.trim();
    case "volume": case "issue": case "pages": case "edition":
      return value.toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, "");
    case "url": return value.trim();
    default: return normalizeText(value);
  }
}

function precisionNote(field: ReconcilableField): (targetKey: string, sourceKey: string) => string | undefined {
  if (field !== "date") return () => undefined;
  // SQL-date keys use 00 for unknown parts: 2024-00-00 is a less precise 2024-05-03.
  return (targetKey, sourceKey) => {
    const compatible = (a: string, b: string) => a.split("-").every((part, i) => /^0+$/.test(part) || part === b.split("-")[i]);
    if (compatible(targetKey, sourceKey) && !compatible(sourceKey, targetKey)) return "Source date is more precise.";
    if (compatible(sourceKey, targetKey) && !compatible(targetKey, sourceKey)) return "My Library date is more precise.";
    return undefined;
  };
}

/** Order, creator type and names, with initials kept distinct from full names (`Smith, J.` ≠ `Smith, Jane`). */
function creatorsKey(creators: readonly RecordCreator[]): string {
  return creators.map((creator) => [
    creator.creatorType,
    normalizeText(creator.name ?? creator.lastName ?? ""),
    normalizeText(creator.firstName ?? "")
  ].join("|")).join("||");
}
