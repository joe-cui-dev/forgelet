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
      continuationFile?: string;
      allowedReadPaths?: string[];
      model?: string;
      budgetUsd?: number;
      preview: boolean;
      act: boolean;
    }
  | { kind: "resume"; sessionId: string; instruction: string; act: boolean }
  | { kind: "config-get" }
  | { kind: "config-set"; key: string; value: string }
  | { kind: "sessions-list" }
  | { kind: "sessions-show"; sessionId: string }
  | { kind: "explain"; sessionId: string }
  | { kind: "memory-suggest"; sessionId: string }
  | { kind: "memory-accept"; suggestionId: string }
  | { kind: "browser-read-current" }
  | { kind: "browser-install-host"; extensionId: string }
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

  if (first === "explain") {
    const sessionId = args[1];
    if (!sessionId) throw new Error("Usage: forge explain <sessionId>");
    return { kind: "explain", sessionId };
  }

  if (first === "resume") {
    return parseResume(args.slice(1));
  }

  if (first === "code") {
    return parseRun(args.slice(1), "coding");
  }

  if (first === "write") {
    if (args[1] === "resume")
      throw new Error("Writing Workflow resume is not available yet.");
    return parseRun(args.slice(1), "writing");
  }

  if (first === "learn") {
    return parseRun(args.slice(1), "learning");
  }

  if (first?.startsWith("-")) throw new Error(`Unknown option: ${first}`);
  throw new Error(`Unknown command: ${first}`);
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
  throw new Error(
    "Usage: forge browser read-current | forge browser install-host --extension-id <chrome-extension-id>",
  );
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
  if (args[0] === "suggest" && args.length === 2) {
    return { kind: "memory-suggest", sessionId: args[1] ?? "" };
  }
  if (args[0] === "accept" && args.length === 2) {
    return { kind: "memory-accept", suggestionId: args[1] ?? "" };
  }
  throw new Error(
    "Usage: forge memory suggest <sessionId> | forge memory accept <suggestionId>",
  );
}

function parseResume(args: string[]): ForgeCommand {
  const sessionId = args[0];
  if (args.includes("--reuse-context"))
    throw new Error(
      "Context reload for Session Continuation is not available yet.",
    );
  const act = args[1] === "--act";
  const instructionArgs = args.slice(act ? 2 : 1);
  const unsupportedOption = instructionArgs.find((arg) => arg.startsWith("--"));
  if (unsupportedOption)
    throw new Error(
      `Unsupported Session Continuation option: ${unsupportedOption}`,
    );
  const instruction = instructionArgs.join(" ").trim();
  if (!sessionId || !instruction)
    throw new Error('Usage: forge resume <sessionId> [--act] "<instruction>"');
  return { kind: "resume", sessionId, instruction, act };
}

function parseRun(args: string[], workflow: WorkflowKind): ForgeCommand {
  const contextFiles: string[] = [];
  const allowedReadPaths: string[] = [];
  let model: string | undefined;
  let budgetUsd: number | undefined;
  let workflowVariant: WorkflowVariant | undefined;
  let creativeStyle: CreativeStyle | undefined;
  let continuationFile: string | undefined;
  let preview = false;
  let act = false;
  let withBrowser = false;
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
      if (!isCreativeStyle(value))
        throw new Error(
          "--style must be one of: vivid, tight, literary, plain",
        );
      creativeStyle = value;
      continue;
    }
    if (arg === "--preview") {
      rejectOptionAfterTask(taskParts, arg);
      preview = true;
      continue;
    }
    if (arg === "--act") {
      rejectOptionAfterTask(taskParts, arg);
      if (workflow !== "coding")
        throw new Error("--act is only available for the coding workflow.");
      act = true;
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    taskParts.push(arg ?? "");
  }

  const task = taskParts.join(" ").trim();
  if (!task)
    throw new Error(
      workflow === "writing"
        ? 'Usage: forge write "<task>"'
        : workflow === "learning"
          ? 'Usage: forge learn --context <source> "<task>"'
          : 'Usage: forge code "<task>"',
    );
  if (workflow === "learning" && contextFiles.length === 0 && !withBrowser)
    throw new Error("forge learn requires --context or --with-browser.");
  if (creativeStyle && workflowVariant !== "creative")
    throw new Error("--style is only available with --creative.");
  if (continuationFile && workflow !== "writing")
    throw new Error("--continue is only available for the writing workflow.");
  if (continuationFile && workflowVariant !== "creative")
    throw new Error("--continue is only available with --creative.");
  if (workflowVariant === "creative" && !creativeStyle)
    throw new Error(
      "--creative requires --style <vivid|tight|literary|plain>.",
    );
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
    ...(continuationFile ? { continuationFile } : {}),
    ...(allowedReadPaths.length > 0 ? { allowedReadPaths } : {}),
    model,
    budgetUsd,
    preview,
    act,
  };
}

function rejectOptionAfterTask(taskParts: string[], option: string): void {
  if (taskParts.length > 0)
    throw new Error(`Unknown option after task: ${option}`);
}

function isCreativeStyle(value: string): value is CreativeStyle {
  return (
    value === "vivid" ||
    value === "tight" ||
    value === "literary" ||
    value === "plain"
  );
}
