import type { CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import type { MatchTier } from "../matching/types.js";
import type { ScholarlyWork } from "./scholarlyWorkIndex.js";

/**
 * Persisted form of the Scholarly Work index (§10, §32). Derived data: it must always be
 * rebuildable by re-running the audit, so it stores references, not bibliographic fields.
 */
export interface IndexSnapshot {
  schemaVersion: 1;
  scannedAt: string;
  libraries: readonly SnapshotLibrary[];
  works: readonly SnapshotWork[];
}

export interface SnapshotLibrary {
  libraryID: number;
  name: string;
  /** Zotero's library version at scan time; a later version means the snapshot may be stale (§29). */
  version: number;
}

export interface SnapshotWork {
  id: string;
  confidence?: MatchTier;
  canonical: SnapshotItemRef;
  items: readonly SnapshotItemRef[];
}

export interface SnapshotItemRef {
  libraryID: number;
  itemKey: string;
  version: number;
}

export interface LibraryVersion {
  libraryID: number;
  name: string;
  version: number;
}

export function createSnapshot(audit: CrossLibraryAudit, libraries: readonly LibraryVersion[], scannedAt: Date): IndexSnapshot {
  return {
    schemaVersion: 1,
    scannedAt: scannedAt.toISOString(),
    libraries: libraries.map(({ libraryID, name, version }) => ({ libraryID, name, version })),
    works: audit.works.map(toSnapshotWork)
  };
}

function toSnapshotWork(work: ScholarlyWork): SnapshotWork {
  return {
    id: work.id,
    ...(work.confidence ? { confidence: work.confidence } : {}),
    canonical: toRef(work.canonical),
    items: work.items.map(toRef)
  };
}

function toRef(item: { ref: SnapshotItemRef }): SnapshotItemRef {
  return { libraryID: item.ref.libraryID, itemKey: item.ref.itemKey, version: item.ref.version };
}

export function isIndexSnapshot(value: unknown): value is IndexSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IndexSnapshot>;
  return candidate.schemaVersion === 1 && typeof candidate.scannedAt === "string" && Array.isArray(candidate.libraries) && Array.isArray(candidate.works);
}

/** In-memory lookup over a snapshot: which other libraries hold the work an item belongs to. */
export class WorkLookup {
  private readonly workByItem = new Map<string, SnapshotWork>();
  private readonly libraryNames: ReadonlyMap<number, string>;

  constructor(readonly snapshot: IndexSnapshot) {
    this.libraryNames = new Map(snapshot.libraries.map((library) => [library.libraryID, library.name]));
    for (const work of snapshot.works) for (const item of work.items) this.workByItem.set(refKey(item), work);
  }

  workFor(libraryID: number, itemKey: string): SnapshotWork | undefined {
    return this.workByItem.get(refKey({ libraryID, itemKey }));
  }

  /** Names of the other libraries holding this item's work, sorted; empty when unique or unknown. */
  alsoIn(libraryID: number, itemKey: string): readonly string[] {
    const work = this.workFor(libraryID, itemKey);
    if (!work) return [];
    const others = new Set(work.items.filter((item) => item.libraryID !== libraryID).map((item) => item.libraryID));
    return [...others].map((id) => this.libraryNames.get(id) ?? `Library ${id}`).sort();
  }

  /**
   * How many items of this item's own library share its work (1 = no same-library copy).
   * Same-library copies are Zotero duplicates, not cross-library coverage, so callers show
   * them separately rather than folding them into `alsoIn`. The audit never compares two
   * items of one library directly (Zotero's Duplicate Items owns that), so this only exceeds
   * 1 when a copy in another library links them transitively.
   */
  copiesHere(libraryID: number, itemKey: string): number {
    const work = this.workFor(libraryID, itemKey);
    if (!work) return 1;
    return work.items.filter((item) => item.libraryID === libraryID).length;
  }
}

/** Libraries whose Zotero version moved since the snapshot, plus any added or removed since. */
export function staleLibraries(snapshot: IndexSnapshot, current: readonly LibraryVersion[]): readonly LibraryVersion[] {
  const snapshotVersions = new Map(snapshot.libraries.map((library) => [library.libraryID, library.version]));
  const changed = current.filter((library) => snapshotVersions.get(library.libraryID) !== library.version);
  const currentIDs = new Set(current.map((library) => library.libraryID));
  const removed = snapshot.libraries.filter((library) => !currentIDs.has(library.libraryID));
  return [...changed, ...removed];
}

function refKey(item: { libraryID: number; itemKey: string }): string {
  return `${item.libraryID}:${item.itemKey}`;
}
