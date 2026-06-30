import type { CreativeStyle, WorkflowKind, WorkflowVariant } from "../types.js";

export type ForgeCommand =
  | { kind: "run"; workflow: WorkflowKind; workflowVariant?: WorkflowVariant; creativeStyle?: CreativeStyle; task: string; contextFiles: string[]; allowedReadPaths?: string[]; model?: string; budgetUsd?: number; live: boolean; act: boolean }
  | { kind: "config-get" }
  | { kind: "config-set"; key: string; value: string }
  | { kind: "sessions-list" }
  | { kind: "sessions-show"; sessionId: string }
  | { kind: "explain"; sessionId: string }
  | { kind: "memory-suggest"; sessionId: string }
  | { kind: "memory-accept"; suggestionId: string }
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

  if (first === "explain") {
    const sessionId = args[1];
    if (!sessionId) throw new Error("Usage: forge explain <sessionId>");
    return { kind: "explain", sessionId };
  }

  if (first === "write") {
    return parseRun(args.slice(1), "writing");
  }

  return parseRun(args, "coding");
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
  throw new Error("Usage: forge sessions list | forge sessions show <sessionId>");
}

function parseMemory(args: string[]): ForgeCommand {
  if (args[0] === "suggest" && args.length === 2) {
    return { kind: "memory-suggest", sessionId: args[1] ?? "" };
  }
  if (args[0] === "accept" && args.length === 2) {
    return { kind: "memory-accept", suggestionId: args[1] ?? "" };
  }
  throw new Error("Usage: forge memory suggest <sessionId> | forge memory accept <suggestionId>");
}

function parseRun(args: string[], workflow: WorkflowKind): ForgeCommand {
  const contextFiles: string[] = [];
  const allowedReadPaths: string[] = [];
  let model: string | undefined;
  let budgetUsd: number | undefined;
  let workflowVariant: WorkflowVariant | undefined;
  let creativeStyle: CreativeStyle | undefined;
  let live = false;
  let act = false;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--context") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --context");
      contextFiles.push(value);
      continue;
    }
    if (arg === "--allow-read") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --allow-read");
      allowedReadPaths.push(value);
      continue;
    }
    if (arg === "--model") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --model");
      model = value;
      continue;
    }
    if (arg === "--budget") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --budget");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--budget must be a positive number");
      budgetUsd = parsed;
      continue;
    }
    if (arg === "--creative") {
      if (workflow !== "writing")
        throw new Error("--creative is only available for the writing workflow.");
      workflowVariant = "creative";
      continue;
    }
    if (arg === "--style") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --style");
      if (!isCreativeStyle(value))
        throw new Error("--style must be one of: vivid, tight, literary, plain");
      creativeStyle = value;
      continue;
    }
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--act") {
      if (workflow !== "coding")
        throw new Error("--act is only available for the coding workflow.");
      act = true;
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    taskParts.push(arg ?? "");
  }

  const task = taskParts.join(" ").trim();
  if (!task) throw new Error(workflow === "writing" ? "Usage: forge write \"<task>\"" : "Usage: forge \"<task>\"");
  if (creativeStyle && workflowVariant !== "creative")
    throw new Error("--style is only available with --creative.");
  if (workflowVariant === "creative" && !creativeStyle)
    throw new Error("--creative requires --style <vivid|tight|literary|plain>.");
  return {
    kind: "run",
    workflow,
    workflowVariant,
    creativeStyle,
    task,
    contextFiles,
    ...(allowedReadPaths.length > 0 ? { allowedReadPaths } : {}),
    model,
    budgetUsd,
    live,
    act,
  };
}

function isCreativeStyle(value: string): value is CreativeStyle {
  return (
    value === "vivid" ||
    value === "tight" ||
    value === "literary" ||
    value === "plain"
  );
}
