import { auditLibraries, currentLibraryVersions, findCopies, type FindCopiesResult, type ZoteroItem, type ZoteroReadAPI } from "./adapter.js";
import type { CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import { compareBibliographicFields } from "../comparison/fieldComparator.js";
import { createSnapshot, staleLibraries, WorkLookup, type IndexSnapshot } from "../works/indexSnapshot.js";
import type { IndexStore } from "./indexStore.js";

interface ZoteroPane {
  getSelectedItems(): ZoteroItem[];
}

interface XULDocument extends Document {
  createXULElement(name: string): Element;
}

/** Gecko's chrome-privileged window; `openDialog` is not in the DOM lib. */
interface ChromeWindow extends Window {
  openDialog(url: string, name: string, features: string, ...args: unknown[]): Window;
}

interface ZoteroUI extends ZoteroReadAPI {
  debug(message: string): void;
  getActiveZoteroPane(): ZoteroPane;
  getMainWindow(): Window;
}

const MENU_ID = "zotero-library-reconciler-find-copies";
const AUDIT_MENU_ID = "zotero-library-reconciler-audit";

export interface CommandOptions {
  store?: IndexStore;
  now?: () => Date;
  /** Invoked whenever `workLookup` changes (audit or restore) so dependents can repaint. */
  onIndexChanged?: () => void;
  /** Asks the user whether to rescan a stale index; returns true to rescan. Absent → never prompts. */
  confirmRescan?: (message: string) => boolean;
}

export class FindCopiesCommand {
  /** Menu entries are DOM nodes, so they exist per main window (macOS can close and reopen it). */
  private readonly menuItems = new Map<Window, Element[]>();
  private lookup: WorkLookup | undefined;
  private readonly store: IndexStore | undefined;
  private readonly now: () => Date;
  private readonly onIndexChanged: () => void;
  private readonly confirmRescan: ((message: string) => boolean) | undefined;

  constructor(private readonly zotero: ZoteroUI, options: CommandOptions = {}) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.onIndexChanged = options.onIndexChanged ?? (() => undefined);
    this.confirmRescan = options.confirmRescan;
  }

  /** The last persisted index, if any; the audit command refreshes it. */
  get workLookup(): WorkLookup | undefined {
    return this.lookup;
  }

  /**
   * Loads the persisted index at startup so consumers (e.g. a coverage column) can answer
   * immediately, then offers a rescan if any library changed since the scan (§29). The old
   * index stays in use until the rescan completes, so a "Later" answer costs nothing.
   */
  async restoreIndex(): Promise<IndexSnapshot | undefined> {
    const snapshot = await this.store?.load();
    if (!snapshot) return undefined;
    this.lookup = new WorkLookup(snapshot);
    this.onIndexChanged();
    const stale = staleLibraries(snapshot, currentLibraryVersions(this.zotero));
    this.zotero.debug(`[Zotero Library Reconciler] Restored index of ${snapshot.works.length} works from ${snapshot.scannedAt}; ${stale.length} librar${stale.length === 1 ? "y has" : "ies have"} changed since.`);
    if (stale.length > 0 && this.confirmRescan?.(renderStalePrompt(snapshot, stale))) await this.runAudit();
    return snapshot;
  }

  /** Adds the item-menu entries to `window` (defaults to the current main window). Idempotent per window. */
  register(window: Window = this.zotero.getMainWindow()): void {
    const document = window.document as XULDocument;
    const menu = document.getElementById("zotero-itemmenu");
    if (!menu || document.getElementById(MENU_ID)) return;

    const item = document.createXULElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("label", "Find Copies in Other Libraries");
    item.addEventListener("command", () => void this.run());
    menu.appendChild(item);

    const auditItem = document.createXULElement("menuitem");
    auditItem.id = AUDIT_MENU_ID;
    auditItem.setAttribute("label", "Audit Cross-Library Coverage");
    auditItem.addEventListener("command", () => void this.runAudit());
    menu.appendChild(auditItem);

    this.menuItems.set(window, [item, auditItem]);
  }

  /** Removes the entries from one window (on its unload) or from every window (on shutdown). */
  unregister(window?: Window): void {
    const targets = window ? [window] : [...this.menuItems.keys()];
    for (const target of targets) {
      for (const element of this.menuItems.get(target) ?? []) element.remove();
      this.menuItems.delete(target);
    }
  }

  async runAudit(): Promise<void> {
    try {
      const { audit, libraries } = await auditLibraries(this.zotero);
      const snapshot = createSnapshot(audit, libraries, this.now());
      this.lookup = new WorkLookup(snapshot);
      this.onIndexChanged();
      let persistence = "Index not persisted (no store configured).";
      if (this.store) {
        try {
          await this.store.save(snapshot);
          persistence = `Index of ${snapshot.works.length} works saved to ${this.store.location}.`;
        } catch (error) {
          this.zotero.debug(`[Zotero Library Reconciler] Index save failed: ${String(error)}`);
          persistence = "Index could not be saved; see Zotero's debug output.";
        }
      }
      this.show(`${renderAudit(audit)}\n\n${persistence}`, "Cross-Library Audit");
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Audit failed: ${String(error)}`);
      this.show("Cross-library audit could not complete. See Zotero's debug output for details.");
    }
  }

  async run(): Promise<void> {
    const selected = this.zotero.getActiveZoteroPane().getSelectedItems();
    if (selected.length !== 1 || !selected[0]?.isRegularItem()) {
      this.show("Select one bibliographic item, then choose Find Copies in Other Libraries.");
      return;
    }

    try {
      const result = await findCopies(this.zotero, selected[0]);
      this.show(renderResult(result), "Find Copies");
    }
    catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Find Copies failed: ${String(error)}`);
      this.show("Find Copies could not complete. See Zotero's debug output for details.");
    }
  }

  /** Resizable, scrollable, non-modal report window; `alert()` cannot show a library-sized report. */
  private show(message: string, title = "Zotero Library Reconciler"): void {
    const window = this.zotero.getMainWindow() as ChromeWindow;
    try {
      window.openDialog(
        "chrome://zotero-library-reconciler/content/report.xhtml",
        "",
        "chrome,dialog=no,centerscreen,resizable",
        { title, text: message }
      );
    } catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Report window failed, falling back to alert: ${String(error)}`);
      window.alert(message);
    }
  }
}

export function renderStalePrompt(snapshot: IndexSnapshot, stale: readonly { name: string }[]): string {
  const when = snapshot.scannedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const names = stale.map((library) => library.name).join(", ");
  return `The cross-library index was built on ${when}. Since then ${stale.length === 1 ? "this library has" : "these libraries have"} changed: ${names}.\n\nRescan now? The scan is read-only and takes a few seconds. The "Also in" column keeps using the old index until you rescan.`;
}

export function renderAudit(audit: CrossLibraryAudit): string {
  const heading = "Cross-Library Audit";
  const summary = `Compared ${audit.comparedPairs} plausible cross-library pairs. Found ${audit.works.length} scholarly works; ${audit.missingFromMyLibrary.length} are absent from My Library; ${audit.discrepancies.length} matched pairs have metadata differences.`;
  const examples = audit.missingFromMyLibrary.slice(0, 20).map(({ canonical }) => `• ${canonical.fields.title || "Untitled"} — ${canonical.ref.libraryName}`);
  const differenceExamples = audit.discrepancies.slice(0, 10).map(({ left, right, differences }) => `• ${left.fields.title || "Untitled"} — ${left.ref.libraryName} / ${right.ref.libraryName}: ${differences.map(({ field }) => field).join(", ")}`);
  const missingSection = examples.length === 0 ? "No group-library-only works found." : `First ${examples.length} missing works:\n${examples.join("\n")}`;
  const differenceSection = differenceExamples.length === 0 ? "No metadata differences among confirmed matches." : `First ${differenceExamples.length} metadata differences:\n${differenceExamples.join("\n")}`;
  return `${heading}\n\n${summary}\n\n${renderLinkedOracle(audit)}\n\n${missingSection}\n\n${differenceSection}`;
}

/**
 * Zotero's own linked-item relations (§8.0) are user-asserted copies, so every linked pair the
 * bibliographic rules alone would not match is a genuine matcher false negative worth reading.
 */
function renderLinkedOracle(audit: CrossLibraryAudit): string {
  if (audit.linkedPairs === 0) return "Zotero linked items: none found (Zotero records these when you drag items between libraries).";
  const missed = audit.linkedButUnmatched;
  const head = `Zotero linked items: ${audit.linkedPairs} pairs; ${missed.length} need review because the bibliographic rules disagree with the link (a stale link after one record was repurposed, or a wrong identifier/type in one copy). These are not clustered.`;
  if (missed.length === 0) return head;
  const rows = missed.slice(0, 25).map(({ left, right, result }) => `• ${left.fields.title || "Untitled"} (${left.ref.libraryName}) / ${right.fields.title || "Untitled"} (${right.ref.libraryName}): ${result.evidence.map(({ detail }) => detail).join(" ")}`);
  return `${head}\nFirst ${rows.length}:\n${rows.join("\n")}`;
}

export function renderResult(result: FindCopiesResult): string {
  const heading = `Find Copies: ${result.source.fields.title || "Untitled"}`;
  const summary = `Compared ${result.scannedItems} plausible candidates in ${result.scannedLibraries} other libraries.`;
  if (result.copies.length === 0) return `${heading}\n\n${summary}\n\nNo copies or review candidates found.`;

  const rows = result.copies.map(({ item, result: match }) => {
    const evidence = match.evidence.map(({ detail }) => detail).join(" ");
    const differences = match.verdict === "match" ? compareBibliographicFields(result.source, item) : [];
    const differenceText = differences.length === 0 ? "" : `\n  Differences: ${differences.map(({ field, left, right }) => `${field} (${left} → ${right})`).join("; ")}`;
    return `• ${item.ref.libraryName} — ${match.verdict.toUpperCase()}\n  ${item.fields.title || "Untitled"}\n  ${evidence}${differenceText}`;
  });
  return `${heading}\n\n${summary}\n\n${rows.join("\n\n")}`;
}
