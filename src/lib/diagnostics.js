const textEncoder = new TextEncoder();

export const BUNDLE_SCHEMA_VERSION = "serp-support-bundle-v2";
export const CAPTURE_POLICY_VERSION = "diagnostic-v1";

export function normalizeCaptureTarget(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return { origin: parsed.origin.toLowerCase() };
  } catch {
    return null;
  }
}

export function sanitizeDiagnosticText(input, maxLength = 500) {
  return String(input || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/https?:\/\/[^\s"')]+/gi, (value) => normalizeCaptureTarget(value)?.origin || "[redacted-url]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function sanitizeNetworkEntry(input, targetOrigin) {
  const target = normalizeCaptureTarget(input?.url);
  if (!target || target.origin !== targetOrigin) return null;
  return {
    method: String(input?.method || "GET").toUpperCase().slice(0, 12),
    origin: target.origin,
    resourceType: sanitizeDiagnosticText(input?.resourceType || "other", 40),
    status: Number.isFinite(input?.status) ? Number(input.status) : null,
    mimeType: sanitizeDiagnosticText(input?.mimeType || "", 120),
    encodedBytes: Number.isFinite(input?.encodedBytes) ? Math.max(0, Math.round(input.encodedBytes)) : null,
    failed: Boolean(input?.failed),
    error: sanitizeDiagnosticText(input?.error || "", 200) || null,
  };
}

export function summarizeCookies(cookies) {
  const safeCookies = Array.isArray(cookies) ? cookies : [];
  return {
    total: safeCookies.length,
    secure: safeCookies.filter((cookie) => cookie?.secure).length,
    httpOnly: safeCookies.filter((cookie) => cookie?.httpOnly).length,
    session: safeCookies.filter((cookie) => cookie?.session).length,
    sameSite: safeCookies.reduce((counts, cookie) => {
      const key = ["no_restriction", "lax", "strict", "unspecified"].includes(cookie?.sameSite)
        ? cookie.sameSite
        : "unspecified";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
  };
}

export function assessCaptureQuality({ captureError, consoleEntries, networkEntries }) {
  if (captureError) return { status: "failed", reason: sanitizeDiagnosticText(captureError, 200) || "capture_failed" };
  const evidenceCount = Number(consoleEntries || 0) + Number(networkEntries || 0);
  if (evidenceCount === 0) return { status: "partial", reason: "no_diagnostic_activity_captured" };
  return { status: "useful", reason: null };
}

export function createBundleManifest(input) {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    capturePolicyVersion: CAPTURE_POLICY_VERSION,
    generatedAt: input.generatedAt,
    target: { origin: input.targetOrigin },
    helper: { version: input.helperVersion, browser: input.browser },
    capture: {
      quality: input.quality,
      durationMs: input.captureMs,
      consoleEntries: input.consoleEntries,
      networkEntries: input.networkEntries,
    },
    collection: {
      explicitConsent: true,
      rawCookies: false,
      cookieSummaryOnly: true,
      installedExtensions: false,
      requestHeaders: false,
      responseHeaders: false,
      requestBodies: false,
      responseBodies: false,
      fullPrivateUrls: false,
      crossOriginNetwork: false,
    },
  };
}

function crc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = crc32Table();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function littleEndian(value, length) {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    bytes[index] = remaining & 0xff;
    remaining >>>= 8;
  }
  return bytes;
}

function concatBytes(chunks) {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function buildStoredZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = textEncoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : textEncoder.encode(String(file.data));
    const checksum = crc32(data);
    const localHeader = concatBytes([
      littleEndian(0x04034b50, 4), littleEndian(20, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(checksum, 4), littleEndian(data.length, 4),
      littleEndian(data.length, 4), littleEndian(name.length, 2), littleEndian(0, 2),
    ]);
    local.push(localHeader, name, data);
    central.push(concatBytes([
      littleEndian(0x02014b50, 4), littleEndian(20, 2), littleEndian(20, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2), littleEndian(checksum, 4),
      littleEndian(data.length, 4), littleEndian(data.length, 4), littleEndian(name.length, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 4), littleEndian(offset, 4), name,
    ]));
    offset += localHeader.length + name.length + data.length;
  }
  const centralBytes = concatBytes(central);
  const end = concatBytes([
    littleEndian(0x06054b50, 4), littleEndian(0, 2), littleEndian(0, 2),
    littleEndian(files.length, 2), littleEndian(files.length, 2), littleEndian(centralBytes.length, 4),
    littleEndian(offset, 4), littleEndian(0, 2),
  ]);
  return concatBytes([...local, centralBytes, end]);
}
