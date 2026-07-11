import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultConfig } from "../config/index.js";
import {
  MEMORY_DECISIONS_RELATIVE_PATH,
  MEMORY_SUGGESTIONS_RELATIVE_PATH,
  type LegacySuggestionStatus,
} from "../memoryReview/records.js";

const execFileAsync = promisify(execFile);

/** Provider API key env vars a model client would need, read from the same
 * config every provider is routed through. Deliberately absent from every
 * command this smoke runs, so a command that somehow needed one fails loudly
 * instead of silently reaching a provider. */
const MODEL_PROVIDER_ENV_VARS = Object.values(defaultConfig.providers).map(
  (provider) => provider.apiKeyEnv,
);

export interface MemoryReviewSmokeOptions {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface MemoryReviewSmokeRun {
  workspaceRoot: string;
  versionedId: string;
  legacyProposedId: string;
  legacyGapId: string;
  suggestStdout: string;
  listStdout: string;
  showStdout: string;
  acceptStdout: string;
  rejectStdout: string;
  repairStdout: string;
  listAllStdout: string;
}

/** Drives the real, compiled `forge memory` CLI path through a scratch
 * workspace: a versioned suggestion derived from an actionable Session
 * Trace, plus representative legacy evidence (a proposed suggestion and an
 * accepted-but-unwritten Memory Write Gap). No model client env var is ever
 * present, so a command that needed one would fail instead of silently
 * succeeding — the whole surface is deterministic and model-free by
 * construction, not by assertion alone. */
export async function runMemoryReviewSmoke(
  options: MemoryReviewSmokeOptions,
): Promise<MemoryReviewSmokeRun> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-smoke-memory-review-"));
  const env = options.env ?? modelFreeEnv(process.env);

  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  const sessionId = "sess_smoke_memory";
  await writeActionableTrace(workspaceRoot, sessionId);

  const suggestStdout = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "suggest", sessionId], env);
  const versionedId = parseSuggestionId(suggestStdout);
  const suggestRepeat = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "suggest", sessionId], env);
  assertContains(suggestRepeat, "Recorded: existing proposal.", "repeated suggest");

  const legacyProposedId = "mem_smoke_legacy_proposed";
  const legacyGapId = "mem_smoke_legacy_gap";
  await appendLegacySuggestions(workspaceRoot, [
    {
      id: legacyProposedId,
      sourceSessionId: "sess_smoke_legacy",
      text: "Legacy guidance nobody has decided yet.",
      status: "proposed",
    },
    {
      id: legacyGapId,
      sourceSessionId: "sess_smoke_legacy_gap",
      text: "Legacy guidance accepted before this workspace's memory file existed.",
      status: "accepted",
    },
  ]);

  const suggestionsBefore = await readSuggestionsFile(workspaceRoot);
  const treeBefore = await snapshotForgeletTree(workspaceRoot);

  const listStdout = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "list"], env);
  assertContains(listStdout, versionedId, "actionable list");
  assertContains(listStdout, legacyProposedId, "actionable list");
  assertContains(listStdout, "Accepted, but not written — re-accept to repair", "actionable list");
  assertContains(listStdout, `Next: forge memory accept ${legacyGapId}`, "actionable list");
  assertNotContains(listStdout, "Session", "actionable list output should never mention starting a Session");

  const showStdout = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "show", versionedId], env);
  assertContains(showStdout, "Rendered Memory Block:", "evidence show");
  assertContains(showStdout, "--- begin rendered memory block ---", "evidence show");
  assertContains(showStdout, `Accept: forge memory accept ${versionedId}`, "evidence show");
  assertContains(showStdout, `Reject: forge memory reject ${versionedId}`, "evidence show");

  const acceptStdout = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "accept", versionedId], env);
  assertContains(acceptStdout, `Accepted: ${versionedId}`, "accept");
  const acceptRepeat = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "accept", versionedId], env);
  assertContains(acceptRepeat, "Already decided", "repeated accept");

  const rejectStdout = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "reject", legacyProposedId], env);
  assertContains(rejectStdout, `Rejected: ${legacyProposedId}`, "reject");

  const repairStdout = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "accept", legacyGapId], env);
  assertContains(repairStdout, "repaired the missing Durable Memory write", "accepted-unwritten repair");

  const listAllStdout = await runForgeCli(options.cliPath, workspaceRoot, ["memory", "list", "--all"], env);
  assertContains(listAllStdout, "Accepted and written", "full history list");
  assertContains(listAllStdout, "Rejected", "full history list");

  const suggestionsAfter = await readSuggestionsFile(workspaceRoot);
  const treeAfter = await snapshotForgeletTree(workspaceRoot);

  await validateEvidence({
    workspaceRoot,
    versionedId,
    legacyProposedId,
    legacyGapId,
    suggestionsBefore,
    suggestionsAfter,
    treeBefore,
    treeAfter,
  });

  return {
    workspaceRoot,
    versionedId,
    legacyProposedId,
    legacyGapId,
    suggestStdout,
    listStdout,
    showStdout,
    acceptStdout,
    rejectStdout,
    repairStdout,
    listAllStdout,
  };
}

