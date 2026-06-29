import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadDotEnv } from "../config/env.js";

const execFileAsync = promisify(execFile);

export interface CreativeWritingSmokeEvidence {
  stdout: string;
  tracePath: string;
  traceEvents: unknown[];
  contextPath?: string;
}

export interface CreativeWritingSmokeValidation {
  sessionId: string;
  tracePath: string;
  model: string;
}

export interface CreativeWritingSmokeOptions {
  cliPath: string;
  workspaceRoot: string;
  contextPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface CreativeWritingSmokeRun extends CreativeWritingSmokeValidation {
  stdout: string;
  workspaceRoot: string;
}

export async function runCreativeWritingSmoke(
  options: CreativeWritingSmokeOptions,
): Promise<CreativeWritingSmokeRun> {
  const beforeTraceFiles = await listTraceFiles(options.workspaceRoot);
  const stdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    options.contextPath,
    options.env,
  );
  const tracePath = await findNewTracePath(
    options.workspaceRoot,
    beforeTraceFiles,
  );
  const traceEvents = parseTrace(await readFile(tracePath, "utf8"));
  const validation = validateCreativeWritingSmokeEvidence({
    stdout,
    tracePath,
    traceEvents,
    contextPath: options.contextPath,
  });

  return {
    ...validation,
    stdout,
    workspaceRoot: options.workspaceRoot,
  };
}

export function validateCreativeWritingSmokeEvidence(
  evidence: CreativeWritingSmokeEvidence,
): CreativeWritingSmokeValidation {
  const started = findEvent(evidence.traceEvents, "session_started");
  const contextAttachment = findEvent(
    evidence.traceEvents,
    "context_attachment",
  );
  const route = findEvent(evidence.traceEvents, "routing_selected");
  const finalSummary = findEvent(evidence.traceEvents, "final_summary");
  const finished = findEvent(evidence.traceEvents, "session_finished");

  const sessionId = stringValue(started.sessionId, "session_started.sessionId");
  const startedPayload = recordValue(
    started.payload,
    "session_started.payload",
  );
  if (startedPayload.workflow !== "writing")
    throw new Error("Writing smoke expected workflow=writing.");
  if (startedPayload.workflowVariant !== "creative")
    throw new Error("Writing smoke expected workflowVariant=creative.");
  if (startedPayload.creativeStyle !== "vivid")
    throw new Error("Writing smoke expected creativeStyle=vivid.");

  const contextPayload = recordValue(
    contextAttachment.payload,
    "context_attachment.payload",
  );
  const expectedContextPath =
    evidence.contextPath ?? "fixtures/writing/scene.md";
  if (contextPayload.title !== basename(expectedContextPath))
    throw new Error(
      `Writing smoke expected ${basename(expectedContextPath)} context attachment title.`,
    );
  if (contextPayload.uri !== expectedContextPath)
    throw new Error(
      `Writing smoke expected ${expectedContextPath} context attachment uri.`,
    );

  const routePayload = recordValue(route.payload, "routing_selected.payload");
  const model = stringValue(
    routePayload.model,
    "routing_selected.payload.model",
  );

  const finalSummaryPayload = recordValue(
    finalSummary.payload,
    "final_summary.payload",
  );
  stringValue(finalSummaryPayload.summary, "final_summary.payload.summary");

  const finishedPayload = recordValue(
    finished.payload,
    "session_finished.payload",
  );
  if (finishedPayload.status !== "completed")
    throw new Error("Writing smoke expected a completed Session.");

  assertRevisionPack(evidence.stdout);

  return {
    sessionId,
    tracePath: evidence.tracePath,
    model,
  };
}

function assertRevisionPack(content: string): void {
  for (const heading of ["Critique", "Revision", "Alternatives", "Notes"]) {
    if (!hasHeading(content, heading))
      throw new Error(`Writing smoke output is missing ${heading}.`);
  }
  const hasNumberedOptions =
    /(^|\n)\s*1[.)]\s+\S/.test(content) && /(^|\n)\s*2[.)]\s+\S/.test(content);
  const hasLabeledOptions =
    /(^|\n)\s*(#{1,6}\s*)?(\*\*)?(Option|Alternative) A\b/i.test(content) &&
    /(^|\n)\s*(#{1,6}\s*)?(\*\*)?(Option|Alternative) B\b/i.test(content);
  if (!hasNumberedOptions && !hasLabeledOptions)
    throw new Error("Writing smoke output must include two Alternatives.");
}

function hasHeading(content: string, heading: string): boolean {
  return new RegExp(`(^|\\n)#{0,6}\\s*${heading}\\s*(\\n|$)`, "i").test(
    content,
  );
}

function findEvent(events: unknown[], type: string): Record<string, unknown> {
  const event = events.find((candidate) => {
    return isRecord(candidate) && candidate.type === type;
  });
  if (!isRecord(event)) throw new Error(`Trace is missing ${type}.`);
  return event;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`Trace field is not an object: ${label}.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Trace field is not a string: ${label}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function runForgeCli(
  cliPath: string,
  workspaceRoot: string,
  contextPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "write",
        "--live",
        "--creative",
        "--style",
        "vivid",
        "--context",
        contextPath,
        "rewrite this scene with a more vivid voice",
      ],
      {
        cwd: workspaceRoot,
        env,
        maxBuffer: 1024 * 1024,
      },
    );
    return result.stdout;
  } catch (error) {
    if (isRecord(error)) {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      throw new Error(
        [
          "Creative writing smoke CLI failed.",
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

async function findNewTracePath(
  workspaceRoot: string,
  beforeTraceFiles: Set<string>,
): Promise<string> {
  const afterTraceFiles = await listTraceFiles(workspaceRoot);
  const newFiles = [...afterTraceFiles].filter(
    (file) => !beforeTraceFiles.has(file),
  );
  if (newFiles.length !== 1)
    throw new Error(
      `Creative writing smoke expected one new Session trace, found ${newFiles.length}.`,
    );
  return join(sessionDirFor(workspaceRoot), newFiles[0] ?? "");
}

async function listTraceFiles(workspaceRoot: string): Promise<Set<string>> {
  try {
    const files = (await readdir(sessionDirFor(workspaceRoot))).filter((file) =>
      file.endsWith(".jsonl"),
    );
    return new Set(files);
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT")
      return new Set();
    throw error;
  }
}

function sessionDirFor(workspaceRoot: string): string {
  return join(workspaceRoot, ".forgelet", "sessions");
}

function parseTrace(content: string): unknown[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const env = { ...process.env };
  await loadDotEnv({ path: join(repoRoot, ".env"), env });

  const result = await runCreativeWritingSmoke({
    cliPath: join(repoRoot, "dist", "cli", "index.js"),
    workspaceRoot: repoRoot,
    contextPath: join("fixtures", "writing", "scene.md"),
    env,
  });

  console.log(
    [
      "Creative writing smoke passed.",
      `Workspace: ${result.workspaceRoot}`,
      `Trace: ${result.tracePath}`,
      `Session: ${result.sessionId}`,
      `Model: ${result.model}`,
      "",
      "Revision Pack:",
      result.stdout.trim(),
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
