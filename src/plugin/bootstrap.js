/* Zotero discovers these lifecycle functions as top-level globals. */
function install(data, reason) {}

async function startup({ rootURI, resourceURI }, reason) {
  await Zotero.initializationPromise;
  const baseURI = rootURI || resourceURI.spec;
  Services.scriptloader.loadSubScript(`${baseURI}chrome/content/runtime.js`, globalThis);
  globalThis.ZoteroLibraryReconciler.startup();
}

function shutdown(data, reason) {
  globalThis.ZoteroLibraryReconciler?.shutdown();
}

function uninstall(data, reason) {}
