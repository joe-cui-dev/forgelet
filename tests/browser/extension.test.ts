import { expect, test } from "@jest/globals";
import {
  createShareCurrentPagePayload,
  extractMainTextFromPage,
  renderShareSummary,
} from "../../src/browser/extension/snapshotProducer.js";

test("browser extension selected-text share builds a minimal snapshot payload", () => {
  const payload = createShareCurrentPagePayload({
    mode: "selection",
    url: "https://example.com/issue/123",
    title: "Fix checkout bug",
    capturedAt: "2026-07-02T00:00:00.000Z",
    selectedText: "The checkout button throws after payment auth.",
    pageText: "Full page text should not be sent for selected-text sharing.",
  });

  expect(payload).toEqual({
    type: "shareCurrentPage",
    payload: {
      url: "https://example.com/issue/123",
      title: "Fix checkout bug",
      capturedAt: "2026-07-02T00:00:00.000Z",
      selectedText: "The checkout button throws after payment auth.",
    },
  });
});

test("browser extension whole-page share prefers primary content text", () => {
  const mainText = extractMainTextFromPage({
    primaryTextCandidates: [
      "Navigation",
      "Install the SDK before creating a client.\n\nThen call run().",
    ],
    bodyText:
      "Navigation Docs Install the SDK before creating a client. Then call run(). Footer",
  });

  expect(mainText).toBe(
    "Install the SDK before creating a client. Then call run().",
  );
});

test("browser extension whole-page share falls back to normalized body text", () => {
  const mainText = extractMainTextFromPage({
    primaryTextCandidates: ["Nav", "Short"],
    bodyText: "Docs\n\n  Use the current API page as context.   Footer",
  });

  expect(mainText).toBe("Docs Use the current API page as context. Footer");
});

test("browser extension share summary suggests CLI follow-up without page content", () => {
  const summary = renderShareSummary({
    ok: true,
    title: "Readable API Docs",
    url: "https://example.com/docs",
    contentKind: "mainText",
    contentBytes: 41,
    contentHash: "abc123",
    capturedAt: "2026-07-02T00:00:00.000Z",
    snapshotPath: "/Users/alice/.forgelet/browser/current-page.json",
  });

  expect(summary).toContain("Readable API Docs");
  expect(summary).toContain("mainText");
  expect(summary).toContain("41 bytes");
  expect(summary).toContain("forge browser read-current");
  expect(summary).toContain('forge code --with-browser "<task>"');
  expect(summary).not.toContain("Install the SDK before creating a client.");
});
