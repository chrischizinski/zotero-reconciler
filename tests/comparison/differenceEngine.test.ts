import { describe, expect, it } from "vitest";
import { compareRecords, type FieldRecord, type RecordCreator, type RecordField } from "../../src/comparison/differenceEngine.js";

const MY = { libraryID: 1, libraryName: "My Library", itemKey: "MINE0001", version: 1 };
const TEXTBOOK = { libraryID: 2, libraryName: "Textbook", itemKey: "TEXT0001", version: 1 };
const WATERFOWL = { libraryID: 3, libraryName: "Waterfowl", itemKey: "WATR0001", version: 1 };

const author = (lastName: string, firstName: string, creatorType = "author"): RecordCreator => ({ creatorType, lastName, firstName });

function record(ref: FieldRecord["ref"], values: Record<string, string | RecordField>, options: Partial<FieldRecord> = {}): FieldRecord {
  const fields: FieldRecord["fields"] = {};
  for (const [field, value] of Object.entries(values)) {
    (fields as Record<string, RecordField>)[field] = typeof value === "string" ? { name: field, value } : value;
  }
  return { ref, itemType: "journalArticle", fields, creators: [], validCreatorTypes: ["author", "editor", "contributor"], ...options };
}

const field = (differences: ReturnType<typeof compareRecords>, name: string) => differences.find((difference) => difference.field === name);

describe("Difference Engine — missing is not conflicting (§38)", () => {
  it("target empty and every source agrees → MISSING in target: the one safe recommendation", () => {
    const differences = compareRecords(record(MY, { issue: "" }), [record(TEXTBOOK, { issue: "4" }), record(WATERFOWL, { issue: "4" })]);
    const issue = field(differences, "issue");
    expect(issue?.class).toBe("MISSING");
    expect(issue?.missingIn).toBe("target");
    expect(issue?.alternatives).toHaveLength(1);
    expect(issue?.alternatives[0]?.sources).toEqual([TEXTBOOK, WATERFOWL]);
  });

  it("target 3, sources agree on 4 → DIFFERENT, never MISSING: a value would be overwritten", () => {
    const issue = field(compareRecords(record(MY, { issue: "3" }), [record(TEXTBOOK, { issue: "4" }), record(WATERFOWL, { issue: "4" })]), "issue");
    expect(issue?.class).toBe("DIFFERENT");
    expect(issue?.alternatives.map(({ value }) => value)).toEqual(["4"]);
  });

  it("target empty, sources disagree → CONFLICTING: there is no single value to recommend", () => {
    const issue = field(compareRecords(record(MY, { issue: "" }), [record(TEXTBOOK, { issue: "4" }), record(WATERFOWL, { issue: "5" })]), "issue");
    expect(issue?.class).toBe("CONFLICTING");
    expect(issue?.missingIn).toBeUndefined();
    expect(issue?.alternatives).toHaveLength(2);
  });

  it("target 3, sources 3 and 4 → CONFLICTING: the sources themselves disagree", () => {
    const issue = field(compareRecords(record(MY, { issue: "3" }), [record(TEXTBOOK, { issue: "3" }), record(WATERFOWL, { issue: "4" })]), "issue");
    expect(issue?.class).toBe("CONFLICTING");
    expect(issue?.alternatives.map(({ value }) => value)).toEqual(["4"]);
  });

  it("only My Library has a value → MISSING in sources, nothing to offer", () => {
    const pages = field(compareRecords(record(MY, { pages: "1-10" }), [record(TEXTBOOK, { pages: "" })]), "pages");
    expect(pages?.class).toBe("MISSING");
    expect(pages?.missingIn).toBe("sources");
    expect(pages?.alternatives).toHaveLength(0);
  });

  it("empty everywhere → no row at all", () => {
    expect(field(compareRecords(record(MY, { rights: "" }), [record(TEXTBOOK, { rights: "" })]), "rights")).toBeUndefined();
  });
});

