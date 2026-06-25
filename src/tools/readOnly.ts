import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type {
  AgentPlan,
  PlanStatus,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types.js";
import {
  doesPathOverlapSessionReadScope,
  isPathInSessionReadScope,
} from "../readScope/index.js";

const READ_FILE_LIMIT_BYTES = 20 * 1024;
const GIT_DIFF_LIMIT_BYTES = 20 * 1024;

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
      classify: async (input, ctx) =>
        classifyCollectionRead(
          "list_files",
          optionalString(input, "path") ?? ".",
          input,
          ctx,
        ),
      execute: async (input, ctx) => {
        const path = optionalString(input, "path") ?? ".";
        const root = await safeWorkspacePath(ctx.workspaceRoot, path);
        const files = await listFiles(
          root,
          ctx.workspaceRoot,
          ctx.readScope,
        );
        return {
          ok: true,
          summary: `Listed ${files.length} files.`,
          data: {
            content: files.join("\n"),
            path,
            scopeConstrained: ctx.readScope !== undefined,
          },
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
      classify: async (input, ctx) =>
        classifyCollectionRead(
          "search_text",
          optionalString(input, "path") ?? ".",
          input,
          ctx,
        ),
      execute: async (input, ctx) => {
        const query = requiredString(input, "query");
        const path = optionalString(input, "path") ?? ".";
        const root = await safeWorkspacePath(ctx.workspaceRoot, path);
        const files = await listFiles(
          root,
          ctx.workspaceRoot,
          ctx.readScope,
        );
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
          data: {
            content: matches.join("\n"),
            path,
            scopeConstrained: ctx.readScope !== undefined,
          },
        };
      },
    },
    {
      name: "read_file",
      providerId: "workspace",
      capability: "read_workspace",
      // The description is intentionally detailed to guide the model in using the tool effectively for iterative reading of large files and specific ranges.
      description: [
        "Read a workspace file, truncated to the model observation limit.",
        "Use { path } for the first chunk.",
        "If truncated, continue with { path, offsetBytes: metadata.nextOffsetBytes }.",
        "Use 1-based { path, startLine, lineCount } for source ranges.",
        "Use { path, tailLines } for the end of a file.",
        "Range modes are mutually exclusive.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offsetBytes: { type: "number" },
          limitBytes: { type: "number" },
          startLine: { type: "number" },
          lineCount: { type: "number" },
          tailLines: { type: "number" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      classify: async (input, ctx) => {
        const path = requiredString(input, "path");
        const allowed = await isPathInSessionReadScope(
          ctx.workspaceRoot,
          path,
          ctx.readScope,
        );
        return {
          workflow: ctx.workflow,
          toolName: "read_file",
          capability: "read_workspace",
          riskTier: allowed ? "low" : "forbidden",
          input,
          workspaceRoot: ctx.workspaceRoot,
          targets: [
            {
              kind: "path",
              path,
              classification: allowed
                ? "ordinary"
                : "outside_session_read_scope",
            },
          ],
        };
      },
      // The implementation supports multiple range modes and includes metadata in the tool result to enable the model to manage iterative reads and understand the context of the returned content.
      execute: async (input, ctx) => {
        const path = requiredString(input, "path"); // Validate and resolve the file path safely within the workspace to prevent unauthorized access and ensure the file exists before attempting to read it.
        // Validate and determine range mode.
        const offsetBytes = optionalNonNegativeInteger(input, "offsetBytes"); // 0-based byte offset for reading a specific byte range.
        const limitBytes = optionalPositiveInteger(input, "limitBytes"); // Byte limit for the chunk to read, up to the tool's maximum.
        const startLine = optionalPositiveInteger(input, "startLine"); // 1-based starting line number for reading a specific line range.
        const lineCount = optionalPositiveInteger(input, "lineCount"); // Number of lines to read from the starting line for a line range.
        const tailLines = optionalPositiveInteger(input, "tailLines"); // Number of lines to read from the end of the file for a tail range.
        const hasByteRange =
          offsetBytes !== undefined || limitBytes !== undefined; // Indicates if byte range mode is requested.
        const hasLineRange = startLine !== undefined || lineCount !== undefined; // Indicates if line range mode is requested.
        const hasTailRange = tailLines !== undefined; // Indicates if tail range mode is requested.
        if (
          [hasByteRange, hasLineRange, hasTailRange].filter(Boolean).length > 1
        ) {
          // Enforce that only one range mode is used at a time to avoid ambiguity in how to interpret the input parameters.
          throw new Error("read_file range modes are mutually exclusive.");
        }
        const absolutePath = await safeWorkspacePath(ctx.workspaceRoot, path); // Resolve the file path safely within the workspace to prevent unauthorized access to the file system.
        const buffer = await readFile(absolutePath); // Read the entire file into a buffer to allow for flexible slicing based on the requested range mode. This approach is suitable for files that are within a reasonable size limit, as it simplifies the logic for handling different types of ranges (byte, line, tail) without needing to manage file streams or multiple reads.
        if (tailLines !== undefined) {
          // For tail range mode, split the file into lines and select the last N lines as specified by tailLines. Then, apply byte-level truncation to the selected lines if they exceed the tool's byte limit. The tool result includes metadata about the range of lines returned and whether truncation occurred, enabling the model to make informed decisions about subsequent reads if needed.
          const lines = buffer.toString("utf8").split("\n");
          const returnedStartLine = Math.max(lines.length - tailLines + 1, 1); // Calculate the starting line number for the tail range, ensuring it does not go below 1.
          const selected = lines.slice(returnedStartLine - 1); // Select the lines for the tail range based on the calculated starting line.
          const selectedBuffer = Buffer.from(selected.join("\n"), "utf8"); // Convert the selected lines back into a buffer for consistent handling of byte limits and truncation.
          const returned = selectedBuffer.subarray(0, READ_FILE_LIMIT_BYTES); // Apply byte-level truncation to the selected tail lines to ensure the returned content does not exceed the tool's observation limit, while still providing as much of the tail content as possible.
          const returnedContent = returned.toString("utf8"); // Convert the returned buffer back to a string for inclusion in the tool result, allowing the model to read the content directly while also providing metadata about the range and truncation status.
          const returnedLineCount = returnedContent
            ? returnedContent.split("\n").length
            : 0; // Calculate the number of lines in the returned content to include in the metadata, which helps the model understand how much of the requested tail range was included in the response and whether further reads are necessary to retrieve more of the tail content.
          // Return the tool result with the content and metadata about the tail range, including whether truncation occurred and the line numbers of the returned content, enabling the model to manage iterative reads effectively if the entire tail range was not included in the initial response.
          return readFileToolResult(path, buffer, returned, {
            truncated: selectedBuffer.length > returned.length,
            rangeMetadata: {
              rangeKind: "tail",
              tailLines,
              returnedStartLine:
                returnedLineCount > 0 ? returnedStartLine : undefined,
              returnedEndLine:
                returnedLineCount > 0
                  ? returnedStartLine + returnedLineCount - 1
                  : undefined,
            },
          });
        }
        if (startLine !== undefined || lineCount !== undefined) {
          // For line range mode, split the file into lines and select the specified range of lines based on startLine and lineCount. Similar to tail range mode, apply byte-level truncation to the selected lines if they exceed the tool's byte limit. The tool result includes metadata about the requested line range and the actual lines returned, allowing the model to understand the context of the returned content and manage subsequent reads if needed to retrieve additional lines from the requested range.
          if (startLine === undefined || lineCount === undefined)
            throw new Error("Line ranges require startLine and lineCount.");
          const lines = buffer.toString("utf8").split("\n"); // Split the file content into lines to facilitate line-based selection for the line range mode.
          const selected = lines.slice(
            startLine - 1,
            startLine - 1 + lineCount,
          ); // Select the lines for the requested line range based on the provided startLine and lineCount, adjusting for 0-based indexing in the array.
          const selectedBuffer = Buffer.from(selected.join("\n"), "utf8"); // Convert the selected lines back into a buffer for consistent handling of byte limits and truncation, allowing the tool to apply the same byte-level truncation logic regardless of the range mode.
          const returned = selectedBuffer.subarray(0, READ_FILE_LIMIT_BYTES); // Apply byte-level truncation to the selected lines to ensure the returned content does not exceed the tool's observation limit, while still providing as much of the requested line range as possible.
          const returnedContent = returned.toString("utf8"); // Convert the returned buffer back to a string for inclusion in the tool result, allowing the model to read the content directly while also providing metadata about the range and truncation status.
          const returnedLineCount = returnedContent
            ? returnedContent.split("\n").length
            : 0; // Calculate the number of lines in the returned content to include in the metadata, which helps the model understand how much of the requested line range was included in the response and whether further reads are necessary to retrieve more lines.
          // Return the tool result with the content and metadata about the line range, including whether truncation occurred and the line numbers of the returned content, enabling the model to manage iterative reads effectively if the entire requested line range was not included in the initial response.
          return readFileToolResult(path, buffer, returned, {
            truncated: selectedBuffer.length > returned.length,
            rangeMetadata: {
              rangeKind: "line",
              startLine,
              lineCount,
              returnedStartLine: returnedLineCount > 0 ? startLine : undefined,
              returnedEndLine:
                returnedLineCount > 0
                  ? startLine + returnedLineCount - 1
                  : undefined,
            },
          });
        }
        // For byte range mode (or default mode if no specific range parameters are provided), calculate the byte range to return based on offsetBytes and limitBytes, applying truncation as needed to ensure the returned content does not exceed the tool's observation limit. The tool result includes metadata about the byte range returned and whether truncation occurred, allowing the model to manage iterative reads effectively if the entire file was not included in the initial response. If no range parameters are provided, the tool defaults to returning the first chunk of the file up to the observation limit, and the metadata indicates that this is the default range mode, which can help the model understand that it is receiving the initial portion of the file and may need to request subsequent byte ranges if it needs more content from the file.
        const startByte = Math.min(offsetBytes ?? 0, buffer.length); // Determine the starting byte offset for the read operation, defaulting to 0 if offsetBytes is not provided, and ensuring it does not exceed the file size.
        const byteLimit = Math.min(
          limitBytes ?? READ_FILE_LIMIT_BYTES,
          READ_FILE_LIMIT_BYTES,
        ); // Determine the byte limit for the read operation, defaulting to the tool's maximum observation limit if limitBytes is not provided, and ensuring it does not exceed the tool's defined maximum to prevent excessively large reads.
        const endByte = Math.min(startByte + byteLimit, buffer.length); // Calculate the ending byte offset for the read operation based on the starting byte and the byte limit, ensuring it does not exceed the file size.
        const returned = buffer.subarray(startByte, endByte); // Extract the specified byte range from the file buffer to return as the content for this tool execution, allowing for flexible reading of large files in manageable chunks based on the model's requests.
        // Return the tool result with the content and metadata about the byte range, including whether truncation occurred and the byte offsets of the returned content, enabling the model to manage iterative reads effectively if the entire file was not included in the initial response or if it is navigating through a large file using byte ranges.
        return readFileToolResult(path, buffer, returned, {
          truncated: endByte < buffer.length,
          rangeMetadata: {
            rangeKind:
              offsetBytes === undefined && limitBytes === undefined
                ? "default"
                : "byte",
            offsetBytes,
            limitBytes,
            returnedStartByte: startByte,
            returnedEndByte: endByte,
            nextOffsetBytes: endByte < buffer.length ? endByte : undefined,
          },
        });
      },
    },
    {
      name: "git_status",
      providerId: "git",
      capability: "git_read",
      description: "Show short git status for the workspace.",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async (_input, ctx) => {
        const content = await gitStatus(ctx.workspaceRoot, ctx.readScope);
        return {
          ok: true,
          summary: content.trim()
            ? "Read git status."
            : "Workspace git status is clean.",
          data: {
            content,
            scopeConstrained: ctx.readScope !== undefined,
          },
        };
      },
    },
    {
      name: "git_diff",
      providerId: "git",
      capability: "git_read",
      description: "Show unstaged git diff stat and a truncated diff.",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async (_input, ctx) =>
        gitDiff(ctx.workspaceRoot, ctx.readScope),
    },
    {
      name: "update_plan",
      providerId: "session",
      capability: "update_plan",
      description: "Replace the current Session plan.",
      inputSchema: {
        // The input schema validates that the model provides an array of plan items with the required fields and correct types, and that the status field is one of the allowed values in the PlanStatus vocabulary. This validation helps ensure that the model's proposed plan updates are well-formed and adhere to the expected structure before the Session state is mutated, which is important for maintaining the integrity of the Session and enabling effective observation of the plan by the model.
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["step", "status"],
              additionalProperties: false,
            },
          },
        },
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

const classifyCollectionRead = async (
  toolName: "list_files" | "search_text",
  path: string,
  input: unknown,
  ctx: ToolContext,
) => {
  const allowed = await doesPathOverlapSessionReadScope(
    ctx.workspaceRoot,
    path,
    ctx.readScope,
  );
  return {
    workflow: ctx.workflow,
    toolName,
    capability: "read_workspace" as const,
    riskTier: allowed ? ("low" as const) : ("forbidden" as const),
    input,
    workspaceRoot: ctx.workspaceRoot,
    targets: [
      {
        kind: "path" as const,
        path,
        classification: allowed
          ? ("ordinary" as const)
          : ("outside_session_read_scope" as const),
      },
    ],
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
  readScope?: string[],
): Promise<string[]> => {
  const realWorkspaceRoot = await realpath(workspaceRoot);
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
      if (
        await doesPathOverlapSessionReadScope(
          workspaceRoot,
          absolute,
          readScope,
        )
      )
        files.push(
          ...(await listFiles(absolute, workspaceRoot, readScope)),
        );
    } else if (entry.isFile()) {
      const path = relative(realWorkspaceRoot, absolute);
      if (
        await isPathInSessionReadScope(workspaceRoot, path, readScope)
      )
        files.push(path);
    }
  }
  return files.sort();
};

// Formats read_file results with metadata for truncation and range modes to support iterative reads by the model and human inspection of tool results.
const readFileToolResult = (
  path: string,
  fullBuffer: Buffer,
  returned: Buffer,
  options: {
    truncated: boolean;
    rangeMetadata: Record<string, unknown>;
  },
): ToolResult => {
  return {
    ok: true,
    summary: `Read ${path}${options.truncated ? " with truncation" : ""}.`,
    data: {
      content: returned.toString("utf8"),
      path,
      truncated: options.truncated,
      totalBytes: fullBuffer.length,
      returnedBytes: returned.length,
      contentHash: createHash("sha256").update(fullBuffer).digest("hex"),
      ...options.rangeMetadata,
    },
  };
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
const gitStatus = (
  workspaceRoot: string,
  readScope: string[] | undefined,
): Promise<string> => {
  return new Promise((resolveStatus) => {
    const args = [
      ...(readScope ? ["--literal-pathspecs"] : []),
      "status",
      "--short",
      ...(readScope ? ["--", ...readScope] : []),
    ];
    execFile(
      "git",
      args,
      { cwd: workspaceRoot },
      (error, stdout) => {
        if (error) resolveStatus("Git status is unavailable.");
        else resolveStatus(stdout);
      },
    );
  });
};

const gitDiff = async (
  workspaceRoot: string,
  readScope: string[] | undefined,
): Promise<ToolResult> => {
  const scopedArgs = (args: string[]) => [
    ...(readScope ? ["--literal-pathspecs"] : []),
    ...args,
    ...(readScope ? ["--", ...readScope] : []),
  ];
  const [stat, diff] = await Promise.all([
    gitOutput(workspaceRoot, scopedArgs(["diff", "--stat"])),
    gitOutput(workspaceRoot, scopedArgs(["diff"])),
  ]);
  if (stat === undefined || diff === undefined) {
    return {
      ok: true,
      summary: "Git diff is unavailable.",
      data: {
        content: "Git diff is unavailable.",
        truncated: false,
        totalBytes: 0,
        returnedBytes: 0,
        scopeConstrained: readScope !== undefined,
      },
    };
  }
  if (!stat.trim() && !diff.trim()) {
    return {
      ok: true,
      summary: "Workspace git diff is empty.",
      data: {
        content: "",
        truncated: false,
        totalBytes: 0,
        returnedBytes: 0,
        scopeConstrained: readScope !== undefined,
      },
    };
  }

  const buffer = Buffer.from(diff, "utf8");
  const returned = buffer.subarray(0, GIT_DIFF_LIMIT_BYTES);
  const truncated = buffer.length > returned.length;
  const renderedDiff = returned.toString("utf8");
  const truncationNotice = truncated
    ? `\n[truncated: showing ${returned.length} of ${buffer.length} bytes]`
    : "";

  return {
    ok: true,
    summary: truncated ? "Read git diff with truncation." : "Read git diff.",
    data: {
      content: [
        "Git diff stat:",
        stat.trim() || "(none)",
        "",
        "Git diff:",
        renderedDiff + truncationNotice,
      ].join("\n"),
      truncated,
      totalBytes: buffer.length,
      returnedBytes: returned.length,
      contentHash: createHash("sha256").update(diff).digest("hex"),
      scopeConstrained: readScope !== undefined,
    },
  };
};

const gitOutput = (
  workspaceRoot: string,
  args: string[],
): Promise<string | undefined> => {
  return new Promise((resolveOutput) => {
    execFile(
      "git",
      args,
      { cwd: workspaceRoot, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error) resolveOutput(undefined);
        else resolveOutput(stdout);
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

// Reads an optional non-negative integer field from model-provided tool input.
const optionalNonNegativeInteger = (
  input: unknown,
  key: string,
): number | undefined => {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`Invalid non-negative integer input: ${key}`);
  return value;
};

// Reads an optional positive integer field from model-provided tool input.
const optionalPositiveInteger = (
  input: unknown,
  key: string,
): number | undefined => {
  const value = optionalNonNegativeInteger(input, key);
  if (value === undefined) return undefined;
  if (value === 0) throw new Error(`Invalid positive integer input: ${key}`);
  return value;
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
