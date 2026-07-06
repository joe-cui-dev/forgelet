import type { ModelMessage } from "../types.js";
import { parseObservation } from "./compaction.js";

export interface FactLedgerFileEntry {
  path: string;
  contentHash?: string;
  ranges: string[];
}

export interface FactLedger {
  files: FactLedgerFileEntry[];
  changedFiles: string[];
  commands: string[];
}

export function buildFactLedger(
  foldedMessages: ModelMessage[],
  previousLedger?: FactLedger,
): FactLedger {
  const files = new Map<string, FactLedgerFileEntry>();
  for (const file of previousLedger?.files ?? [])
    files.set(file.path, { ...file, ranges: [...file.ranges] });
  const changedFiles = new Set<string>(previousLedger?.changedFiles ?? []);
  const commands = [...(previousLedger?.commands ?? [])];

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
      const range = rangeText(metadata);
      if (range && !entry.ranges.includes(range)) entry.ranges.push(range);
      files.set(metadata.path, entry);
    }
    if (Array.isArray(metadata.changedFiles))
      for (const changedFile of metadata.changedFiles)
        if (typeof changedFile === "string") changedFiles.add(changedFile);
    if (typeof metadata.command === "string")
      commands.push(commandText(metadata));
  }

  return {
    files: [...files.values()],
    changedFiles: [...changedFiles],
    commands,
  };
}

export function renderFactLedger(ledger: FactLedger): string {
  if (
    ledger.files.length === 0 &&
    ledger.changedFiles.length === 0 &&
    ledger.commands.length === 0
  )
    return "Fact Ledger: (empty)";

  const lines: string[] = ["Fact Ledger:"];
  if (ledger.files.length > 0) {
    lines.push("Files read:");
    for (const file of ledger.files)
      lines.push(
        `- ${file.path}${file.contentHash ? ` (hash: ${file.contentHash})` : ""}: ${file.ranges.join("; ")}`,
      );
  }
  if (ledger.changedFiles.length > 0) {
    lines.push("Files changed:");
    for (const path of ledger.changedFiles) lines.push(`- ${path}`);
  }
  if (ledger.commands.length > 0) {
    lines.push("Commands run:");
    for (const command of ledger.commands) lines.push(`- ${command}`);
  }
  return lines.join("\n");
}

function commandText(metadata: Record<string, unknown>): string {
  const exitCode =
    typeof metadata.exitCode === "number" ? metadata.exitCode : "unknown";
  const duration =
    typeof metadata.durationMs === "number" ? `, ${metadata.durationMs}ms` : "";
  return `${metadata.command} (exit ${exitCode}${duration})`;
}

function rangeText(metadata: Record<string, unknown>): string | undefined {
  if (
    typeof metadata.returnedStartByte === "number" &&
    typeof metadata.returnedEndByte === "number"
  ) {
    const total =
      typeof metadata.totalBytes === "number" ? ` of ${metadata.totalBytes}` : "";
    return `byte range ${metadata.returnedStartByte}-${metadata.returnedEndByte}${total}`;
  }
  if (
    typeof metadata.returnedStartLine === "number" &&
    typeof metadata.returnedEndLine === "number"
  )
    return `line range ${metadata.returnedStartLine}-${metadata.returnedEndLine}`;
  return undefined;
}
