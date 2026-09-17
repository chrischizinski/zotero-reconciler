/* Zotero discovers these lifecycle functions as top-level globals. */
var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, rootURI, resourceURI }, reason) {
  await Zotero.initializationPromise;
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

function shutdown(data, reason) {
  globalThis.ZoteroLibraryReconciler?.shutdown();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
