import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessCaptureQuality,
  buildStoredZip,
  createBundleManifest,
  normalizeCaptureTarget,
  sanitizeDiagnosticText,
  sanitizeNetworkEntry,
  summarizeCookies,
} from "../src/lib/diagnostics.js";

test("capture target accepts only credential-free web origins", () => {
  assert.deepEqual(normalizeCaptureTarget("https://Example.com/private?token=x#secret"), { origin: "https://example.com" });
  assert.equal(normalizeCaptureTarget("chrome://extensions"), null);
  assert.equal(normalizeCaptureTarget("chrome-extension://abc/options.html"), null);
  assert.equal(normalizeCaptureTarget("https://user:pass@example.com"), null);
});

test("diagnostic text removes credentials emails and private URL parts", () => {
  const safe = sanitizeDiagnosticText("Authorization: Bearer secret.value user@example.com https://example.com/private?a=1#x");
  assert.doesNotMatch(safe, /secret\.value|user@example|\/private|a=1/);
  assert.match(safe, /\[redacted\]|https:\/\/example\.com/);
});

test("network projection keeps only selected-origin metadata", () => {
  assert.equal(sanitizeNetworkEntry({ url: "https://tracker.example/pixel" }, "https://example.com"), null);
  assert.deepEqual(sanitizeNetworkEntry({ url: "https://example.com/private?q=secret", method: "post", status: 403, resourceType: "Fetch" }, "https://example.com"), {
    method: "POST", origin: "https://example.com", resourceType: "Fetch", status: 403, mimeType: "", encodedBytes: null, failed: false, error: null,
  });
});

test("cookie evidence is aggregate only", () => {
  const summary = summarizeCookies([{ name: "session", value: "secret", secure: true, httpOnly: true, session: true, sameSite: "lax" }]);
  assert.deepEqual(summary, { total: 1, secure: 1, httpOnly: 1, session: 1, sameSite: { lax: 1 } });
  assert.doesNotMatch(JSON.stringify(summary), /"name"|"value"|secret/);
});

test("capture quality never calls an empty or failed capture useful", () => {
  assert.equal(assessCaptureQuality({ consoleEntries: 0, networkEntries: 0 }).status, "partial");
  assert.equal(assessCaptureQuality({ captureError: "debugger failed", consoleEntries: 1, networkEntries: 1 }).status, "failed");
  assert.equal(assessCaptureQuality({ consoleEntries: 0, networkEntries: 1 }).status, "useful");
});

test("manifest explicitly records privacy exclusions and consent", () => {
  const manifest = createBundleManifest({ generatedAt: "2026-08-19T00:00:00Z", targetOrigin: "https://example.com", helperVersion: "0.1.0", browser: "test", quality: { status: "useful", reason: null }, captureMs: 5000, consoleEntries: 1, networkEntries: 2 });
  assert.equal(manifest.collection.explicitConsent, true);
  for (const key of ["rawCookies", "installedExtensions", "requestHeaders", "responseHeaders", "requestBodies", "responseBodies", "fullPrivateUrls", "crossOriginNetwork"]) assert.equal(manifest.collection[key], false);
});

test("generated ZIP has local and end records", () => {
  const zip = buildStoredZip([{ name: "bundle.json", data: "{}" }]);
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(Array.from(zip.slice(-22, -18)), [0x50, 0x4b, 0x05, 0x06]);
});

test("source has no legacy receiver credential or broad inventory capture", async () => {
  const files = await Promise.all(["background.js", "support.js", "support.html"].map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")));
  const source = files.join("\n");
  assert.doesNotMatch(source, /api\.serp\.co\/support|Bearer\s+[A-Za-z0-9]|chrome\.management|getAllCookieStores|cookies\.txt|extensions\.txt/);
});
