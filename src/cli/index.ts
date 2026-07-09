#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./parseArgs.js";
import { helpText } from "./help.js";
import { loadConfig, setGlobalConfigValue } from "../config/index.js";
import { explainSession } from "../explain/index.js";
import { formatDebugTranscriptShow } from "../debugTranscript/index.js";
import { acceptMemorySuggestion, suggestMemoryFromSession } from "../memory/index.js";
import { loadCurrentBrowserSnapshot } from "../browser/index.js";
import { installChromeNativeMessagingHost } from "../browser/nativeHostInstall.js";
import { createKnowledgeNote, searchKnowledgeNotes } from "../knowledge/index.js";
import { listSessions, showSession } from "../sessions/index.js";
import { listPausedSessions } from "../sessions/queue.js";
import {
  findWritingArtifactEntry,
  readWritingArtifactCatalog,
  readWritingArtifactContent,
  searchWritingArtifacts,
} from "../writingArtifacts/index.js";
import { createWritingProject } from "../writingProjects/index.js";
import type { SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { ModelClient } from "../types.js";
import type { ApprovalHandler } from "../tools/toolRegistry.js";
import { runRunCommand } from "./commands/run.js";
import { runResumeCommand } from "./commands/resume.js";
import { runDecideCommand } from "./commands/decide.js";
import {
  createInteractiveTerminalOutputController,
  type InteractiveTerminalOutputController,
} from "./terminal.js";
import {
  formatWritingArtifactCatalog,
  formatWritingArtifactSearch,
  formatWritingArtifactDetail,
  formatCreatedWritingProject,
} from "./present/writing.js";
import { formatSessionList, formatSessionDetail } from "./present/sessions.js";
import { formatQueue } from "./present/queue.js";
import { formatSessionExplanation } from "./present/explain.js";
import { formatCreatedKnowledgeNote, formatKnowledgeNoteSearch } from "./present/knowledge.js";
import { formatMemorySuggestion, formatAcceptedMemory } from "./present/memory.js";
import { formatBrowserSnapshot, formatInstalledChromeNativeHost } from "./present/browser.js";
import type { CreateLiveModelClientInput } from "./wiring.js";

export { createInteractiveTerminalOutputController };
export type { InteractiveTerminalOutputController, CreateLiveModelClientInput };

export interface RunCliOptions {
  homeDir?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  createLiveModelClient?: (
    input: CreateLiveModelClientInput,
  ) => Promise<ModelClient>;
  approvalHandler?: ApprovalHandler;
  decidePrompt?: (prompt: string) => Promise<string>;
  onLiveEvent?: SessionLiveEventSink;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
      case "run":
        return ok(await runRunCommand(command, { workspaceRoot, options }));
      case "resume":
        return ok(await runResumeCommand(command, { workspaceRoot, options }));
      case "queue":
        return ok(formatQueue(await listPausedSessions(workspaceRoot)));
      case "decide":
        return ok(await runDecideCommand(command, { workspaceRoot, options }));
      case "config-get":
        return ok(JSON.stringify(await loadConfig({ homeDir: options.homeDir, workspaceRoot }), null, 2));
      case "config-set":
        await setGlobalConfigValue({
          homeDir: options.homeDir,
          key: command.key,
          value: command.value,
        });
        return ok(`Config set: ${command.key}=${command.value}`);
      case "sessions-list":
        return ok(formatSessionList(await listSessions(workspaceRoot)));
      case "sessions-show":
        return ok(formatSessionDetail(await showSession(workspaceRoot, command.sessionId)));
      case "explain":
        return ok(formatSessionExplanation(await explainSession(workspaceRoot, command.sessionId)));
      case "debug-show":
        return ok(
          await formatDebugTranscriptShow({
            workspaceRoot,
            sessionId: command.sessionId,
            full: command.full,
          }),
        );
      case "notes-create":
        return ok(
          formatCreatedKnowledgeNote(
            await createKnowledgeNote(workspaceRoot, {
              scope: command.scope,
              fromSessionId: command.fromSessionId,
              title: command.title,
            }),
          ),
        );
      case "notes-search":
        return ok(
          formatKnowledgeNoteSearch(
            await searchKnowledgeNotes(workspaceRoot, {
              scope: command.scope,
              query: command.query,
              limit: command.limit,
            }),
          ),
        );
      case "writing-artifacts-list":
        return ok(formatWritingArtifactCatalog(await readWritingArtifactCatalog(workspaceRoot)));
      case "writing-artifacts-search":
        return ok(
          formatWritingArtifactSearch(
            await searchWritingArtifacts(workspaceRoot, {
              query: command.query,
              limit: command.limit,
            }),
          ),
        );
      case "writing-artifacts-show": {
        const entry = await findWritingArtifactEntry({
          workspaceRoot,
          artifact: command.artifact,
        });
        if (entry.status === "missing")
          throw new Error(
            `Writing artifact file is missing: ${entry.path}. Trace provenance still exists at ${entry.tracePath ?? "unknown"}.`,
          );
        return ok(
          formatWritingArtifactDetail({
            entry,
            ...(await readWritingArtifactContent({
              workspaceRoot,
              entry,
              full: command.full,
            })),
          }),
        );
      }
      case "writing-projects-create":
        return ok(
          formatCreatedWritingProject(
            await createWritingProject(workspaceRoot, command.slug),
          ),
        );
      case "memory-suggest":
        return ok(formatMemorySuggestion(await suggestMemoryFromSession(workspaceRoot, command.sessionId)));
      case "memory-accept":
        return ok(formatAcceptedMemory(await acceptMemorySuggestion(workspaceRoot, command.suggestionId)));
      case "browser-read-current":
        return ok(
          formatBrowserSnapshot(
            await loadCurrentBrowserSnapshot({ homeDir: options.homeDir }),
          ),
        );
      case "browser-install-host":
        return ok(
          formatInstalledChromeNativeHost(
            await installChromeNativeMessagingHost({
              extensionId: command.extensionId,
              homeDir: options.homeDir ?? process.env.HOME ?? "",
              workspaceRoot,
            }),
          ),
        );
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

function ok(stdout: string): RunCliResult {
  return { stdout, stderr: "", exitCode: 0 };
}

async function main(): Promise<void> {
  const terminalOutput =
    process.stdout.isTTY && process.stderr.isTTY
      ? createInteractiveTerminalOutputController((line) =>
          process.stderr.write(line),
        )
      : undefined;
  const argv = process.argv.slice(2);
  const result = await runCli(argv, {
    onLiveEvent: terminalOutput?.onLiveEvent,
  });
  if (result.stdout) {
    if (terminalOutput?.shouldSuppressFinalStdout(argv)) {
      const footer = terminalOutput.formatSuppressedFinalStdoutFooter(
        result.stdout,
      );
      if (footer) process.stderr.write(`${footer}\n`);
    } else {
      console.log(result.stdout);
    }
  }
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
