import { findCopies, readFieldRecord, type CopyMatch, type ZoteroFieldReadAPI, type ZoteroItem, type ZoteroReadAPI } from "./adapter.js";
import type { TransactionStore } from "./transactionStore.js";
import { describeMatch } from "../audit/metadataDifferences.js";
import { compareRecords, type FieldRecord } from "../comparison/differenceEngine.js";
import { executeReconcilePlan, type ReconcileOutcome } from "../write/reconcileExecutor.js";
import { applyReconcilePreview, display, reconcilePreviewModel, type GatedSource, type ReconcilePreviewModel, type ReconcilePreviewResult } from "../write/reconcilePlan.js";
import { writeChunk, type ChunkResult } from "../write/fillExecutor.js";
import { DEFAULT_CHUNK_SIZE } from "../write/importExecutor.js";
import { lastMetadataSession, logEntryID, metadataLogEntry, revertLogEntry, revertWrites, type MetadataLogEntry, type RevertLogEntry } from "../write/transactionLog.js";
import type { WriteAPI } from "../write/writeApi.js";

/**
 * Phase 4 slice 1: "Compare Copies and Update My Library…" for ONE selected My Library item
 * (docs/phase4-field-reconciliation.md §11). `run()` is the §25 sequence in order — SCAN/MATCH
 * (Find Copies on the selected item, so every pair is direct: decision F), gate to EXACT/HIGH
 * (§5), COMPARE (field reader + Difference Engine), PROPOSE/PREVIEW/CONFIRM (window), WRITE
 * (compare-and-swap in one transaction), LOG — and the result opens only after the log line
 * is on disk. Gated by a preference in `runtime.ts`; not registered otherwise.
 */

interface XULDocument extends Document {
  createXULElement(name: string): Element;
}

interface ChromeWindow extends Window {
  openDialog(url: string, name: string, features: string, ...args: unknown[]): Window;
}

interface ZoteroReconcileUI extends ZoteroReadAPI {
  debug(message: string): void;
  getActiveZoteroPane(): { getSelectedItems(): ZoteroItem[] };
  getMainWindow(): Window;
  Items: ZoteroReadAPI["Items"] & ZoteroFieldReadAPI["Items"];
  ItemFields: ZoteroFieldReadAPI["ItemFields"];
  CreatorTypes: ZoteroFieldReadAPI["CreatorTypes"];
}

const RECONCILE_MENU_ID = "zotero-library-reconciler-reconcile";
const UNDO_MENU_ID = "zotero-library-reconciler-undo-metadata";
const PREVIEW_URL = "chrome://zotero-library-reconciler/content/reconcilePreview.xhtml";
const REPORT_URL = "chrome://zotero-library-reconciler/content/report.xhtml";
const TITLE = "Compare Copies";

export interface ReconcileCommandOptions {
  writeAPI: WriteAPI;
  store: TransactionStore;
  now?: () => Date;
  /** Shows the preview window; defaults to the modal XHTML dialog. Tests inject a scripted answer. */
  openPreview?: (model: ReconcilePreviewModel) => ReconcilePreviewResult;
  /** Yes/no question before the undo; defaults to a Services.prompt dialog in the runtime. */
  confirm?: (message: string) => boolean;
  show?: (text: string, title: string) => void;
}

export class ReconcileCommand {
  private readonly menuItems = new Map<Window, Element[]>();
  private readonly writeAPI: WriteAPI;
  private readonly store: TransactionStore;
  private readonly now: () => Date;
  private readonly openPreview: (model: ReconcilePreviewModel) => ReconcilePreviewResult;
  private readonly confirm: (message: string) => boolean;
  private readonly show: (text: string, title: string) => void;
  private busy = false;

  constructor(private readonly zotero: ZoteroReconcileUI, options: ReconcileCommandOptions) {
    this.writeAPI = options.writeAPI;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.openPreview = options.openPreview ?? ((model) => this.openPreviewWindow(model));
    this.confirm = options.confirm ?? (() => false);
    this.show = options.show ?? ((text, title) => this.openReportWindow(text, title));
  }

