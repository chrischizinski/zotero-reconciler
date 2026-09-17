import { normalizeDOI, normalizeISBN, normalizeText } from "../matching/normalize.js";
import type { ScannedItem } from "../matching/types.js";

export interface FieldDifference {
  field: "title" | "date" | "doi" | "isbn" | "creators";
  left: string;
  right: string;
}

export function compareBibliographicFields(left: ScannedItem, right: ScannedItem): readonly FieldDifference[] {
  const differences: FieldDifference[] = [];
  compare(differences, "title", left.fields.title, right.fields.title, normalizeText);
  compare(differences, "date", left.fields.date, right.fields.date, normalizeDate);
  compare(differences, "doi", left.fields.doi, right.fields.doi, (value) => normalizeDOI(value) ?? "");
  compare(differences, "isbn", left.fields.isbn, right.fields.isbn, (value) => normalizeISBN(value) ?? "");
  compare(differences, "creators", creatorDisplay(left), creatorDisplay(right), normalizeText);
  return differences;
}

function compare(differences: FieldDifference[], field: FieldDifference["field"], left: string | undefined, right: string | undefined, normalize: (value: string) => string): void {
  if (!left || !right || normalize(left) === normalize(right)) return;
  differences.push({ field, left, right });
}

function normalizeDate(value: string): string {
  return value.match(/^\d{4}/)?.[0] ?? normalizeText(value);
}

function creatorDisplay(item: ScannedItem): string {
  return item.creators.map((creator) => `${creator.lastName}, ${creator.firstName ?? ""}`).join("; ");
}
