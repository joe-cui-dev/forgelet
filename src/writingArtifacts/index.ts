import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  CreativeStyle,
  TraceEvent,
  WorkflowVariant,
  WritingArtifact,
} from "../types.js";
import { listSessionTraceFiles, readTraceFile } from "../trace/index.js";

export type WritingArtifactStatus = "available" | "missing" | "untracked";
export type CatalogContentKind = WritingArtifact["contentKind"] | "unknown";

export interface WritingArtifactCatalog {
  path: ".forgelet/writing";
  entries: WritingArtifactCatalogEntry[];
}

export interface WritingArtifactCatalogEntry {
  path: string;
  status: WritingArtifactStatus;
  contentKind: CatalogContentKind;
  contentBytes: number;
  sessionId?: string;
  createdAt: string;
  task?: string;
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  projectSlug?: string;
  tracePath?: string;
}

export interface WritingArtifactSearchResult {
  path: ".forgelet/writing";
  query: string;
  entries: WritingArtifactSearchEntry[];
}

export interface WritingArtifactSearchEntry extends WritingArtifactCatalogEntry {
  snippet: string;
}

export async function readWritingArtifactCatalog(
  workspaceRoot: string,
): Promise<WritingArtifactCatalog> {
  const traced = await readTraceBackedEntries(workspaceRoot);
  const byPath = new Map(traced.map((entry) => [entry.path, entry]));

  for (const file of await listWritingArtifactFiles(workspaceRoot)) {
    const relativePath = workspaceRelative(workspaceRoot, file);
    const existing = byPath.get(relativePath);
    const stats = await stat(file);
    if (existing) {
      existing.status = "available";
      existing.contentBytes = existing.contentBytes || stats.size;
      continue;
    }
    byPath.set(relativePath, {
      path: relativePath,
      status: "untracked",
      contentKind: "unknown",
      contentBytes: stats.size,
      createdAt: stats.mtime.toISOString(),
    });
  }

  return {
    path: ".forgelet/writing",
    entries: [...byPath.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    ),
  };
}

export async function searchWritingArtifacts(
  workspaceRoot: string,
  input: { query: string; limit: number },
): Promise<WritingArtifactSearchResult> {
  const query = input.query.trim();
  if (!query) throw new Error("Writing Artifact Catalog search query is required.");
  const catalog = await readWritingArtifactCatalog(workspaceRoot);
  const matches: WritingArtifactSearchEntry[] = [];

  for (const entry of catalog.entries) {
    if (entry.status !== "missing") {
      const body = await readFile(join(workspaceRoot, entry.path), "utf8");
      const bodySnippet = findSnippet(body, query);
      if (bodySnippet) {
        matches.push({ ...entry, snippet: bodySnippet });
        continue;
      }
    }
    const metadata = searchableMetadata(entry);
    const metadataSnippet = findSnippet(metadata, query);
    if (metadataSnippet) {
      matches.push({ ...entry, snippet: snippetForEntry(entry, metadataSnippet) });
    }
  }

  return {
    path: catalog.path,
    query,
    entries: matches.slice(0, input.limit),
  };
}

async function readTraceBackedEntries(
  workspaceRoot: string,
): Promise<WritingArtifactCatalogEntry[]> {
  const entries: WritingArtifactCatalogEntry[] = [];
  for (const tracePath of await listSessionTraceFiles(workspaceRoot)) {
    let events: TraceEvent[];
    try {
      events = await readTraceFile(tracePath);
    } catch {
      continue;
    }
    const started = events.find((event) => event.type === "session_started");
    const task = events.find((event) => event.type === "user_task");
    for (const artifactEvent of events.filter(
      (event) => event.type === "writing_artifact",
    )) {
      const artifact = asWritingArtifact(artifactEvent.payload);
      if (!artifact) continue;
      entries.push({
        path: artifact.path,
        status: (await exists(join(workspaceRoot, artifact.path)))
          ? "available"
          : "missing",
        contentKind: artifact.contentKind,
        contentBytes: artifact.contentBytes,
        sessionId: artifactEvent.sessionId,
        createdAt: artifactEvent.ts,
        task: typeof task?.payload.task === "string" ? task.payload.task : undefined,
        workflowVariant: asWorkflowVariant(started?.payload.workflowVariant),
        creativeStyle: asCreativeStyle(started?.payload.creativeStyle),
        projectSlug:
          typeof started?.payload.projectSlug === "string"
            ? started.payload.projectSlug
            : undefined,
        tracePath: workspaceRelative(workspaceRoot, tracePath),
      });
    }
  }
  return entries;
}

async function listWritingArtifactFiles(workspaceRoot: string): Promise<string[]> {
  const writingDir = join(workspaceRoot, ".forgelet", "writing");
  try {
    const entries = await readdir(writingDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(writingDir, entry.name));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function readWritingArtifactContent(input: {
  workspaceRoot: string;
  entry: WritingArtifactCatalogEntry;
  full?: boolean;
}): Promise<{ body: string; truncated: boolean }> {
  const body = await readFile(join(input.workspaceRoot, input.entry.path), "utf8");
  if (input.full || body.length <= 4_000) return { body, truncated: false };
  return { body: body.slice(0, 4_000), truncated: true };
}

export async function findWritingArtifactEntry(input: {
  workspaceRoot: string;
  artifact: string;
}): Promise<WritingArtifactCatalogEntry> {
  const catalog = await readWritingArtifactCatalog(input.workspaceRoot);
  if (input.artifact.startsWith(".forgelet/writing/")) {
    const entry = catalog.entries.find((item) => item.path === input.artifact);
    if (entry) return entry;
    throw new Error(`Writing Artifact not found: ${input.artifact}`);
  }
  if (
    input.artifact.endsWith(".md") ||
    input.artifact.includes("/") ||
    input.artifact.includes("\\")
  )
    throw new Error(
      "Writing Artifact Catalog only previews files under .forgelet/writing/.",
    );
  const entry = catalog.entries.find((item) => item.sessionId === input.artifact);
  if (!entry)
    throw new Error(
      `Writing Artifact not found for Session id: ${input.artifact}`,
    );
  return entry;
}

function asWritingArtifact(
  value: Record<string, unknown>,
): WritingArtifact | undefined {
  if (
    typeof value.path !== "string" ||
    !value.path.startsWith(".forgelet/writing/") ||
    !value.path.endsWith(".md") ||
    !isWritingArtifactContentKind(value.contentKind) ||
    typeof value.contentBytes !== "number"
  )
    return undefined;
  return {
    path: value.path,
    contentKind: value.contentKind,
    contentBytes: value.contentBytes,
  };
}

function isWritingArtifactContentKind(
  value: unknown,
): value is WritingArtifact["contentKind"] {
  return value === "draft" || value === "revision" || value === "final";
}

function asWorkflowVariant(value: unknown): WorkflowVariant | undefined {
  return value === "creative" ? value : undefined;
}

function asCreativeStyle(value: unknown): CreativeStyle | undefined {
  return typeof value === "string" ? value : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function workspaceRelative(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path) || basename(path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function searchableMetadata(entry: WritingArtifactCatalogEntry): string {
  return [
    basename(entry.path),
    entry.sessionId,
    entry.contentKind,
    entry.creativeStyle,
    entry.task,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function findSnippet(text: string, query: string): string | undefined {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return undefined;
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + query.length + 24);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function snippetForEntry(
  entry: WritingArtifactCatalogEntry,
  snippet: string,
): string {
  if (entry.status === "missing") return "unavailable; artifact file is missing";
  return snippet;
}
