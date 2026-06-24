import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type {
  ToolContext,
  ToolDefinition,
  ToolRequest,
  ToolResult,
  ToolTarget,
} from "../types.js";

const PATCH_PREVIEW_BYTES = 2 * 1024;

export interface ActionableSessionState {
  baselineDirtyPaths: Set<string>;
  forgeletTouchedPaths: Set<string>;
}

export interface ActionableCodingToolsOptions {
  safeCommands: string[];
  commandTimeoutMs: number;
  maxPatchBytes: number;
  sessionState: ActionableSessionState;
}

export const createActionableCodingTools = (
  options: ActionableCodingToolsOptions,
): ToolDefinition[] => [
  {
    name: "apply_patch",
    providerId: "workspace",
    capability: "write_workspace",
    description:
      "Apply a git-apply compatible unified diff to ordinary workspace files.",
    inputSchema: {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
      additionalProperties: false,
    },
    classify: (input, ctx) => classifyPatch(input, ctx, options),
    execute: (input, ctx) => applyPatch(input, ctx, options),
  },
  {
    name: "run_command",
    providerId: "command",
    capability: "run_safe_command",
    description: [
      "Run one configured safe command in the workspace without a shell.",
      options.safeCommands.length > 0
        ? `The command must match exactly one of: ${options.safeCommands.join(", ")}.`
        : "No commands are configured safe for this Session.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    classify: (input, ctx) => classifyCommand(input, ctx, options),
    execute: (input, ctx) => runCommand(input, ctx, options),
  },
];

const classifyPatch = (
  input: unknown,
  ctx: ToolContext,
  options: ActionableCodingToolsOptions,
): ToolRequest => {
  const patch = requiredString(input, "patch");
  const changedFiles = parsePatchTargets(patch);
  const deleteTargets = parseDeleteTargets(patch);
  const targets = changedFiles.map((path) =>
    classifyPathTarget(path, ctx, options, deleteTargets.has(path)),
  );
  return {
    workflow: ctx.workflow,
    toolName: "apply_patch",
    capability: "write_workspace",
    riskTier:
      Buffer.byteLength(patch, "utf8") > options.maxPatchBytes ||
      targets.some((target) => target.classification !== "ordinary")
        ? "forbidden"
        : "medium",
    input,
    workspaceRoot: ctx.workspaceRoot,
    targets,
  };
};

const applyPatch = async (
  input: unknown,
  ctx: ToolContext,
  options: ActionableCodingToolsOptions,
): Promise<ToolResult> => {
  const patch = requiredString(input, "patch");
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > options.maxPatchBytes)
    return {
      ok: false,
      summary: `Patch exceeds maxPatchBytes (${options.maxPatchBytes}).`,
    };

  const changedFiles = parsePatchTargets(patch);
  const deleteTargets = parseDeleteTargets(patch);
  if (changedFiles.length === 0)
    return { ok: false, summary: "Patch has no changed files." };

  for (const path of changedFiles) {
    if (deleteTargets.has(path))
      return {
        ok: false,
        summary: `Delete-file patches are denied: ${path}`,
      };
    if (options.sessionState.baselineDirtyPaths.has(path))
      return {
        ok: false,
        summary: `Patch target was dirty at Session start: ${path}`,
      };
    const target = classifyPathTarget(path, ctx, options, false);
    if (target.classification !== "ordinary")
      return {
        ok: false,
        summary: `Patch target is ${target.classification}: ${path}`,
      };
    await mkdir(dirname(resolve(ctx.workspaceRoot, path)), { recursive: true });
  }

  const check = await gitApply(ctx.workspaceRoot, ["--check", "-"], patch);
  if (!check.ok)
    return {
      ok: false,
      summary: "Patch failed git apply --check.",
      error: check.output,
      data: { content: truncate(check.output, PATCH_PREVIEW_BYTES) },
    };

  const applied = await gitApply(ctx.workspaceRoot, ["-"], patch);
  if (!applied.ok)
    return {
      ok: false,
      summary: "Patch failed git apply.",
      error: applied.output,
      data: { content: truncate(applied.output, PATCH_PREVIEW_BYTES) },
    };

  changedFiles.forEach((path) => options.sessionState.forgeletTouchedPaths.add(path));
  return {
    ok: true,
    summary: `Applied patch to ${changedFiles.length} file(s).`,
    data: {
      content: [
        `Changed files: ${changedFiles.join(", ")}`,
        `Patch hash: ${createHash("sha256").update(patch).digest("hex")}`,
      ].join("\n"),
      truncated: patchBytes > PATCH_PREVIEW_BYTES,
      totalBytes: patchBytes,
      returnedBytes: Math.min(patchBytes, PATCH_PREVIEW_BYTES),
      contentHash: createHash("sha256").update(patch).digest("hex"),
      changedFiles,
    },
  };
};

const classifyCommand = (
  input: unknown,
  ctx: ToolContext,
  options: ActionableCodingToolsOptions,
): ToolRequest => {
  const command = requiredString(input, "command");
  const exactMatch = options.safeCommands.includes(command);
  return {
    workflow: ctx.workflow,
    toolName: "run_command",
    capability: "run_safe_command",
    riskTier: exactMatch ? "medium" : "forbidden",
    input,
    workspaceRoot: ctx.workspaceRoot,
    targets: [
      {
        kind: "command",
        command,
        classification: exactMatch ? "safe_configured" : "unsafe",
      },
    ],
  };
};

