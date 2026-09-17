import { FindCopiesCommand } from "../zotero/findCopiesCommand.js";

declare const Zotero: {
  debug(message: string): void;
  getActiveZoteroPane(): unknown;
  getMainWindow(): Window;
  Libraries: unknown;
  Items: unknown;
};

let findCopiesCommand: FindCopiesCommand | undefined;

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
    findCopiesCommand = new FindCopiesCommand(
      Zotero as ConstructorParameters<typeof FindCopiesCommand>[0],
    );
    findCopiesCommand.register();
    log("Started read-only matching foundation.");
  },
  shutdown(): void {
    findCopiesCommand?.unregister();
    findCopiesCommand = undefined;
    log("Stopped.");
  },
};
