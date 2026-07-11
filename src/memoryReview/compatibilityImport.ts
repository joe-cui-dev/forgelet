import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../config/index.js";
import { withMemoryDecisionLock } from "./lock.js";
import {
  MEMORY_DECISIONS_RELATIVE_PATH,
  foldDecisionLog,
  readDecisionLogRecords,
  readSuggestionRecords,
  singleLinePreview,
  type DecisionLogRecord,
  type MemoryDecisionRecord,
  type SuggestionRecord,
} from "./records.js";

export interface CompatibilityImportOptions {
  now?: () => Date;
}

/** Runs the Compatibility Import before the first memory operation: recoverable
 * legacy accepted/rejected status becomes append-only Memory Decision evidence,
 * and an observed existing legacy accepted block becomes a found-existing
 * Memory Write Record. Validates everything before appending anything, never
 * rewrites the suggestions file, and never invents historical timestamps. */
export async function ensureCompatibilityImport(
  workspaceRoot: string,
  options: CompatibilityImportOptions = {},
): Promise<void> {
  const suggestions = await readSuggestionRecords(workspaceRoot);
  if (!suggestions.some(hasLegacyDecision)) return;

  await withMemoryDecisionLock(workspaceRoot, async () => {
    const records = await readSuggestionRecords(workspaceRoot);
    const { firstDecisionById, writtenIds } = foldDecisionLog(
      await readDecisionLogRecords(workspaceRoot),
    );

    const importedAt = (options.now?.() ?? new Date()).toISOString();
    const appends: DecisionLogRecord[] = [];
    for (const record of records) {
      if (!hasLegacyDecision(record)) continue;
      if (firstDecisionById.has(record.id)) continue;
      const imported: MemoryDecisionRecord = {
        type: "decision",
        suggestionId: record.id,
        decision: record.legacyStatus,
        sourceSessionId: record.sourceSessionId,
        textHash: createHash("sha256").update(record.text).digest("hex"),
        textPreview: singleLinePreview(record.text),
        origin: "legacy-status",
        importedAt,
      };
      firstDecisionById.set(record.id, imported);
      appends.push(imported);
      // The old block is looked for only at the moment its legacy status is
      // imported. Afterwards the log alone is authority: a block appearing
      // later never closes a Memory Write Gap — idempotent re-accept does.
      if (imported.decision === "accepted" && !writtenIds.has(record.id)) {
        const observed = await observeExistingBlock(workspaceRoot, record.id);
        if (observed) {
          writtenIds.add(record.id);
          appends.push({
            type: "write-record",
            suggestionId: record.id,
            origin: "found-existing",
            path: observed.path,
            blockHash: observed.blockHash,
            blockBytes: observed.blockBytes,
            observedAt: importedAt,
          });
        }
      }
    }

    if (appends.length === 0) return;
    await appendFile(
      join(workspaceRoot, MEMORY_DECISIONS_RELATIVE_PATH),
      appends.map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );
  });
}

function hasLegacyDecision(
  record: SuggestionRecord,
): record is SuggestionRecord & { legacyStatus: "accepted" | "rejected" } {
  return record.legacyStatus === "accepted" || record.legacyStatus === "rejected";
}

interface ObservedBlock {
  path: string;
  blockHash: string;
  blockBytes: number;
}

/** Looks for the exact legacy `## <suggestionId>` heading in the currently
 * configured Durable Memory target. A present-day observation only: the block
 * bytes are hashed as found, and no historical write time is claimed. */
async function observeExistingBlock(
  workspaceRoot: string,
  suggestionId: string,
): Promise<ObservedBlock | undefined> {
  const config = await loadConfig({ workspaceRoot });
  const memoryPath = isAbsolute(config.memoryFile)
    ? config.memoryFile
    : join(workspaceRoot, config.memoryFile);
  let content: string;
  try {
    content = await readFile(memoryPath, "utf8");
  } catch {
    return undefined;
  }
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line === `## ${suggestionId}`);
  if (headingIndex === -1) return undefined;
  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      endIndex = index;
      break;
    }
  }
  const block =
    endIndex === lines.length
      ? lines.slice(headingIndex).join("\n")
      : lines.slice(headingIndex, endIndex).join("\n") + "\n";
  return {
    path: config.memoryFile,
    blockHash: createHash("sha256").update(block).digest("hex"),
    blockBytes: Buffer.byteLength(block, "utf8"),
  };
}
