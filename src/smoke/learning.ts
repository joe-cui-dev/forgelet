import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadDotEnv } from "../config/env.js";

const execFileAsync = promisify(execFile);

export interface LearningSmokeEvidence {
  stdout: string;
  tracePath: string;
  traceEvents: unknown[];
  contextPath?: string;
}

export interface LearningSmokeValidation {
  sessionId: string;
  tracePath: string;
  model: string;
}

export interface LearningSmokeOptions {
  cliPath: string;
  workspaceRoot: string;
  contextPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface LearningSmokeRun extends LearningSmokeValidation {
  stdout: string;
  workspaceRoot: string;
}

export async function runLearningSmoke(
  options: LearningSmokeOptions,
): Promise<LearningSmokeRun> {
  const beforeTraceFiles = await listTraceFiles(options.workspaceRoot);
  const knowledgeDirExisted = await pathExists(knowledgeDirFor(options.workspaceRoot));
  const stdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    options.contextPath,
    options.env,
  );
  if (
    !knowledgeDirExisted &&
    (await pathExists(knowledgeDirFor(options.workspaceRoot)))
  )
    throw new Error("Learning smoke must not create .forgelet/knowledge/.");
  const tracePath = await findNewTracePath(
    options.workspaceRoot,
    beforeTraceFiles,
  );
  const traceEvents = parseTrace(await readFile(tracePath, "utf8"));
  const validation = validateLearningSmokeEvidence({
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

export function validateLearningSmokeEvidence(
  evidence: LearningSmokeEvidence,
): LearningSmokeValidation {
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
  if (startedPayload.workflow !== "learning")
    throw new Error("Learning smoke expected workflow=learning.");

  const contextPayload = recordValue(
    contextAttachment.payload,
    "context_attachment.payload",
  );
  const expectedContextPath =
    evidence.contextPath ?? "fixtures/learning/article.md";
  if (contextPayload.title !== basename(expectedContextPath))
    throw new Error(
      `Learning smoke expected ${basename(expectedContextPath)} context attachment title.`,
    );
  if (contextPayload.uri !== expectedContextPath)
    throw new Error(
      `Learning smoke expected ${expectedContextPath} context attachment uri.`,
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
    throw new Error("Learning smoke expected a completed Session.");

  assertLearningPack(evidence.stdout);

  return {
    sessionId,
    tracePath: evidence.tracePath,
    model,
  };
}

function assertLearningPack(content: string): void {
  for (const heading of [
    "Summary",
    "Key Concepts",
    "Source Links",
    "Open Questions",
    "Review Prompts",
  ]) {
    if (!hasHeading(content, heading))
      throw new Error(`Learning smoke output is missing ${heading}.`);
  }
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
      [cliPath, "learn", "--context", contextPath, "teach me the core ideas"],
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
          "Learning smoke CLI failed.",
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
      `Learning smoke expected one new Session trace, found ${newFiles.length}.`,
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

function knowledgeDirFor(workspaceRoot: string): string {
  return join(workspaceRoot, ".forgelet", "knowledge");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
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

  const result = await runLearningSmoke({
    cliPath: join(repoRoot, "dist", "cli", "index.js"),
    workspaceRoot: repoRoot,
    contextPath: join("fixtures", "learning", "article.md"),
    env,
  });

  console.log(
    [
      "Learning smoke passed.",
      `Workspace: ${result.workspaceRoot}`,
      `Trace: ${result.tracePath}`,
      `Session: ${result.sessionId}`,
      `Model: ${result.model}`,
      "",
      "Learning Pack:",
      result.stdout.trim(),
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
