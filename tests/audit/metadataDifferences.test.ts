import { describe, expect, it } from "vitest";
import { metadataDifferenceReport, refKey } from "../../src/audit/metadataDifferences.js";
import type { FieldRecord } from "../../src/comparison/differenceEngine.js";
import type { ItemRef, MatchResult, MatchTier, MatchVerdict, ScannedItem } from "../../src/matching/types.js";
import type { MatchPair } from "../../src/works/scholarlyWorkIndex.js";

const MY = 1;
const ref = (libraryID: number, itemKey: string): ItemRef => ({ libraryID, libraryName: libraryID === MY ? "My Library" : `Group ${libraryID}`, itemKey, version: 1 });
const scanned = (r: ItemRef): ScannedItem => ({ ref: r, itemType: "journalArticle", fields: {}, creators: [] });
const result = (verdict: MatchVerdict, tier: MatchTier): MatchResult => ({ verdict, tier, evidence: [], titleRelation: "equivalent", typeRelation: "compatible" });
const pair = (left: ItemRef, right: ItemRef, verdict: MatchVerdict = "match", tier: MatchTier = "exact"): MatchPair => ({ left: scanned(left), right: scanned(right), result: result(verdict, tier) });

function record(r: ItemRef, values: Record<string, string>): FieldRecord {
  return { ref: r, itemType: "journalArticle", fields: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { name, value }])), creators: [], validCreatorTypes: ["author"] };
}

function records(...list: FieldRecord[]): Map<string, FieldRecord> {
  return new Map(list.map((item) => [refKey(item.ref), item]));
}

const title = (r: ItemRef) => `Title ${r.itemKey}`;

describe("Metadata Differences report — same gate as Compare Copies (§5), read-only", () => {
  it("counts fillable / different / conflicting per My Library item and sorts most fillable first", () => {
    const a = ref(MY, "A"), b = ref(MY, "B"), ga = ref(2, "GA"), gb = ref(2, "GB"), hb = ref(3, "HB");
    const report = metadataDifferenceReport(
      [pair(a, ga), pair(gb, b, "match", "high"), pair(b, hb)],
      MY,
      records(
        record(a, { issue: "", pages: "1-2" }), record(ga, { issue: "4", pages: "1-9" }),
        record(b, { issue: "", volume: "", pages: "" }), record(gb, { issue: "4", volume: "8", pages: "5" }), record(hb, { issue: "4", volume: "9", pages: "5" })
      ),
      title
    );
    expect(report.compared).toBe(2);
    expect(report.items.map((item) => [item.target.itemKey, item.fillable, item.different, item.conflicting])).toEqual([["B", 2, 0, 1], ["A", 1, 1, 0]]);
    expect(report.items[0]?.sourceLibraries).toEqual(["Group 2", "Group 3"]);
  });

  it("REVIEW and POSSIBLE pairs never contribute: a weak match must not even suggest values", () => {
    const a = ref(MY, "A"), ga = ref(2, "GA"), gb = ref(2, "GB");
    const report = metadataDifferenceReport([pair(a, ga, "review", "review"), pair(a, gb, "match", "review")], MY, records(record(a, { issue: "" }), record(ga, { issue: "4" }), record(gb, { issue: "4" })), title);
    expect(report).toEqual({ compared: 0, items: [], unreadable: 0 });
  });

  it("only My Library items are targets: a group↔group pair produces no row", () => {
    const g2 = ref(2, "G2"), g3 = ref(3, "G3");
    const report = metadataDifferenceReport([pair(g2, g3)], MY, records(record(g2, { issue: "" }), record(g3, { issue: "4" })), title);
    expect(report.compared).toBe(0);
  });

  it("an item whose copies are identical (or differ only in formatting) is compared but not listed", () => {
    const a = ref(MY, "A"), ga = ref(2, "GA");
    const report = metadataDifferenceReport([pair(a, ga)], MY, records(record(a, { pages: "1-9" }), record(ga, { pages: "1–9" })), title);
    expect(report.compared).toBe(1);
    expect(report.items).toEqual([]);
  });

  it("an item deleted since the scan is counted as unreadable, not silently dropped", () => {
    const a = ref(MY, "A"), ga = ref(2, "GA");
    const report = metadataDifferenceReport([pair(a, ga)], MY, records(record(ga, { issue: "4" })), title);
    expect(report.unreadable).toBe(1);
  });
});
