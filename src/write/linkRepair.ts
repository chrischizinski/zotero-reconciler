import type { CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import { linkKey } from "../matching/links.js";
import type { ScannedItem } from "../matching/types.js";
import type { WriteItemRef } from "./writeApi.js";

/**
 * "Review Outdated Zotero Links…" PROPOSE → PREVIEW → CONFIRM as data
 * (docs/stale-link-removal.md). A Zotero `owl:sameAs` link proves a copy event, not that the
 * records still describe one work; a link whose records have since diverged blocks both our
 * import and Zotero's own drag-copy, and Zotero has no UI to remove it. Only links whose
 * TITLES diverged are offered — a same-title pair the rules deny means the data is wrong, not
 * the link — and nothing is pre-ticked.
 */

export interface LinkPair {
  /** The My Library item that stores the relation (Zotero keeps it on the user-library side). */
  target: WriteItemRef & { title: string };
  /** The group item the relation points at. Never written. */
  linked: WriteItemRef & { title: string; libraryName: string };
  /** Why the rules deny the pair, for the preview and the log. */
  evidence: readonly string[];
  /** `journalArticle · 2020 · 10.1016/…` per side, for the preview. */
  targetDetail: string;
  linkedDetail: string;
}

export interface NotOfferedLink {
  title: string;
  reason: string;
}

export interface LinkCandidates {
  offered: readonly LinkPair[];
  notOffered: readonly NotOfferedLink[];
}

export function staleLinkCandidates(audit: CrossLibraryAudit, myLibraryID: number): LinkCandidates {
  const offered: LinkPair[] = [];
  const notOffered: NotOfferedLink[] = [];
  for (const pair of audit.linkedButUnmatched) {
    const mine = pair.left.ref.libraryID === myLibraryID ? pair.left : pair.right.ref.libraryID === myLibraryID ? pair.right : undefined;
    const other = mine === pair.left ? pair.right : pair.left;
    const label = `${pair.left.fields.title || "Untitled"} / ${pair.right.fields.title || "Untitled"}`;
    if (!mine || other.ref.libraryID === myLibraryID) { notOffered.push({ title: label, reason: "neither copy is in My Library; only My Library items are edited" }); continue; }
    if (pair.result.titleRelation !== "substitution" && pair.result.titleRelation !== "missing") {
      notOffered.push({ title: label, reason: "the titles still agree, so the link is probably right and one copy holds a wrong identifier or type — fix that record by hand" });
      continue;
    }
    if (!(mine.linkedItems ?? []).some((ref) => linkKey(ref) === linkKey({ libraryID: other.ref.libraryID, itemKey: other.ref.itemKey }))) {
      notOffered.push({ title: label, reason: "the link is stored on the group copy, which this tool never edits" });
      continue;
    }
    offered.push({
      target: { libraryID: mine.ref.libraryID, itemKey: mine.ref.itemKey, title: mine.fields.title || "Untitled" },
      linked: { libraryID: other.ref.libraryID, itemKey: other.ref.itemKey, title: other.fields.title || "Untitled", libraryName: other.ref.libraryName },
      evidence: pair.result.evidence.map(({ detail }) => detail),
      targetDetail: detail(mine),
      linkedDetail: detail(other)
    });
  }
  offered.sort((a, b) => a.target.title.localeCompare(b.target.title));
  return { offered, notOffered };
}

function detail(item: ScannedItem): string {
  return [item.itemType, item.fields.date?.slice(0, 4), item.fields.doi].filter(Boolean).join(" · ");
}

export function linkPairKey(pair: Pick<LinkPair, "target" | "linked">): string {
  return `${pair.target.libraryID}:${pair.target.itemKey}>${pair.linked.libraryID}:${pair.linked.itemKey}`;
}

export interface LinkPreviewModel {
  summary: string;
  rows: readonly { key: string; mine: string; mineDetail: string; theirs: string; theirsDetail: string; evidence: readonly string[] }[];
  notOffered: readonly string[];
}

export interface LinkPreviewResult {
  confirmed: boolean;
  checkedKeys: readonly string[];
}

export function linkPreviewModel(candidates: LinkCandidates): LinkPreviewModel {
  const n = candidates.offered.length;
  return {
    summary: [
      `${n} Zotero link${n === 1 ? "" : "s"} join${n === 1 ? "s" : ""} a My Library item to a group item that now describes a different work (the titles no longer agree).`,
      "While such a link exists, Zotero treats the group item as already copied into My Library, so neither Add Missing Items nor drag-and-drop can bring it in. Zotero offers no way to remove it.",
      "Tick a pair only if you are sure the two records are different works. Removing a link changes nothing else: no field, tag, collection or note, and the group item is never edited."
    ].join("\n"),
    rows: candidates.offered.map((pair) => ({
      key: linkPairKey(pair),
      mine: `My Library: ${pair.target.title}`,
      mineDetail: pair.targetDetail,
      theirs: `${pair.linked.libraryName}: ${pair.linked.title}`,
      theirsDetail: pair.linkedDetail,
      evidence: pair.evidence
    })),
    notOffered: candidates.notOffered.map(({ title, reason }) => `${title} — not offered: ${reason}.`)
  };
}

/** Cancel → nothing. Otherwise only offered pairs the user ticked; an unknown key adds nothing. */
export function applyLinkPreview(candidates: LinkCandidates, result: LinkPreviewResult): LinkPair[] | undefined {
  if (!result.confirmed) return undefined;
  const checked = new Set(result.checkedKeys);
  return candidates.offered.filter((pair) => checked.has(linkPairKey(pair)));
}
