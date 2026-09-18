import { CoverageColumn, type ItemTreeManagerAPI } from "../zotero/coverageColumn.js";
import { FindCopiesCommand } from "../zotero/findCopiesCommand.js";
import { ImportCommand } from "../zotero/importCommand.js";
import { IndexStore, type SnapshotFileSystem } from "../zotero/indexStore.js";
import { TransactionStore, type LogFileSystem } from "../zotero/transactionStore.js";
import { zoteroWriteAPI, type ZoteroWriteAPI } from "../zotero/writeAdapter.js";

declare const Zotero: {
  debug(message: string): void;
  getActiveZoteroPane(): unknown;
  getMainWindow(): Window;
  getMainWindows(): Window[];
  Libraries: unknown;
  Items: unknown;
  URI: unknown;
  DataDirectory: { dir: string };
  ItemTreeManager: ItemTreeManagerAPI;
  Prefs: { get(pref: string, global?: boolean): unknown };
};
declare const IOUtils: SnapshotFileSystem & LogFileSystem;
declare const Services: {
  prompt: { confirmEx(window: Window, title: string, text: string, flags: number, b0: string, b1: string, b2: string | null, check: string | null, state: object): number; BUTTON_POS_0: number; BUTTON_POS_1: number; BUTTON_TITLE_IS_STRING: number; BUTTON_POS_1_DEFAULT: number };
};
declare const PathUtils: { join(...parts: string[]): string };

let findCopiesCommand: FindCopiesCommand | undefined;
let importCommand: ImportCommand | undefined;
let coverageColumn: CoverageColumn | undefined;

/**
 * Phase 3 gate. Off by default: the write path is not even registered unless this is true.
 * Set in the dev profile's prefs.js while the write engine is validated against real libraries.
 */
const ENABLE_IMPORT_PREF = "extensions.zotero-library-reconciler.enableImport";

type ReconcilerRuntime = {
  startup(): void;
  shutdown(): void;
  /** Bootstrap forwards Zotero's per-window hooks; menu entries live in each window's DOM. */
  onMainWindowLoad(window: Window): void;
  onMainWindowUnload(window: Window): void;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  ZoteroLibraryReconciler: ReconcilerRuntime;
};

function log(message: string): void {
  Zotero.debug(`[Zotero Library Reconciler] ${message}`);
}

/** Cancel is the default button: Enter must never trash anything. */
function confirmDialog(message: string, title: string, yes: string): boolean {
  const { prompt } = Services;
  const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1_DEFAULT;
  return prompt.confirmEx(Zotero.getMainWindow(), title, message, flags, yes, "Cancel", null, null, {}) === 0;
}

function importEnabled(): boolean {
  try {
    return Zotero.Prefs.get(ENABLE_IMPORT_PREF, true) === true;
  } catch {
    return false;
  }
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
    if (importEnabled()) {
      importCommand = new ImportCommand(Zotero as ConstructorParameters<typeof ImportCommand>[0], {
        writeAPI: zoteroWriteAPI(Zotero as unknown as ZoteroWriteAPI),
        store: TransactionStore.inDataDirectory(IOUtils, Zotero.DataDirectory.dir, (...parts) => PathUtils.join(...parts)),
        refreshIndex: () => command.refreshIndex(),
        confirm: (message) => confirmDialog(message, "Undo Last Import Session", "Move to Trash"),
      });
    }
    for (const window of Zotero.getMainWindows()) {
      command.register(window);
      importCommand?.register(window);
    }
    coverageColumn.register();
    void command.restoreIndex().catch((error: unknown) => log(`Index restore failed: ${String(error)}`));
    log(importCommand ? `Started; Phase 3 import ENABLED by ${ENABLE_IMPORT_PREF}.` : "Started read-only matching foundation.");
  },
  shutdown(): void {
    coverageColumn?.unregister();
    coverageColumn = undefined;
    importCommand?.unregister();
    importCommand = undefined;
    findCopiesCommand?.unregister();
    findCopiesCommand = undefined;
    log("Stopped.");
  },
  onMainWindowLoad(window: Window): void {
    findCopiesCommand?.register(window);
    importCommand?.register(window);
  },
  onMainWindowUnload(window: Window): void {
    findCopiesCommand?.unregister(window);
    importCommand?.unregister(window);
  },
};
