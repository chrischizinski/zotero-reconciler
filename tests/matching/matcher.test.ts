import { describe, expect, it } from "vitest";
import { matchItems } from "../../src/matching/matcher.js";
import { normalizeISBN, normalizeItem } from "../../src/matching/normalize.js";
import type { ScannedItem } from "../../src/matching/types.js";

function item(overrides: Partial<ScannedItem> & { fields?: ScannedItem["fields"] } = {}): ScannedItem {
  const { fields: fieldOverrides, ...itemOverrides } = overrides;
  return {
    ref: { libraryID: 1, libraryName: "My Library", itemKey: "AAAA1111", version: 1 },
    itemType: "journalArticle",
    fields: { title: "Effects of harvest regulations on waterfowl hunters", date: "2024", ...fieldOverrides },
    creators: [{ lastName: "Smith", firstName: "Jane" }],
    ...itemOverrides
  };
}

describe("normalization", () => {
  it("canonicalizes ISBN-10 and ISBN-13 to the same valid ISBN-13", () => {
    expect(normalizeISBN("0-306-40615-2")).toBe("9780306406157");
    expect(normalizeISBN("978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeISBN("978-0-306-40615-8")).toBeUndefined();
  });

  it("reads PMID from Extra", () => {
    expect(normalizeItem(item({ fields: { title: "A", extra: "PMID: 38472910" } })).identifiers.pmid).toBe("38472910");
  });
});

describe("matching regression fixtures (§46)", () => {
  it("matches DOI proxy and case variants exactly (Tier 1, §7 DOI normalization)", () => {
    const result = matchItems(item({ fields: { title: "A", doi: "10.1002/JWMG.12345" } }), item({ fields: { title: "B", doi: "https://doi.org/10.1002/jwmg.12345" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "exact" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 1", detail: "doi identical." });
  });

  it("matches ISBN-10 against its ISBN-13 form (Tier 1, §7 ISBN canonicalization)", () => {
    const result = matchItems(item({ itemType: "book", fields: { title: "A", isbn: "0-306-40615-2" } }), item({ itemType: "book", fields: { title: "B", isbn: "978-0-306-40615-7" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "exact" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 1", detail: "isbn13 identical." });
  });

  it("matches on a PMID that lives only in Extra (Tier 1, §7 extra parsing)", () => {
    const result = matchItems(item({ fields: { title: "A", extra: "PMID: 38472910" } }), item({ fields: { title: "B", extra: "PMID: 38472910" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "exact" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 1", detail: "pmid identical." });
  });

  it("blocks same-looking records with conflicting DOIs (D1)", () => {
    const result = matchItems(item({ fields: { doi: "10.1/one" } }), item({ fields: { doi: "10.1/two" } }));
    expect(result).toMatchObject({ verdict: "no-match" });
    expect(result.evidence[0]).toMatchObject({ rule: "D1" });
  });

  it("does not let print versus electronic ISSN affect a supported match (§8.0 ISSN is not a denial)", () => {
    const result = matchItems(item({ fields: { issn: "0021-9010" } }), item({ fields: { issn: "1939-1854" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "high" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 2" });
  });

  it("matches records one publication year apart (Tier 2, §7 ±1 year)", () => {
    const result = matchItems(item({ fields: { date: "2019" } }), item({ fields: { date: "2020" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "high" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 2" });
  });

  it("blocks records three publication years apart (D5)", () => {
    const result = matchItems(item({ fields: { date: "2019" } }), item({ fields: { date: "2022" } }));
    expect(result).toMatchObject({ verdict: "no-match", tier: "none" });
    expect(result.evidence[0]).toMatchObject({ rule: "D5" });
  });

  it("blocks substituted topic words (D7, §8.3 SUBSTITUTION)", () => {
    const result = matchItems(item({ fields: { title: "Effects of harvest regulations on duck hunters" } }), item({ fields: { title: "Effects of harvest regulations on goose hunters" } }));
    expect(result).toMatchObject({ verdict: "no-match", titleRelation: "substitution" });
    expect(result.evidence[0]).toMatchObject({ rule: "D7" });
  });

  it("blocks consecutive annual reports whose only difference is the year token (D7, §8.3 SUBSTITUTION)", () => {
    const result = matchItems(item({ fields: { title: "Annual report 2019", date: "2019" } }), item({ fields: { title: "Annual report 2020", date: "2020" } }));
    expect(result).toMatchObject({ verdict: "no-match", titleRelation: "substitution" });
    expect(result.evidence[0]).toMatchObject({ rule: "D7" });
  });

  it("matches an addition-only subtitle and records the relation (Tier 2, §8.3 ADDITION-ONLY)", () => {
    const result = matchItems(item({ fields: { title: "Harvest of mallards" } }), item({ fields: { title: "Harvest of mallards: a regional review" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "high", titleRelation: "addition-only" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 2", detail: "Title relation: addition-only." });
  });

  it("treats hyphenation as punctuation (Tier 2, §7 punctuation → space)", () => {
    const result = matchItems(item({ fields: { title: "Long-term trends in mallard harvest" } }), item({ fields: { title: "Long term trends in mallard harvest" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "high", titleRelation: "equivalent" });
  });

  it("ignores trailing punctuation and case (Tier 2, §7 trim/case)", () => {
    const result = matchItems(item({ fields: { title: "Harvest of Mallards." } }), item({ fields: { title: "harvest of mallards" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "high", titleRelation: "equivalent" });
  });

  it("permits creator order changes because any shared creator key is enough (§7 any-creator rule)", () => {
    const result = matchItems(item({ creators: [{ lastName: "Smith", firstName: "Jane" }, { lastName: "Jones", firstName: "A" }] }), item({ creators: [{ lastName: "Jones", firstName: "Andrew" }, { lastName: "Smith", firstName: "J" }] }));
    expect(result).toMatchObject({ verdict: "match", tier: "high" });
  });

  it("matches creatorless records only when both records are creatorless (§7 creatorless rule)", () => {
    expect(matchItems(item({ creators: [] }), item({ creators: [] }))).toMatchObject({ verdict: "match", tier: "high" });
    const mixed = matchItems(item({ creators: [] }), item());
    expect(mixed).toMatchObject({ verdict: "no-match" });
    expect(mixed.evidence[0]).toMatchObject({ rule: "Tier 4" });
  });

  it("matches corporate authors on the exact normalized string (§7 single-field mode)", () => {
    const result = matchItems(
      item({ creators: [{ lastName: "U.S. Fish and Wildlife Service", fieldMode: 1 }] }),
      item({ creators: [{ lastName: "u.s. fish and wildlife service", fieldMode: 1 }] })
    );
    expect(result).toMatchObject({ verdict: "match", tier: "high" });
  });

  it("does not match an abbreviated corporate author (§7 single-field mode)", () => {
    const result = matchItems(
      item({ creators: [{ lastName: "U.S. Fish and Wildlife Service", fieldMode: 1 }] }),
      item({ creators: [{ lastName: "USFWS", fieldMode: 1 }] })
    );
    expect(result).toMatchObject({ verdict: "no-match" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 4" });
  });

  it("classifies preprint and journal article as related rather than a match (§8.4)", () => {
    const result = matchItems(item({ itemType: "preprint" }), item({ itemType: "journalArticle" }));
    expect(result).toMatchObject({ verdict: "related", tier: "none", typeRelation: "related" });
    expect(result.evidence[0]).toMatchObject({ rule: "§8.4" });
  });

  it("classifies conference paper and journal article as related rather than a match (§8.4)", () => {
    const result = matchItems(item({ itemType: "conferencePaper" }), item({ itemType: "journalArticle" }));
    expect(result).toMatchObject({ verdict: "related", tier: "none", typeRelation: "related" });
    expect(result.evidence[0]).toMatchObject({ rule: "§8.4" });
  });

  it("does not classify unrelated preprints and articles as related (Tier 4)", () => {
    const result = matchItems(
      item({ itemType: "preprint", fields: { title: "Waterfowl harvest management", date: "2024" } }),
      item({ itemType: "journalArticle", fields: { title: "Urban tree canopy planning", date: "2024" } })
    );
    expect(result).toMatchObject({ verdict: "no-match", typeRelation: "related" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 4" });
  });

  it("matches a preprint and journal article that share a DOI, naming the article canonical (Tier 1 + §8.4 decision)", () => {
    const result = matchItems(item({ itemType: "preprint", fields: { title: "A", doi: "10.1/z" } }), item({ itemType: "journalArticle", fields: { title: "A", doi: "10.1/z" } }));
    expect(result).toMatchObject({ verdict: "match", tier: "exact", typeRelation: "related" });
    expect(result.evidence).toEqual([
      { rule: "Tier 1", detail: "doi identical." },
      { rule: "§8.4", detail: "Related item types share an identifier; journalArticle is the canonical record." }
    ]);
  });

  it("does not match a book section with its parent book (D6, §8.4 part vs. whole)", () => {
    const result = matchItems(item({ itemType: "bookSection", fields: { isbn: "0-306-40615-2" } }), item({ itemType: "book", fields: { isbn: "0-306-40615-2" } }));
    expect(result).toMatchObject({ verdict: "no-match" });
    expect(result.evidence[0]).toMatchObject({ rule: "D6" });
  });

  it("does not match a dataset and an article merely because their titles agree (D6, §8.4)", () => {
    const result = matchItems(item({ itemType: "dataset" }), item({ itemType: "journalArticle" }));
    expect(result).toMatchObject({ verdict: "no-match" });
    expect(result.evidence[0]).toMatchObject({ rule: "D6" });
  });

  it("keeps a thesis and the journal article derived from it apart, even with identical title, author, and year (D6, decision 2026-09-17)", () => {
    const result = matchItems(item({ itemType: "thesis", fields: { date: "2014" } }), item({ itemType: "journalArticle", fields: { date: "2015" } }));
    expect(result).toMatchObject({ verdict: "no-match", typeRelation: "incompatible" });
    expect(result.evidence[0]).toMatchObject({ rule: "D6" });
  });

  it("routes a one-character title typo to manual review (Tier 3)", () => {
    const result = matchItems(item({ fields: { title: "Waterfowl harvest management" } }), item({ fields: { title: "WaterfowI harvest management" } }));
    expect(result).toMatchObject({ verdict: "review", tier: "review" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 3" });
  });

});

describe("rules learned from real-library validation (2026-09-17)", () => {
  it("does not treat a shared ISBN as identity for book sections: chapters of one volume share it", () => {
    const result = matchItems(
      item({ itemType: "bookSection", fields: { title: "Co-management in Alaska", date: "2023", isbn: "978-1-4214-4657-8" } }),
      item({ itemType: "bookSection", fields: { title: "Research with tribes", date: "2023", isbn: "978-1-4214-4657-8" } })
    );
    expect(result).toMatchObject({ verdict: "no-match", tier: "none" });
    expect(result.evidence[0]).toMatchObject({ rule: "D7" });
  });

  it("still denies book sections whose ISBNs differ (D2) and matches books whose ISBNs agree (Tier 1)", () => {
    const denied = matchItems(item({ itemType: "bookSection", fields: { isbn: "0-306-40615-2" } }), item({ itemType: "bookSection", fields: { isbn: "978-1-4214-4657-8" } }));
    expect(denied.evidence[0]).toMatchObject({ rule: "D2" });
    expect(matchItems(item({ itemType: "book", fields: { isbn: "0-306-40615-2" } }), item({ itemType: "book", fields: { title: "Other", isbn: "978-0-306-40615-7" } }))).toMatchObject({ tier: "exact" });
  });

  it("requires ADDITION-ONLY to be an ordered prefix, not a word subset", () => {
    const subset = matchItems(
      item({ fields: { title: "The common carp", date: "2011" } }),
      item({ fields: { title: "Using boat electrofishing to estimate the abundance of invasive common carp", date: "2012" } })
    );
    expect(subset).toMatchObject({ verdict: "no-match", titleRelation: "substitution" });
    expect(subset.evidence[0]).toMatchObject({ rule: "D7" });
    expect(matchItems(item({ fields: { title: "Governing the commons" } }), item({ fields: { title: "Governing the commons: the evolution of institutions for collective action" } })))
      .toMatchObject({ verdict: "match", titleRelation: "addition-only" });
  });

  it("does not let a one-word title be a prefix of anything", () => {
    const result = matchItems(item({ itemType: "bookSection", fields: { title: "Introduction" } }), item({ itemType: "bookSection", fields: { title: "An introduction to Indian reserved water rights" } }));
    expect(result).toMatchObject({ verdict: "no-match", titleRelation: "substitution" });
  });

  it("routes an edition marker in the added words to review, because editions are related works (§8.4)", () => {
    const result = matchItems(item({ itemType: "book", fields: { title: "Human dimensions of wildlife management", date: "2012" } }), item({ itemType: "book", fields: { title: "Human dimensions of wildlife management, second edition", date: "2012" } }));
    expect(result).toMatchObject({ verdict: "review", tier: "review", titleRelation: "addition-only" });
    expect(result.evidence[0]).toMatchObject({ rule: "§8.4" });
  });

  it("folds typographic quotes and dashes so they do not become title substitutions ([DIVERGES] from Zotero)", () => {
    expect(matchItems(item({ fields: { title: "Deer hunting on Pennsylvania’s public and private lands" } }), item({ fields: { title: "Deer hunting on Pennsylvania's public and private lands" } })))
      .toMatchObject({ verdict: "match", tier: "high", titleRelation: "equivalent" });
    expect(matchItems(item({ fields: { title: "The role of cognitions in human–coyote interactions" } }), item({ fields: { title: "The role of cognitions in human-coyote interactions" } })))
      .toMatchObject({ verdict: "match", tier: "high", titleRelation: "equivalent" });
  });
});

describe("Tier 0 — Zotero linked items (§8.0)", () => {
  const group = (overrides: Partial<ScannedItem> & { fields?: ScannedItem["fields"] } = {}): ScannedItem =>
    item({ ref: { libraryID: 2, libraryName: "Group", itemKey: "BBBB2222", version: 1 }, ...overrides });

  it("matches at EXACT when Zotero recorded that one record was copied from the other, even with no shared bibliographic evidence", () => {
    // The user made this copy; the relation is an assertion, not an inference. Titles differ
    // completely here so nothing else could have produced the match.
    const copy = group({ fields: { title: "Completely different title", date: "1999" }, creators: [{ lastName: "Nobody" }], linkedItems: [{ libraryID: 1, itemKey: "AAAA1111" }] });
    const result = matchItems(item(), copy);
    expect(result).toMatchObject({ verdict: "match", tier: "exact" });
    expect(result.evidence[0]).toMatchObject({ rule: "Tier 0" });
    // Zotero writes the relation on the copy only; direction must not matter.
    expect(matchItems(copy, item())).toMatchObject({ verdict: "match", tier: "exact" });
  });

  it("outranks D6: a linked copy whose type was later changed is still the same record", () => {
    const retyped = group({ itemType: "report", linkedItems: [{ libraryID: 1, itemKey: "AAAA1111" }] });
    expect(matchItems(item(), retyped)).toMatchObject({ verdict: "match", tier: "exact" });
    expect(matchItems(item(), group({ itemType: "report" }))).toMatchObject({ verdict: "no-match" });
  });

  it("ignores links that point at a different item", () => {
    const other = group({ fields: { title: "Completely different title", date: "1999" }, linkedItems: [{ libraryID: 1, itemKey: "ZZZZ9999" }] });
    expect(matchItems(item(), other)).toMatchObject({ verdict: "no-match" });
  });

  it("can be switched off so the bibliographic rules alone are audited against Zotero's links", () => {
    const copy = group({ fields: { title: "Completely different title", date: "1999" }, linkedItems: [{ libraryID: 1, itemKey: "AAAA1111" }] });
    expect(matchItems(item(), copy, { ignoreLinkedItems: true })).toMatchObject({ verdict: "no-match" });
  });
});
