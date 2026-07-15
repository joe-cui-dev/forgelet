import type { LookupAddress } from "node:dns";
import { lookup as resolveDns } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { PublicWebPolicy, classifyPublicWebUrl, isForbiddenIpAddress } from "./policy.js";
import type { PublicWebReader } from "./index.js";

export class PublicWebFetchError extends Error {
  constructor(
    readonly code: "web_egress_denied" | "web_fetch_failed" | "web_content_rejected",
    message: string,
    readonly metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PublicWebFetchError";
  }
}

/** The sole network boundary for Public Web reads. Redirects are deliberate:
 * every next URL is classified and every hostname is resolved before connect. */
export function createBoundedPublicWebReader(): PublicWebReader {
  return { read: (input) => readPublicWebPage(input.url) };
}

export async function readPublicWebPage(url: string): ReturnType<PublicWebReader["read"]> {
  const deadline = Date.now() + PublicWebPolicy.requestTimeoutMs;
  let currentUrl = url;
  for (let redirects = 0; redirects <= PublicWebPolicy.maxRedirects; redirects += 1) {
    assertAdmittedUrl(currentUrl);
    const response = await requestOneHop(currentUrl, deadline);
    if (isRedirect(response.status)) {
      const location = response.headers.location;
      if (!location) throw new PublicWebFetchError("web_fetch_failed", "Public Web redirect has no Location header.", { url: currentUrl, httpStatus: response.status });
      if (redirects === PublicWebPolicy.maxRedirects)
        throw new PublicWebFetchError("web_fetch_failed", `Public Web redirect limit exceeded (${PublicWebPolicy.maxRedirects}).`, { url: currentUrl, httpStatus: response.status });
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new PublicWebFetchError("web_fetch_failed", `Public Web request returned HTTP ${response.status}.`, { url, finalUrl: currentUrl, httpStatus: response.status });
    const contentType = response.headers.contentType;
    if (!PublicWebPolicy.allowedContentTypes.includes(contentType as never))
      throw new PublicWebFetchError("web_content_rejected", `Public Web content type is not allowed: ${contentType || "(missing)"}.`, { url, finalUrl: currentUrl, httpStatus: response.status, contentType, fetchedBytes: response.fetchedBytes });
    const extracted = extractPublicWebText(response.text, contentType);
    const text = truncateUtf8(extracted.text, PublicWebPolicy.maxStoredExtractedTextBytes);
    return {
      title: extracted.title ?? new URL(currentUrl).hostname,
      url,
      finalUrl: currentUrl,
      httpStatus: response.status,
      fetchedBytes: response.fetchedBytes,
      contentType,
      text: text.value,
      ...(text.truncated ? { truncated: true } : {}),
    };
  }
  throw new PublicWebFetchError("web_fetch_failed", "Public Web redirect handling failed.", { url });
}

function assertAdmittedUrl(url: string): void {
  const target = classifyPublicWebUrl(url);
  if (target.classification !== "ordinary")
    throw new PublicWebFetchError("web_egress_denied", `Public Web URL is not admitted: ${target.classification}.`, { url });
}

async function requestOneHop(url: string, deadline: number): Promise<{ status: number; headers: { location?: string; contentType: string }; text: string; fetchedBytes: number }> {
  const parsed = new URL(url);
  const addresses = await beforeDeadline(
    resolveDns(parsed.hostname, { all: true, verbatim: true }),
    deadline,
    url,
  );
  if (addresses.length === 0 || addresses.some(({ address }) => isForbiddenIpAddress(address)))
    throw new PublicWebFetchError("web_egress_denied", "Public Web hostname resolved to a forbidden address.", { url });
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0)
    throw new PublicWebFetchError("web_fetch_failed", `Public Web request timed out after ${PublicWebPolicy.requestTimeoutMs}ms.`, { url });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = <T>(callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimeout);
      callback(value);
    };
    const fail = (error: unknown) => finish(reject, error);
    const totalTimeout = setTimeout(
      () => fail(new PublicWebFetchError("web_fetch_failed", `Public Web request timed out after ${PublicWebPolicy.requestTimeoutMs}ms.`, { url })),
      remainingMs,
    );
    const request = httpsRequest(parsed, {
      headers: { "accept-encoding": "gzip, deflate, br" },
      lookup: pinnedAddressLookup(addresses),
    }, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = normalizeContentType(response.headers["content-type"]);
      const location = headerValue(response.headers.location);
      if (isRedirect(status)) {
        // Do not drain an unbounded redirect body. Closing it immediately
        // preserves the raw-network cap before the next hop is admitted.
        response.destroy();
        finish(resolve, { status, headers: { ...(location ? { location } : {}), contentType }, text: "", fetchedBytes: 0 });
        return;
      }
      const contentLength = Number(headerValue(response.headers["content-length"]));
      if (Number.isFinite(contentLength) && contentLength > PublicWebPolicy.maxRawNetworkBytes) {
        response.destroy();
        fail(new PublicWebFetchError("web_content_rejected", `Public Web response exceeds ${PublicWebPolicy.maxRawNetworkBytes} raw bytes.`, { url, httpStatus: status, contentType, fetchedBytes: contentLength }));
        return;
      }
      let fetchedBytes = 0;
      let decompressedBytes = 0;
      const chunks: Buffer[] = [];
      let output: Transform;
      try {
        output = decoderFor(headerValue(response.headers["content-encoding"]));
      } catch (error) {
        response.destroy();
        reject(error);
        return;
      }
      const failResponse = (error: unknown) => {
        response.destroy();
        fail(error instanceof PublicWebFetchError ? error : new PublicWebFetchError("web_fetch_failed", error instanceof Error ? error.message : String(error), { url, httpStatus: status, contentType, fetchedBytes }));
      };
      response.on("data", (chunk: Buffer) => {
        fetchedBytes += chunk.length;
        if (fetchedBytes > PublicWebPolicy.maxRawNetworkBytes)
          failResponse(new PublicWebFetchError("web_content_rejected", `Public Web response exceeds ${PublicWebPolicy.maxRawNetworkBytes} raw bytes.`, { url, httpStatus: status, contentType, fetchedBytes }));
      });
      response.on("error", failResponse);
      output.on("data", (chunk: Buffer) => {
        decompressedBytes += chunk.length;
        if (decompressedBytes > PublicWebPolicy.maxDecompressedBytes) {
          failResponse(new PublicWebFetchError("web_content_rejected", `Public Web response exceeds ${PublicWebPolicy.maxDecompressedBytes} decompressed bytes.`, { url, httpStatus: status, contentType, fetchedBytes }));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      output.on("error", failResponse);
      output.on("end", () => finish(resolve, { status, headers: { ...(location ? { location } : {}), contentType }, text: Buffer.concat(chunks).toString("utf8"), fetchedBytes }));
      response.pipe(output);
    });
    request.setTimeout(remainingMs, () => request.destroy(new Error(`Public Web request timed out after ${PublicWebPolicy.requestTimeoutMs}ms.`)));
    request.on("error", (error) => fail(new PublicWebFetchError("web_fetch_failed", error.message, { url })));
    request.end();
  });
}

