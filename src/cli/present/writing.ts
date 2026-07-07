import {
  type WritingArtifactCatalog,
  type WritingArtifactCatalogEntry,
  type WritingArtifactSearchResult,
} from "../../writingArtifacts/index.js";
import {
  WRITING_PROJECTS_DIR,
  type WritingProjectManifest,
} from "../../writingProjects/index.js";

export function formatWritingArtifactCatalog(catalog: WritingArtifactCatalog): string {
  const untracked = catalog.entries.filter(
    (entry) => entry.status === "untracked",
  ).length;
  if (catalog.entries.length === 0)
    return [
      "Writing Artifact Catalog",
      `Path: ${catalog.path}`,
      "Artifacts: 0",
      "Untracked: 0",
    ].join("\n");
  return [
    "Writing Artifact Catalog",
    `Path: ${catalog.path}`,
    `Artifacts: ${catalog.entries.length}`,
    `Untracked: ${untracked}`,
    "",
    ...catalog.entries.flatMap((entry, index) => [
      `${index + 1}. ${entry.path.replace(/^\.forgelet\/writing\//, "")}`,
      `   Status: ${entry.status}`,
      `   Kind: ${entry.contentKind}`,
      ...(entry.projectSlug ? [`   Project: ${entry.projectSlug}`] : []),
      `   Session: ${entry.sessionId ?? "none"}`,
      `   Created: ${entry.createdAt}`,
      ...(entry.task ? [`   Task: ${entry.task}`] : []),
      `   Bytes: ${entry.contentBytes}`,
      `   Continue: ${formatWritingArtifactContinueHint(entry)}`,
      "",
    ]),
  ].join("\n").trimEnd();
}

export function formatCreatedWritingProject(project: WritingProjectManifest): string {
  return [
    "Writing Project created",
    `Slug: ${project.slug}`,
    `Manifest: ${WRITING_PROJECTS_DIR}/${project.slug}.json`,
  ].join("\n");
}

export function formatWritingArtifactSearch(search: WritingArtifactSearchResult): string {
  return [
    "Writing Artifact Catalog Search",
    `Path: ${search.path}`,
    `Query: ${search.query}`,
    `Results: ${search.entries.length}`,
    ...search.entries.flatMap((entry, index) => [
      "",
      `${index + 1}. ${entry.path.replace(/^\.forgelet\/writing\//, "")}`,
      `   Status: ${entry.status}`,
      `   Kind: ${entry.contentKind}`,
      ...(entry.projectSlug ? [`   Project: ${entry.projectSlug}`] : []),
      `   Session: ${entry.sessionId ?? "none"}`,
      `   Created: ${entry.createdAt}`,
      ...(entry.task ? [`   Task: ${entry.task}`] : []),
      `   Snippet: ${entry.snippet}`,
      `   Continue: ${formatWritingArtifactContinueHint(entry)}`,
    ]),
  ].join("\n");
}

export function formatWritingArtifactContinueHint(
  entry: WritingArtifactCatalogEntry,
): string {
  if (entry.status === "missing")
    return "unavailable; artifact file is missing";
  const style = entry.creativeStyle ?? "<style>";
  return `forge write --creative --style ${style} --continue ${entry.path} "<brief>"`;
}

export function formatWritingArtifactDetail(input: {
  entry: WritingArtifactCatalogEntry;
  body: string;
  truncated: boolean;
}): string {
  const entry = input.entry;
  return [
    "Writing Artifact",
    `Path: ${entry.path}`,
    `Status: ${entry.status}`,
    `Kind: ${entry.contentKind}`,
    `Session: ${entry.sessionId ?? "none"}`,
    `Created: ${entry.createdAt}`,
    ...(entry.task ? [`Task: ${entry.task}`] : []),
    `Bytes: ${entry.contentBytes}`,
    `Trace: ${entry.tracePath ?? "none"}`,
    `Continue: ${formatWritingArtifactContinueHint(entry)}`,
    "",
    "Preview:",
    input.body,
    ...(input.truncated ? ["[truncated]"] : []),
  ].join("\n");
}
