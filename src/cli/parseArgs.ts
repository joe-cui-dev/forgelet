import type {
  CreativeInputKind,
  CreativeStyle,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";

export type ForgeCommand =
  | {
      kind: "run";
      workflow: WorkflowKind;
      workflowVariant?: WorkflowVariant;
      creativeStyle?: CreativeStyle;
      creativeInputKind?: CreativeInputKind;
      task: string;
      contextFiles: string[];
      withBrowser?: boolean;
      publicWeb?: boolean;
      continuationFile?: string;
      projectSlug?: string;
      allowedReadPaths?: string[];
      model?: string;
      budgetUsd?: number;
      preview: boolean;
      act: boolean;
      debug?: boolean;
      writeScopePrefixes?: string[];
      allowedCommands?: string[];
      maxWallClockMs?: number;
      maxModelTurns?: number;
    }
  | {
      kind: "resume";
      sessionId: string;
      instruction: string;
      act: boolean;
      debug?: boolean;
    }
  | { kind: "config-get" }
  | { kind: "config-set"; key: string; value: string }
  | { kind: "sessions-list" }
  | { kind: "sessions-show"; sessionId: string }
  | { kind: "queue" }
  | { kind: "decide"; sessionId?: string }
  | { kind: "explain"; sessionId: string }
  | {
      kind: "notes-create";
      scope: "project";
      fromSessionId: string;
      title?: string;
    }
  | {
      kind: "notes-search";
      scope: "project";
      query: string;
      limit: number;
    }
  | { kind: "writing-artifacts-list" }
  | { kind: "writing-artifacts-show"; artifact: string; full: boolean }
  | { kind: "writing-artifacts-search"; query: string; limit: number }
  | { kind: "writing-projects-create"; slug: string }
  | { kind: "memory-suggest"; sessionId: string }
  | { kind: "memory-accept"; suggestionId: string }
  | { kind: "memory-reject"; suggestionId: string }
  | { kind: "memory-list"; all: boolean }
  | { kind: "memory-show"; suggestionId: string }
  | { kind: "debug-show"; sessionId: string; full: boolean }
  | { kind: "browser-read-current" }
  | { kind: "browser-install-host"; extensionId: string }
  | { kind: "browser-profiles-approve"; name?: string }
  | { kind: "browser-profiles-list" }
  | { kind: "browser-profiles-set-default"; profileId: string }
  | { kind: "browser-profiles-revoke"; profileId: string }
  | { kind: "help" }
  | { kind: "version" };

export function parseArgs(argv: string[]): ForgeCommand {
  const args = [...argv];

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { kind: "help" };
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return { kind: "version" };
  }

  const first = args[0];

  if (first === "config") {
    return parseConfig(args.slice(1));
  }

  if (first === "sessions") {
    return parseSessions(args.slice(1));
  }

  if (first === "memory") {
    return parseMemory(args.slice(1));
  }

  if (first === "browser") {
    return parseBrowser(args.slice(1));
  }

  if (first === "debug") {
    return parseDebug(args.slice(1));
  }

  if (first === "notes") {
    return parseNotes(args.slice(1));
  }

  if (first === "explain") {
    const sessionId = args[1];
    if (!sessionId) throw new Error("Usage: forge explain <sessionId>");
    return { kind: "explain", sessionId };
  }

  if (first === "resume") {
    return parseResume(args.slice(1));
  }

  if (first === "queue") {
    if (args.length > 1) throw new Error("Usage: forge queue");
    return { kind: "queue" };
  }

  if (first === "decide") {
    if (args.length > 2) throw new Error("Usage: forge decide [sessionId]");
    return { kind: "decide", ...(args[1] ? { sessionId: args[1] } : {}) };
  }

  if (first === "code") {
    return parseRun(args.slice(1), "coding");
  }

  if (first === "write") {
    if (args[1] === "resume")
      throw new Error("Writing Workflow resume is not available yet.");
    if (args[1] === "projects") return parseWritingProjects(args.slice(2));
    if (args[1] === "artifacts") return parseWritingArtifacts(args.slice(2));
    return parseRun(args.slice(1), "writing");
  }

  if (first === "learn") {
    return parseRun(args.slice(1), "learning");
  }

  if (first?.startsWith("-")) throw new Error(`Unknown option: ${first}`);
  throw new Error(`Unknown command: ${first}`);
}

