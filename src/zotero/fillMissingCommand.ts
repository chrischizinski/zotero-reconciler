import type { ZoteroFieldReadAPI, ZoteroReadAPI } from "./adapter.js";
import { openProgressDialog, type ProgressHandle } from "./importCommand.js";
import { loadStrongComparisons } from "./metadataDifferencesCommand.js";
import type { TransactionStore } from "./transactionStore.js";
import { describeMatch, refKey } from "../audit/metadataDifferences.js";
import { compareRecords, type FieldRecord } from "../comparison/differenceEngine.js";
import { executeFillPlan, type FillItemOutcome, type FillOutcome } from "../write/fillExecutor.js";
import { applyFillPreview, fillPreviewModel, type FillPlan, type FillPreviewModel, type FillPreviewResult } from "../write/fillPlan.js";
import { fillMissingPlan, type GatedSource, type ReconcilePlan } from "../write/reconcilePlan.js";
import { logEntryID, metadataLogEntry, type MetadataLogEntry } from "../write/transactionLog.js";
import type { WriteAPI } from "../write/writeApi.js";

/**
 * Phase 4 slice 3: "Fill Missing Fields from Other Libraries…" (Tools menu). The §25 sequence
 * in `run()` — SCAN/MATCH (fresh audit: direct strong pairs only, decision F), COMPARE (field
 * reader + Difference Engine), PROPOSE (per item, exactly what Compare Copies would
 * pre-select: `fillMissingPlan`), PREVIEW/CONFIRM (window, items can only be unticked), WRITE
 * (chunks of 25, one transaction and one ⌘Z step each, per-item compare-and-swap), LOG (one
 * entry per attempted item, sharing a session id, in one write) — and the result opens only
 * after the log is on disk. Gated by `enableReconcile` in `runtime.ts`.
 */

interface XULDocument extends Document {
  createXULElement(name: string): Element;
}

interface ChromeWindow extends Window {
  openDialog(url: string, name: string, features: string, ...args: unknown[]): Window;
}

interface ZoteroFillUI extends ZoteroReadAPI {
  debug(message: string): void;
  getMainWindow(): Window;
  Items: ZoteroReadAPI["Items"] & ZoteroFieldReadAPI["Items"];
  ItemFields: ZoteroFieldReadAPI["ItemFields"];
  CreatorTypes: ZoteroFieldReadAPI["CreatorTypes"];
}

const MENU_ID = "zotero-library-reconciler-fill-missing";
const PREVIEW_URL = "chrome://zotero-library-reconciler/content/fillPreview.xhtml";
const REPORT_URL = "chrome://zotero-library-reconciler/content/report.xhtml";
const TITLE = "Fill Missing Fields";

export interface FillMissingOptions {
  writeAPI: WriteAPI;
  store: TransactionStore;
  now?: () => Date;
  openPreview?: (model: FillPreviewModel) => FillPreviewResult;
  show?: (text: string, title: string) => void;
  openProgress?: (total: number) => ProgressHandle;
}

export class FillMissingCommand {
  private readonly menuItems = new Map<Window, Element[]>();
  private readonly writeAPI: WriteAPI;
  private readonly store: TransactionStore;
  private readonly now: () => Date;
  private readonly openPreview: (model: FillPreviewModel) => FillPreviewResult;
  private readonly show: (text: string, title: string) => void;
  private readonly openProgress: (total: number) => ProgressHandle;
  private busy = false;

  constructor(private readonly zotero: ZoteroFillUI, options: FillMissingOptions) {
    this.writeAPI = options.writeAPI;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.openPreview = options.openPreview ?? ((model) => this.openPreviewWindow(model));
    this.show = options.show ?? ((text, title) => this.openReportWindow(text, title));
    this.openProgress = options.openProgress ?? ((total) => openProgressDialog(this.zotero, total, "Filling Missing Fields"));
  }

  register(window: Window = this.zotero.getMainWindow()): void {
    const document = window.document as XULDocument;
    const menu = document.getElementById("menu_ToolsPopup");
    if (!menu || document.getElementById(MENU_ID)) return;
    const item = document.createXULElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("label", "Fill Missing Fields from Other Libraries…");
    item.addEventListener("command", () => void this.run());
    menu.appendChild(item);
    this.menuItems.set(window, [item]);
  }

  unregister(window?: Window): void {
    const targets = window ? [window] : [...this.menuItems.keys()];
    for (const target of targets) {
      for (const element of this.menuItems.get(target) ?? []) element.remove();
      this.menuItems.delete(target);
    }
  }

