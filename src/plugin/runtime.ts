import { CoverageColumn, type ItemTreeManagerAPI } from "../zotero/coverageColumn.js";
import { FindCopiesCommand } from "../zotero/findCopiesCommand.js";
import { IndexStore, type SnapshotFileSystem } from "../zotero/indexStore.js";

declare const Zotero: {
  debug(message: string): void;
  getActiveZoteroPane(): unknown;
  getMainWindow(): Window;
  Libraries: unknown;
  Items: unknown;
  DataDirectory: { dir: string };
  ItemTreeManager: ItemTreeManagerAPI;
};
declare const IOUtils: SnapshotFileSystem;
declare const Services: {
  prompt: { confirmEx(window: Window, title: string, text: string, flags: number, b0: string, b1: string, b2: string | null, check: string | null, state: object): number; BUTTON_POS_0: number; BUTTON_POS_1: number; BUTTON_TITLE_IS_STRING: number };
};
declare const PathUtils: { join(...parts: string[]): string };

let findCopiesCommand: FindCopiesCommand | undefined;
let coverageColumn: CoverageColumn | undefined;

type ReconcilerRuntime = {
  startup(): void;
  shutdown(): void;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  ZoteroLibraryReconciler: ReconcilerRuntime;
};

function log(message: string): void {
  Zotero.debug(`[Zotero Library Reconciler] ${message}`);
}

runtimeGlobal.ZoteroLibraryReconciler = {
  startup(): void {
    const store = IndexStore.inDataDirectory(IOUtils, Zotero.DataDirectory.dir, (...parts) => PathUtils.join(...parts));
    const command = new FindCopiesCommand(Zotero as ConstructorParameters<typeof FindCopiesCommand>[0], {
      store,
      onIndexChanged: () => coverageColumn?.refresh(),
      confirmRescan: (message) => {
        const { prompt } = Services;
        const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING;
        return prompt.confirmEx(Zotero.getMainWindow(), "Zotero Library Reconciler", message, flags, "Rescan Now", "Later", null, null, {}) === 0;
      },
    });
    findCopiesCommand = command;
    coverageColumn = new CoverageColumn(Zotero.ItemTreeManager, () => command.workLookup);
    command.register();
    coverageColumn.register();
    void command.restoreIndex().catch((error: unknown) => log(`Index restore failed: ${String(error)}`));
    log("Started read-only matching foundation.");
  },
  shutdown(): void {
    coverageColumn?.unregister();
    coverageColumn = undefined;
    findCopiesCommand?.unregister();
    findCopiesCommand = undefined;
    log("Stopped.");
  },
};
