import { isIP } from "node:net";
import type { ToolTarget } from "../types.js";

export const PublicWebPolicy = {
  requestTimeoutMs: 15_000,
  maxRedirects: 5,
  maxRawNetworkBytes: 1_024 * 1_024,
  maxDecompressedBytes: 4 * 1_024 * 1_024,
  allowedContentTypes: ["text/html", "text/plain", "text/markdown", "application/json"],
  maxStoredExtractedTextBytes: 256 * 1_024,
  maxSourceInjectionBytes: 60 * 1_024,
  maxSearchCalls: 5,
  defaultSearchResultCount: 5,
  maxSearchResults: 10,
  maxQueryBytes: 256,
  maxReadAttempts: 10,
  userAgent: "Mozilla/5.0 (compatible; Forgelet/1.0)",
  thinHtmlExtractionByteFloor: 500,
  thinHtmlExtractionRatioFloor: 0.02,
} as const;

export function classifyPublicWebUrl(url: string): Extract<ToolTarget, { kind: "url" }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "url", url, classification: "malformed" };
  }
  if (parsed.protocol !== "https:") return { kind: "url", url, classification: "non_https_scheme" };
  if (parsed.port !== "" && parsed.port !== "443") return { kind: "url", url, classification: "non_443_port" };
  if (parsed.username || parsed.password) return { kind: "url", url, classification: "userinfo" };
  const hostname = unbracketHostname(parsed.hostname);
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal"))
    return { kind: "url", url, classification: "local_hostname" };
  if (isIP(hostname) !== 0 && isForbiddenIpAddress(hostname))
    return { kind: "url", url, classification: "private_ip" };
  return { kind: "url", url, classification: "ordinary" };
}

/** Used again after DNS resolution by the HTTP adapter to close DNS-rebinding gaps. */
export function isForbiddenIpAddress(address: string): boolean {
  const normalized = unbracketHostname(address).toLowerCase();
  if (isIP(normalized) === 4) return isForbiddenIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  const groups = expandIpv6(normalized);
  if (!groups) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isForbiddenIpv4(mapped);
  }
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const isUnspecified = groups.every((group) => group === 0);
  return isLoopback || isUnspecified || (groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80;
}

function isForbiddenIpv4(address: string): boolean {
  const [first = -1, second = -1] = address.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function unbracketHostname(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function expandIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}
