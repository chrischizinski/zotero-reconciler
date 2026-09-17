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
    const command = new FindCopiesCommand(
      Zotero as ConstructorParameters<typeof FindCopiesCommand>[0],
      store,
      () => new Date(),
      () => coverageColumn?.refresh(),
    );
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