interface ValidateEvidenceInput {
  workspaceRoot: string;
  versionedId: string;
  legacyProposedId: string;
  legacyGapId: string;
  suggestionsBefore: string;
  suggestionsAfter: string;
  treeBefore: Set<string>;
  treeAfter: Set<string>;
}

/** Inspects the Memory Decision Log, Durable Memory, and the append-only
 * suggestions file directly, rather than trusting exit codes. The full
 * before/after `.forgelet` snapshot proves list/show/accept/reject create no
 * Session, Session Trace, Debug Transcript, or other extra review artifact:
 * the only files a review command may add are the Memory Decision Log and
 * Durable Memory itself, and none may be removed. */
async function validateEvidence(input: ValidateEvidenceInput): Promise<void> {
  if (input.suggestionsAfter !== input.suggestionsBefore)
    throw new Error("Memory Review smoke expected memory-suggestions.jsonl to stay append-only through every review command.");

  const removed = setDifference(input.treeBefore, input.treeAfter);
  if (removed.length > 0)
    throw new Error(`Memory Review smoke expected no files removed from .forgelet; removed=[${removed.join(", ")}].`);
  const added = setDifference(input.treeAfter, input.treeBefore);
  const expectedAdded = [MEMORY_DECISIONS_RELATIVE_PATH, defaultConfig.memoryFile].sort();
  if (added.join("\n") !== expectedAdded.join("\n"))
    throw new Error(
      `Memory Review smoke expected review commands to create exactly [${expectedAdded.join(", ")}]; found=[${added.join(", ")}].`,
    );

  const log = (await readFile(join(input.workspaceRoot, MEMORY_DECISIONS_RELATIVE_PATH), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assertHasRecord(log, (r) => r.type === "decision" && r.suggestionId === input.versionedId && r.decision === "accepted", "Memory Decision for the versioned suggestion");
  assertHasRecord(log, (r) => r.type === "write-record" && r.suggestionId === input.versionedId, "Memory Write Record for the versioned suggestion");
  assertHasRecord(log, (r) => r.type === "decision" && r.suggestionId === input.legacyProposedId && r.decision === "rejected", "Memory Decision for the rejected legacy suggestion");
  assertHasRecord(log, (r) => r.type === "decision" && r.suggestionId === input.legacyGapId && r.decision === "accepted" && r.origin === "legacy-status", "imported legacy Memory Decision for the Memory Write Gap suggestion");
  assertHasRecord(log, (r) => r.type === "write-record" && r.suggestionId === input.legacyGapId, "repaired Memory Write Record for the Memory Write Gap suggestion");

  const memory = await readFile(join(input.workspaceRoot, defaultConfig.memoryFile), "utf8");
  if (!memory.includes(`## ${input.versionedId}`))
    throw new Error("Memory Review smoke expected the accepted versioned suggestion's block in Durable Memory.");
  if (!memory.includes(`## ${input.legacyGapId}`))
    throw new Error("Memory Review smoke expected the repaired legacy suggestion's block in Durable Memory.");
  if (memory.includes(`## ${input.legacyProposedId}`))
    throw new Error("Memory Review smoke expected the rejected legacy suggestion to never be written to Durable Memory.");
}

function setDifference(from: Set<string>, subtract: Set<string>): string[] {
  return [...from].filter((value) => !subtract.has(value)).sort();
}

function assertHasRecord(
  records: Record<string, unknown>[],
  predicate: (record: Record<string, unknown>) => boolean,
  label: string,
): void {
  if (!records.some(predicate)) throw new Error(`Memory Review smoke expected ${label} in the Memory Decision Log.`);
}

async function readSuggestionsFile(workspaceRoot: string): Promise<string> {
  try {
    return await readFile(join(workspaceRoot, MEMORY_SUGGESTIONS_RELATIVE_PATH), "utf8");
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** Every file path under `.forgelet`, workspace-relative with forward
 * slashes, so a before/after diff catches an extra artifact anywhere in the
 * tree rather than only in the specific paths this smoke expects to touch. */
async function snapshotForgeletTree(workspaceRoot: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(workspaceRoot, ".forgelet"), {
      recursive: true,
      withFileTypes: true,
    });
    return new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
          join(relative(workspaceRoot, entry.parentPath), entry.name).replaceAll("\\", "/"),
        ),
    );
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
}

interface LegacySuggestionFixture {
  id: string;
  sourceSessionId: string;
  text: string;
  status: LegacySuggestionStatus;
}

async function appendLegacySuggestions(
  workspaceRoot: string,
  suggestions: LegacySuggestionFixture[],
): Promise<void> {
  const lines = suggestions
    .map((suggestion) =>
      JSON.stringify({
        id: suggestion.id,
        sourceSessionId: suggestion.sourceSessionId,
        text: suggestion.text,
        reason: "Derived deterministically from actionable Session audit evidence.",
        status: suggestion.status,
      }),
    )
    .join("\n") + "\n";
  await writeFile(join(workspaceRoot, MEMORY_SUGGESTIONS_RELATIVE_PATH), lines, {
    encoding: "utf8",
    flag: "a",
  });
}

async function writeActionableTrace(workspaceRoot: string, sessionId: string): Promise<void> {
  const trace = [
    {
      type: "session_started",
      ts: "2026-07-11T10:00:00.000Z",
      sessionId,
      payload: { workflow: "coding", startedAt: "2026-07-11T10:00:00.000Z" },
    },
    {
      type: "final_summary",
      ts: "2026-07-11T10:01:00.000Z",
      sessionId,
      payload: {
        audit: {
          changeGroups: {
            forgeletChanged: ["src/greeting.ts"],
            preExistingAtSessionStart: [],
            otherCurrentWorkspaceChanges: [],
          },
          verificationCommands: [{ command: "npm test", exitCode: 0, timedOut: false }],
          kernelObservedRisks: [],
          modelTurns: 1,
          estimatedCostUsd: 0.01,
          tracePath: `.forgelet/sessions/${sessionId}.jsonl`,
        },
      },
    },
    {
      type: "session_finished",
      ts: "2026-07-11T10:02:00.000Z",
      sessionId,
      payload: { status: "completed" },
    },
  ];
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", `${sessionId}.jsonl`),
    trace.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

function parseSuggestionId(stdout: string): string {
  const match = stdout.match(/^Memory suggestion: (mem_[0-9a-f]+)$/m);
  if (!match?.[1]) throw new Error("Memory Review smoke could not parse the suggestion id from forge memory suggest output.");
  return match[1];
}

function modelFreeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of MODEL_PROVIDER_ENV_VARS) delete env[key];
  return env;
}

