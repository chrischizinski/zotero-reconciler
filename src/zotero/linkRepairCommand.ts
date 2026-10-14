import { auditLibraries, type ZoteroReadAPI } from "./adapter.js";
import type { TransactionStore } from "./transactionStore.js";
import { applyLinkPreview, linkPreviewModel, staleLinkCandidates, type LinkPair, type LinkPreviewModel, type LinkPreviewResult } from "../write/linkRepair.js";
import { lastLinkSession, logEntryID, type LinkLogEntry, type LinkRestoreLogEntry } from "../write/transactionLog.js";
import type { LinkRemovalResult, LinkRestoreStatus, WriteAPI } from "../write/writeApi.js";

/**
 * "Review Outdated Zotero Links…" (docs/stale-link-removal.md). §25 in order: SCAN/MATCH (fresh
 * audit), PROPOSE (linked pairs whose titles diverged, link stored on the My Library item),
 * PREVIEW/CONFIRM (nothing pre-ticked), WRITE (one transaction, compare-and-swap per pair),
 * LOG (one line per pair, shared session, one append) — and the result opens only after the
 * log is on disk. "Undo Last Link Removal…" restores the latest session from the log. Gated by
 * `enableLinkRepair` in `runtime.ts`.
 */

interface XULDocument extends Document {
  createXULElement(name: string): Element;
}

interface ChromeWindow extends Window {
  openDialog(url: string, name: string, features: string, ...args: unknown[]): Window;
}

interface ZoteroLinkUI extends ZoteroReadAPI {
  debug(message: string): void;
  getMainWindow(): Window;
}

const REVIEW_MENU_ID = "zotero-library-reconciler-review-links";
const UNDO_MENU_ID = "zotero-library-reconciler-undo-links";
const PREVIEW_URL = "chrome://zotero-library-reconciler/content/linkPreview.xhtml";
const REPORT_URL = "chrome://zotero-library-reconciler/content/report.xhtml";
const TITLE = "Outdated Zotero Links";

export interface LinkRepairOptions {
  writeAPI: WriteAPI;
  store: TransactionStore;
  now?: () => Date;
  /** Re-runs the audit after a write so the index and "Also in" column reflect the change. */
  refreshIndex?: () => Promise<unknown>;
  openPreview?: (model: LinkPreviewModel) => LinkPreviewResult;
  confirm?: (message: string) => boolean;
  show?: (text: string, title: string) => void;
}

export class LinkRepairCommand {
  private readonly menuItems = new Map<Window, Element[]>();
  private readonly writeAPI: WriteAPI;
  private readonly store: TransactionStore;
  private readonly now: () => Date;
  private readonly refreshIndex: () => Promise<unknown>;
  private readonly openPreview: (model: LinkPreviewModel) => LinkPreviewResult;
  private readonly confirm: (message: string) => boolean;
  private readonly show: (text: string, title: string) => void;
  private busy = false;

  constructor(private readonly zotero: ZoteroLinkUI, options: LinkRepairOptions) {
    this.writeAPI = options.writeAPI;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.refreshIndex = options.refreshIndex ?? (async () => undefined);
    this.openPreview = options.openPreview ?? ((model) => this.openPreviewWindow(model));
    this.confirm = options.confirm ?? (() => false);
    this.show = options.show ?? ((text, title) => this.openReportWindow(text, title));
  }

  register(window: Window = this.zotero.getMainWindow()): void {
    const document = window.document as XULDocument;
    const menu = document.getElementById("menu_ToolsPopup");
    if (!menu || document.getElementById(REVIEW_MENU_ID)) return;
    const review = document.createXULElement("menuitem");
    review.id = REVIEW_MENU_ID;
    review.setAttribute("label", "Review Outdated Zotero Links…");
    review.addEventListener("command", () => void this.run());
    menu.appendChild(review);
    const undo = document.createXULElement("menuitem");
    undo.id = UNDO_MENU_ID;
    undo.setAttribute("label", "Undo Last Link Removal…");
    undo.addEventListener("command", () => void this.undoLast());
    menu.appendChild(undo);
    this.menuItems.set(window, [review, undo]);
  }

