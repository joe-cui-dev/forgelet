import type { ModelMessage } from "../types.js";
import {
  formatObservationRange,
  mergeObservationRanges,
  observationRangeFromMetadata,
  parseObservation,
  type ObservationRange,
} from "../observation/index.js";
import {
  byteLengthUtf8,
  FACT_LEDGER_BUDGET_RATIO,
  subBudgetBytes,
} from "./budget.js";

export interface FactLedgerFileEntry {
  path: string;
  contentHash?: string;
  ranges: ObservationRange[];
}

export interface FactLedger {
  files: FactLedgerFileEntry[];
  changedFiles: string[];
  commands: FactLedgerCommandEntry[];
}

export interface FactLedgerCommandEntry {
  command: string;
  exitCode: number | "unknown";
  durationMs?: number;
  runs: number;
}

export interface RenderFactLedgerOptions {
  maxConversationBytes?: number;
}

export function buildFactLedger(
  foldedMessages: ModelMessage[],
  previousLedger?: FactLedger,
): FactLedger {
  const files = new Map<string, FactLedgerFileEntry>();
  for (const file of previousLedger?.files ?? [])
    files.set(file.path, { ...file, ranges: [...file.ranges] });
  const changedFiles = new Set<string>(previousLedger?.changedFiles ?? []);
  const commands = new Map<string, FactLedgerCommandEntry>();
  for (const command of previousLedger?.commands ?? [])
    commands.set(command.command, { ...command });

  for (const message of foldedMessages) {
    if (message.role !== "tool") continue;
    const parsed = parseObservation(message.content);
    if (!parsed) continue;
    const metadata = parsed.metadata ?? {};
    if (typeof metadata.path === "string" && metadata.path) {
      const entry = files.get(metadata.path) ?? {
        path: metadata.path,
        ranges: [],
      };
      if (typeof metadata.contentHash === "string")
        entry.contentHash = metadata.contentHash;
      const range = observationRangeFromMetadata(metadata);
      if (range) entry.ranges = mergeObservationRanges([...entry.ranges, range]);
      files.set(metadata.path, entry);
    }
    if (Array.isArray(metadata.changedFiles))
      for (const changedFile of metadata.changedFiles)
        if (typeof changedFile === "string") changedFiles.add(changedFile);
    if (typeof metadata.command === "string") {
      const previous = commands.get(metadata.command);
      commands.delete(metadata.command);
      commands.set(metadata.command, commandEntry(metadata, previous));
    }
  }

  return {
    files: [...files.values()],
    changedFiles: [...changedFiles],
    commands: [...commands.values()],
  };
}

export function renderFactLedger(
  ledger: FactLedger,
  options: RenderFactLedgerOptions = {},
): string {
  if (
    ledger.files.length === 0 &&
    ledger.changedFiles.length === 0 &&
    ledger.commands.length === 0
  )
    return "Fact Ledger: (empty)";

  const maxBytes =
    options.maxConversationBytes === undefined
      ? undefined
      : subBudgetBytes(options.maxConversationBytes, FACT_LEDGER_BUDGET_RATIO);
  let commandStart = 0;
  let fileStart = 0;
  let evictedCommands = 0;
  let evictedFiles = 0;
  let rendered = renderLedgerLines(ledger, commandStart, fileStart, {
    evictedCommands,
    evictedFiles,
  });

  while (maxBytes !== undefined && byteLengthUtf8(rendered) > maxBytes) {
    if (commandStart < ledger.commands.length) {
      commandStart += 1;
      evictedCommands += 1;
    } else if (fileStart < ledger.files.length) {
      fileStart += 1;
      evictedFiles += 1;
    } else break;
    rendered = renderLedgerLines(ledger, commandStart, fileStart, {
      evictedCommands,
      evictedFiles,
    });
  }
  return rendered;
}

function renderLedgerLines(
  ledger: FactLedger,
  commandStart: number,
  fileStart: number,
  evictions: { evictedCommands: number; evictedFiles: number },
): string {
  const files = ledger.files.slice(fileStart);
  const commands = ledger.commands.slice(commandStart);
  const lines: string[] = ["Fact Ledger:"];
  if (files.length > 0) {
    lines.push("Files read:");
    for (const file of files)
      lines.push(
        `- ${file.path}${file.contentHash ? ` (hash: ${file.contentHash})` : ""}: ${file.ranges.map(formatObservationRange).join("; ")}`,
      );
  }
  if (ledger.changedFiles.length > 0) {
    lines.push("Files changed:");
    for (const path of ledger.changedFiles) lines.push(`- ${path}`);
  }
  if (commands.length > 0) {
    lines.push("Commands run:");
    for (const command of commands) lines.push(`- ${commandText(command)}`);
  }
  if (evictions.evictedCommands > 0 || evictions.evictedFiles > 0)
    lines.push(
      `Ledger truncated: evicted ${entryCount(evictions.evictedCommands, "command")} and ${entryCount(evictions.evictedFiles, "file-read")}; see Trace for full evidence.`,
    );
  return lines.join("\n");
}

function entryCount(count: number, label: string): string {
  return `${count} ${label} ${count === 1 ? "entry" : "entries"}`;
}

function commandEntry(
  metadata: Record<string, unknown>,
  previous?: FactLedgerCommandEntry,
): FactLedgerCommandEntry {
  const exitCode =
    typeof metadata.exitCode === "number" ? metadata.exitCode : "unknown";
  return {
    command: String(metadata.command),
    exitCode,
    durationMs:
      typeof metadata.durationMs === "number" ? metadata.durationMs : undefined,
    runs: (previous?.runs ?? 0) + 1,
  };
}

function commandText(command: FactLedgerCommandEntry): string {
  if (command.runs > 1)
    return `${command.command} (exit ${command.exitCode}, ${command.runs} runs)`;
  const duration =
    typeof command.durationMs === "number" ? `, ${command.durationMs}ms` : "";
  return `${command.command} (exit ${command.exitCode}${duration})`;
}
