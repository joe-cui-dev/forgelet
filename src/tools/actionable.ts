import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ActionableToolDeps } from "../kernel/workflowDefinition.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolRequest,
  ToolResult,
  ToolTarget,
} from "../types.js";
import { isSecretBearingPath } from "../secretPaths/index.js";

const PATCH_PREVIEW_BYTES = 2 * 1024;

export const createActionableCodingTools = (
  options: ActionableToolDeps,
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
    preflight: (input, ctx) => preflightPatch(input, ctx),
    execute: (input, ctx) => applyPatch(input, ctx, options),
  },
  {
    name: "run_command",
    providerId: "command",
    capability: "run_safe_command",
    description: [
      "Run one configured safe command in the workspace without a shell.",
      options.settings.safeCommands.length > 0
        ? `The command must match exactly one of: ${options.settings.safeCommands.join(", ")}.`
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
  options: ActionableToolDeps,
): ToolRequest => {
  const patch = normalizePatch(requiredString(input, "patch"));
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
      Buffer.byteLength(patch, "utf8") > options.settings.maxPatchBytes ||
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
  options: ActionableToolDeps,
): Promise<ToolResult> => {
  const patch = normalizePatch(requiredString(input, "patch"));
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > options.settings.maxPatchBytes)
    return {
      ok: false,
      summary: `Patch exceeds maxPatchBytes (${options.settings.maxPatchBytes}).`,
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
    if (
      options.sessionState.baselineDirtyPaths.has(path) &&
      !isContinuationOwnedDirtyPath(path, options)
    )
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

  const planned = planPatchApply(patch);
  if (!planned.ok) return planned.failure;

  // No `--check` pass first: `git apply` validates the whole patch before it
  // writes anything, so a workspace that moved since the preflight fails here
  // with the same message and no partial edit.
  const applied = await gitApply(
    ctx.workspaceRoot,
    [...planned.gitApplyArgs, "-"],
    patch,
  );
  if (!applied.ok)
    return patchFailure("Patch failed git apply.", applied.output);

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
  options: ActionableToolDeps,
): ToolRequest => {
  const command = requiredString(input, "command");
  const exactMatch = options.settings.safeCommands.includes(command);
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
  options: ActionableToolDeps,
): Promise<ToolResult> => {
  const command = requiredString(input, "command");
  if (!options.settings.safeCommands.includes(command))
    return { ok: false, summary: `Command is not configured safe: ${command}` };
  const argv = parseCommand(command);
  if (argv.length === 0) return { ok: false, summary: "Command is empty." };
  const startedAt = Date.now();
  const result = await execCommand(
    argv[0] ?? "",
    argv.slice(1),
    ctx.workspaceRoot,
    options.settings.commandTimeoutMs,
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

/** Everything about a patch that can be decided by reading it, with no process
 * spawned and nothing touched. Shared by the preflight that runs before the
 * approval prompt and the execution that runs after it. */
const planPatchApply = (
  patch: string,
): { ok: true; gitApplyArgs: string[] } | { ok: false; failure: ToolResult } => {
  // A hunk that creates a file is insert-only by nature and has no existing
  // content to land in the wrong part of, so it needs neither an anchor nor
  // the relaxed placement rules.
  const zeroContextHunks = parsePatchHunks(patch).filter(
    (hunk) => !hunk.hasContext && !hunk.createsFile,
  );
  // A zero-context hunk that only adds lines is placed at the line number in
  // its header with nothing for git to verify against, so a header the model
  // guessed wrong edits the wrong part of the file and still reports success.
  // A single removed line is enough to anchor the hunk to real content.
  if (zeroContextHunks.some((hunk) => !hunk.hasDeletion))
    return {
      ok: false,
      failure: {
        ok: false,
        summary: "Patch has an insert-only hunk with no context lines.",
        error: [
          "An insert-only hunk carries nothing git can match against, so it",
          "would be placed at its stated line number unchecked. Include at",
          "least one surrounding context line in the hunk.",
        ].join(" "),
      },
    };

  return {
    ok: true,
    gitApplyArgs: [
      ...GIT_APPLY_RECOUNT_ARGS,
      ...(zeroContextHunks.length > 0 ? [GIT_APPLY_UNIDIFF_ZERO_ARG] : []),
    ],
  };
};

const patchFailure = (summary: string, output: string): ToolResult => ({
  ok: false,
  summary,
  error: `${output}\n${PATCH_FAILURE_HINT}`,
  data: { content: truncate(output, PATCH_PREVIEW_BYTES) },
});

/** Path, delete and dirty-file guards are already enforced by the permission
 * decision, so all that is left to establish before the prompt is whether the
 * patch applies at all. */
const preflightPatch = async (
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult | undefined> => {
  const patch = normalizePatch(requiredString(input, "patch"));
  const planned = planPatchApply(patch);
  if (!planned.ok) return planned.failure;
  const check = await gitApply(
    ctx.workspaceRoot,
    [...planned.gitApplyArgs, "--check", "-"],
    patch,
  );
  return check.ok
    ? undefined
    : patchFailure("Patch failed git apply --check.", check.output);
};

const normalizePatch = (patch: string): string =>
  patch.length > 0 && !patch.endsWith("\n") ? `${patch}\n` : patch;

/** Models routinely miscount the `@@ -a,b +c,d @@` line numbers, and plain
 * `git apply` rejects the whole patch when a count disagrees with its body
 * (`corrupt patch`, `patch fragment without header`). `--recount` derives the
 * counts from the body instead, which is what the model meant in the first
 * place. */
const GIT_APPLY_RECOUNT_ARGS = ["--recount"];

/** `git apply` also rejects hunks carrying no context line at all, which is the
 * shape a model reaches for when replacing a single line. `--unidiff-zero`
 * accepts them, but only pass it when the patch needs it: it relaxes the
 * placement checks for every hunk in the patch. */
const GIT_APPLY_UNIDIFF_ZERO_ARG = "--unidiff-zero";

const PATCH_FAILURE_HINT = [
  "Hunk line counts are recounted automatically, so a wrong count in an `@@`",
  "header is not the cause. The removed and context lines must match the file",
  "byte for byte: re-read the target region with read_file and copy the lines",
  "from it rather than retyping them.",
].join(" ");

type PatchHunk = {
  hasContext: boolean;
  hasDeletion: boolean;
  createsFile: boolean;
};

/** Classified from the hunk body rather than its header, because the header
 * counts are exactly what cannot be trusted here. */
const parsePatchHunks = (patch: string): PatchHunk[] => {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  let creatingFile = false;
  const lines = patch.split("\n");
  // `normalizePatch` guarantees a trailing newline, so the last element is an
  // artifact of the split rather than a line of the last hunk.
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { hasContext: false, hasDeletion: false, createsFile: creatingFile };
      hunks.push(current);
      continue;
    }
    // A file header closes the preceding hunk. `--- a/x` is indistinguishable
    // from a removed line of content, so match the header shapes the rest of
    // this module already assumes (`parsePatchTargets`).
    if (
      line.startsWith("diff --git ") ||
      /^(--- |\+\+\+ )(a\/|b\/|\/dev\/null)/.test(line)
    ) {
      current = undefined;
      if (line.startsWith("diff --git ")) creatingFile = false;
      if (line === "--- /dev/null") creatingFile = true;
      continue;
    }
    if (!current) continue;
    // A bare empty line is a context line that lost its leading space in
    // transit. Counting it as context keeps an ambiguous hunk away from
    // `--unidiff-zero`, which is the safe direction to be wrong in.
    if (line === "" || line.startsWith(" ")) current.hasContext = true;
    else if (line.startsWith("-")) current.hasDeletion = true;
  }
  return hunks;
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
  options: ActionableToolDeps,
  isDelete: boolean,
): Extract<ToolTarget, { kind: "path" }> => {
  return {
    kind: "path",
    path,
    classification: isDelete
      ? "delete_file"
      : options.sessionState.baselineDirtyPaths.has(path) &&
        !isContinuationOwnedDirtyPath(path, options)
      ? "dirty_at_session_start"
      : classifyPath(path, ctx.workspaceRoot),
  };
};

const isContinuationOwnedDirtyPath = (
  path: string,
  options: ActionableToolDeps,
): boolean => options.sessionState.continuationOwnedDirtyPaths?.has(path) ?? false;

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
  // Two rules, deliberately. The shared list is what the read side also denies,
  // so neither direction can grow a hole the other lacks — it is what catches
  // `id_rsa` and `deploy.pem`, which the substring heuristic below never did.
  // The heuristic then stays as the write side's wider net: refusing to patch
  // `src/auth/token.ts` costs a pause, so the write side can afford to guess.
  if (
    isSecretBearingPath(normalized) ||
    /(\.env|secret|token|credential|key)/i.test(normalized)
  )
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
