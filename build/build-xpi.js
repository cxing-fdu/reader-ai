const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const output = join(dist, `reader-ai-${manifest.version}.xpi`);
const latest = join(dist, "reader-ai-latest.xpi");

if (!existsSync(dist)) {
  mkdirSync(dist);
}

for (const file of [output, latest]) {
  if (existsSync(file)) {
    unlinkSync(file);
  }
}

execFileSync(
  "zip",
  [
    "-r",
    output,
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "defaults",
    "content",
    "locale",
    "icons",
    "-x",
    "dist/*",
    "*.DS_Store",
    "__MACOSX/*",
  ],
  { cwd: root, stdio: "inherit" }
);

copyFileSync(output, latest);
console.log(output);
console.log(latest);
