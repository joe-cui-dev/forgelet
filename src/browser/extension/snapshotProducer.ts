export type ShareMode = "selection" | "page";

export interface ShareCurrentPageInput {
  mode: ShareMode;
  url: string;
  title: string;
  capturedAt: string;
  selectedText?: string;
  pageText?: string;
}

export interface ShareCurrentPageMessage {
  type: "shareCurrentPage";
  payload: {
    url: string;
    title: string;
    capturedAt: string;
    selectedText?: string;
    mainText?: string;
  };
}

export interface PageTextInput {
  primaryTextCandidates: string[];
  bodyText: string;
}

export type ShareSummaryInput =
  | {
      ok: true;
      title: string;
      url: string;
      contentKind: "selectedText" | "mainText";
      contentBytes: number;
      contentHash: string;
      capturedAt: string;
      snapshotPath: string;
    }
  | { ok: false; error: string };

export function renderShareSummary(input: ShareSummaryInput): string {
  if (!input.ok) return `Share failed: ${input.error}`;
  return [
    "Shared with Forgelet",
    `Title: ${input.title}`,
    `URL: ${input.url}`,
    `Content: ${input.contentKind}`,
    `Content bytes: ${input.contentBytes} bytes`,
    `Content hash: ${input.contentHash}`,
    `Captured at: ${input.capturedAt}`,
    `Snapshot: ${input.snapshotPath}`,
    "",
    "Next:",
    "forge browser read-current",
    'forge code --with-browser "<task>"',
  ].join("\n");
}

export function extractMainTextFromPage(input: PageTextInput): string {
  const primaryText = input.primaryTextCandidates
    .map(normalizeText)
    .find((candidate) => candidate.length >= 40);
  return primaryText ?? normalizeText(input.bodyText);
}

export function createShareCurrentPagePayload(
  input: ShareCurrentPageInput,
): ShareCurrentPageMessage {
  const base = {
    url: input.url,
    title: input.title,
    capturedAt: input.capturedAt,
  };
  if (input.mode === "selection") {
    return {
      type: "shareCurrentPage",
      payload: {
        ...base,
        selectedText: normalizeText(input.selectedText),
      },
    };
  }
  return {
    type: "shareCurrentPage",
    payload: {
      ...base,
      mainText: normalizeText(input.pageText),
    },
  };
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
