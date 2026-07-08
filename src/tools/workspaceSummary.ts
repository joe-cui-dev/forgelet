import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
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
  anchorFiles: string[];
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
  const realWorkspaceRoot = await realpath(ctx.workspaceRoot);
  const root = await safeWorkspacePath(ctx.workspaceRoot, requestedPath);
  const listed = await listWorkspaceFiles(root, ctx.workspaceRoot, ctx.readScope);
  // Truncated slice bounds the unbounded inventories (configs, test conventions); anchor
  // files are detected on the full scope-filtered listing and unioned in beyond the slice.
  const files = listed.files.slice(0, maxFiles);
  const truncated = listed.files.length > files.length;
  const scanRoot = relative(realWorkspaceRoot, root);
  const anchorFiles = selectAnchorFiles(listed.files, scanRoot);
  const anchorsBeyondSlice = anchorFiles.filter((file) => !files.includes(file));
  const packageJsonPath = anchorFiles.find(
    (file) => basename(file) === "package.json",
  );
  const packageRoot = packageJsonPath ? dirname(packageJsonPath) : ".";
  const packageJson = packageJsonPath
    ? await readPackageJson(resolve(ctx.workspaceRoot, packageJsonPath))
    : undefined;
  // Entrypoint verification runs on the full listing so an anchored package.json whose
  // main/bin points past the slice still resolves to a real, listed file.
  const entrypointCandidates = findEntrypointCandidates(
    listed.files,
    packageJson,
    packageRoot,
  );
  const summary: WorkspaceSummary = {
    content: "",
    path: requestedPath,
    scopeConstrained: ctx.readScope !== undefined,
    limits: {
      maxFiles,
      maxExcerptBytes,
      scannedFiles: files.length + anchorsBeyondSlice.length,
      totalFiles: listed.files.length,
    },
    directories: listed.directories,
    anchorFiles,
    configs: findConfigFiles(files),
    scripts: packageJson ? readPackageScripts(packageJson) : {},
    dependencies: packageJson ? readPackageDependencies(packageJson) : [],
    entrypointCandidates,
    testConventions: findTestConventions(files, listed.directories),
    excerpts: await readHighSignalExcerpts(
      ctx.workspaceRoot,
      excerptCandidates(anchorFiles, entrypointCandidates, files),
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

// Anchor Files (see CONTEXT.md): the fixed high-signal set located directly at the summary's
// effective scan root, listed in canonical order.
export const ANCHOR_FILE_NAMES = [
  "package.json",
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
] as const;

// Selects the scan-root Anchor Files from a scope-filtered listing. `scanRoot` is the
// workspace-relative scan root ("" or "." for the workspace root). Matching is
// case-insensitive; if multiple casings coexist on a case-sensitive filesystem the
// byte-order-smallest path wins, keeping detection deterministic. Only direct children of
// the scan root qualify — nested same-named files are never Anchor Files.
export const selectAnchorFiles = (files: string[], scanRoot: string): string[] => {
  const rootDir = scanRoot === "" || scanRoot === "." ? "." : scanRoot;
  const best = new Map<string, string>();
  for (const file of files) {
    if (dirname(file) !== rootDir) continue;
    const lowerName = basename(file).toLowerCase();
    const anchor = ANCHOR_FILE_NAMES.find((name) => name.toLowerCase() === lowerName);
    if (!anchor) continue;
    const existing = best.get(anchor);
    if (existing === undefined || file < existing) best.set(anchor, file);
  }
  return ANCHOR_FILE_NAMES.map((name) => best.get(name)).filter(
    (file): file is string => file !== undefined,
  );
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
    formatList("Anchor Files", summary.anchorFiles),
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
  const anchorsBeyondMaxFiles = Math.max(
    0,
    summary.limits.scannedFiles - summary.limits.maxFiles,
  );
  if (
    summary.truncated ||
    summary.scopeConstrained ||
    summary.skippedDirectories.length > 0 ||
    truncatedExcerptPaths.length > 0 ||
    anchorsBeyondMaxFiles > 0
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
    if (anchorsBeyondMaxFiles > 0)
      sections.push(
        `- Anchor files scanned beyond max files: ${anchorsBeyondMaxFiles}`,
      );
  }
  return sections.join("\n");
};

const readHighSignalExcerpts = async (
  workspaceRoot: string,
  candidates: string[],
  maxExcerptBytes: number,
): Promise<WorkspaceSummaryExcerpt[]> => {
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

// Builds the ordered excerpt candidate list within a fixed budget of 5: every detected
// Anchor File first, then the single remaining non-anchor slot filled by priority
// entrypoint > test sample > tsconfig. Configs and test conventions already have their own
// rendered sections, so the test/tsconfig samples are drawn from the truncated slice.
const excerptCandidates = (
  anchorFiles: string[],
  entrypointCandidates: string[],
  sliceFiles: string[],
): string[] => {
  const candidates: string[] = [];
  const add = (path: string | undefined): void => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };
  for (const anchor of anchorFiles) add(anchor);
  for (const entrypoint of entrypointCandidates) add(entrypoint);
  add(sliceFiles.find((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)));
  add(sliceFiles.find((file) => /^tsconfig.*\.json$/.test(basename(file))));
  return candidates.slice(0, 5);
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