const runCommand = async (
  input: unknown,
  ctx: ToolContext,
  options: ActionableCodingToolsOptions,
): Promise<ToolResult> => {
  const command = requiredString(input, "command");
  if (!options.safeCommands.includes(command))
    return { ok: false, summary: `Command is not configured safe: ${command}` };
  const argv = parseCommand(command);
  if (argv.length === 0) return { ok: false, summary: "Command is empty." };
  const startedAt = Date.now();
  const result = await execCommand(
    argv[0] ?? "",
    argv.slice(1),
    ctx.workspaceRoot,
    options.commandTimeoutMs,
  );
  const durationMs = Date.now() - startedAt;
  const content = truncate(result.output, PATCH_PREVIEW_BYTES);
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    summary: result.timedOut
      ? `Command timed out after ${durationMs}ms.`
      : `Command exited ${result.exitCode}.`,
    error:
      result.exitCode === 0 && !result.timedOut ? undefined : result.output,
    data: {
      content,
      truncated: Buffer.byteLength(result.output, "utf8") > PATCH_PREVIEW_BYTES,
      totalBytes: Buffer.byteLength(result.output, "utf8"),
      returnedBytes: Buffer.byteLength(content, "utf8"),
      contentHash: createHash("sha256").update(result.output).digest("hex"),
      command,
      exitCode: result.exitCode,
      durationMs,
      timedOut: result.timedOut,
    },
  };
};

const parsePatchTargets = (patch: string): string[] => {
  const targets = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) targets.add(match[2] ?? match[1] ?? "");
    const newFile = /^\+\+\+ b\/(.+)$/.exec(line);
    if (newFile) targets.add(newFile[1] ?? "");
  }
  return [...targets].filter(Boolean);
};

const parseDeleteTargets = (patch: string): Set<string> => {
  const targets = new Set<string>();
  let current: string | undefined;
  for (const line of patch.split("\n")) {
    const diff = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diff) current = diff[2] ?? diff[1];
    if (line === "+++ /dev/null" && current) targets.add(current);
  }
  return targets;
};

const classifyPathTarget = (
  path: string,
  ctx: ToolContext,
  options: ActionableCodingToolsOptions,
  isDelete: boolean,
): Extract<ToolTarget, { kind: "path" }> => {
  return {
    kind: "path",
    path,
    classification: isDelete
      ? "delete_file"
      : options.sessionState.baselineDirtyPaths.has(path)
      ? "dirty_at_session_start"
      : classifyPath(path, ctx.workspaceRoot),
  };
};

const classifyPath = (
  path: string,
  workspaceRoot: string,
): Extract<ToolTarget, { kind: "path" }>["classification"] => {
  if (isAbsolute(path)) return "outside_workspace";
  const normalized = normalize(path);
  if (normalized.startsWith("..")) return "outside_workspace";
  const absolute = resolve(workspaceRoot, normalized);
  if (relative(workspaceRoot, absolute).startsWith(".."))
    return "outside_workspace";
  if (
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".forgelet" ||
    normalized.startsWith(".forgelet/")
  )
    return "internal";
  if (
    normalized === "node_modules" ||
    normalized.startsWith("node_modules/") ||
    normalized === "dist" ||
    normalized.startsWith("dist/") ||
    normalized === "dist-test" ||
    normalized.startsWith("dist-test/")
  )
    return "generated";
  if (/(\.env|secret|token|credential|key)/i.test(normalized))
    return "sensitive";
  return "ordinary";
};

const gitApply = (
  workspaceRoot: string,
  args: string[],
  patch: string,
): Promise<{ ok: boolean; output: string }> => {
  return new Promise((resolveApply) => {
    const child = spawn("git", ["apply", ...args], { cwd: workspaceRoot });
    const output: string[] = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.on("error", (error) =>
      resolveApply({ ok: false, output: error.message }),
    );
    child.on("close", (code) =>
      resolveApply({ ok: code === 0, output: output.join("") }),
    );
    child.stdin.end(patch);
  });
};

const execCommand = (
  executable: string,
  args: string[],
  workspaceRoot: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> => {
  return new Promise((resolveCommand) => {
    const child = spawn(executable, args, { cwd: workspaceRoot, shell: false });
    const output: string[] = [];
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      child.kill("SIGTERM");
      finished = true;
      resolveCommand({
        exitCode: null,
        output: output.join(""),
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveCommand({ exitCode: null, output: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveCommand({ exitCode: code, output: output.join(""), timedOut: false });
    });
  });
};

const parseCommand = (command: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (char === " " && !quote) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  if (quote) throw new Error("Command contains an unterminated quote.");
  return parts;
};

const truncate = (value: string, bytes: number): string =>
  Buffer.from(value, "utf8").subarray(0, bytes).toString("utf8");

const requiredString = (input: unknown, key: string): string => {
  if (!isRecord(input) || typeof input[key] !== "string")
    throw new Error(`Missing required string input: ${key}`);
  return input[key];
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};