async function runForgeCli(
  cliPath: string,
  workspaceRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: workspaceRoot,
      env,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    if (isRecord(error)) {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      throw new Error(
        [
          `Memory Review smoke CLI failed for: forge ${args.join(" ")}`,
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    throw error;
  }
}

function assertContains(content: string, expected: string, label: string): void {
  if (!content.includes(expected)) throw new Error(`Memory Review smoke output is missing (${label}): ${expected}`);
}

function assertNotContains(content: string, unexpected: string, label: string): void {
  if (content.includes(unexpected)) throw new Error(`Memory Review smoke output unexpectedly contains (${label}): ${unexpected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await runMemoryReviewSmoke({
    cliPath: join(repoRoot, "dist", "cli", "index.js"),
  });

  console.log(
    [
      "Project Memory Review smoke passed.",
      `Workspace: ${relative(repoRoot, result.workspaceRoot)} (${result.workspaceRoot})`,
      `Versioned suggestion: ${result.versionedId}`,
      `Legacy proposed suggestion: ${result.legacyProposedId}`,
      `Legacy Memory Write Gap suggestion: ${result.legacyGapId}`,
      "",
      "List (actionable):",
      result.listStdout.trim(),
      "",
      "List (--all):",
      result.listAllStdout.trim(),
    ].join("\n"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
