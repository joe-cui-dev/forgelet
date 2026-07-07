import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WRITING_PROJECTS_DIR = ".forgelet/writing/projects";

export interface WritingProjectManifest {
  slug: string;
  title?: string;
  createdAt: string;
  head: string | null;
  members: string[];
}

export interface ApplyWritingProjectArtifactResult {
  manifest: WritingProjectManifest;
  memberAdded: string;
  headBefore: string | null;
  headAfter: string | null;
}

export function applyArtifactToProject(
  manifest: WritingProjectManifest,
  input: { artifactPath: string; continuationSource: string | null },
): ApplyWritingProjectArtifactResult {
  const headBefore = manifest.head;
  const shouldAdvanceHead =
    manifest.head === null || input.continuationSource === manifest.head;
  const nextManifest: WritingProjectManifest = {
    ...manifest,
    members: [...manifest.members, input.artifactPath],
    head: shouldAdvanceHead ? input.artifactPath : manifest.head,
  };
  return {
    manifest: nextManifest,
    memberAdded: input.artifactPath,
    headBefore,
    headAfter: nextManifest.head,
  };
}

export async function createWritingProject(
  workspaceRoot: string,
  slug: string,
): Promise<WritingProjectManifest> {
  assertValidWritingProjectSlug(slug);
  const manifest: WritingProjectManifest = {
    slug,
    createdAt: new Date().toISOString(),
    head: null,
    members: [],
  };
  const projectsDir = join(workspaceRoot, WRITING_PROJECTS_DIR);
  await mkdir(projectsDir, { recursive: true });
  try {
    await writeFile(
      join(projectsDir, `${slug}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST")
      throw new Error(`Writing Project already exists: ${slug}`);
    throw error;
  }
  return manifest;
}

export async function loadWritingProject(
  workspaceRoot: string,
  slug: string,
): Promise<WritingProjectManifest> {
  assertValidWritingProjectSlug(slug);
  const path = manifestPath(workspaceRoot, slug);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      throw new Error(
        `Unknown Writing Project: ${slug}\n${await formatExistingProjects(workspaceRoot)}`,
      );
    throw error;
  }
  return parseWritingProjectManifest(path, content);
}

export async function saveWritingProject(
  workspaceRoot: string,
  manifest: WritingProjectManifest,
): Promise<void> {
  assertValidWritingProjectSlug(manifest.slug);
  parseWritingProjectManifest(
    manifestPath(workspaceRoot, manifest.slug),
    JSON.stringify(manifest),
  );
  await mkdir(join(workspaceRoot, WRITING_PROJECTS_DIR), { recursive: true });
  await writeFile(
    manifestPath(workspaceRoot, manifest.slug),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export interface PrepareWritingProjectRunInput {
  workspaceRoot: string;
  project?: WritingProjectManifest;
  continuationFile?: string;
  allowedReadPaths?: string[];
}

export interface PrepareWritingProjectRunResult {
  readScopeMembers: string[];
  warnings: string[];
  continuationFile?: string;
}

export async function prepareWritingProjectRun(
  input: PrepareWritingProjectRunInput,
): Promise<PrepareWritingProjectRunResult> {
  if (input.project && input.allowedReadPaths && input.allowedReadPaths.length > 0)
    throw new Error(
      "--project cannot be combined with --allow-read; the Writing Project manifest defines the Session Read Scope.",
    );

  const readScopeMembers: string[] = [];
  const warnings: string[] = [];
  if (input.project) {
    for (const member of input.project.members) {
      if (await pathExists(join(input.workspaceRoot, member))) {
        readScopeMembers.push(member);
        continue;
      }
      if (member === input.project.head)
        throw new Error(
          `Writing Project head is missing: ${member}. Edit ${WRITING_PROJECTS_DIR}/${input.project.slug}.json or restore the artifact before continuing.`,
        );
      warnings.push(
        `Warning: Writing Project member is missing and was excluded from this Session Read Scope: ${member}`,
      );
    }
  }

  const continuationFile = resolveProjectContinuationFile({
    project: input.project,
    continuationFile: input.continuationFile,
  });

  return { readScopeMembers, warnings, continuationFile };
}

function resolveProjectContinuationFile(input: {
  project?: WritingProjectManifest;
  continuationFile?: string;
}): string | undefined {
  if (!input.project) return input.continuationFile;
  if (input.continuationFile) {
    if (!input.project.members.includes(input.continuationFile))
      throw new Error(
        [
          `--continue artifact is not a member of Writing Project ${input.project.slug}: ${input.continuationFile}`,
          "Remove --project to continue it directly, or edit .forgelet/writing/projects/" +
            `${input.project.slug}.json to add the member.`,
        ].join("\n"),
      );
    return input.continuationFile;
  }
  return input.project.head ?? undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function formatExistingProjects(workspaceRoot: string): Promise<string> {
  const slugs = await listWritingProjectSlugs(workspaceRoot);
  if (slugs.length === 0)
    return "No Writing Projects exist yet. Create one with: forge write projects create <slug>";
  return `Existing projects: ${slugs.join(", ")}`;
}

async function listWritingProjectSlugs(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(workspaceRoot, WRITING_PROJECTS_DIR), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function manifestPath(workspaceRoot: string, slug: string): string {
  return join(workspaceRoot, WRITING_PROJECTS_DIR, `${slug}.json`);
}

function parseWritingProjectManifest(
  path: string,
  content: string,
): WritingProjectManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse ${path}: ${message}`);
  }
  if (!isRecord(parsed))
    throw new Error(`${path} must contain a Writing Project manifest object.`);
  if (typeof parsed.slug !== "string")
    throw new Error(`${path} slug must be a string.`);
  if (typeof parsed.createdAt !== "string")
    throw new Error(`${path} createdAt must be a string.`);
  if (parsed.head !== null && typeof parsed.head !== "string")
    throw new Error(`${path} head must be a string or null.`);
  if (!Array.isArray(parsed.members))
    throw new Error(`${path} members must be an array.`);

  const members = parsed.members.map((member) => {
    if (typeof member !== "string")
      throw new Error(`${path} member must be a string.`);
    if (!member.startsWith(".forgelet/writing/"))
      throw new Error(
        `${path} member must start with .forgelet/writing/: ${member}`,
      );
    if (!member.endsWith(".md"))
      throw new Error(`${path} member must end with .md: ${member}`);
    return member;
  });
  if (parsed.head !== null && !members.includes(parsed.head))
    throw new Error(`${path} head must be one of members: ${parsed.head}`);

  return {
    slug: parsed.slug,
    title: typeof parsed.title === "string" ? parsed.title : undefined,
    createdAt: parsed.createdAt,
    head: parsed.head,
    members,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidWritingProjectSlug(slug: string): void {
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return;
  throw new Error(
    `Writing Project slug must use lowercase kebab-case: ${slug}`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
