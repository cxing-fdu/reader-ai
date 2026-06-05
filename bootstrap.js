var ReaderAIChromeHandle;

function install() {}

function uninstall() {}

async function startup({ id, version, resourceURI, rootURI }) {
  await Zotero.initializationPromise;

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  let aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  let manifestURI = Services.io.newURI(rootURI + "manifest.json");

  ReaderAIChromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "reader-ai", rootURI + "content/"],
    ["locale", "reader-ai", "en-US", rootURI + "locale/en-US/"],
  ]);

  Services.scriptloader.loadSubScript(rootURI + "content/reader-ai.js");
  ReaderAI.init({ id, version, rootURI });
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  if (typeof ReaderAI !== "undefined") {
    ReaderAI.shutdown();
  }
  if (ReaderAIChromeHandle) {
    ReaderAIChromeHandle.destruct();
    ReaderAIChromeHandle = null;
  }
}
