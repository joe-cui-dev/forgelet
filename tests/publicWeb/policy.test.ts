import {
  PublicWebPolicy,
  classifyPublicWebUrl,
} from "../../src/publicWeb/policy.js";
import { createPermissionPolicy } from "../../src/permissions/index.js";

test("defines the settled Public Web byte, time, and call limits", () => {
  expect(PublicWebPolicy).toMatchObject({
    requestTimeoutMs: 15_000,
    maxRedirects: 5,
    maxRawNetworkBytes: 1_048_576,
    maxDecompressedBytes: 4_194_304,
    maxStoredExtractedTextBytes: 262_144,
    maxSourceInjectionBytes: 61_440,
    maxSearchCalls: 5,
    defaultSearchResultCount: 5,
    maxSearchResults: 10,
    maxQueryBytes: 256,
    maxReadAttempts: 10,
    userAgent: "Mozilla/5.0 (compatible; Forgelet/1.0)",
    thinHtmlExtractionByteFloor: 500,
    thinHtmlExtractionRatioFloor: 0.02,
  });
  expect(PublicWebPolicy.allowedContentTypes).toEqual([
    "text/html",
    "text/plain",
    "text/markdown",
    "application/json",
  ]);
});

test.each([
  ["http://example.com", "non_https_scheme"],
  ["https://example.com:8443", "non_443_port"],
  ["https://user@example.com", "userinfo"],
  ["https://localhost/article", "local_hostname"],
  ["https://docs.internal/article", "local_hostname"],
  ["https://127.0.0.1/article", "private_ip"],
  ["https://[::1]/article", "private_ip"],
])("classifies %s as a forbidden URL target", async (url, classification) => {
  const target = classifyPublicWebUrl(url);
  expect(target).toMatchObject({ kind: "url", url, classification });

  const decision = await createPermissionPolicy().decide({
    workflow: "learning",
    toolName: "web_read",
    capability: "read_public_web",
    riskTier: "forbidden",
    input: { url },
    workspaceRoot: "/tmp/workspace",
    targets: [target],
  });
  expect(decision).toMatchObject({ kind: "deny", riskTier: "forbidden" });
});

test("admits only ordinary public HTTPS URLs at classification time", () => {
  expect(classifyPublicWebUrl("https://www.example.com/article")).toEqual({
    kind: "url",
    url: "https://www.example.com/article",
    classification: "ordinary",
  });
});