  /** Compare acts on the selected item (item menu); undo acts on the log (Tools menu, beside the import undo). */
  register(window: Window = this.zotero.getMainWindow()): void {
    const document = window.document as XULDocument;
    const itemMenu = document.getElementById("zotero-itemmenu");
    const toolsMenu = document.getElementById("menu_ToolsPopup");
    if (!itemMenu || !toolsMenu || document.getElementById(RECONCILE_MENU_ID)) return;

    const compare = document.createXULElement("menuitem");
    compare.id = RECONCILE_MENU_ID;
    compare.setAttribute("label", "Compare Copies and Update My Library…");
    compare.addEventListener("command", () => void this.run());
    itemMenu.appendChild(compare);

    const undo = document.createXULElement("menuitem");
    undo.id = UNDO_MENU_ID;
    undo.setAttribute("label", "Undo Last Metadata Update…");
    undo.addEventListener("command", () => void this.undoLast());
    toolsMenu.appendChild(undo);

    this.menuItems.set(window, [compare, undo]);
  }

  unregister(window?: Window): void {
    const targets = window ? [window] : [...this.menuItems.keys()];
    for (const target of targets) {
      for (const element of this.menuItems.get(target) ?? []) element.remove();
      this.menuItems.delete(target);
    }
  }

  /** Returns the outcome (undefined when nothing was attempted) so tests can assert on it. */
  async run(): Promise<ReconcileOutcome | undefined> {
    if (this.busy) { this.show("A metadata update is already running.", TITLE); return undefined; }
    const selected = this.zotero.getActiveZoteroPane().getSelectedItems();
    const myLibraryID = this.writeAPI.userLibraryID();
    if (selected.length !== 1 || !selected[0]?.isRegularItem()) {
      this.show("Select one bibliographic item in My Library, then choose Compare Copies and Update My Library.", TITLE);
      return undefined;
    }
    return this.runFor(selected[0]);
  }

