import { describe, expect, it } from "vitest";
import { auditCrossLibraries } from "../../src/audit/crossLibraryAudit.js";
import type { ScannedItem } from "../../src/matching/types.js";
import { applyLinkPreview, linkPairKey, linkPreviewModel, staleLinkCandidates } from "../../src/write/linkRepair.js";

const MY = 1;
function item(libraryID: number, itemKey: string, title: string, extra: Partial<ScannedItem> & { doi?: string } = {}): ScannedItem {
  const { doi, ...rest } = extra;
  return {
    ref: { libraryID, libraryName: libraryID === MY ? "My Library" : `Group ${libraryID}`, itemKey, version: 1 },
    itemType: "journalArticle",
    fields: { title, date: "2020", ...(doi ? { doi } : {}) },
    creators: [{ lastName: "Wszola", firstName: "Lyndsie" }],
    ...rest
  };
}
const linkTo = (libraryID: number, itemKey: string) => ({ linkedItems: [{ libraryID, itemKey }] });

describe("Outdated links — which pairs are offered (docs/stale-link-removal.md)", () => {
  // Real case #1: one record repurposed into a different paper after copying.
  const stale = [
    item(MY, "MINE1", "Use and expenditures on public access hunting lands", { doi: "10.1016/j.jort.2019.100256", ...linkTo(5, "GRP1") }),
    item(5, "GRP1", "Public access for pheasant hunters: understanding an emerging need", { doi: "10.1002/jwmg.21785" })
  ];

  it("offers a link whose titles diverged, stored on the My Library item, with the denial evidence", () => {
    const { offered } = staleLinkCandidates(auditCrossLibraries(stale, MY), MY);
    expect(offered.map((pair) => [pair.target.itemKey, pair.linked.itemKey, pair.linked.libraryName])).toEqual([["MINE1", "GRP1", "Group 5"]]);
    expect(offered[0]?.evidence.join(" ")).toContain("Normalized DOIs differ.");
    expect(offered[0]?.linkedDetail).toBe("journalArticle · 2020 · 10.1002/jwmg.21785");
  });

  it("does NOT offer a same-title pair the rules deny: the link is right, one record's data is wrong (fix by hand)", () => {
    const wrongDOI = [
      item(MY, "MINE2", "Beyond water data: benefits to volunteers", { doi: "10.1177/2514848619834849", ...linkTo(5, "GRP2") }),
      item(5, "GRP2", "Beyond water data: benefits to volunteers", { doi: "10.1080/09640568.2017.1415869" })
    ];
    const { offered, notOffered } = staleLinkCandidates(auditCrossLibraries(wrongDOI, MY), MY);
    expect(offered).toEqual([]);
    expect(notOffered[0]?.reason).toContain("titles still agree");
  });

  it("does NOT offer a link stored on the group copy: this tool never edits a group item", () => {
    const groupSide = [item(MY, "MINE3", "Use and expenditures on public access hunting lands"), item(5, "GRP3", "Public access for pheasant hunters", linkTo(MY, "MINE3"))];
    const { offered, notOffered } = staleLinkCandidates(auditCrossLibraries(groupSide, MY), MY);
    expect(offered).toEqual([]);
    expect(notOffered[0]?.reason).toContain("stored on the group copy");
  });

  it("does NOT offer a group ↔ group link", () => {
    const groups = [item(4, "G4", "Use and expenditures on public access hunting lands", linkTo(5, "G5")), item(5, "G5", "Public access for pheasant hunters")];
    expect(staleLinkCandidates(auditCrossLibraries(groups, MY), MY).offered).toEqual([]);
  });

  it("an intact link (rules agree) is never a candidate", () => {
    const intact = [item(MY, "MINE4", "Same paper", linkTo(5, "GRP4")), item(5, "GRP4", "Same paper")];
    expect(staleLinkCandidates(auditCrossLibraries(intact, MY), MY)).toEqual({ offered: [], notOffered: [] });
  });

  it("Cancel → nothing; only ticked, offered keys survive the window", () => {
    const candidates = staleLinkCandidates(auditCrossLibraries(stale, MY), MY);
    const key = linkPairKey(candidates.offered[0]!);
    expect(linkPreviewModel(candidates).rows.map((row) => row.key)).toEqual([key]);
    expect(applyLinkPreview(candidates, { confirmed: false, checkedKeys: [key] })).toBeUndefined();
    expect(applyLinkPreview(candidates, { confirmed: true, checkedKeys: ["1:MINE9>5:GRP9"] })).toEqual([]);
    expect(applyLinkPreview(candidates, { confirmed: true, checkedKeys: [key] })?.map((pair) => pair.target.itemKey)).toEqual(["MINE1"]);
  });
});
