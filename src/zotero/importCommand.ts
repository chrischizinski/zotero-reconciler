import { auditLibraries, type ZoteroReadAPI } from "./adapter.js";
import type { TransactionStore } from "./transactionStore.js";
import { importCandidates } from "../write/importCandidates.js";
import { executeImportPlan, type ImportOutcome, type RowOutcome } from "../write/importExecutor.js";
import { buildImportPlan } from "../write/importPlan.js";
import { applyPreview, previewModel, type PreviewModel, type PreviewResult } from "../write/importPreviewModel.js";
import { createdRefs, importLogEntry, logEntryID, undoLogEntry, type ImportLogEntry } from "../write/transactionLog.js";
import type { WriteAPI } from "../write/writeApi.js";

/**
 * Phase 3 "Add Missing Items to My Library": the one command that reaches the write engine.
 * The whole §25 sequence lives in `run()` in order — SCAN/MATCH (fresh audit, so plan
 * versions are current), COMPARE (recall re-check), PROPOSE (plan), PREVIEW/CONFIRM
 * (window), WRITE (executor), LOG (store) — and the outcome dialog opens only after the log
 * line is on disk (invariant 8). Gated by a preference in `runtime.ts`; not registered
 * otherwise.
 */

interface XULDocument extends Document {
  createXULElement(name: string): Element;
}

interface ChromeWindow extends Window {
  openDialog(url: string, name: string, features: string, ...args: unknown[]): Window;
}

interface ZoteroImportUI extends ZoteroReadAPI {
  debug(message: string): void;
  getMainWindow(): Window;
}

const IMPORT_MENU_ID = "zotero-library-reconciler-import";
const UNDO_MENU_ID = "zotero-library-reconciler-undo-import";
const PREVIEW_URL = "chrome://zotero-library-reconciler/content/importPreview.xhtml";
const REPORT_URL = "chrome://zotero-library-reconciler/content/report.xhtml";
const UNDO_PREVIEW_ROWS = 15;

export interface ImportCommandOptions {
  writeAPI: WriteAPI;
  store: TransactionStore;
  now?: () => Date;
  /** Re-runs the audit after a write so the index reflects the new items. */
  refreshIndex?: () => Promise<unknown>;
  /** Shows the preview window; defaults to the modal XHTML dialog. Tests inject a scripted answer. */
  openPreview?: (model: PreviewModel) => PreviewResult;
  /** Yes/no question before the undo trashes items; defaults to a Services.prompt dialog in the runtime. */
  confirm?: (message: string) => boolean;
  /** Shows a report; defaults to the report window. */
  show?: (text: string, title: string) => void;
}

export class ImportCommand {
  private readonly menuItems = new Map<Window, Element[]>();
  private readonly writeAPI: WriteAPI;
  private readonly store: TransactionStore;
  private readonly now: () => Date;
  private readonly refreshIndex: () => Promise<unknown>;
  private readonly openPreview: (model: PreviewModel) => PreviewResult;
  private readonly confirm: (message: string) => boolean;
  private readonly show: (text: string, title: string) => void;
  /** A second click while a session runs must not start a second session. */
  private busy = false;

  constructor(private readonly zotero: ZoteroImportUI, options: ImportCommandOptions) {
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
    const menu = document.getElementById("zotero-itemmenu");
    if (!menu || document.getElementById(IMPORT_MENU_ID)) return;

    const importItem = document.createXULElement("menuitem");
    importItem.id = IMPORT_MENU_ID;
    importItem.setAttribute("label", "Add Missing Items to My Library…");
    importItem.addEventListener("command", () => void this.run());
    menu.appendChild(importItem);

    const undoItem = document.createXULElement("menuitem");
    undoItem.id = UNDO_MENU_ID;
    undoItem.setAttribute("label", "Undo Last Import Session…");
    undoItem.addEventListener("command", () => void this.undoLast());
    menu.appendChild(undoItem);

    this.menuItems.set(window, [importItem, undoItem]);
  }

  unregister(window?: Window): void {
    const targets = window ? [window] : [...this.menuItems.keys()];
    for (const target of targets) {
      for (const element of this.menuItems.get(target) ?? []) element.remove();
      this.menuItems.delete(target);
    }
  }