  /** The same sequence for a given item; the Metadata Differences window calls this per row. */
  async runFor(item: ZoteroItem): Promise<ReconcileOutcome | undefined> {
    if (this.busy) { this.show("A metadata update is already running.", TITLE); return undefined; }
    const myLibraryID = this.writeAPI.userLibraryID();
    if (item.libraryID !== myLibraryID) {
      this.show("Only My Library items can be updated. Select the My Library copy of this work (the \"Also in\" column shows where copies are).", TITLE);
      return undefined;
    }
    this.busy = true;
    try {
      // SCAN / MATCH — direct pairs with the selected item only (decision F).
      const found = await findCopies(this.zotero, item);
      const gated = found.copies.filter(isStrongMatch);
      const ignored = found.copies.filter((copy) => !isStrongMatch(copy));
      if (gated.length === 0) {
        this.show(renderNoStrongMatch(found.source.fields.title, ignored), TITLE);
        return undefined;
      }

      // COMPARE
      const myLibraryName = this.zotero.Libraries.getAll().find((library) => library.libraryID === myLibraryID)?.name ?? "My Library";
      const target = await readFieldRecord(this.zotero, { libraryID: myLibraryID, libraryName: myLibraryName, itemKey: item.key });
      if (!target) throw new Error("The selected item could not be read.");
      const read = await Promise.all(gated.map(async (copy) => ({ copy, record: await readFieldRecord(this.zotero, copy.item.ref) })));
      const usable = read.filter((entry): entry is { copy: CopyMatch; record: FieldRecord } => entry.record !== undefined);
      const sources: GatedSource[] = usable.map(({ copy }) => ({ ref: copy.item.ref, evidence: describeMatch(copy.result) }));
      const differences = compareRecords(target, usable.map(({ record }) => record));

      // PROPOSE → PREVIEW → CONFIRM
      const title = found.source.fields.title || "Untitled";
      const model = reconcilePreviewModel(title, differences, sources);
      if (!model.rows.some((row) => row.offerable)) {
        this.show(renderNothingToUpdate(title, model), TITLE);
        return undefined;
      }
      const plan = applyReconcilePreview({ libraryID: myLibraryID, itemKey: item.key, title }, differences, sources, this.openPreview(model), this.now());
      if (!plan) return undefined;

      // WRITE → LOG. The log line is on disk before the user sees a result.
      const outcome = await executeReconcilePlan(this.writeAPI, plan);
      if (outcome.status === "nothing-chosen") {
        this.show("No field was selected, so nothing was changed.", TITLE);
        return outcome;
      }
      const logged = await this.log(metadataLogEntry(outcome, logEntryID(this.now())));
      this.show(renderOutcome(outcome, logged), TITLE);
      return outcome;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Compare Copies failed: ${String(error)}`);
      this.show(`Compare Copies could not complete: ${String(error)}\n\nNothing was written.`, TITLE);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Reverts the most recent un-undone written entry — or, for a Fill Missing session, every
   * written item of that session — field by field compare-and-swap (invariant 10), in chunks of
   * one transaction each. An item whose field changed since is skipped and stays not undone.
   */
  async undoLast(): Promise<RevertLogEntry[] | undefined> {
    const undoTitle = "Undo Last Metadata Update";
    if (this.busy) { this.show("A metadata update is already running.", undoTitle); return undefined; }
    this.busy = true;
    try {
      const { entries } = await this.store.readAll();
      const group = lastMetadataSession(entries);
      if (group.length === 0) { this.show("No metadata update to undo.", undoTitle); return undefined; }
      if (!this.confirm(group.length === 1 ? renderRevertPrompt(group[0]!) : renderSessionRevertPrompt(group))) return undefined;

      const results: ChunkResult[] = [];
      for (let start = 0; start < group.length; start += DEFAULT_CHUNK_SIZE) {
        const chunk = group.slice(start, start + DEFAULT_CHUNK_SIZE);
        results.push(...(await writeChunk(this.writeAPI, chunk.map((entry) => ({ target: { libraryID: entry.target.libraryID, itemKey: entry.target.itemKey }, writes: revertWrites(entry), checks: [] })))));
      }
      const at = this.now();
      const base = logEntryID(at);
      const reverts = group.map((entry, index) => revertLogEntry(entry, results[index]!.status, results[index]!.detail, group.length === 1 ? base : `${base}-${index}`, at));
      await this.store.appendAll(reverts);
      const restored = group.filter((_, index) => reverts[index]!.status === "written").map((entry) => entry.id);
      if (restored.length > 0) await this.store.markUndone(restored, at.toISOString());
      this.show(group.length === 1 ? renderRevertOutcome(group[0]!, reverts[0]!) : renderSessionRevertOutcome(group, reverts), undoTitle);
      return reverts;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Metadata undo failed: ${String(error)}`);
      this.show(`The undo could not complete: ${String(error)}`, undoTitle);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  private async log(entry: MetadataLogEntry): Promise<string> {
    try {
      await this.store.append(entry);
      return `Logged as ${entry.id} in ${this.store.location}.`;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Transaction log write failed: ${String(error)}`);
      const keys = `${entry.target.libraryID}:${entry.target.itemKey}`;
      return `WARNING: the transaction log could not be written (${String(error)}). Item ${keys} ${entry.status === "written" ? "WAS changed" : "was not changed"}; Zotero's Edit → Undo still works until restart, but this update cannot be undone from the log.`;
    }
  }

  private openPreviewWindow(model: ReconcilePreviewModel): ReconcilePreviewResult {
    const result: ReconcilePreviewResult = { confirmed: false, choices: {} };
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

/** §5: only EXACT (Tier 0 corroborated, Tier 1) and HIGH (Tier 2) matches may supply values; never REVIEW/POSSIBLE. */
export function isStrongMatch(copy: CopyMatch): boolean {
  return copy.result.verdict === "match" && (copy.result.tier === "exact" || copy.result.tier === "high");
}

function renderNoStrongMatch(title: string | undefined, ignored: readonly CopyMatch[]): string {
  const head = `${title || "Untitled"}\n\nNo copy in another library is a strong enough match (EXACT or HIGH) to supply metadata. Nothing can be updated.`;
  if (ignored.length === 0) return `${head}\n\nNo candidate copies were found.`;
  const rows = ignored.map((copy) => `• ${copy.item.ref.libraryName} — ${copy.result.verdict.toUpperCase()}: ${copy.result.evidence.map(({ detail }) => detail).join(" ")}`);
  return `${head}\n\nCandidates that need review instead:\n${rows.join("\n")}`;
}

function renderNothingToUpdate(title: string, model: ReconcilePreviewModel): string {
  const rows = model.rows.map((row) => `• ${row.field}: ${row.class}${row.notes.length > 0 ? ` (${row.notes.join(" ")})` : ""}`);
  return `${title}\n\nNothing to update: no field has a different value that can be written to this item.\n\n${rows.join("\n") || "All compared fields are identical."}`;
}

/** Actual result, never the plan (invariant 7). */
export function renderOutcome(outcome: ReconcileOutcome, logged: string): string {
  const { plan } = outcome;
  if (outcome.status === "written") {
    const lines = plan.edits.map((edit) => `• ${edit.field}: "${display(edit.old) || "—"}" → "${display(outcome.stored?.[edit.name] ?? edit.next)}" (from ${edit.source.libraryName})`);
    return `Updated ${plan.edits.length} field${plan.edits.length === 1 ? "" : "s"} of "${plan.target.title}" in My Library:\n${lines.join("\n")}\n\nEdit → Undo reverts this until Zotero restarts; Tools → Undo Last Metadata Update… works from the log at any time.\n\n${logged}`;
  }
  const why: Record<string, string> = {
    "target-changed": "the My Library item changed after the comparison",
    "source-changed": "a source copy changed after the comparison",
    "target-missing": "the My Library item no longer exists",
    aborted: "My Library is not editable",
    failed: "Zotero reported an error"
  };
  return `Nothing was written: ${why[outcome.status] ?? outcome.status}.${outcome.detail ? `\n${outcome.detail}` : ""}\n\nRun Compare Copies again to see the current values.\n\n${logged}`;
}

export function renderRevertPrompt(entry: MetadataLogEntry): string {
  const when = entry.confirmedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const lines = entry.changes.map((change) => `• ${change.field}: "${display(change.new)}" → back to "${display(change.old) || "—"}"`);
  return `Restore ${entry.changes.length} field${entry.changes.length === 1 ? "" : "s"} of "${entry.target.title}" updated on ${when}?\n\n${lines.join("\n")}\n\nA field you have edited since then is left alone and nothing is restored.`;
}

function renderRevertOutcome(entry: MetadataLogEntry, revert: RevertLogEntry): string {
  if (revert.status === "written") return `Restored ${entry.changes.length} field${entry.changes.length === 1 ? "" : "s"} of "${entry.target.title}".`;
  if (revert.status === "target-changed") return `Nothing was restored: a field of "${entry.target.title}" changed after the update (or Edit → Undo already reverted it).\n${revert.detail ?? ""}`;
  return `Nothing was restored (${revert.status}).\n${revert.detail ?? ""}`;
}

const SESSION_PREVIEW_ROWS = 15;

export function renderSessionRevertPrompt(group: readonly MetadataLogEntry[]): string {
  const when = group[0]!.confirmedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const fields = group.reduce((sum, entry) => sum + entry.changes.length, 0);
  const lines = group.slice(0, SESSION_PREVIEW_ROWS).map((entry) => `• ${entry.target.title}: ${entry.changes.map((change) => change.field).join(", ")}`);
  const more = group.length > SESSION_PREVIEW_ROWS ? `\n… and ${group.length - SESSION_PREVIEW_ROWS} more` : "";
  return `Restore ${fields} field${fields === 1 ? "" : "s"} of ${group.length} items filled on ${when}?\n\n${lines.join("\n")}${more}\n\nAn item with a field you have edited since then is left alone.`;
}

/** Actual counts, never the session size (invariant 7). */
export function renderSessionRevertOutcome(group: readonly MetadataLogEntry[], reverts: readonly RevertLogEntry[]): string {
  const skipped = group.flatMap((entry, index) => (reverts[index]!.status === "written" ? [] : [`• ${entry.target.title} — ${reverts[index]!.status}${reverts[index]!.detail ? `: ${reverts[index]!.detail}` : ""}`]));
  const restored = group.length - skipped.length;
  const head = `Restored ${restored} of ${group.length} item${group.length === 1 ? "" : "s"}.`;
  return skipped.length === 0 ? head : `${head}\n\nNot restored (changed since the fill, or already reverted with Edit → Undo):\n${skipped.join("\n")}`;
}
