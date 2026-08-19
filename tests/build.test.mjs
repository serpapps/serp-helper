import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.join(root, "dist", "serp-helper-staging-chrome.zip");
const buildInfoPath = path.join(root, "dist", "serp-helper-staging-chrome", "build-info.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("staging helper builds are byte-for-byte reproducible", async () => {
  const build = () => execFileSync(process.execPath, ["scripts/build.mjs", "--environment", "staging"], {
    cwd: root,
    stdio: "ignore",
  });

  build();
  const first = await readFile(archivePath);
  build();
  const second = await readFile(archivePath);
  assert.equal(sha256(first), sha256(second));

  const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
  assert.deepEqual(buildInfo, {
    environment: "staging",
    version: "0.1.0",
    supportFormUrl: "https://serp-dev-safe-store.serpcompany.workers.dev/support?source=serp-helper-staging",
  });
});