  /** The full §25 sequence. Returns the outcome (or undefined when nothing was written) so tests can assert on it. */
  async run(): Promise<ImportOutcome | undefined> {
    if (this.busy) { this.show("An import or undo is already running.", "Add Missing Items"); return undefined; }
    this.busy = true;
    try {
      // SCAN → MATCH → COMPARE → PROPOSE
      const scan = await auditLibraries(this.zotero);
      const { candidates, alreadyPresent } = importCandidates(scan.items, scan.audit, scan.myLibraryID);
      if (candidates.length === 0 && alreadyPresent.length === 0) {
        this.show("Every work in your group libraries is already in My Library. Nothing to import.", "Add Missing Items");
        return undefined;
      }
      const proposed = buildImportPlan(candidates, scan.myLibraryID, this.now());
      const targetName = this.writeAPI.library(scan.myLibraryID)?.name ?? "My Library";

      // PREVIEW → CONFIRM: the window decides per row; Cancel leaves no confirmed plan.
      const plan = applyPreview(proposed, this.openPreview(previewModel(proposed, alreadyPresent, targetName)), this.now());
      if (!plan) return undefined;
      if (!plan.rows.some((row) => row.decision === "import")) {
        this.show("No works were ticked. Nothing was imported.", "Add Missing Items");
        return undefined;
      }

      // WRITE → LOG. The log line is on disk before the user sees a result (invariant 8).
      const outcome = await executeImportPlan(this.writeAPI, plan);
      const logged = await this.log(outcome);
      if (!outcome.aborted && outcome.totals.created > 0) await this.refreshQuietly();
      this.show(renderOutcome(outcome, logged), "Add Missing Items");
      return outcome;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Import failed: ${String(error)}`);
      // The executor catches per-row errors itself, so reaching here means the session failed before its first row (§40).
      this.show(`The import could not complete: ${String(error)}\n\nNo transaction log entry was written. If any item was created it is in the "Reconciler Imports" collection.`, "Add Missing Items");
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  /** Trashes (never erases) everything the most recent un-undone import session created; recoverable from Zotero's trash. */
  async undoLast(): Promise<void> {
    if (this.busy) { this.show("An import or undo is already running.", "Undo Last Import"); return; }
    this.busy = true;
    try {
      const { entries } = await this.store.readAll();
      const last = [...entries].reverse().find((entry): entry is ImportLogEntry => entry.action === "import" && !entry.undoneAt && createdRefs(entry).length > 0);
      if (!last) { this.show("No import session to undo.", "Undo Last Import"); return; }
      const refs = createdRefs(last);
      if (!this.confirm(renderUndoPrompt(last))) return;

      await this.writeAPI.trashItems(refs);
      const at = this.now();
      await this.store.append(undoLogEntry(last, refs, logEntryID(at), at));
      await this.store.markUndone(last.id, at.toISOString());
      await this.refreshQuietly();
      this.show(`Moved ${refs.length} imported item${refs.length === 1 ? "" : "s"} to the trash. They can be restored from Zotero's trash; the empty session collection was left in place.`, "Undo Last Import");
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Undo failed: ${String(error)}`);
      this.show(`The undo could not complete: ${String(error)}`, "Undo Last Import");
    } finally {
      this.busy = false;
    }
  }

  private async log(outcome: ImportOutcome): Promise<string> {
    const entry = importLogEntry(outcome, logEntryID(this.now()));
    try {
      await this.store.append(entry);
      return `Logged as ${entry.id} in ${this.store.location}.`;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Transaction log write failed: ${String(error)}`);
      return `WARNING: the transaction log could not be written (${String(error)}). The items above were created but this session cannot be undone from the log; they are in the session collection.`;
    }
  }

  private async refreshQuietly(): Promise<void> {
    try {
      await this.refreshIndex();
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Index refresh after write failed: ${String(error)}`);
    }
  }

  private openPreviewWindow(model: PreviewModel): PreviewResult {
    const result: PreviewResult = { confirmed: false, checkedKeys: [], copyTags: model.copyTags };
    const window = this.zotero.getMainWindow() as ChromeWindow;
    // Modal: openDialog returns after the window closes, with the user's answer in `result`.
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

/** Actual counts from the outcome, never the plan size (invariant 7). */
export function renderOutcome(outcome: ImportOutcome, logged: string): string {
  if (outcome.aborted) return `Nothing was imported: ${outcome.aborted}\n\n${logged}`;
  const { totals } = outcome;
  const skipped = totals.skippedStale + totals.skippedMissing + totals.skippedExisting;
  const head = `Created ${totals.created} item${totals.created === 1 ? "" : "s"} in My Library (collection "Reconciler Imports"), skipped ${skipped}, failed ${totals.failed}.`;
  const detail = outcome.rows.filter((row) => row.status !== "created").map(describeRow);
  const sections = [head, ...(detail.length > 0 ? [`Not imported:\n${detail.join("\n")}`] : []), logged];
  return sections.join("\n\n");
}

function describeRow(row: RowOutcome): string {
  const title = row.row.source.title || "Untitled";
  if (row.status === "skipped") return `• ${title} — skipped: ${row.detail}`;
  if (row.status === "failed") return `• ${title} — FAILED: ${row.error}`;
  return `• ${title}`;
}

export function renderUndoPrompt(entry: ImportLogEntry): string {
  const rows = entry.rows.filter((row) => row.created);
  const when = entry.confirmedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const titles = rows.slice(0, UNDO_PREVIEW_ROWS).map((row) => `• ${row.source.title || "Untitled"}`);
  const more = rows.length > UNDO_PREVIEW_ROWS ? `\n… and ${rows.length - UNDO_PREVIEW_ROWS} more` : "";
  return `Move the ${rows.length} item${rows.length === 1 ? "" : "s"} imported on ${when} to the trash?\n\nThey go to Zotero's trash, not permanent deletion. Edits you made to them since the import are kept with the trashed item.\n\n${titles.join("\n")}${more}`;
}