  unregister(window?: Window): void {
    const targets = window ? [window] : [...this.menuItems.keys()];
    for (const target of targets) {
      for (const element of this.menuItems.get(target) ?? []) element.remove();
      this.menuItems.delete(target);
    }
  }

  /** Returns the log entries written (undefined when nothing was attempted) so tests can assert on them. */
  async run(): Promise<LinkLogEntry[] | undefined> {
    if (this.busy) { this.show("A link review is already running.", TITLE); return undefined; }
    this.busy = true;
    try {
      const { audit, myLibraryID } = await auditLibraries(this.zotero);
      const candidates = staleLinkCandidates(audit, myLibraryID);
      if (candidates.offered.length === 0) {
        const others = candidates.notOffered.map(({ title, reason }) => `• ${title} — ${reason}.`);
        this.show(`No outdated Zotero links to review: every link between a My Library item and a group item still joins records whose titles agree.${others.length > 0 ? `\n\nLinks the rules question but that are not offered:\n${others.join("\n")}` : ""}`, TITLE);
        return undefined;
      }
      const chosen = applyLinkPreview(candidates, this.openPreview(linkPreviewModel(candidates)));
      if (!chosen) return undefined;
      if (chosen.length === 0) { this.show("No links were ticked. Nothing was changed.", TITLE); return undefined; }

      const confirmedAt = this.now().toISOString();
      let results: (LinkRemovalResult | { status: "failed"; detail: string })[];
      try {
        results = await this.writeAPI.removeLinkedRelations(chosen.map(({ target, linked }) => ({ target: { libraryID: target.libraryID, itemKey: target.itemKey }, linked: { libraryID: linked.libraryID, itemKey: linked.itemKey } })));
      } catch (error) {
        // The transaction rolled back whole: nothing was removed.
        results = chosen.map(() => ({ status: "failed", detail: String(error) }));
      }
      const session = logEntryID(this.now());
      const entries = chosen.map((pair, index) => linkLogEntry(pair, results[index]!, `${session}-${index}`, session, confirmedAt));
      const logged = await this.log(entries);
      if (entries.some((entry) => entry.status === "removed")) await this.refreshQuietly();
      this.show(renderLinkOutcome(entries, logged), TITLE);
      return entries;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Link review failed: ${String(error)}`);
      this.show(`The link review could not complete: ${String(error)}\n\nNothing was changed.`, TITLE);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  async undoLast(): Promise<LinkRestoreLogEntry[] | undefined> {
    const undoTitle = "Undo Last Link Removal";
    if (this.busy) { this.show("A link review is already running.", undoTitle); return undefined; }
    this.busy = true;
    try {
      const { entries } = await this.store.readAll();
      const group = lastLinkSession(entries);
      if (group.length === 0) { this.show("No link removal to undo.", undoTitle); return undefined; }
      const lines = group.map((entry) => `• ${entry.target.title} ↔ ${entry.linked.libraryName}: ${entry.linked.title}`);
      if (!this.confirm(`Restore ${group.length} Zotero link${group.length === 1 ? "" : "s"} removed on ${group[0]!.confirmedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC")}?\n\n${lines.join("\n")}\n\nA link that already exists again is left as it is.`)) return undefined;

      let statuses: (LinkRestoreStatus | "failed")[];
      try {
        statuses = await this.writeAPI.restoreLinkedRelations(group.map((entry) => ({ target: { libraryID: entry.target.libraryID, itemKey: entry.target.itemKey }, uri: entry.uri! })));
      } catch (error) {
        this.zotero.debug(`[Zotero Library Reconciler] Link restore failed: ${String(error)}`);
        statuses = group.map(() => "failed");
      }
      const at = this.now();
      const base = logEntryID(at);
      const restores: LinkRestoreLogEntry[] = group.map((entry, index) => ({ id: `${base}-${index}`, action: "restore_link", reverses: entry.id, at: at.toISOString(), status: statuses[index]! }));
      await this.store.appendAll(restores);
      // "already-present" also means the link is back, so the removal no longer stands.
      const reversed = group.filter((_, index) => statuses[index] === "restored" || statuses[index] === "already-present").map((entry) => entry.id);
      if (reversed.length > 0) await this.store.markUndone(reversed, at.toISOString());
      if (statuses.includes("restored")) await this.refreshQuietly();
      const restored = statuses.filter((status) => status === "restored").length;
      const other = group.flatMap((entry, index) => (statuses[index] === "restored" ? [] : [`• ${entry.target.title} — ${statuses[index]}`]));
      this.show(`Restored ${restored} of ${group.length} link${group.length === 1 ? "" : "s"}.${other.length > 0 ? `\n\n${other.join("\n")}` : ""}`, undoTitle);
      return restores;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Link undo failed: ${String(error)}`);
      this.show(`The undo could not complete: ${String(error)}`, undoTitle);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  private async log(entries: readonly LinkLogEntry[]): Promise<string> {
    try {
      await this.store.appendAll(entries);
      return `Logged as session ${entries[0]?.session} in ${this.store.location}.`;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Transaction log write failed: ${String(error)}`);
      const removed = entries.filter((entry) => entry.status === "removed").map((entry) => `${entry.target.libraryID}:${entry.target.itemKey}`);
      return `WARNING: the transaction log could not be written (${String(error)}). ${removed.length} link${removed.length === 1 ? " WAS" : "s WERE"} removed${removed.length > 0 ? ` (${removed.join(", ")})` : ""}; Zotero's Edit → Undo still works until restart, but this session cannot be undone from the log.`;
    }
  }

