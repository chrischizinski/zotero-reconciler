import type { LinkedRef, ScannedItem } from "./types.js";

/** Stable key for a library-scoped item reference. */
export function linkKey(ref: LinkedRef): string {
  return `${ref.libraryID}:${ref.itemKey}`;
}

/**
 * True when either record carries a Zotero `owl:sameAs` relation pointing at the other.
 * Zotero writes the relation on the copy only, so the check is deliberately one-sided in
 * either direction.
 */
export function areLinked(left: ScannedItem, right: ScannedItem): boolean {
  return pointsTo(left, right) || pointsTo(right, left);
}

function pointsTo(from: ScannedItem, to: ScannedItem): boolean {
  return (from.linkedItems ?? []).some((ref) => ref.libraryID === to.ref.libraryID && ref.itemKey === to.ref.itemKey);
}
