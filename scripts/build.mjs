import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoredZip } from "../src/lib/diagnostics.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environmentIndex = process.argv.indexOf("--environment");
const environment = environmentIndex >= 0 ? process.argv[environmentIndex + 1] : "staging";
if (!["staging", "production"].includes(environment)) throw new Error("environment must be staging or production");
const supportFormUrl = environment === "staging"
  ? "https://serp-dev-safe-store.serpcompany.workers.dev/support?source=serp-helper-staging"
  : "https://serp.store/support?source=serp-helper";
const outDir = path.join(root, "dist", `serp-helper-${environment}-chrome`);
await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, "lib"), { recursive: true });
for (const file of ["background.js", "support.html"]) await cp(path.join(root, "src", file), path.join(outDir, file));
await cp(path.join(root, "src", "lib", "diagnostics.js"), path.join(outDir, "lib", "diagnostics.js"));
const supportSource = await readFile(path.join(root, "src", "support.js"), "utf8");
await writeFile(path.join(outDir, "support.js"), supportSource.replace("__SUPPORT_FORM_URL__", supportFormUrl));
for (const size of [16, 32, 48, 128]) await cp(path.join(root, "assets", `icon-${size}.png`), path.join(outDir, `icon-${size}.png`));
const manifest = {
  manifest_version: 3,
  name: environment === "staging" ? "SERP Helper (Staging)" : "SERP Helper",
  description: "Creates privacy-bounded diagnostics for a structured SERP support case.",
  version: "0.1.0",
  icons: Object.fromEntries([16, 32, 48, 128].map((size) => [String(size), `icon-${size}.png`])),
  permissions: ["activeTab", "debugger", "downloads", "storage", "tabs"],
  optional_permissions: ["cookies"],
  optional_host_permissions: ["http://*/*", "https://*/*"],
  action: { default_title: "SERP Support Helper", default_popup: "support.html" },
  background: { service_worker: "background.js", type: "module" },
};
await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(outDir, "build-info.json"), `${JSON.stringify({ environment, version: manifest.version, supportFormUrl }, null, 2)}\n`);
const names = ["background.js", "build-info.json", ...[16, 32, 48, 128].map((size) => `icon-${size}.png`), "lib/diagnostics.js", "manifest.json", "support.html", "support.js"];
const files = await Promise.all(names.map(async (name) => ({ name, data: new Uint8Array(await readFile(path.join(outDir, name))) })));
const archive = buildStoredZip(files);
const archivePath = path.join(root, "dist", `serp-helper-${environment}-chrome.zip`);
await writeFile(archivePath, archive);
console.log(archivePath);
