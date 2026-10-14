/* Zotero discovers these lifecycle functions as top-level globals. */
var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, rootURI, resourceURI }, reason) {
  await Zotero.initializationPromise;
  // Zotero can call startup twice without a shutdown in between (ADDON_ENABLE then
  // APP_STARTUP after a re-enable). The runtime bundle is an IIFE, so a second load would
  // orphan the first instance's registrations; tear it down first.
  if (globalThis.ZoteroLibraryReconciler) {
    Zotero.debug("[Zotero Library Reconciler] startup called again; restarting.");
    shutdown({ id, version, rootURI, resourceURI }, reason);
  }
  const baseURI = rootURI || resourceURI.spec;

  // Zotero 7+ ignores chrome.manifest for bootstrapped plugins; chrome:// URLs must be
  // registered here so the report window (chrome/content/report.xhtml) resolves.
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(`${baseURI}manifest.json`);
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-library-reconciler", `${baseURI}chrome/content/`]
  ]);

  Services.scriptloader.loadSubScript(`${baseURI}chrome/content/runtime.js`, globalThis);
  globalThis.ZoteroLibraryReconciler.startup();
}

// Menu entries are per-window DOM nodes; the item-tree column is global and needs no per-window work.
function onMainWindowLoad({ window }) {
  globalThis.ZoteroLibraryReconciler?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  globalThis.ZoteroLibraryReconciler?.onMainWindowUnload(window);
}

function shutdown(data, reason) {
  globalThis.ZoteroLibraryReconciler?.shutdown();
  delete globalThis.ZoteroLibraryReconciler;
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
