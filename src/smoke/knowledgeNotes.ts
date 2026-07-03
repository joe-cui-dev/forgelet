import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadDotEnv } from "../config/env.js";
import { runLearningSmoke } from "./learning.js";

const execFileAsync = promisify(execFile);

export interface KnowledgeNotesSmokeOptions {
  cliPath: string;
  workspaceRoot: string;
  contextPath: string;
  query?: string;
  env?: NodeJS.ProcessEnv;
}

export interface KnowledgeNotesSmokeRun {
  sessionId: string;
  tracePath: string;
  model: string;
  workspaceRoot: string;
  notePath: string;
  createStdout: string;
  searchStdout: string;
  searchResults: number;
}

export async function runKnowledgeNotesSmoke(
  options: KnowledgeNotesSmokeOptions,
): Promise<KnowledgeNotesSmokeRun> {
  const learning = await runLearningSmoke(options);
  const createStdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    [
      "notes",
      "create",
      "--scope",
      "project",
      "--from-session",
      learning.sessionId,
    ],
    "Knowledge Notes create smoke CLI failed.",
    options.env,
  );
  const notePath = parseRequiredLine(createStdout, "Path");
  await assertPathExists(join(options.workspaceRoot, notePath));

  const query = options.query ?? "core ideas";
  const searchStdout = await runForgeCli(
    options.cliPath,
    options.workspaceRoot,
    ["notes", "search", "--scope", "project", query],
    "Knowledge Notes search smoke CLI failed.",
    options.env,
  );
  const searchResults = Number.parseInt(
    parseRequiredLine(searchStdout, "Results"),
    10,
  );
  if (!Number.isInteger(searchResults) || searchResults < 1)
    throw new Error("Knowledge Notes smoke expected at least one search result.");
  if (!searchStdout.includes(notePath))
    throw new Error("Knowledge Notes smoke search output is missing note path.");

  return {
    sessionId: learning.sessionId,
    tracePath: learning.tracePath,
    model: learning.model,
    workspaceRoot: learning.workspaceRoot,
    notePath,
    createStdout,
    searchStdout,
    searchResults,
  };
}

async function runForgeCli(
  cliPath: string,
  workspaceRoot: string,
  args: string[],
  failureMessage: string,
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
          failureMessage,
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

function parseRequiredLine(stdout: string, label: string): string {
  const prefix = `${label}:`;
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(prefix));
  const value = line?.slice(line.indexOf(prefix) + prefix.length).trim();
  if (!value)
    throw new Error(`Knowledge Notes smoke output is missing ${label}.`);
  return value;
}

async function assertPathExists(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT")
      throw new Error(`Knowledge Notes smoke expected note file: ${path}`);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const env = { ...process.env };
  await loadDotEnv({ path: join(repoRoot, ".env"), env });

  const result = await runKnowledgeNotesSmoke({
    cliPath: join(repoRoot, "dist", "cli", "index.js"),
    workspaceRoot: repoRoot,
    contextPath: join("fixtures", "learning", "article.md"),
    env,
  });

  console.log(
    [
      "Knowledge Notes smoke passed.",
      `Workspace: ${result.workspaceRoot}`,
      `Trace: ${result.tracePath}`,
      `Session: ${result.sessionId}`,
      `Model: ${result.model}`,
      `Note: ${result.notePath}`,
      `Search results: ${result.searchResults}`,
      "",
      "Knowledge Note:",
      result.createStdout.trim(),
      "",
      "Search:",
      result.searchStdout.trim(),
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
