import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ToolContext, ToolResult } from "../types.js";
import { listWorkspaceFiles, safeWorkspacePath } from "./workspacePaths.js";

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_EXCERPT_BYTES = 2_000;

export interface WorkspaceSummary {
  content: string;
  path: string;
  scopeConstrained: boolean;
  limits: {
    maxFiles: number;
    maxExcerptBytes: number;
    scannedFiles: number;
    totalFiles: number;
  };
  directories: string[];
  manifests: string[];
  configs: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  entrypointCandidates: string[];
  testConventions: string[];
  excerpts: WorkspaceSummaryExcerpt[];
  skippedDirectories: string[];
  truncated: boolean;
}

export interface WorkspaceSummaryExcerpt {
  path: string;
  returnedBytes: number;
  totalBytes: number;
  truncated: boolean;
  content: string;
}

export const summarizeWorkspace = async (
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> => {
  const requestedPath = optionalString(input, "path") ?? ".";
  const maxFiles = optionalPositiveInteger(input, "maxFiles") ?? DEFAULT_MAX_FILES;
  const maxExcerptBytes =
    optionalPositiveInteger(input, "maxExcerptBytes") ??
    DEFAULT_MAX_EXCERPT_BYTES;
  const root = await safeWorkspacePath(ctx.workspaceRoot, requestedPath);
  const listed = await listWorkspaceFiles(root, ctx.workspaceRoot, ctx.readScope);
  const files = listed.files.slice(0, maxFiles);
  const truncated = listed.files.length > files.length;
  const manifests = findManifestFiles(files);
  const packageJsonPath = manifests.find((file) => basename(file) === "package.json");
  const packageRoot = packageJsonPath ? dirname(packageJsonPath) : ".";
  const packageJson = packageJsonPath
    ? await readPackageJson(resolve(ctx.workspaceRoot, packageJsonPath))
    : undefined;
  const summary: WorkspaceSummary = {
    content: "",
    path: requestedPath,
    scopeConstrained: ctx.readScope !== undefined,
    limits: {
      maxFiles,
      maxExcerptBytes,
      scannedFiles: files.length,
      totalFiles: listed.files.length,
    },
    directories: listed.directories,
    manifests,
    configs: findConfigFiles(files),
    scripts: packageJson ? readPackageScripts(packageJson) : {},
    dependencies: packageJson ? readPackageDependencies(packageJson) : [],
    entrypointCandidates: findEntrypointCandidates(
      files,
      packageJson,
      packageRoot,
    ),
    testConventions: findTestConventions(files, listed.directories),
    excerpts: await readHighSignalExcerpts(
      ctx.workspaceRoot,
      files,
      packageJson,
      packageRoot,
      maxExcerptBytes,
    ),
    skippedDirectories: listed.skippedDirectories,
    truncated,
  };
  summary.content = renderWorkspaceSummary(summary);
  return {
    ok: true,
    summary: truncated
      ? "Summarized workspace with truncation."
      : "Summarized workspace.",
    data: summary,
  };
};

const findManifestFiles = (files: string[]): string[] =>
  files.filter((file) => {
    const name = basename(file);
    return (
      name === "package.json" ||
      name === "README.md" ||
      name === "package-lock.json" ||
      name === "pnpm-lock.yaml" ||
      name === "yarn.lock"
    );
  }).sort((left, right) => manifestOrder(left) - manifestOrder(right));

const manifestOrder = (path: string): number => {
  const name = basename(path);
  if (name === "package.json") return 0;
  if (name === "README.md") return 1;
  if (name === "package-lock.json") return 2;
  if (name === "pnpm-lock.yaml") return 3;
  if (name === "yarn.lock") return 4;
  return 5;
};

const findConfigFiles = (files: string[]): string[] =>
  files.filter((file) => {
    const name = basename(file);
    return (
      /^tsconfig.*\.json$/.test(name) ||
      /^(vite|jest|eslint|prettier|rollup|webpack)\.config\.[cm]?[jt]s$/.test(
        name,
      ) ||
      name === ".eslintrc" ||
      name === ".prettierrc"
    );
  });

const findEntrypointCandidates = (
  files: string[],
  packageJson: Record<string, unknown> | undefined,
  packageRoot = ".",
): string[] => {
  const candidates = new Set<string>();
  for (const path of [
    packageRelativePath(packageRoot, "src/cli/index.ts"),
    packageRelativePath(packageRoot, "src/index.ts"),
    packageRelativePath(packageRoot, "src/main.ts"),
  ]) {
    if (files.includes(path)) candidates.add(path);
  }
  if (packageJson) {
    const main = packageJson.main;
    const normalizedMain =
      typeof main === "string" ? packageRelativePath(packageRoot, main) : undefined;
    if (normalizedMain && files.includes(normalizedMain))
      candidates.add(normalizedMain);
    const bin = packageJson.bin;
    const normalizedBin =
      typeof bin === "string" ? packageRelativePath(packageRoot, bin) : undefined;
    if (normalizedBin && files.includes(normalizedBin))
      candidates.add(normalizedBin);
    else if (isRecord(bin)) {
      for (const value of Object.values(bin)) {
        const normalized =
          typeof value === "string"
            ? packageRelativePath(packageRoot, value)
            : undefined;
        if (normalized && files.includes(normalized))
          candidates.add(normalized);
      }
    }
  }
  return [...candidates].sort();
};

const findTestConventions = (files: string[], directories: string[]): string[] => {
  const conventions = new Set<string>();
  if (directories.some((directory) => directory === "tests/" || directory.startsWith("tests/")))
    conventions.add("tests/");
  if (directories.some((directory) => directory.endsWith("__tests__/")))
    conventions.add("__tests__/");
  if (files.some((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)))
    conventions.add("*.test.ts");
  return [...conventions].sort((left, right) => conventionOrder(left) - conventionOrder(right));
};

const conventionOrder = (value: string): number => {
  if (value === "tests/") return 0;
  if (value === "__tests__/") return 1;
  return 2;
};

const readPackageScripts = (
  packageJson: Record<string, unknown>,
): Record<string, string> => {
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  return Object.fromEntries(
    Object.entries(scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
};

const readPackageDependencies = (
  packageJson: Record<string, unknown>,
): string[] => {
  const dependencies = new Set<string>();
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const section = packageJson[key];
    if (!isRecord(section)) continue;
    for (const dependency of Object.keys(section)) dependencies.add(dependency);
  }
  return [...dependencies].sort();
};

const renderWorkspaceSummary = (summary: WorkspaceSummary): string => {
  const truncatedExcerptPaths = summary.excerpts
    .filter((excerpt) => excerpt.truncated)
    .map((excerpt) => excerpt.path);
  const sections = [
    "# Workspace",
    `- Path: ${summary.path}`,
    summary.scopeConstrained ? "- Session Read Scope: constrained" : "- Session Read Scope: full workspace",
    "",
    "## Scripts and dependencies",
    formatList("Scripts", Object.keys(summary.scripts)),
    formatList("Dependencies", summary.dependencies),
    "",
    "## Directory shape",
    ...formatBullets(summary.directories),
    "",
    "## Entrypoint candidates",
    ...formatBullets(summary.entrypointCandidates),
    "",
    "## Tests",
    ...formatBullets(summary.testConventions),
    "",
    "## High-signal excerpts",
    ...formatExcerpts(summary.excerpts),
  ];
  if (
    summary.truncated ||
    summary.scopeConstrained ||
    summary.skippedDirectories.length > 0 ||
    truncatedExcerptPaths.length > 0
  ) {
    sections.push(
      "",
      "## Limits",
      `- Effective path: ${summary.path}`,
      `- Files scanned: ${summary.limits.scannedFiles} of ${summary.limits.totalFiles}`,
      `- Max files: ${summary.limits.maxFiles}`,
      `- Max excerpt bytes: ${summary.limits.maxExcerptBytes}`,
      `- Scope constrained: ${summary.scopeConstrained ? "yes" : "no"}`,
      formatList("Skipped directories", summary.skippedDirectories),
      formatList("Truncated excerpts", truncatedExcerptPaths),
      `- Truncated: ${summary.truncated ? "yes" : "no"}`,
    );
  }
  return sections.join("\n");
};

const readHighSignalExcerpts = async (
  workspaceRoot: string,
  files: string[],
  packageJson: Record<string, unknown> | undefined,
  packageRoot: string,
  maxExcerptBytes: number,
): Promise<WorkspaceSummaryExcerpt[]> => {
  const candidates = excerptCandidates(files, packageJson, packageRoot).slice(0, 5);
  const excerpts: WorkspaceSummaryExcerpt[] = [];
  for (const path of candidates) {
    const buffer = await readTextBuffer(resolve(workspaceRoot, path));
    if (!buffer) continue;
    const returned = buffer.subarray(0, maxExcerptBytes);
    excerpts.push({
      path,
      returnedBytes: returned.length,
      totalBytes: buffer.length,
      truncated: returned.length < buffer.length,
      content: returned.toString("utf8"),
    });
  }
  return excerpts;
};

const excerptCandidates = (
  files: string[],
  packageJson: Record<string, unknown> | undefined,
  packageRoot = ".",
): string[] => {
  const candidates = new Set<string>();
  addFirstMatching(candidates, files, (file) =>
    ["README.md", "CONTEXT.md", "AGENTS.md"].includes(basename(file)),
  );
  if (files.includes("package.json")) candidates.add("package.json");
  addFirstMatching(candidates, files, (file) => /^tsconfig.*\.json$/.test(basename(file)));
  for (const entrypoint of findEntrypointCandidates(files, packageJson, packageRoot)) {
    candidates.add(entrypoint);
  }
  addFirstMatching(candidates, files, (file) =>
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file),
  );
  return [...candidates];
};

const addFirstMatching = (
  candidates: Set<string>,
  files: string[],
  predicate: (file: string) => boolean,
): void => {
  const match = files.find(predicate);
  if (match) candidates.add(match);
};

const readTextBuffer = async (path: string): Promise<Buffer | undefined> => {
  try {
    const buffer = await readFile(path);
    if (buffer.includes(0)) return undefined;
    return buffer;
  } catch {
    return undefined;
  }
};

const formatExcerpts = (excerpts: WorkspaceSummaryExcerpt[]): string[] => {
  if (excerpts.length === 0) return ["- none"];
  return excerpts.flatMap((excerpt) => [
    `### ${excerpt.path}`,
    `- Bytes: ${excerpt.returnedBytes} of ${excerpt.totalBytes}`,
    `- Truncated: ${excerpt.truncated ? "yes" : "no"}`,
    "```",
    excerpt.content,
    "```",
  ]);
};

const formatList = (label: string, values: string[]): string =>
  values.length > 0 ? `- ${label}: ${values.join(", ")}` : `- ${label}: none`;

const formatBullets = (values: string[]): string[] =>
  values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];

const readPackageJson = async (
  path: string,
): Promise<Record<string, unknown> | undefined> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const packageRelativePath = (packageRoot: string, path: string): string => {
  const stripped = path.replace(/^\.\//, "");
  return packageRoot === "." ? stripped : `${packageRoot}/${stripped}`;
};

const optionalString = (input: unknown, key: string): string | undefined => {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
};

const optionalPositiveInteger = (
  input: unknown,
  key: string,
): number | undefined => {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error(`Invalid positive integer input: ${key}`);
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
