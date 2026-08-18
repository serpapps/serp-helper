import { normalizeCaptureTarget } from "./lib/diagnostics.js";

const SUPPORT_FORM_URL = "__SUPPORT_FORM_URL__";
const consent = document.querySelector("#consent");
const exportButton = document.querySelector("#exportButton");
const targetOrigin = document.querySelector("#targetOrigin");
const supportLink = document.querySelector("#supportLink");
const status = document.querySelector("#status");
let selectedOrigin = null;

supportLink.href = SUPPORT_FORM_URL;

function setStatus(message, tone = "muted") {
  status.textContent = message;
  status.dataset.tone = tone;
}

chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
  selectedOrigin = normalizeCaptureTarget(tabs?.[0]?.url)?.origin || null;
  targetOrigin.textContent = selectedOrigin || "Open the affected http(s) website first.";
  exportButton.disabled = !selectedOrigin || !consent.checked;
});

consent.addEventListener("change", () => {
  exportButton.disabled = !selectedOrigin || !consent.checked;
});

exportButton.addEventListener("click", async () => {
  if (!selectedOrigin || !consent.checked) return;
  exportButton.disabled = true;
  setStatus("Capturing diagnostic activity for about five seconds…");
  try {
    const permissionGranted = await chrome.permissions.request({
      permissions: ["cookies"],
      origins: [`${selectedOrigin}/*`],
    });
    if (!permissionGranted) throw new Error("Website diagnostic permission was not granted.");
    const response = await chrome.runtime.sendMessage({ type: "SERP_HELPER_EXPORT" });
    if (!response?.ok) throw new Error(response?.error || "Diagnostic export failed.");
    const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(response.zipBytes)], { type: "application/zip" }));
    await chrome.downloads.download({ url: blobUrl, filename: "support.zip", saveAs: true, conflictAction: "uniquify" });
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
    setStatus("support.zip is ready. Open the support form and attach it to your case.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Diagnostic export failed.", "error");
  } finally {
    exportButton.disabled = !selectedOrigin || !consent.checked;
  }
});
