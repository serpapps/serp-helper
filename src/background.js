import {
  assessCaptureQuality,
  buildStoredZip,
  createBundleManifest,
  normalizeCaptureTarget,
  sanitizeDiagnosticText,
  sanitizeNetworkEntry,
  summarizeCookies,
} from "./lib/diagnostics.js";

const CAPTURE_MS = 5_000;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_NETWORK_ENTRIES = 250;

const callbackResult = (register) => new Promise((resolve, reject) => register((value) => {
  const error = chrome.runtime.lastError;
  if (error) reject(new Error(error.message));
  else resolve(value);
}));

async function activeTab() {
  const tabs = await callbackResult((done) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, done));
  return tabs?.[0] || null;
}

async function cookieSummary(origin) {
  try {
    const cookies = await callbackResult((done) => chrome.cookies.getAll({ url: `${origin}/` }, done));
    return summarizeCookies(cookies);
  } catch {
    return summarizeCookies([]);
  }
}

async function platformInfo() {
  try {
    const info = await callbackResult((done) => chrome.runtime.getPlatformInfo(done));
    return { os: info?.os || "unknown", arch: info?.arch || "unknown" };
  } catch {
    return { os: "unknown", arch: "unknown" };
  }
}

async function captureTab(tabId, targetOrigin, captureMs) {
  const consoleEntries = [];
  const requests = new Map();
  let captureError = null;
  let attached = false;
  const debuggee = { tabId };
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === "Runtime.consoleAPICalled" && consoleEntries.length < MAX_CONSOLE_ENTRIES) {
      const text = (params?.args || []).map((item) => item?.value ?? item?.description ?? "").join(" ");
      consoleEntries.push({ level: params?.type || "log", message: sanitizeDiagnosticText(text) });
      return;
    }
    if (method === "Runtime.exceptionThrown" && consoleEntries.length < MAX_CONSOLE_ENTRIES) {
      consoleEntries.push({ level: "error", message: sanitizeDiagnosticText(params?.exceptionDetails?.text || "Exception") });
      return;
    }
    if (method === "Network.requestWillBeSent") {
      requests.set(String(params?.requestId || ""), {
        url: params?.request?.url,
        method: params?.request?.method,
        resourceType: params?.type,
      });
      return;
    }
    if (method === "Network.responseReceived") {
      const key = String(params?.requestId || "");
      const entry = requests.get(key) || {};
      requests.set(key, {
        ...entry,
        status: params?.response?.status,
        mimeType: params?.response?.mimeType,
      });
      return;
    }
    if (method === "Network.loadingFinished") {
      const key = String(params?.requestId || "");
      requests.set(key, { ...(requests.get(key) || {}), encodedBytes: params?.encodedDataLength });
      return;
    }
    if (method === "Network.loadingFailed") {
      const key = String(params?.requestId || "");
      requests.set(key, { ...(requests.get(key) || {}), failed: true, error: params?.errorText });
    }
  };
  const onDetach = (source, reason) => {
    if (source.tabId === tabId) captureError ||= `Debugger detached: ${sanitizeDiagnosticText(reason, 120)}`;
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  try {
    await callbackResult((done) => chrome.debugger.attach(debuggee, "1.3", done));
    attached = true;
    await callbackResult((done) => chrome.debugger.sendCommand(debuggee, "Runtime.enable", {}, done));
    await callbackResult((done) => chrome.debugger.sendCommand(debuggee, "Network.enable", {}, done));
    await new Promise((resolve) => setTimeout(resolve, captureMs));
  } catch (error) {
    captureError = error instanceof Error ? error.message : String(error);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    if (attached) await callbackResult((done) => chrome.debugger.detach(debuggee, done)).catch(() => undefined);
  }
  const networkEntries = Array.from(requests.values())
    .map((entry) => sanitizeNetworkEntry(entry, targetOrigin))
    .filter(Boolean)
    .slice(0, MAX_NETWORK_ENTRIES);
  return { consoleEntries, networkEntries, captureError };
}

async function exportBundle() {
  const tab = await activeTab();
  const target = normalizeCaptureTarget(tab?.url);
  if (!tab?.id || !target) throw new Error("Open the affected website first. Browser settings and extension pages cannot be captured.");
  const [cookies, environment, capture] = await Promise.all([
    cookieSummary(target.origin),
    platformInfo(),
    captureTab(tab.id, target.origin, CAPTURE_MS),
  ]);
  const quality = assessCaptureQuality({
    captureError: capture.captureError,
    consoleEntries: capture.consoleEntries.length,
    networkEntries: capture.networkEntries.length,
  });
  if (quality.status !== "useful") throw new Error(quality.reason === "no_diagnostic_activity_captured"
    ? "No diagnostic activity was captured. Reproduce the problem on the affected page and try again."
    : `Capture failed: ${quality.reason}`);
  const manifest = createBundleManifest({
    generatedAt: new Date().toISOString(),
    targetOrigin: target.origin,
    helperVersion: chrome.runtime.getManifest().version,
    browser: navigator.userAgentData?.brands?.map((item) => item.brand).join(", ") || "browser",
    quality,
    captureMs: CAPTURE_MS,
    consoleEntries: capture.consoleEntries.length,
    networkEntries: capture.networkEntries.length,
  });
  const zipBytes = buildStoredZip([
    { name: "bundle.json", data: JSON.stringify(manifest, null, 2) },
    { name: "cookie-summary.json", data: JSON.stringify({ targetOrigin: target.origin, ...cookies }, null, 2) },
    { name: "console.json", data: JSON.stringify(capture.consoleEntries, null, 2) },
    { name: "network.json", data: JSON.stringify(capture.networkEntries, null, 2) },
    { name: "environment.json", data: JSON.stringify(environment, null, 2) },
  ]);
  return { zipBytes: Array.from(zipBytes), targetOrigin: target.origin, quality };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SERP_HELPER_EXPORT") return false;
  exportBundle().then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "Diagnostic export failed." });
  });
  return true;
});
