import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadDotEnv } from "../config/env.js";

const execFileAsync = promisify(execFile);

export interface WritingArtifactsSmokeEvidence {
  writeStdout: string;
  listStdout: string;
  showStdout: string;
  searchStdout: string;
  limitedSearchStdout: string;
  tracePath: string;
  traceEvents: unknown[];
  traceFilesAfterWrite: string[];
  traceFilesAfterCatalogReads: string[];
}

export interface WritingArtifactsSmokeValidation {
  sessionId: string;
  tracePath: string;
  artifactPath: string;
}

export interface WritingArtifactsSmokeOptions {
  cliPath: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
}

export interface WritingArtifactsSmokeRun
  extends WritingArtifactsSmokeValidation {
  writeStdout: string;
  listStdout: string;
  showStdout: string;
  searchStdout: string;
  limitedSearchStdout: string;
  workspaceRoot: string;
}

export async function runWritingArtifactsSmoke(
  options: WritingArtifactsSmokeOptions,
): Promise<WritingArtifactsSmokeRun> {
  const beforeTraceFiles = await listTraceFiles(options.workspaceRoot);
  const writeStdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    [
      "write",
      "--creative",
      "--style",
      "vivid",
      "write a rain-soaked convenience store scene in one paragraph",
    ],
    options.env,
  );
  const traceFilesAfterWrite = [...(await listTraceFiles(options.workspaceRoot))]
    .sort();
  const newTraceFiles = traceFilesAfterWrite.filter(
    (file) => !beforeTraceFiles.has(file),
  );
  if (newTraceFiles.length !== 1)
    throw new Error(
      `Writing Artifact Catalog smoke expected one new Session trace from forge write, found ${newTraceFiles.length}.`,
    );

  const tracePath = join(sessionDirFor(options.workspaceRoot), newTraceFiles[0] ?? "");
  const traceEvents = parseTrace(await readFile(tracePath, "utf8"));
  const sessionId = stringValue(
    findEvent(traceEvents, "session_started").sessionId,
    "session_started.sessionId",
  );
  const artifactPath = stringValue(
    recordValue(
      findEvent(traceEvents, "writing_artifact").payload,
      "writing_artifact.payload",
    ).path,
    "writing_artifact.payload.path",
  );
  await readFile(join(options.workspaceRoot, artifactPath), "utf8");
  const listStdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    ["write", "artifacts", "list"],
    options.env,
  );
  const showStdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    ["write", "artifacts", "show", sessionId],
    options.env,
  );
  const searchStdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    ["write", "artifacts", "search", "rain"],
    options.env,
  );
  const limitedSearchStdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    ["write", "artifacts", "search", "--limit", "1", "rain"],
    options.env,
  );
  const traceFilesAfterCatalogReads = [
    ...(await listTraceFiles(options.workspaceRoot)),
  ].sort();

  const validation = validateWritingArtifactsSmokeEvidence({
    writeStdout,
    listStdout,
    showStdout,
    searchStdout,
    limitedSearchStdout,
    tracePath,
    traceEvents,
    traceFilesAfterWrite,
    traceFilesAfterCatalogReads,
  });

  return {
    ...validation,
    writeStdout,
    listStdout,
    showStdout,
    searchStdout,
    limitedSearchStdout,
    workspaceRoot: options.workspaceRoot,
  };
}

export function validateWritingArtifactsSmokeEvidence(
  evidence: WritingArtifactsSmokeEvidence,
): WritingArtifactsSmokeValidation {
  const started = findEvent(evidence.traceEvents, "session_started");
  const artifact = findEvent(evidence.traceEvents, "writing_artifact");
  const finished = findEvent(evidence.traceEvents, "session_finished");
  const sessionId = stringValue(started.sessionId, "session_started.sessionId");
  const startedPayload = recordValue(
    started.payload,
    "session_started.payload",
  );
  if (startedPayload.workflow !== "writing")
    throw new Error("Writing Artifact Catalog smoke expected workflow=writing.");
  if (startedPayload.workflowVariant !== "creative")
    throw new Error(
      "Writing Artifact Catalog smoke expected workflowVariant=creative.",
    );

  const artifactPayload = recordValue(
    artifact.payload,
    "writing_artifact.payload",
  );
  const artifactPath = stringValue(
    artifactPayload.path,
    "writing_artifact.payload.path",
  );
  if (!artifactPath.startsWith(".forgelet/writing/"))
    throw new Error(
      "Writing Artifact Catalog smoke expected a .forgelet/writing artifact.",
    );

  const finishedPayload = recordValue(
    finished.payload,
    "session_finished.payload",
  );
  if (finishedPayload.status !== "completed")
    throw new Error(
      "Writing Artifact Catalog smoke expected a completed Session.",
    );

  assertContains(evidence.writeStdout, "Writing artifact:");
  assertContains(evidence.listStdout, "Writing Artifact Catalog");
  assertContains(evidence.listStdout, "Status: available");
  assertContains(evidence.listStdout, "Continue:");
  assertContains(evidence.showStdout, "Writing Artifact");
  assertContains(evidence.showStdout, "Status: available");
  assertContains(evidence.showStdout, "Continue:");
  assertContains(evidence.showStdout, "Preview:");
  assertContains(evidence.showStdout, artifactPath);
  assertContains(evidence.searchStdout, "Writing Artifact Catalog Search");
  assertContains(evidence.searchStdout, "Query: rain");
  assertContains(evidence.searchStdout, "Results: ");
  assertContains(evidence.searchStdout, "Status: available");
  assertContains(evidence.searchStdout, "Snippet:");
  assertContains(evidence.searchStdout, artifactPath.replace(".forgelet/writing/", ""));
  assertContains(evidence.limitedSearchStdout, "Writing Artifact Catalog Search");
  assertContains(evidence.limitedSearchStdout, "Query: rain");
  assertContains(evidence.limitedSearchStdout, "Results: 1");

  if (
    evidence.traceFilesAfterWrite.join("\n") !==
    evidence.traceFilesAfterCatalogReads.join("\n")
  )
    throw new Error(
      "Writing Artifact Catalog smoke expected list/show to avoid creating extra Session traces.",
    );

  return {
    sessionId,
    tracePath: evidence.tracePath,
    artifactPath,
  };
}

async function runForgeCli(
  cliPath: string,
  workspaceRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
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
          `Writing Artifact Catalog smoke CLI failed for: forge ${args.join(" ")}`,
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

function assertContains(content: string, expected: string): void {
  if (!content.includes(expected))
    throw new Error(`Smoke output is missing: ${expected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const env = { ...process.env };
  await loadDotEnv({ path: join(repoRoot, ".env"), env });

  const result = await runWritingArtifactsSmoke({
    cliPath: join(repoRoot, "dist", "cli", "index.js"),
    workspaceRoot: repoRoot,
    env,
  });

  console.log(
    [
      "Writing Artifact Catalog smoke passed.",
      `Workspace: ${result.workspaceRoot}`,
      `Trace: ${result.tracePath}`,
      `Session: ${result.sessionId}`,
      `Artifact: ${result.artifactPath}`,
      "",
      "Catalog:",
      result.listStdout.trim(),
      "",
      "Catalog search:",
      result.searchStdout.trim(),
      "",
      "Artifact preview:",
      result.showStdout.trim(),
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