describe("Difference Engine — format-only differences are IDENTICAL with a visible note (decision C)", () => {
  it("en dash vs hyphen in pages is not offered for copying", () => {
    const pages = field(compareRecords(record(MY, { pages: "1021-1034" }), [record(TEXTBOOK, { pages: "1021–1034" })]), "pages");
    expect(pages?.class).toBe("IDENTICAL");
    expect(pages?.alternatives).toHaveLength(0);
    expect(pages?.notes[0]).toContain("Formatting differs only");
  });

  it("title case difference is format-only", () => {
    const title = field(compareRecords(record(MY, { title: "Waterfowl harvest" }), [record(TEXTBOOK, { title: "Waterfowl Harvest" })]), "title");
    expect(title?.class).toBe("IDENTICAL");
  });

  it("issue 3(4) vs 34 is a real difference: numbers are not compared with the title normalizer", () => {
    const issue = field(compareRecords(record(MY, { issue: "3(4)" }), [record(TEXTBOOK, { issue: "34" })]), "issue");
    expect(issue?.class).toBe("DIFFERENT");
  });

  it("DOI in URL form vs bare DOI is format-only", () => {
    const doi = field(compareRecords(record(MY, { DOI: "10.1002/jwmg.12345" }), [record(TEXTBOOK, { DOI: "https://doi.org/10.1002/JWMG.12345" })]), "DOI");
    expect(doi?.class).toBe("IDENTICAL");
  });
});

describe("Difference Engine — dates compare on the reader's SQL key, with precision notes", () => {
  const date = (value: string, key: string): RecordField => ({ name: "date", value, key });

  it("same day written two ways is format-only", () => {
    const result = field(compareRecords(record(MY, { date: date("May 3, 2024", "2024-05-03") }), [record(TEXTBOOK, { date: date("2024-05-03", "2024-05-03") })]), "date");
    expect(result?.class).toBe("IDENTICAL");
  });

  it("year-only target vs full source date is DIFFERENT with a note, never MISSING", () => {
    const result = field(compareRecords(record(MY, { date: date("2024", "2024-00-00") }), [record(TEXTBOOK, { date: date("2024-05-03", "2024-05-03") })]), "date");
    expect(result?.class).toBe("DIFFERENT");
    expect(result?.notes).toContain("Source date is more precise.");
  });
});

describe("Difference Engine — fields that do not exist on the target's type are shown, not offered", () => {
  it("a book has no issue field: the row says why", () => {
    const issue = field(compareRecords(record(MY, {}, { itemType: "book" }), [record(TEXTBOOK, { issue: "4" })]), "issue");
    expect(issue?.targetName).toBeUndefined();
    expect(issue?.notOffered).toBe("book has no issue field");
  });

  it("base-mapped fields compare across types and keep each side's field name", () => {
    const target = record(MY, { publicationTitle: { name: "bookTitle", value: "" } }, { itemType: "bookSection" });
    const pub = field(compareRecords(target, [record(TEXTBOOK, { publicationTitle: "Waterfowl Management" })]), "publicationTitle");
    expect(pub?.class).toBe("MISSING");
    expect(pub?.targetName).toBe("bookTitle");
    expect(pub?.alternatives[0]?.sourceName).toBe("publicationTitle");
  });
});

describe("Difference Engine — creators as one unit (decision E)", () => {
  it("initials vs full first name is DIFFERENT, not identical", () => {
    const creators = field(compareRecords(record(MY, {}, { creators: [author("Smith", "J.")] }), [record(TEXTBOOK, {}, { creators: [author("Smith", "Jane")] })]), "creators");
    expect(creators?.class).toBe("DIFFERENT");
  });

  it("author vs editor with the same name is DIFFERENT: the creator type is part of the value", () => {
    const creators = field(compareRecords(record(MY, {}, { creators: [author("Smith", "Jane")] }), [record(TEXTBOOK, {}, { creators: [author("Smith", "Jane", "editor")] })]), "creators");
    expect(creators?.class).toBe("DIFFERENT");
  });

  it("a creator type the target type does not accept is not offered (Zotero would silently turn it into an author)", () => {
    const target = record(MY, {}, { validCreatorTypes: ["author"] });
    const creators = field(compareRecords(target, [record(TEXTBOOK, {}, { creators: [author("Lucas", "George", "director")] })]), "creators");
    expect(creators?.class).toBe("MISSING");
    expect(creators?.notOffered).toContain("creator type");
  });
});
