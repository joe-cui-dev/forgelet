import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig } from "../config/index.js";

export interface DurableMemoryDestination {
  /** The filesystem path Forgelet actually reads and writes. */
  absolutePath: string;
  /** Workspace-relative when inside the workspace, the absolute path otherwise. */
  displayPath: string;
}

/** Resolves the configured Durable Memory target the same way for `show`'s
 * preview and `accept`'s write, so the two can never name different files. */
export async function resolveDurableMemoryDestination(
  workspaceRoot: string,
): Promise<DurableMemoryDestination> {
  const configured = (await loadConfig({ workspaceRoot })).memoryFile;
  const absolutePath = isAbsolute(configured)
    ? configured
    : join(workspaceRoot, configured);
  const workspaceRelative = relative(workspaceRoot, absolutePath);
  const displayPath =
    workspaceRelative !== "" &&
    !workspaceRelative.startsWith("..") &&
    !isAbsolute(workspaceRelative)
      ? workspaceRelative
      : absolutePath;
  return { absolutePath, displayPath };
}

export interface ExistingMemoryBlock {
  blockHash: string;
  blockBytes: number;
}

/** Looks for the exact `## <suggestionId>` heading already present in Durable
 * Memory, so acceptance never appends a duplicate block during a repair. */
export async function findExistingMemoryBlock(
  absolutePath: string,
  suggestionId: string,
): Promise<ExistingMemoryBlock | undefined> {
  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
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
    blockHash: createHash("sha256").update(block).digest("hex"),
    blockBytes: Buffer.byteLength(block, "utf8"),
  };
}
