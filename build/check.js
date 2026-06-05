const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const root = join(__dirname, "..");
const readJSON = file => JSON.parse(readFileSync(join(root, file), "utf8"));
const manifest = readJSON("manifest.json");
const pkg = readJSON("package.json");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function checkFile(path) {
  assert(existsSync(join(root, path)), `Missing required file: ${path}`);
}

assert(manifest.version === pkg.version, "manifest.json and package.json versions differ");
assert(manifest.author === "cxing-fdu", "manifest author should be cxing-fdu");
assert(manifest.applications?.zotero?.id, "Zotero application id is missing");
assert(manifest.applications?.zotero?.update_url, "Zotero update_url is missing");

[
  "bootstrap.js",
  "prefs.js",
  "defaults/preferences/reader-ai.js",
  "content/reader-ai.js",
  "content/reader-ai.css",
  "locale/en-US/reader-ai.ftl",
  "icons/reader-ai.svg",
  "icons/reader-ai-48.png",
  "icons/reader-ai-96.png",
].forEach(checkFile);

execFileSync(process.execPath, ["--check", join(root, "content/reader-ai.js")], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", join(root, "bootstrap.js")], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", join(root, "build/build-xpi.js")], { stdio: "inherit" });

const sandbox = { console, AbortController };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, "content/reader-ai.js"), "utf8"), sandbox);
const ReaderAI = sandbox.ReaderAI;

assert(ReaderAI, "ReaderAI object was not created");
assert(ReaderAI.isAbortError({ name: "AbortError" }), "Abort detection smoke test failed");

const figureSnippets = ReaderAI.extractFigureSnippets(
  "Introduction. Figure 2 shows the ablation curve and caption details. Methods follow. Conclusion discusses limitations.",
  ["2"],
  "解释 Figure 2"
);
assert(figureSnippets.length > 0, "Figure snippet smoke test failed");

const sectionHints = ReaderAI.sectionHintsForQuestion("帮我总结方法和局限");
assert(sectionHints.length >= 2, "Section hint smoke test failed");

const followups = ReaderAI.suggestFollowups(
  "解释 Figure 2 的方法",
  "The method uses an ablation figure.",
  { captionSnippets: [{ label: "Figure 2", text: "caption" }] }
);
assert(followups.some(item => item.label === "顺着图讲"), "Follow-up smoke test failed");
assert(ReaderAI.isMarkdownTableRow("| A | B |"), "Markdown table row smoke test failed");
assert(ReaderAI.isMarkdownTableSeparator("| --- | --- |"), "Markdown table separator smoke test failed");
assert(ReaderAI.cleanInlineText("**bold** and `code`") === "bold and code", "Inline markdown cleanup smoke test failed");
assert(ReaderAI.estimateTokens("12345678") === 2, "Token estimate smoke test failed");
assert(ReaderAI.contextCacheKey({ id: 1 }, { id: 2 }) === "1:2", "Context cache key smoke test failed");
assert(ReaderAI.findViewForRoot(null) === null, "findViewForRoot null smoke test failed");
ReaderAI.setStatus(null, "noop");

const diagnostic = ReaderAI.describeAPIError({
  status: 404,
  statusText: "Not Found",
  endpoint: "https://example.test/responses",
  apiType: "responses",
  model: "unavailable-model",
  json: { error: { message: "model does not exist" } },
  text: "",
});
assert(diagnostic.includes("Model: unavailable-model"), "Provider diagnostic smoke test failed");

ReaderAI.pluginID = "reader-ai@test";
ReaderAI.pref = key => ({
  baseURL: "https://api.example.com/v1",
  apiType: "responses",
  model: "example-model",
  apiKey: "TEST_PLACEHOLDER_VALUE",
  contextMode: "auto",
  maxContextChars: "24000",
  temperature: "0.2",
}[key] || "");
const debugReport = ReaderAI.debugReport(null);
assert(debugReport.includes("API Key configured: yes"), "Debug report key status smoke test failed");
assert(!debugReport.includes("TEST_PLACEHOLDER_VALUE"), "Debug report leaked API key");

console.log(`Reader AI checks passed for ${manifest.version}`);
