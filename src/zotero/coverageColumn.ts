import type { WorkLookup } from "../works/indexSnapshot.js";

/** The subset of `Zotero.ItemTreeManager` (Zotero 7+ plugin API) the column uses. */
export interface ItemTreeManagerAPI {
  registerColumn(option: ItemTreeColumnOption): string | false;
  unregisterColumn(dataKey: string): boolean;
  refreshColumns(): void;
}

export interface ItemTreeColumnOption {
  dataKey: string;
  label: string;
  pluginID: string;
  enabledTreeIDs?: string[];
  flex?: number;
  width?: string;
  minWidth?: number;
  showInColumnPicker?: boolean;
  zoteroPersist?: string[];
  dataProvider: (item: { libraryID: number; key: string; isRegularItem(): boolean }, dataKey: string) => string;
}

export const PLUGIN_ID = "zotero-library-reconciler@cchizinski2.local";

/**
 * Read-only "Also in" item-tree column (§36 coverage view). Answers from the persisted
 * index only; it never scans or writes. Empty until an audit has run.
 */
export class CoverageColumn {
  private registeredKey: string | undefined;

  constructor(private readonly manager: ItemTreeManagerAPI, private readonly lookup: () => WorkLookup | undefined) {}

  register(): void {
    if (this.registeredKey) return;
    const key = this.manager.registerColumn({
      dataKey: "alsoIn",
      label: "Also in",
      pluginID: PLUGIN_ID,
      enabledTreeIDs: ["main"],
      flex: 1,
      minWidth: 80,
      showInColumnPicker: true,
      zoteroPersist: ["width", "hidden", "sortDirection"],
      dataProvider: (item) => this.cellText(item)
    });
    if (key) this.registeredKey = key;
  }

  unregister(): void {
    if (!this.registeredKey) return;
    this.manager.unregisterColumn(this.registeredKey);
    this.registeredKey = undefined;
  }

  /** Call after the index changes so visible rows repaint. */
  refresh(): void {
    if (this.registeredKey) this.manager.refreshColumns();
  }

  cellText(item: { libraryID: number; key: string; isRegularItem(): boolean }): string {
    if (!item.isRegularItem()) return "";
    return this.lookup()?.alsoIn(item.libraryID, item.key).join(", ") ?? "";
  }
}
