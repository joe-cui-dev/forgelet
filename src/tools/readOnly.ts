import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type {
  AgentPlan,
  PlanStatus,
  ToolContext,
  ToolDefinition,
  ToolObservation,
  ToolResult,
} from "../types.js";

const READ_FILE_LIMIT_BYTES = 20 * 1024;
const TRACE_PREVIEW_CHARS = 500;

// Builds the low-risk tool set exposed to a read-only Session loop.
export const createReadOnlyTools = (plan: AgentPlan): ToolDefinition[] => {
  return [
    {
      name: "list_files",
      providerId: "workspace",
      capability: "read_workspace",
      description: "List files under the current workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (input, ctx) => {
        const path = optionalString(input, "path") ?? ".";
        const root = await safeWorkspacePath(ctx.workspaceRoot, path);
        const files = await listFiles(root, ctx.workspaceRoot);
        return {
          ok: true,
          summary: `Listed ${files.length} files.`,
          data: { content: files.join("\n"), path },
        };
      },
    },
    {
      name: "search_text",
      providerId: "workspace",
      capability: "read_workspace",
      description: "Search workspace text files for a query.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input, ctx) => {
        const query = requiredString(input, "query");
        const path = optionalString(input, "path") ?? ".";
        const root = await safeWorkspacePath(ctx.workspaceRoot, path);
        const files = await listFiles(root, ctx.workspaceRoot);
        const matches: string[] = [];
        for (const file of files) {
          const absolutePath = await safeWorkspacePath(ctx.workspaceRoot, file);
          const content = await readTextIfSmall(absolutePath);
          if (!content) continue;
          content.split("\n").forEach((line, index) => {
            if (line.includes(query))
              matches.push(`${file}:${index + 1}: ${line}`);
          });
        }
        return {
          ok: true,
          summary: `Found ${matches.length} matches for "${query}".`,
          data: { content: matches.join("\n"), path },
        };
      },
    },
    {
      name: "read_file",
      providerId: "workspace",
      capability: "read_workspace",
      description:
        "Read a workspace file, truncated to the model observation limit.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input, ctx) => {
        const path = requiredString(input, "path");
        const absolutePath = await safeWorkspacePath(ctx.workspaceRoot, path);
        const buffer = await readFile(absolutePath);
        const returned = buffer.subarray(0, READ_FILE_LIMIT_BYTES);
        return {
          ok: true,
          summary: `Read ${path}${buffer.length > returned.length ? " with truncation" : ""}.`,
          data: {
            content: returned.toString("utf8"),
            path,
            truncated: buffer.length > returned.length,
            totalBytes: buffer.length,
            returnedBytes: returned.length,
            contentHash: createHash("sha256").update(buffer).digest("hex"),
          },
        };
      },
    },
    {
      name: "git_status",
      providerId: "git",
      capability: "git_read",
      description: "Show short git status for the workspace.",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async (_input, ctx) => {
        const content = await gitStatus(ctx.workspaceRoot);
        return {
          ok: true,
          summary: content.trim()
            ? "Read git status."
            : "Workspace git status is clean.",
          data: { content },
        };
      },
    },
    {
      name: "update_plan",
      providerId: "session",
      capability: "update_plan",
      description: "Replace the current Session plan.",
      inputSchema: {
        type: "object",
        properties: { items: { type: "array" } },
        required: ["items"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const items = readPlanItems(input);
        plan.items = items;
        return {
          ok: true,
          summary: `Updated plan with ${items.length} items.`,
          data: { content: formatPlan(plan) },
        };
      },
    },
  ];
};

