import { auditLibraries, findCopies, type FindCopiesResult, type ZoteroItem, type ZoteroReadAPI } from "./adapter.js";
import type { CrossLibraryAudit } from "../audit/crossLibraryAudit.js";
import { compareBibliographicFields } from "../comparison/fieldComparator.js";

interface ZoteroPane {
  getSelectedItems(): ZoteroItem[];
}

interface XULDocument extends Document {
  createXULElement(name: string): Element;
}

interface ZoteroUI extends ZoteroReadAPI {
  debug(message: string): void;
  getActiveZoteroPane(): ZoteroPane;
  getMainWindow(): Window;
}

const MENU_ID = "zotero-library-reconciler-find-copies";
const AUDIT_MENU_ID = "zotero-library-reconciler-audit";

export class FindCopiesCommand {
  private menuItem: Element | undefined;
  private auditMenuItem: Element | undefined;

  constructor(private readonly zotero: ZoteroUI) {}

  register(): void {
    const window = this.zotero.getMainWindow();
    const document = window.document as XULDocument;
    const menu = document.getElementById("zotero-itemmenu");
    if (!menu || document.getElementById(MENU_ID)) return;

    const item = document.createXULElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("label", "Find Copies in Other Libraries");
    item.addEventListener("command", () => void this.run());
    menu.appendChild(item);
    this.menuItem = item;

    const auditItem = document.createXULElement("menuitem");
    auditItem.id = AUDIT_MENU_ID;
    auditItem.setAttribute("label", "Audit Cross-Library Coverage");
    auditItem.addEventListener("command", () => void this.runAudit());
    menu.appendChild(auditItem);
    this.auditMenuItem = auditItem;
  }

  unregister(): void {
    this.menuItem?.remove();
    this.auditMenuItem?.remove();
    this.menuItem = undefined;
    this.auditMenuItem = undefined;
  }

  async runAudit(): Promise<void> {
    try {
      this.show(renderAudit(await auditLibraries(this.zotero)));
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
      this.show(renderResult(result));
    }
    catch (error) {
      this.zotero.debug(`[Zotero Library Reconciler] Find Copies failed: ${String(error)}`);
      this.show("Find Copies could not complete. See Zotero's debug output for details.");
    }
  }

  private show(message: string): void {
    this.zotero.getMainWindow().alert(message);
  }
}

export function renderAudit(audit: CrossLibraryAudit): string {
  const heading = "Cross-Library Audit";
  const summary = `Compared ${audit.comparedPairs} plausible cross-library pairs. Found ${audit.works.length} scholarly works; ${audit.missingFromMyLibrary.length} are absent from My Library; ${audit.discrepancies.length} matched pairs have metadata differences.`;
  const examples = audit.missingFromMyLibrary.slice(0, 20).map(({ canonical }) => `• ${canonical.fields.title || "Untitled"} — ${canonical.ref.libraryName}`);
  const differenceExamples = audit.discrepancies.slice(0, 10).map(({ left, right, differences }) => `• ${left.fields.title || "Untitled"} — ${left.ref.libraryName} / ${right.ref.libraryName}: ${differences.map(({ field }) => field).join(", ")}`);
  const missingSection = examples.length === 0 ? "No group-library-only works found." : `First ${examples.length} missing works:\n${examples.join("\n")}`;
  const differenceSection = differenceExamples.length === 0 ? "No metadata differences among confirmed matches." : `First ${differenceExamples.length} metadata differences:\n${differenceExamples.join("\n")}`;
  return `${heading}\n\n${summary}\n\n${missingSection}\n\n${differenceSection}`;
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
