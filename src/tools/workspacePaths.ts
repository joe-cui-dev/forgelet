import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import {
  doesPathOverlapSessionReadScope,
  isPathInSessionReadScope,
} from "../readScope/index.js";

export const SKIPPED_WORKSPACE_DIRECTORIES = new Set([
  ".git",
  ".forgelet",
  "node_modules",
  "dist",
  "dist-test",
]);

export interface ListedWorkspaceFiles {
  files: string[];
  directories: string[];
  skippedDirectories: string[];
}

// Resolves a path through realpath so symlinks cannot escape the workspace.
export const safeWorkspacePath = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const absolute = resolve(workspaceRoot, path);
  const [realWorkspaceRoot, realTarget] = await Promise.all([
    realpath(workspaceRoot),
    realpath(absolute),
  ]);
  const rel = relative(realWorkspaceRoot, realTarget);
  if (rel.startsWith(".."))
    throw new Error(`Path is outside workspace: ${path}`);
  return realTarget;
};

export interface WorkspacePathTarget {
  absolutePath: string;
  relativePath: string;
  isFile: boolean;
}

// Resolves a workspace-relative path to its real location and reports whether it names a
// file or a directory, so tools like search_text can accept either. Raises a clear,
// model-actionable error instead of a raw errno when the path does not exist.
export const resolveWorkspacePathTarget = async (
  workspaceRoot: string,
  path: string,
): Promise<WorkspacePathTarget> => {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  let absolutePath: string;
  try {
    absolutePath = await safeWorkspacePath(workspaceRoot, path);
  } catch (error) {
    if (isMissingPathError(error))
      throw new Error(`Path does not exist in workspace: ${path}`);
    throw error;
  }
  const stats = await stat(absolutePath);
  return {
    absolutePath,
    relativePath: relative(realWorkspaceRoot, absolutePath),
    isFile: stats.isFile(),
  };
};

const isMissingPathError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ((error as NodeJS.ErrnoException).code === "ENOENT" ||
    (error as NodeJS.ErrnoException).code === "ENOTDIR");

// Recursively lists workspace files while skipping generated and internal folders.
export const listWorkspaceFiles = async (
  root: string,
  workspaceRoot: string,
  readScope?: string[],
): Promise<ListedWorkspaceFiles> => {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const output: ListedWorkspaceFiles = {
    files: [],
    directories: [],
    skippedDirectories: [],
  };
  await collectWorkspaceFiles(root, workspaceRoot, realWorkspaceRoot, readScope, output);
  output.files.sort();
  output.directories.sort();
  output.skippedDirectories.sort();
  return {
    files: [...new Set(output.files)],
    directories: [...new Set(output.directories)],
    skippedDirectories: [...new Set(output.skippedDirectories)],
  };
};

// Returns UTF-8 text only for files that look safe and useful to search.
export const readTextIfSmall = async (
  path: string,
): Promise<string | undefined> => {
  const ext = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip"].includes(ext))
    return undefined;
  try {
    const buffer = await readFile(path);
    if (buffer.includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
};

const collectWorkspaceFiles = async (
  root: string,
  workspaceRoot: string,
  realWorkspaceRoot: string,
  readScope: string[] | undefined,
  output: ListedWorkspaceFiles,
): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(root, entry.name);
    const workspacePath = relative(realWorkspaceRoot, absolute);
    if (entry.isDirectory()) {
      if (SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) {
        output.skippedDirectories.push(`${workspacePath}/`);
        continue;
      }
      if (
        await doesPathOverlapSessionReadScope(
          workspaceRoot,
          absolute,
          readScope,
        )
      ) {
        output.directories.push(`${workspacePath}/`);
        await collectWorkspaceFiles(
          absolute,
          workspaceRoot,
          realWorkspaceRoot,
          readScope,
          output,
        );
      }
    } else if (
      entry.isFile() &&
      (await isPathInSessionReadScope(workspaceRoot, workspacePath, readScope))
    ) {
      output.files.push(workspacePath);
    }
  }
};
