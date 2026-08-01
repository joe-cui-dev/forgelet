import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

// Session-internal state rather than workspace content: `.git` is Git's own
// object store, and `.forgelet` holds this Session's Trace beside the Trace of
// every Session before it. The write side has always classified both as
// `internal`; this is the same boundary named once so the read side can share
// it.
export const INTERNAL_WORKSPACE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".forgelet",
]);

export const isInternalWorkspacePath = (workspacePath: string): boolean => {
  if (isAbsolute(workspacePath)) return false;
  const [firstSegment] = normalize(workspacePath).split(sep);
  return (
    firstSegment !== undefined &&
    INTERNAL_WORKSPACE_DIRECTORY_NAMES.has(firstSegment)
  );
};

// The one way into an internal directory: a Session Read Scope entry that names
// a path inside it. `--allow-read .forgelet/sessions` still works, so inspecting
// a Trace stays possible and stays the user's explicit decision rather than
// something a Session grants itself mid-loop.
export const isInternalPathGrantedByReadScope = async (
  workspaceRoot: string,
  path: string,
  readScope: string[] | undefined,
): Promise<boolean> => {
  const internalEntries = readScope?.filter(isInternalWorkspacePath);
  if (!internalEntries || internalEntries.length === 0) return false;
  return isPathInSessionReadScope(workspaceRoot, path, internalEntries);
};

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
