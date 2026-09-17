import { describe, expect, it } from "vitest";
import { normalizeItem } from "../../src/matching/normalize.js";
import type { ScannedItem } from "../../src/matching/types.js";
import { recallCheck } from "../../src/write/recallCheck.js";

const MY = 1;
const GROUP = 2;

function item(libraryID: number, key: string, overrides: Partial<ScannedItem> & { fields?: ScannedItem["fields"] } = {}): ScannedItem {
  const { fields, ...rest } = overrides;
  return {
    ref: { libraryID, libraryName: libraryID === MY ? "My Library" : "Group", itemKey: key, version: 1 },
    itemType: "journalArticle",
    fields: { title: "Waterfowl harvest management under uncertainty", date: "2025", ...fields },
    creators: [{ lastName: "Lee", firstName: "S" }],
    ...rest
  };
}

const check = (candidate: ScannedItem, mine: ScannedItem[]) => recallCheck(normalizeItem(candidate), mine.map(normalizeItem));

describe("recall re-check before import (§48.1) — the §47 pairs the precision matcher must NOT match must appear here", () => {
  it("surfaces a same-title record the precision pass denied for its item type (thesis ↔ article)", () => {
    const result = check(item(GROUP, "G"), [item(MY, "M", { itemType: "thesis" })]);
    expect(result.alreadyPresent).toBeUndefined();
    expect(result.nearMisses).toHaveLength(1);
    expect(result.nearMisses[0]).toMatchObject({ reason: "same-title", evidence: expect.stringMatching(/incompatible/) });
  });

  it("surfaces a wrong-DOI-in-one-library pair (D1 denied it; the user decides which DOI is wrong)", () => {
    const result = check(item(GROUP, "G", { fields: { doi: "10.1/right" } }), [item(MY, "M", { fields: { doi: "10.1/wrong" } })]);
    expect(result.nearMisses[0]).toMatchObject({ reason: "same-title", evidence: expect.stringMatching(/DOIs differ/) });
  });

  it("ranks a shared identifier first even when types are incompatible (dataset with the article's DOI)", () => {
    const result = check(
      item(GROUP, "G", { fields: { doi: "10.1/a" } }),
      [item(MY, "M1", { itemType: "thesis" }), item(MY, "M2", { itemType: "dataset", fields: { title: "Supplementary data", doi: "10.1/a" } })]
    );
    expect(result.nearMisses.map(({ reason }) => reason)).toEqual(["shared-identifier", "same-title"]);
  });

  it("surfaces the erratum, the 'year off by two' (D5) and the substituted-word title, given a shared author", () => {
    const mine = [
      item(MY, "ERR", { fields: { title: "Erratum: Waterfowl harvest management under uncertainty" } }),
      item(MY, "Y", { fields: { date: "2023" } }),
      item(MY, "SUB", { fields: { title: "Waterfowl harvest management under certainty" } })
    ];
    const result = check(item(GROUP, "G"), mine);
    expect(result.alreadyPresent).toBeUndefined();
    const byKey = Object.fromEntries(result.nearMisses.map((miss) => [miss.item.ref.itemKey, miss]));
    // "Erratum:" is a leading addition, which the ordered-prefix rule (§8.3) treats as substitution.
    expect(byKey.ERR?.reason).toBe("similar-title");
    expect(byKey.SUB?.reason).toBe("similar-title");
    expect(byKey.Y).toMatchObject({ reason: "same-title", evidence: expect.stringMatching(/years differ/i) });
  });

  it("reports 'already present' and no near-misses when the precision rules now match (index was stale)", () => {
    const result = check(item(GROUP, "G"), [item(MY, "M")]);
    expect(result.alreadyPresent?.ref.itemKey).toBe("M");
    expect(result.nearMisses).toEqual([]);
  });

  it("uses the opening words as a last net only with a shared author or adjacent year, and stays quiet on unrelated records", () => {
    // Different author, same year, same first three content words → last-resort net.
    const opening = item(MY, "OPEN", { fields: { title: "Waterfowl harvest management: a synthesis of state programs" }, creators: [{ lastName: "Other" }] });
    const unrelated = item(MY, "NO", { fields: { title: "Urban forestry outcomes in Ohio" }, creators: [{ lastName: "Jones" }] });
    const strangerSameOpening = item(MY, "STR", { fields: { title: "Waterfowl harvest management: a synthesis of state programs", date: "1990" }, creators: [{ lastName: "Nobody" }] });
    const result = check(item(GROUP, "G"), [opening, unrelated, strangerSameOpening]);
    expect(result.nearMisses.map((miss) => miss.item.ref.itemKey)).toEqual(["OPEN"]);
    expect(result.nearMisses[0]?.reason).toBe("same-opening-words");
  });
});
