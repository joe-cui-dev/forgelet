import { PublicWebPolicy, classifyPublicWebUrl } from "./policy.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolRequest,
  ToolResult,
} from "../types.js";
import type { SessionSourceLedger } from "../sourceLedger/index.js";

export interface PublicWebSearchCandidate {
  title: string;
  url: string;
  snippet?: string;
}

export interface PublicWebSearchProvider {
  search(input: { query: string; count: number }): Promise<PublicWebSearchCandidate[]>;
}

export interface PublicWebReader {
  read(input: { url: string }): Promise<{
    title: string;
    url: string;
    finalUrl: string;
    httpStatus: number;
    fetchedBytes: number;
    contentType: string;
    text: string;
    truncated?: boolean;
  }>;
}

export interface PublicWebAdapters {
  searchProvider: PublicWebSearchProvider;
  reader: PublicWebReader;
}

export interface PublicWebSessionState {
  searchCalls: number;
  readAttempts: number;
}

export function createPublicWebTools(input: {
  adapters: PublicWebAdapters;
  ledger: SessionSourceLedger;
  state: PublicWebSessionState;
}): ToolDefinition[] {
  return [
    {
      name: "web_search",
      providerId: "public_web",
      capability: "read_public_web",
      description: "Search the public Web for candidate pages. Search candidates are not sources until web_read succeeds.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, count: { type: "number" } },
        required: ["query"],
        additionalProperties: false,
      },
      classify: (value, ctx) => classifySearch(value, ctx),
      execute: (value) => executeSearch(value, input),
    },
    {
      name: "web_read",
      providerId: "public_web",
      capability: "read_public_web",
      description: "Read one admitted public HTTPS page and add its extracted text as a Session source.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
      classify: (value, ctx) => classifyRead(value, ctx),
      execute: (value) => executeRead(value, input),
    },
  ];
}

function classifySearch(value: unknown, ctx: ToolContext): ToolRequest {
  return {
    workflow: ctx.workflow,
    toolName: "web_search",
    capability: "read_public_web",
    riskTier: "low",
    input: value,
    workspaceRoot: ctx.workspaceRoot,
    targets: [],
  };
}

function classifyRead(value: unknown, ctx: ToolContext): ToolRequest {
  const url = requiredString(value, "url");
  const target = classifyPublicWebUrl(url);
  return {
    workflow: ctx.workflow,
    toolName: "web_read",
    capability: "read_public_web",
    riskTier: target.classification === "ordinary" ? "low" : "forbidden",
    input: value,
    workspaceRoot: ctx.workspaceRoot,
    targets: [target],
  };
}

async function executeSearch(
  value: unknown,
  input: Parameters<typeof createPublicWebTools>[0],
): Promise<ToolResult> {
  const query = requiredString(value, "query");
  const requestedCount = optionalCount(value);
  if (Buffer.byteLength(query, "utf8") > PublicWebPolicy.maxQueryBytes)
    return webFailure("web_content_rejected", `Search query exceeds ${PublicWebPolicy.maxQueryBytes} bytes.`);
  if (input.state.searchCalls >= PublicWebPolicy.maxSearchCalls)
    return webFailure("web_budget_exhausted", `Public Web search budget exhausted (${PublicWebPolicy.maxSearchCalls} calls).`);
  input.state.searchCalls += 1;
  try {
    const candidates = await input.adapters.searchProvider.search({ query, count: requestedCount });
    const returned = candidates.slice(0, requestedCount);
    return {
      ok: true,
      summary: `Returned ${returned.length} public Web search candidates.`,
      data: {
        content: JSON.stringify(returned),
        requestedCount,
        returnedCount: returned.length,
      },
    };
  } catch (error) {
    return webFailure("web_search_failed", errorMessage(error), { requestedCount, returnedCount: 0 });
  }
}

async function executeRead(
  value: unknown,
  input: Parameters<typeof createPublicWebTools>[0],
): Promise<ToolResult> {
  const url = requiredString(value, "url");
  if (input.state.readAttempts >= PublicWebPolicy.maxReadAttempts)
    return webFailure("web_budget_exhausted", `Public Web read budget exhausted (${PublicWebPolicy.maxReadAttempts} attempts).`, { url });
  input.state.readAttempts += 1;
  try {
    const page = await input.adapters.reader.read({ url });
    const appended = await input.ledger.appendWebSource({
      title: page.title,
      url: page.url,
      finalUrl: page.finalUrl,
      content: page.text,
      fetchedBytes: page.fetchedBytes,
      contentType: page.contentType,
    });
    return {
      ok: true,
      summary: appended.deduplicated
        ? `Reused public Web source ${appended.attachment.attachment.id}.`
        : `Added public Web source ${appended.attachment.attachment.id}.`,
      data: {
        url,
        finalUrl: page.finalUrl,
        httpStatus: page.httpStatus,
        fetchedBytes: page.fetchedBytes,
        storedBytes: appended.attachment.attachment.contentBytes,
        contentType: page.contentType,
        sourceId: appended.attachment.attachment.id,
        deduplicated: appended.deduplicated,
        truncated: page.truncated === true,
      },
    };
  } catch (error) {
    return webFailure("web_fetch_failed", errorMessage(error), { url });
  }
}

function optionalCount(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return PublicWebPolicy.defaultSearchResultCount;
  const count = (value as Record<string, unknown>).count;
  if (count === undefined) return PublicWebPolicy.defaultSearchResultCount;
  if (!Number.isInteger(count) || typeof count !== "number" || count < 1 || count > PublicWebPolicy.maxSearchResults)
    throw new Error(`count must be an integer from 1 to ${PublicWebPolicy.maxSearchResults}.`);
  return count;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${key} must be a string.`);
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string" || !field.trim()) throw new Error(`${key} must be a non-empty string.`);
  return field;
}

function webFailure(
  errorCode: ToolResult["errorCode"],
  message: string,
  data: Record<string, unknown> = {},
): ToolResult {
  return { ok: false, summary: message, error: message, errorCode, data };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { PublicWebPolicy } from "./policy.js";