function parseWritingArtifacts(args: string[]): ForgeCommand {
  if (args[0] === "list" && args.length === 1)
    return { kind: "writing-artifacts-list" };
  if (args[0] === "search") return parseWritingArtifactsSearch(args.slice(1));
  if (args[0] === "show") {
    const artifact = args[1];
    if (!artifact)
      throw new Error(
        "Usage: forge write artifacts list | forge write artifacts show <artifact> [--full]",
      );
    const remaining = args.slice(2);
    const full = remaining.includes("--full");
    const unsupported = remaining.find((arg) => arg !== "--full");
    if (unsupported)
      throw new Error(`Unsupported Writing Artifact Catalog option: ${unsupported}`);
    return { kind: "writing-artifacts-show", artifact, full };
  }
  throw new Error(
    "Usage: forge write artifacts list | forge write artifacts show <artifact> [--full] | forge write artifacts search [--limit <n>] \"<query>\"",
  );
}

function parseWritingArtifactsSearch(args: string[]): ForgeCommand {
  let limit = 10;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (queryParts.length > 0 && arg?.startsWith("-"))
      throw new Error(
        `Unsupported Writing Artifact Catalog option after query: ${arg}`,
      );
    if (arg === "--limit") {
      const value = args[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error("--limit must be a positive integer");
      limit = parsed;
      continue;
    }
    if (arg?.startsWith("-"))
      throw new Error(`Unsupported Writing Artifact Catalog option: ${arg}`);
    queryParts.push(arg ?? "");
  }

  const query = queryParts.join(" ").trim();
  if (!query)
    throw new Error(
      'Usage: forge write artifacts search [--limit <n>] "<query>"',
    );
  return { kind: "writing-artifacts-search", query, limit };
}

function parseWritingProjects(args: string[]): ForgeCommand {
  if (args[0] === "create" && args.length === 2)
    return { kind: "writing-projects-create", slug: args[1] ?? "" };
  throw new Error("Usage: forge write projects create <slug>");
}

function parseBrowser(args: string[]): ForgeCommand {
  if (args[0] === "read-current" && args.length === 1) {
    return { kind: "browser-read-current" };
  }
  if (
    args[0] === "install-host" &&
    args[1] === "--extension-id" &&
    args.length === 3
  ) {
    return { kind: "browser-install-host", extensionId: args[2] ?? "" };
  }
  if (args[0] === "profiles") {
    return parseBrowserProfiles(args.slice(1));
  }
  throw new Error(
    "Usage: forge browser read-current | forge browser install-host --extension-id <chrome-extension-id> | forge browser profiles approve|list|set-default|revoke",
  );
}

const BROWSER_PROFILES_USAGE =
  "Usage: forge browser profiles approve [--name <name>] | forge browser profiles list | forge browser profiles set-default <profileId> | forge browser profiles revoke <profileId>";

function parseBrowserProfiles(args: string[]): ForgeCommand {
  if (args[0] === "approve") {
    const remaining = args.slice(1);
    if (remaining.length === 0) return { kind: "browser-profiles-approve" };
    if (remaining[0] === "--name" && remaining.length === 2) {
      const name = remaining[1] ?? "";
      if (!name) throw new Error(BROWSER_PROFILES_USAGE);
      return { kind: "browser-profiles-approve", name };
    }
    throw new Error(BROWSER_PROFILES_USAGE);
  }
  if (args[0] === "list" && args.length === 1) {
    return { kind: "browser-profiles-list" };
  }
  if (args[0] === "set-default" && args.length === 2) {
    return { kind: "browser-profiles-set-default", profileId: args[1] ?? "" };
  }
  if (args[0] === "revoke" && args.length === 2) {
    return { kind: "browser-profiles-revoke", profileId: args[1] ?? "" };
  }
  throw new Error(BROWSER_PROFILES_USAGE);
}

function parseDebug(args: string[]): ForgeCommand {
  if (args[0] !== "show") {
    throw new Error("Usage: forge debug show <sessionId> [--full]");
  }
  const sessionId = args[1];
  if (!sessionId) throw new Error("Usage: forge debug show <sessionId> [--full]");
  const remaining = args.slice(2);
  const full = remaining.includes("--full");
  const unsupported = remaining.find((arg) => arg !== "--full");
  if (unsupported)
    throw new Error(`Unsupported Debug Transcript option: ${unsupported}`);
  return { kind: "debug-show", sessionId, full };
}