  /** Returns the outcome (undefined when nothing was attempted) so tests can assert on it. */
  async run(): Promise<FillOutcome | undefined> {
    if (this.busy) { this.show("Fill Missing Fields is already running.", TITLE); return undefined; }
    this.busy = true;
    try {
      // SCAN → MATCH → COMPARE → PROPOSE
      const { myLibraryID, targets, records, titles } = await loadStrongComparisons(this.zotero);
      const items: ReconcilePlan[] = [];
      for (const { target, partners } of targets.values()) {
        const targetRecord = records.get(refKey(target));
        const usable = partners.flatMap((partner) => {
          const record = records.get(refKey(partner.ref));
          return record ? [{ record, source: { ref: partner.ref, evidence: describeMatch(partner.result) } satisfies GatedSource }] : [];
        });
        if (!targetRecord || usable.length === 0) continue;
        const differences = compareRecords(targetRecord, usable.map(({ record }): FieldRecord => record));
        const plan = fillMissingPlan({ libraryID: myLibraryID, itemKey: target.itemKey, title: titles(target) }, differences, usable.map(({ source }) => source));
        if (plan.edits.length > 0) items.push(plan);
      }
      if (items.length === 0) {
        this.show("No My Library item has an empty field that every strongly matched copy agrees on. Nothing to fill.\n\nFields that differ or conflict, and identifiers, are only changed one item at a time with Compare Copies.", TITLE);
        return undefined;
      }
      items.sort((a, b) => a.target.title.localeCompare(b.target.title));

      // PREVIEW → CONFIRM
      const plan = applyFillPreview({ items }, this.openPreview(fillPreviewModel({ items })), this.now());
      if (!plan) return undefined;
      if (plan.items.length === 0) { this.show("No items were ticked. Nothing was changed.", TITLE); return undefined; }

      // WRITE → LOG. The log is on disk before the user sees a result (invariant 8).
      const progress = this.openProgress(plan.items.length);
      let outcome: FillOutcome;
      try {
        outcome = await executeFillPlan(this.writeAPI, plan, { onProgress: (p) => progress.update(p), shouldCancel: () => progress.cancelled() });
      } finally {
        progress.close();
      }
      const logged = await this.log(outcome);
      this.show(renderFillOutcome(outcome, logged), TITLE);
      return outcome;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Fill Missing failed: ${String(error)}`);
      // The executor catches per-item errors itself, so reaching here means the session failed before its first write.
      this.show(`Fill Missing Fields could not complete: ${String(error)}\n\nNothing was written.`, TITLE);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  private async log(outcome: FillOutcome): Promise<string> {
    const base = logEntryID(this.now());
    const attempted = outcome.items.filter((item): item is Exclude<FillItemOutcome, { status: "cancelled" }> => item.status !== "cancelled");
    const entries: MetadataLogEntry[] = attempted.map((item, index) => metadataLogEntry(item, `${base}-${index}`, base));
    try {
      await this.store.appendAll(entries);
      return entries.length > 0 ? `Logged as session ${base} (${entries.length} entr${entries.length === 1 ? "y" : "ies"}) in ${this.store.location}.` : "Nothing was attempted, so nothing was logged.";
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Transaction log write failed: ${String(error)}`);
      const changed = attempted.filter((item) => item.status === "written").map((item) => `${item.plan.target.libraryID}:${item.plan.target.itemKey}`);
      return `WARNING: the transaction log could not be written (${String(error)}). ${changed.length} item${changed.length === 1 ? " WAS" : "s WERE"} changed${changed.length > 0 ? ` (${changed.join(", ")})` : ""}; Zotero's Edit → Undo still works until restart, but this session cannot be undone from the log.`;
    }
  }

  private openPreviewWindow(model: FillPreviewModel): FillPreviewResult {
    const result: FillPreviewResult = { confirmed: false, checkedKeys: [] };
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

const REASON: Record<string, string> = {
  "target-changed": "changed in My Library since the list was made",
  "source-changed": "a source copy changed since the list was made",
  "target-missing": "no longer exists or is in the trash",
  failed: "FAILED"
};

/** Actual counts from the outcome, never the plan size (invariant 7); skips listed separately. */
export function renderFillOutcome(outcome: FillOutcome, logged: string): string {
  if (outcome.aborted) return `Nothing was written: ${outcome.aborted}\n\n${logged}`;
  const { totals } = outcome;
  const skipped = totals.skippedTargetChanged + totals.skippedSourceChanged + totals.skippedMissing;
  const cancelled = totals.cancelled > 0 ? `, cancelled ${totals.cancelled} (not attempted)` : "";
  const head = `Filled ${totals.fieldsWritten} field${totals.fieldsWritten === 1 ? "" : "s"} in ${totals.itemsUpdated} My Library item${totals.itemsUpdated === 1 ? "" : "s"}; skipped ${skipped}, failed ${totals.failed}${cancelled}.`;
  const notWritten = outcome.items.filter((item) => item.status !== "written" && item.status !== "cancelled")
    .map((item) => `• ${item.plan.target.title} — ${REASON[item.status] ?? item.status}${"detail" in item && item.detail ? `: ${item.detail}` : ""}`);
  const undo = totals.itemsUpdated > 0 ? ["Edit → Undo reverts one chunk of up to 25 items per step until Zotero restarts; Tools → Undo Last Metadata Update… reverts the whole session from the log at any time."] : [];
  return [head, ...(notWritten.length > 0 ? [`Not written (run Compare Copies on these to see current values):\n${notWritten.join("\n")}`] : []), ...undo, logged].join("\n\n");
}
