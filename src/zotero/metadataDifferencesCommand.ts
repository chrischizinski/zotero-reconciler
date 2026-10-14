import { auditLibraries, readFieldRecord, type ZoteroFieldReadAPI, type ZoteroItem, type ZoteroReadAPI } from "./adapter.js";
import { metadataDifferenceReport, refKey, strongPartnersOfMyLibrary, type ItemDifferenceSummary, type MetadataDifferenceReport } from "../audit/metadataDifferences.js";
import type { FieldRecord } from "../comparison/differenceEngine.js";
import type { ItemRef } from "../matching/types.js";

/**
 * Phase 4 slice 2: "Metadata Differences in My Library…" (Tools menu). Read-only: scans,
 * matches, reads the fields of every My Library item with a strong copy elsewhere, and lists
 * the items Compare Copies would have something to offer for. Rows can select the item in
 * Zotero, and — only when Phase 4 is enabled — open Compare Copies for it.
 */

interface XULDocument extends Document {
  createXULElement(name: string): Element;
}

interface ChromeWindow extends Window {
  openDialog(url: string, name: string, features: string, ...args: unknown[]): Window;
}

interface ZoteroDifferencesUI extends ZoteroReadAPI {
  debug(message: string): void;
  getMainWindow(): Window;
  getActiveZoteroPane(): { selectItem(itemID: number, options?: { inLibraryRoot?: boolean }): Promise<unknown> };
  Items: ZoteroReadAPI["Items"] & ZoteroFieldReadAPI["Items"] & { getIDFromLibraryAndKey(libraryID: number, key: string): number | false };
  ItemFields: ZoteroFieldReadAPI["ItemFields"];
  CreatorTypes: ZoteroFieldReadAPI["CreatorTypes"];
}

const MENU_ID = "zotero-library-reconciler-metadata-differences";
const WINDOW_URL = "chrome://zotero-library-reconciler/content/metadataDifferences.xhtml";
const REPORT_URL = "chrome://zotero-library-reconciler/content/report.xhtml";

/** What a window row can ask for. `compare` is absent when Phase 4 writes are disabled. */
export interface DifferencesActions {
  select(itemKey: string): void;
  compare?: (itemKey: string) => Promise<string>;
}

export interface DifferencesWindowModel {
  summary: string;
  rows: readonly { itemKey: string; title: string; counts: string; detail: string; fillable: number }[];
}

export interface MetadataDifferencesOptions {
  /** Opens Compare Copies for one My Library item and returns a one-line status; absent → no Compare button. */
  compare?: (item: ZoteroItem) => Promise<string>;
  openWindow?: (model: DifferencesWindowModel, actions: DifferencesActions) => void;
  show?: (text: string, title: string) => void;
}

export class MetadataDifferencesCommand {
  private readonly menuItems = new Map<Window, Element[]>();
  private readonly compare: ((item: ZoteroItem) => Promise<string>) | undefined;
  private readonly openWindow: (model: DifferencesWindowModel, actions: DifferencesActions) => void;
  private readonly show: (text: string, title: string) => void;

  constructor(private readonly zotero: ZoteroDifferencesUI, options: MetadataDifferencesOptions = {}) {
    this.compare = options.compare;
    this.openWindow = options.openWindow ?? ((model, actions) => this.openDifferencesWindow(model, actions));
    this.show = options.show ?? ((text, title) => this.openReportWindow(text, title));
  }

