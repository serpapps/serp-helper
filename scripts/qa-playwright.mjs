import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperDir = path.join(root, "dist", "serp-helper-staging-chrome");
const localZip = path.join(root, "dist", "serp-helper-staging-chrome.zip");
const liveSupportUrl = "https://serp-dev-safe-store.serpcompany.workers.dev/support?validation=synthetic-playwright";
const stagingSupportUrl = "https://serp-dev-safe-store.serpcompany.workers.dev/support?source=serp-helper-staging";
const contentTypes = new Map([
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function installChromeMock({ activeUrl, permissionGranted }) {
  const state = { permissionRequest: null, message: null, download: null };
  Object.defineProperty(window, "__serpHelperTest", { value: state, configurable: true });
  const chromeApi = window.chrome || {};
  Object.assign(chromeApi, {
    tabs: { query(_query, callback) { callback([{ id: 42, url: activeUrl }]); } },
    permissions: {
      async request(request) {
        state.permissionRequest = request;
        return permissionGranted;
      },
    },
    runtime: {
      async sendMessage(message) {
        state.message = message;
        return { ok: true, zipBytes: [80, 75, 3, 4] };
      },
    },
    downloads: {
      async download(options) {
        state.download = options;
        return 1;
      },
    },
  });
  if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: chromeApi });
}

const server = createServer(async (request, response) => {
  try {
    const relative = new URL(request.url, "http://127.0.0.1").pathname.replace(/^\/+/, "") || "support.html";
    if (relative === "favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const resolved = path.resolve(helperDir, relative);
    if (!resolved.startsWith(`${helperDir}${path.sep}`)) throw new Error("Invalid path");
    const body = await readFile(resolved);
    response.writeHead(200, { "content-type": contentTypes.get(path.extname(resolved)) || "application/octet-stream" });
    response.end(body);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const popupUrl = `http://127.0.0.1:${server.address().port}/support.html`;
const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  console.log("[qa] testing helper popup success path");
  const popup = await browser.newPage();
  popup.setDefaultTimeout(10_000);
  popup.on("pageerror", (error) => console.error(`[popup error] ${error.message}`));
  await popup.addInitScript(installChromeMock, { activeUrl: "https://example.test/private/path?token=must-not-appear", permissionGranted: true });
  await popup.goto(popupUrl, { waitUntil: "domcontentloaded" });
  await popup.getByText("https://example.test", { exact: true }).waitFor();
  assert.equal(await popup.locator("#exportButton").isDisabled(), true);
  assert.equal(await popup.locator("#supportLink").getAttribute("href"), stagingSupportUrl);
  await popup.locator("#consent").check();
  assert.equal(await popup.locator("#exportButton").isEnabled(), true);
  await popup.locator("#exportButton").click();
  await popup.getByText("support.zip is ready. Open the support form and attach it to your case.", { exact: true }).waitFor();
  const state = await popup.evaluate(() => ({
    permissionRequest: window.__serpHelperTest.permissionRequest,
    message: window.__serpHelperTest.message,
    filename: window.__serpHelperTest.download?.filename,
  }));
  assert.deepEqual(state.permissionRequest, { permissions: ["cookies"], origins: ["https://example.test/*"] });
  assert.deepEqual(state.message, { type: "SERP_HELPER_EXPORT" });
  assert.equal(state.filename, "support.zip");

  console.log("[qa] testing restricted-page rejection");
  const restricted = await browser.newPage();
  restricted.setDefaultTimeout(10_000);
  await restricted.addInitScript(installChromeMock, { activeUrl: "chrome://extensions/", permissionGranted: true });
  await restricted.goto(popupUrl, { waitUntil: "domcontentloaded" });
  await restricted.getByText("Open the affected http(s) website first.", { exact: true }).waitFor();
  await restricted.locator("#consent").check();
  assert.equal(await restricted.locator("#exportButton").isDisabled(), true);

  console.log("[qa] testing permission-denial error");
  const denied = await browser.newPage();
  denied.setDefaultTimeout(10_000);
  await denied.addInitScript(installChromeMock, { activeUrl: "https://example.test/problem", permissionGranted: false });
  await denied.goto(popupUrl, { waitUntil: "domcontentloaded" });
  await denied.locator("#consent").check();
  await denied.locator("#exportButton").click();
  await denied.getByText("Website diagnostic permission was not granted.", { exact: true }).waitFor();

  console.log("[qa] testing live staging guidance and download");
  const store = await browser.newPage({ acceptDownloads: true });
  store.setDefaultTimeout(30_000);
  store.on("pageerror", (error) => console.error(`[store error] ${error.message}`));
  await store.goto(liveSupportUrl, { waitUntil: "domcontentloaded" });
  await store.waitForTimeout(5_000);
  console.log(`[qa] live page ${await store.title()} ${store.url()}`);
  const liveText = await store.locator("body").innerText();
  assert.match(liveText, /Create support\.zip with SERP Helper/);
  assert.match(liveText, /reproduce the problem during the five-second capture/);
  const downloadLink = store.getByRole("link", { name: "Download staging SERP Helper for Chrome" });
  assert.equal(await downloadLink.getAttribute("href"), "/downloads/serp-helper-staging-chrome.zip");
  const [download] = await Promise.all([store.waitForEvent("download"), downloadLink.click()]);
  const downloadedPath = await download.path();
  const [downloaded, expected] = await Promise.all([readFile(downloadedPath), readFile(localZip)]);
  assert.equal(sha256(downloaded), sha256(expected));
  const attachment = store.locator('input[name="diagnostic"]');
  await attachment.setInputFiles(localZip);
  assert.equal(await attachment.evaluate((input) => input.files?.[0]?.name), "serp-helper-staging-chrome.zip");

  console.log(JSON.stringify({
    helperPopup: "passed",
    restrictedPageRejection: "passed",
    permissionDenial: "passed",
    stagingGuidance: "passed",
    attachmentSelection: "passed",
    liveDownloadSha256: sha256(downloaded),
    productionTouched: false,
    formSubmitted: false,
  }, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