function parseNotes(args: string[]): ForgeCommand {
  if (args[0] === "search") return parseNotesSearch(args.slice(1));
  if (args[0] !== "create") throw new Error("Usage: forge notes create --scope project --from-session <sessionId> [--title <title>]");
  let scope: string | undefined;
  let fromSessionId: string | undefined;
  let title: string | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--scope") {
      scope = args[++i];
      continue;
    }
    if (arg === "--from-session") {
      fromSessionId = args[++i];
      continue;
    }
    if (arg === "--title") {
      title = args[++i];
      continue;
    }
    throw new Error(`Unsupported notes create option: ${arg}`);
  }

  if (scope === "personal")
    throw new Error("Personal Knowledge Scope is not available yet.");
  if (scope !== "project")
    throw new Error("The first Knowledge Notes slice requires --scope project.");
  if (!fromSessionId)
    throw new Error("Usage: forge notes create --scope project --from-session <sessionId> [--title <title>]");

  return { kind: "notes-create", scope, fromSessionId, title };
}

function parseNotesSearch(args: string[]): ForgeCommand {
  let scope: string | undefined;
  let limit = 10;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--scope") {
      scope = args[++i];
      continue;
    }
    if (arg === "--limit") {
      const value = args[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error("--limit must be a positive integer");
      limit = parsed;
      continue;
    }
    if (arg === "--json") {
      throw new Error("JSON output is not available yet.");
    }
    if (arg?.startsWith("-"))
      throw new Error(`Unsupported notes search option: ${arg}`);
    queryParts.push(arg ?? "");
  }

  if (scope === "personal")
    throw new Error("Personal Knowledge Scope is not available yet.");
  if (scope !== "project")
    throw new Error("The first Knowledge Notes slice requires --scope project.");
  const query = queryParts.join(" ").trim();
  if (!query)
    throw new Error('Usage: forge notes search --scope project [--limit <n>] "<query>"');
  return { kind: "notes-search", scope, query, limit };
}

function parseConfig(args: string[]): ForgeCommand {
  if (args[0] === "get" && args.length === 1) return { kind: "config-get" };
  if (args[0] === "set" && args.length === 3) {
    if (isModelDefaultConfigKey(args[1] ?? ""))
      throw new Error(
        "Model defaults are defined in src/config/index.ts; use --model for a single run override.",
      );
    return { kind: "config-set", key: args[1] ?? "", value: args[2] ?? "" };
  }
  throw new Error("Usage: forge config get | forge config set <key> <value>");
}

function isModelDefaultConfigKey(key: string): boolean {
  return (
    key === "defaultModel" ||
    key === "fallbackModel" ||
    key === "cheapModel" ||
    key === "routing" ||
    key.startsWith("routing.")
  );
}

function parseSessions(args: string[]): ForgeCommand {
  if (args[0] === "list" && args.length === 1) return { kind: "sessions-list" };
  if (args[0] === "show" && args.length === 2) {
    return { kind: "sessions-show", sessionId: args[1] ?? "" };
  }
  throw new Error(
    "Usage: forge sessions list | forge sessions show <sessionId>",
  );
}

function parseMemory(args: string[]): ForgeCommand {
  if (args[0] === "list" && args.length === 1) {
    return { kind: "memory-list", all: false };
  }
  if (args[0] === "list" && args.length === 2 && args[1] === "--all") {
    return { kind: "memory-list", all: true };
  }
  if (args[0] === "show" && args.length === 2) {
    return { kind: "memory-show", suggestionId: args[1] ?? "" };
  }
  if (args[0] === "suggest" && args.length === 2) {
    return { kind: "memory-suggest", sessionId: args[1] ?? "" };
  }
  if (args[0] === "accept" && args.length === 2) {
    return { kind: "memory-accept", suggestionId: args[1] ?? "" };
  }
  if (args[0] === "reject" && args.length === 2) {
    return { kind: "memory-reject", suggestionId: args[1] ?? "" };
  }
  throw new Error(
    "Usage: forge memory list [--all] | forge memory show <suggestionId> | forge memory suggest <sessionId> | forge memory accept <suggestionId> | forge memory reject <suggestionId>",
  );
}