// Converts tool results into model-visible observations while keeping trace metadata compact.
export const toolResultToObservation = (
  result: ToolResult,
  toolCallId: string,
  toolName: string,
): ToolObservation => {
  const data = isRecord(result.data) ? result.data : {};
  const content = typeof data.content === "string" ? data.content : undefined;
  const metadata = {
    truncated: typeof data.truncated === "boolean" ? data.truncated : undefined,
    totalBytes:
      typeof data.totalBytes === "number" ? data.totalBytes : undefined,
    returnedBytes:
      typeof data.returnedBytes === "number" ? data.returnedBytes : undefined,
    contentHash:
      typeof data.contentHash === "string" ? data.contentHash : undefined,
    path: typeof data.path === "string" ? data.path : undefined,
    preview: content ? content.slice(0, TRACE_PREVIEW_CHARS) : undefined,
  };
  return {
    ok: result.ok,
    toolCallId,
    toolName,
    summary: result.summary,
    content,
    error: result.ok
      ? undefined
      : { code: "tool_failed", message: result.error ?? result.summary },
    metadata,
  };
};

// Produces the standard observation shape for policy-denied tool calls.
export const deniedToolObservation = (
  toolCallId: string,
  toolName: string,
  message: string,
): ToolObservation => {
  return {
    ok: false,
    toolCallId,
    toolName,
    summary: message,
    error: { code: "permission_denied", message },
    metadata: {},
  };
};

// Produces the standard observation shape for model-requested tools that do not exist.
export const unknownToolObservation = (
  toolCallId: string,
  toolName: string,
): ToolObservation => {
  const message = `Unknown tool: ${toolName}`;
  return {
    ok: false,
    toolCallId,
    toolName,
    summary: message,
    error: { code: "unknown_tool", message },
    metadata: {},
  };
};

// Resolves a path through realpath so symlinks cannot escape the workspace.
const safeWorkspacePath = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const absolute = resolve(workspaceRoot, path);
  const [realWorkspaceRoot, realTarget] = await Promise.all([
    realpath(workspaceRoot),
    realpath(absolute),
  ]);
  const rel = relative(realWorkspaceRoot, realTarget);
  if (rel.startsWith(".."))
    throw new Error(`Path is outside workspace: ${path}`);
  return realTarget;
};

// Recursively lists workspace files while skipping generated and internal folders.
const listFiles = async (
  root: string,
  workspaceRoot: string,
): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === ".forgelet" ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "dist-test"
    )
      continue;
    const absolute = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute, workspaceRoot)));
    } else if (entry.isFile()) {
      files.push(relative(workspaceRoot, absolute));
    }
  }
  return files.sort();
};

// Returns UTF-8 text only for files that look safe and useful to search.
const readTextIfSmall = async (path: string): Promise<string | undefined> => {
  const ext = extname(path);
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip"].includes(ext))
    return undefined;
  try {
    const buffer = await readFile(path);
    if (buffer.includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
};

// Keeps git integration read-only and degrades gracefully outside a git checkout.
const gitStatus = (workspaceRoot: string): Promise<string> => {
  return new Promise((resolveStatus) => {
    execFile(
      "git",
      ["status", "--short"],
      { cwd: workspaceRoot },
      (error, stdout) => {
        if (error) resolveStatus("Git status is unavailable.");
        else resolveStatus(stdout);
      },
    );
  });
};

// Reads a required string field from model-provided tool input.
const requiredString = (input: unknown, key: string): string => {
  const value = optionalString(input, key);
  if (!value) throw new Error(`Missing required string input: ${key}`);
  return value;
};

// Reads an optional string field without accepting non-object input.
const optionalString = (input: unknown, key: string): string | undefined => {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
};

// Validates the model-provided replacement plan before mutating Session state.
const readPlanItems = (input: unknown): AgentPlan["items"] => {
  if (!isRecord(input) || !Array.isArray(input.items))
    throw new Error("Missing plan items.");
  return input.items.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.step !== "string" ||
      !isPlanStatus(item.status)
    )
      throw new Error("Invalid plan item.");
    return { step: item.step, status: item.status };
  });
};

// Narrows untrusted values to the Session plan status vocabulary.
const isPlanStatus = (value: unknown): value is PlanStatus => {
  return (
    value === "pending" || value === "in_progress" || value === "completed"
  );
};

// Formats the mutable Session plan for model observation content.
const formatPlan = (plan: AgentPlan): string => {
  return plan.items.map((item) => `- [${item.status}] ${item.step}`).join("\n");
};

// Shared guard for tool inputs and tool result payloads.
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};