  register(window: Window = this.zotero.getMainWindow()): void {
    const document = window.document as XULDocument;
    const menu = document.getElementById("menu_ToolsPopup");
    if (!menu || document.getElementById(MENU_ID)) return;
    const item = document.createXULElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("label", "Metadata Differences in My Library…");
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

  async run(): Promise<MetadataDifferenceReport | undefined> {
    try {
      const { audit, myLibraryID, titles, records } = await loadStrongComparisons(this.zotero);
      const report = metadataDifferenceReport(audit.confirmedPairs, myLibraryID, records, titles);
      this.openWindow(windowModel(report, this.compare !== undefined), this.actions(myLibraryID));
      return report;
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Metadata Differences failed: ${String(error)}`);
      this.show(`Metadata Differences could not complete: ${String(error)}`, "Metadata Differences");
      return undefined;
    }
  }

  private actions(myLibraryID: number): DifferencesActions {
    const select = (itemKey: string) => {
      const id = this.zotero.Items.getIDFromLibraryAndKey(myLibraryID, itemKey);
      if (id) void this.zotero.getActiveZoteroPane().selectItem(id, { inLibraryRoot: true });
    };
    const { compare } = this;
    if (!compare) return { select };
    return {
      select,
      compare: async (itemKey) => {
        const item = this.zotero.Items.getByLibraryAndKey(myLibraryID, itemKey);
        return item ? compare(item) : "This item no longer exists.";
      }
    };
  }

  private openDifferencesWindow(model: DifferencesWindowModel, actions: DifferencesActions): void {
    const window = this.zotero.getMainWindow() as ChromeWindow;
    window.openDialog(WINDOW_URL, "", "chrome,dialog=no,centerscreen,resizable", { model, actions });
  }

  private openReportWindow(text: string, title: string): void {
    const window = this.zotero.getMainWindow() as ChromeWindow;
    try {
      window.openDialog(REPORT_URL, "", "chrome,dialog=no,centerscreen,resizable", { title, text });
    } catch {
      window.alert(text);
    }
  }
}

/**
 * SCAN → MATCH, then the field records of every My Library item with a direct strong match
 * and of those matches. Shared by this report and Fill Missing, so both see the same items.
 */
export async function loadStrongComparisons(zotero: ZoteroReadAPI & ZoteroFieldReadAPI) {
  const { audit, myLibraryID, items } = await auditLibraries(zotero);
  const titleByKey = new Map(items.map((item) => [refKey(item.ref), item.fields.title || "Untitled"]));
  const targets = strongPartnersOfMyLibrary(audit.confirmedPairs, myLibraryID);
  const refs = new Map<string, ItemRef>();
  for (const { target, partners } of targets.values()) {
    for (const ref of [target, ...partners.map((partner) => partner.ref)]) refs.set(refKey(ref), ref);
  }
  const records = new Map<string, FieldRecord>();
  for (const [key, ref] of refs) {
    const record = await readFieldRecord(zotero, ref);
    if (record) records.set(key, record);
  }
  return { audit, myLibraryID, targets, records, titles: (ref: Pick<ItemRef, "libraryID" | "itemKey">) => titleByKey.get(refKey(ref)) ?? "Untitled" };
}

export function windowModel(report: MetadataDifferenceReport, canCompare: boolean): DifferencesWindowModel {
  const fillable = report.items.filter((item) => item.fillable > 0).length;
  const parts = [
    `${report.compared} My Library item${report.compared === 1 ? " has" : "s have"} a strong match (EXACT or HIGH) in another library. ${report.items.length} of them ha${report.items.length === 1 ? "s" : "ve"} fields that differ; ${fillable} ha${fillable === 1 ? "s" : "ve"} fields My Library lacks that every copy agrees on (identifiers not counted: they are never filled automatically).`,
    canCompare
      ? "Compare Copies… opens the update window for that item, which re-reads current values; nothing changes until you confirm there."
      : "Read-only: updating is disabled (extensions.zotero-library-reconciler.enableReconcile).",
    ...(report.unreadable > 0 ? [`${report.unreadable} item${report.unreadable === 1 ? "" : "s"} could not be read (deleted since the scan?) and ${report.unreadable === 1 ? "is" : "are"} not listed.`] : [])
  ];
  return { summary: parts.join("\n"), rows: report.items.map(row) };
}

function row(item: ItemDifferenceSummary): DifferencesWindowModel["rows"][number] {
  const missing = item.missing === item.fillable ? `${item.missing} missing` : `${item.missing} missing (${item.fillable} fillable; identifiers need checking)`;
  const counts = [missing, `${item.different} different`, `${item.conflicting} conflicting`].join(" · ");
  const fields = item.fields.map((field) => `${field.field} (${field.class === "MISSING" && !field.fillable ? "missing — identifier, check by hand" : field.class.toLowerCase()})`).join(", ");
  return { itemKey: item.target.itemKey, title: item.title, counts, detail: `${fields} — vs ${item.sourceLibraries.join(", ")}`, fillable: item.fillable };
}