function parseResume(args: string[]): ForgeCommand {
  const sessionId = args[0];
  if (args.includes("--reuse-context"))
    throw new Error(
      "Context reload for Session Continuation is not available yet.",
    );
  let act = false;
  let debug = false;
  let optionIndex = 1;
  while (args[optionIndex]?.startsWith("--")) {
    const option = args[optionIndex];
    if (option === "--act") {
      act = true;
      optionIndex += 1;
      continue;
    }
    if (option === "--debug") {
      debug = true;
      optionIndex += 1;
      continue;
    }
    break;
  }
  const instructionArgs = args.slice(optionIndex);
  const unsupportedOption = instructionArgs.find((arg) => arg.startsWith("--"));
  if (unsupportedOption)
    throw new Error(
      `Unsupported Session Continuation option: ${unsupportedOption}`,
    );
  const instruction = instructionArgs.join(" ").trim();
  if (!sessionId || !instruction)
    throw new Error('Usage: forge resume <sessionId> [--act] "<instruction>"');
  return { kind: "resume", sessionId, instruction, act, ...(debug ? { debug } : {}) };
}

function parseRun(args: string[], workflow: WorkflowKind): ForgeCommand {
  const contextFiles: string[] = [];
  const allowedReadPaths: string[] = [];
  let model: string | undefined;
  let budgetUsd: number | undefined;
  let workflowVariant: WorkflowVariant | undefined;
  let creativeStyle: CreativeStyle | undefined;
  let continuationFile: string | undefined;
  let projectSlug: string | undefined;
  let preview = false;
  let act = false;
  let debug = false;
  let withBrowser = false;
  let publicWeb = false;
  const writeScopePrefixes: string[] = [];
  const allowedCommands: string[] = [];
  let maxWallClockMs: number | undefined;
  let maxModelTurns: number | undefined;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--context") {
      rejectOptionAfterTask(taskParts, arg);
      const value = args[++i];
      if (!value) throw new Error("Missing value for --context");
      contextFiles.push(value);
      continue;
    }
    if (arg === "--with-browser") {
      rejectOptionAfterTask(taskParts, arg);
      withBrowser = true;
      continue;
    }
    if (arg === "--web") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow !== "learning") throw new Error("--web is only available for the learning workflow.");
      publicWeb = true;
      continue;
    }
    if (arg === "--continue") {
      rejectOptionAfterTask(taskParts, arg);
      const value = args[++i];
      if (!value) throw new Error("Missing value for --continue");
      if (continuationFile)
        throw new Error("Exactly one --continue artifact can be provided.");
      if (!value.toLowerCase().endsWith(".md"))
        throw new Error(
          "--continue supports Markdown files only; pass a path such as .forgelet/writing/<artifact>.md.",
        );
      continuationFile = value;
      continue;
    }
    if (arg === "--project") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow !== "writing")
        throw new Error("--project is only available for the writing workflow.");
      const value = args[++i];
      if (!value) throw new Error("Missing value for --project");
      if (projectSlug)
        throw new Error("Exactly one --project slug can be provided.");
      projectSlug = value;
      continue;
    }
    if (arg === "--allow-read") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow === "learning")
        throw new Error("--allow-read is not available for the learning workflow.");
      const value = args[++i];
      if (!value) throw new Error("Missing value for --allow-read");
      allowedReadPaths.push(value);
      continue;
    }
    if (arg === "--model") {
      rejectOptionAfterTask(taskParts, arg);
      const value = args[++i];
      if (!value) throw new Error("Missing value for --model");
      model = value;
      continue;
    }
    if (arg === "--budget") {
      rejectOptionAfterTask(taskParts, arg);
      const value = args[++i];
      if (!value) throw new Error("Missing value for --budget");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0)
        throw new Error("--budget must be a positive number");
      budgetUsd = parsed;
      continue;
    }
    if (arg === "--creative") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow !== "writing")
        throw new Error(
          "--creative is only available for the writing workflow.",
        );
      workflowVariant = "creative";
      continue;
    }
    if (arg === "--style") {
      rejectOptionAfterTask(taskParts, arg);
      const value = args[++i];
      if (!value) throw new Error("Missing value for --style");
      creativeStyle = value;
      continue;
    }
    if (arg === "--preview") {
      rejectOptionAfterTask(taskParts, arg);
      preview = true;
      continue;
    }
    if (arg === "--debug") {
      rejectOptionAfterTask(taskParts, arg);
      debug = true;
      continue;
    }
    if (arg === "--act") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow !== "coding")
        throw new Error("--act is only available for the coding workflow.");
      act = true;
      continue;
    }
    if (arg === "--write-scope") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow !== "coding")
        throw new Error("--write-scope is only available for the coding workflow.");
      const value = args[++i];
      if (!value) throw new Error("Missing value for --write-scope");
      writeScopePrefixes.push(value);
      act = true;
      continue;
    }
    if (arg === "--allow-command") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow !== "coding")
        throw new Error("--allow-command is only available for the coding workflow.");
      const value = args[++i];
      if (!value) throw new Error("Missing value for --allow-command");
      allowedCommands.push(value);
      continue;
    }
    if (arg === "--max-wall-clock-ms") {
      rejectOptionAfterTask(taskParts, arg);
      const value = args[++i];
      if (!value) throw new Error("Missing value for --max-wall-clock-ms");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error("--max-wall-clock-ms must be a positive integer");
      maxWallClockMs = parsed;
      continue;
    }
    if (arg === "--max-turns") {
      rejectOptionAfterTask(taskParts, arg);
      const value = args[++i];
      if (!value) throw new Error("Missing value for --max-turns");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error("--max-turns must be a positive integer");
      maxModelTurns = parsed;
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    taskParts.push(arg ?? "");
  }

  if (allowedCommands.length > 0 && writeScopePrefixes.length === 0)
    throw new Error("--allow-command requires --write-scope to be set.");

  const task = taskParts.join(" ").trim();
  if (!task)
    throw new Error(
      workflow === "writing"
        ? 'Usage: forge write "<task>"'
        : workflow === "learning"
          ? 'Usage: forge learn --context <source> "<task>"'
          : 'Usage: forge code "<task>"',
    );
  if (workflow === "learning" && contextFiles.length === 0 && !withBrowser && !publicWeb)
    throw new Error("forge learn requires --context, --with-browser, or --web.");
  if (publicWeb && withBrowser)
    throw new Error("--web cannot be combined with --with-browser: the task-only Public Web Query Scope excludes Browser Context.");
  if (creativeStyle && workflowVariant !== "creative")
    throw new Error("--style is only available with --creative.");
  if (continuationFile && workflow !== "writing")
    throw new Error("--continue is only available for the writing workflow.");
  if (continuationFile && workflowVariant !== "creative")
    throw new Error("--continue is only available with --creative.");
  if (debug && preview)
    throw new Error(
      "--debug is available only for model-backed Session runs, not --preview.",
    );
  if (workflowVariant === "creative" && !creativeStyle)
    throw new Error("--creative requires --style <name>.");
  const creativeInputKind: CreativeInputKind | undefined =
    workflowVariant === "creative"
      ? continuationFile
        ? "continuation"
        : contextFiles.length > 0
          ? "revision"
          : "draft"
      : undefined;
  return {
    kind: "run",
    workflow,
    ...(workflowVariant ? { workflowVariant } : {}),
    ...(creativeStyle ? { creativeStyle } : {}),
    ...(creativeInputKind ? { creativeInputKind } : {}),
    task,
    contextFiles,
    ...(withBrowser ? { withBrowser } : {}),
    ...(publicWeb ? { publicWeb } : {}),
    ...(continuationFile ? { continuationFile } : {}),
    ...(projectSlug ? { projectSlug } : {}),
    ...(allowedReadPaths.length > 0 ? { allowedReadPaths } : {}),
    model,
    budgetUsd,
    preview,
    act,
    ...(debug ? { debug } : {}),
    ...(writeScopePrefixes.length > 0 ? { writeScopePrefixes } : {}),
    ...(allowedCommands.length > 0 ? { allowedCommands } : {}),
    ...(maxWallClockMs !== undefined ? { maxWallClockMs } : {}),
    ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
  };
}

function rejectOptionAfterTask(taskParts: string[], option: string): void {
  if (taskParts.length > 0)
    throw new Error(`Unknown option after task: ${option}`);
}
