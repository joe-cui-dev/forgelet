#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./parseArgs.js";
import { helpText } from "./help.js";
import { runAgent } from "../agent/runAgent.js";
import { loadConfig, routeModel } from "../config/index.js";
import { loadDotEnv } from "../config/env.js";
import { DeepSeekModelClient } from "../models/providers/deepseek.js";
import { listSessions, showSession } from "../sessions/index.js";
import type { ModelClient, WorkflowKind } from "../types.js";

export interface RunCliOptions {
  homeDir?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  createLiveModelClient?: (
    input: CreateLiveModelClientInput,
  ) => Promise<ModelClient>;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CreateLiveModelClientInput {
  workflow: WorkflowKind;
  modelOverride?: string;
  homeDir?: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  try {
    const command = parseArgs(argv);

    switch (command.kind) {
      case "help":
        return ok(helpText());
      case "version":
        return ok("0.1.0");
      case "run": {
        const modelClient = command.live
          ? await (options.createLiveModelClient ?? createDeepSeekLiveModelClient)({
              workflow: command.workflow,
              modelOverride: command.model,
              homeDir: options.homeDir,
              workspaceRoot,
              env: options.env ?? process.env,
            })
          : undefined;
        const result = await runAgent({
          workflow: command.workflow,
          task: command.task,
          contextFiles: command.contextFiles,
          model: command.model,
          budgetUsd: command.budgetUsd,
          workspaceRoot,
          modelClient
        });
        return ok(result.summary);
      }
      case "config-get":
        return ok(JSON.stringify(await loadConfig({ homeDir: options.homeDir, workspaceRoot }), null, 2));
      case "config-set":
        return ok(`Config set is scaffolded: ${command.key}=${command.value}`);
      case "sessions-list":
        return ok(formatSessionList(await listSessions(workspaceRoot)));
      case "sessions-show":
        return ok(formatSessionDetail(await showSession(workspaceRoot, command.sessionId)));
      case "explain":
        return ok(`Explain mode is scaffolded for ${command.sessionId}.`);
      case "memory-suggest":
        return ok(`Memory suggestion is scaffolded for session ${command.sessionId}.`);
      case "memory-accept":
        return ok(`Memory acceptance is scaffolded for suggestion ${command.suggestionId}.`);
      default: {
        const exhaustive: never = command;
        throw new Error(`Unhandled command: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `forge: ${message}`, exitCode: 1 };
  }
}

async function createDeepSeekLiveModelClient(
  input: CreateLiveModelClientInput,
): Promise<ModelClient> {
  await loadDotEnv({ workspaceRoot: input.workspaceRoot, env: input.env });
  const config = await loadConfig({
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  const route = routeModel(config, input.workflow, input.modelOverride);
  if (!route.model.startsWith("deepseek-")) {
    throw new Error(
      `Live execution currently supports DeepSeek models only. Route selected ${route.model}.`,
    );
  }
  const apiKeyEnv = config.providers.deepseek.apiKeyEnv;
  const apiKey = input.env[apiKeyEnv];
  if (!apiKey)
    throw new Error(`${apiKeyEnv} is required for --live DeepSeek execution.`);
  return new DeepSeekModelClient({ apiKey, model: route.model });
}

function ok(stdout: string): RunCliResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function formatSessionList(sessions: Awaited<ReturnType<typeof listSessions>>): string {
  if (sessions.length === 0) return "No Forgelet sessions found.";
  return sessions.map((session) => `${session.id}\t${session.workflow}\t${session.status}\t${session.startedAt}\t${session.task}`).join("\n");
}

function formatSessionDetail(session: Awaited<ReturnType<typeof showSession>>): string {
  const context = session.contextAttachments.length > 0 ? session.contextAttachments.map((attachment) => attachment.title ?? attachment.id).join(", ") : "none";
  const route = session.route ? `${session.route.model} (${session.route.reason})` : "none";
  return [
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    `Workflow: ${session.workflow}`,
    `Task: ${session.task}`,
    `Started: ${session.startedAt}`,
    `Context attachments: ${context}`,
    `Route: ${route}`,
    `Final summary: ${session.finalSummary}`,
    `Trace: ${session.tracePath}`
  ].join("\n");
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
}

export function isCliEntrypoint(
  argvPath: string | undefined,
  moduleUrl: string,
): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  await main();
}