  private async refreshQuietly(): Promise<void> {
    try {
      await this.refreshIndex();
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Index refresh after link change failed: ${String(error)}`);
    }
  }

  private openPreviewWindow(model: LinkPreviewModel): LinkPreviewResult {
    const result: LinkPreviewResult = { confirmed: false, checkedKeys: [] };
    const window = this.zotero.getMainWindow() as ChromeWindow;
    window.openDialog(PREVIEW_URL, "", "chrome,modal,centerscreen,resizable", { model, result });
    return result;
  }

  private openReportWindow(text: string, title: string): void {
    const window = this.zotero.getMainWindow() as ChromeWindow;
    try {
      window.openDialog(REPORT_URL, "", "chrome,dialog=no,centerscreen,resizable", { title, text });
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Report window failed, falling back to alert: ${String(error)}`);
      window.alert(text);
    }
  }
}

function linkLogEntry(pair: LinkPair, result: LinkRemovalResult | { status: "failed"; detail: string }, id: string, session: string, confirmedAt: string): LinkLogEntry {
  return {
    id, action: "remove_link", session, confirmedAt,
    target: pair.target,
    linked: pair.linked,
    status: result.status,
    ...(result.status === "removed" ? { uri: result.uri } : { detail: result.detail }),
    evidence: pair.evidence
  };
}

/** Actual results (invariant 7); not-removed pairs listed with the reason. */
export function renderLinkOutcome(entries: readonly LinkLogEntry[], logged: string): string {
  const removed = entries.filter((entry) => entry.status === "removed").length;
  const head = `Removed ${removed} of ${entries.length} Zotero link${entries.length === 1 ? "" : "s"}. No field, tag, collection or note was changed, and no group item was edited.`;
  const notRemoved = entries.filter((entry) => entry.status !== "removed").map((entry) => `• ${entry.target.title} — ${entry.status}${entry.detail ? `: ${entry.detail}` : ""}`);
  const after = removed > 0 ? ["The group items are no longer treated as already copied: Add Missing Items can now offer them. Edit → Undo reverts this until Zotero restarts; Tools → Undo Last Link Removal… works from the log at any time."] : [];
  return [head, ...(notRemoved.length > 0 ? [`Not removed:\n${notRemoved.join("\n")}`] : []), ...after, logged].join("\n\n");
}
