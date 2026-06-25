import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

export const normalizeSessionReadScope = async (
  workspaceRoot: string,
  allowedReadPaths: string[] | undefined,
): Promise<string[] | undefined> => {
  if (!allowedReadPaths || allowedReadPaths.length === 0) return undefined;
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const normalized = await Promise.all(
    allowedReadPaths.map(async (path) => {
      if (isAbsolute(path))
        throw new Error("--allow-read paths must be workspace-relative.");
      const realTarget = await realpath(resolve(workspaceRoot, path));
      const workspacePath = relative(realWorkspaceRoot, realTarget);
      if (isOutside(workspacePath))
        throw new Error(`Read scope path is outside workspace: ${path}`);
      return workspacePath || ".";
    }),
  );
  return [...new Set(normalized)];
};

export const isPathInSessionReadScope = async (
  workspaceRoot: string,
  path: string,
  readScope: string[] | undefined,
): Promise<boolean> => {
  if (!readScope) return true;
  const realTarget = await canonicalizeCandidate(resolve(workspaceRoot, path));
  for (const entry of readScope) {
    const realEntry = await realpath(resolve(workspaceRoot, entry));
    const relativeToEntry = relative(realEntry, realTarget);
    if (relativeToEntry === "" || !isOutside(relativeToEntry)) return true;
  }
  return false;
};

export const doesPathOverlapSessionReadScope = async (
  workspaceRoot: string,
  path: string,
  readScope: string[] | undefined,
): Promise<boolean> => {
  if (!readScope) return true;
  const realTarget = await canonicalizeCandidate(resolve(workspaceRoot, path));
  for (const entry of readScope) {
    const realEntry = await realpath(resolve(workspaceRoot, entry));
    const entryFromTarget = relative(realTarget, realEntry);
    const targetFromEntry = relative(realEntry, realTarget);
    if (
      entryFromTarget === "" ||
      !isOutside(entryFromTarget) ||
      !isOutside(targetFromEntry)
    )
      return true;
  }
  return false;
};

const isOutside = (path: string): boolean =>
  path === ".." || path.startsWith("../") || resolve("/", path) === path;

const canonicalizeCandidate = async (path: string): Promise<string> => {
  const missingSegments: string[] = [];
  let candidate = path;
  for (;;) {
    try {
      const existingPath = await realpath(candidate);
      return resolve(existingPath, ...missingSegments);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;