/** Pins the socket to addresses that already passed the forbidden-address
 * screen, so connect cannot re-resolve past the DNS-rebinding check. Node
 * calls this with `options.all` set when autoSelectFamily is enabled (the
 * default since Node 20) and requires the address-array callback shape there. */
export function pinnedAddressLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const pinned = addresses[0];
    if (!pinned) {
      callback(new Error("No pinned address available."), "", 0);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, url: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new PublicWebFetchError("web_fetch_failed", `Public Web request timed out after ${PublicWebPolicy.requestTimeoutMs}ms.`, { url });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new PublicWebFetchError("web_fetch_failed", `Public Web request timed out after ${PublicWebPolicy.requestTimeoutMs}ms.`, { url })), remainingMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function decoderFor(contentEncoding: string | undefined): Transform {
  if (!contentEncoding || contentEncoding === "identity") return new IdentityTransform();
  if (contentEncoding === "gzip") return createGunzip();
  if (contentEncoding === "deflate") return createInflate();
  if (contentEncoding === "br") return createBrotliDecompress();
  throw new PublicWebFetchError("web_content_rejected", `Public Web content encoding is not allowed: ${contentEncoding}.`);
}

class IdentityTransform extends Transform {
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    callback(null, chunk);
  }
}

export function extractPublicWebText(content: string, contentType = "text/html"): { title?: string; text: string } {
  if (contentType !== "text/html") return { text: normalizeText(content) };
  const withoutIgnored = content.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(withoutIgnored);
  const title = titleMatch ? normalizeText(decodeHtmlEntities(titleMatch[1])) : undefined;
  const withBreaks = withoutIgnored.replace(/<\/?(?:address|article|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>|<br\s*\/?>/gi, "\n");
  const text = normalizeText(decodeHtmlEntities(withBreaks.replace(/<[^>]*>/g, " ")));
  return { ...(title ? { title } : {}), text };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[\t\f\v ]+/g, " ").trim()).filter(Boolean).join("\n");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (whole, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
    const codePoint = decimal ? Number(decimal) : hexadecimal ? Number.parseInt(hexadecimal, 16) : undefined;
    if (codePoint !== undefined && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) return String.fromCodePoint(codePoint);
    const entities: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return named ? entities[named.toLowerCase()] ?? whole : whole;
  });
}

function truncateUtf8(value: string, limit: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= limit) return { value, truncated: false };
  return { value: buffer.subarray(0, limit).toString("utf8").replace(/\uFFFD$/, ""), truncated: true };
}

function isRedirect(status: number): boolean { return status >= 300 && status < 400; }
function normalizeContentType(value: string | string[] | undefined): string { return (headerValue(value)?.split(";", 1)[0]?.trim().toLowerCase()) ?? ""; }
function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
