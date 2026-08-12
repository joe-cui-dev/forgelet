import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ContextAttachment } from "../types.js";
import { findSessionTracePath, isTraceEvent, readTraceFile, type TraceEvent } from "../trace/index.js";

export type KnowledgeScope = "project";

export interface CreateKnowledgeNoteInput {
  scope: KnowledgeScope;
  fromSessionId: string;
  title?: string;
  createdAt?: string;
}

export interface CreatedKnowledgeNote {
  path: string;
  sourceSessionId: string;
  sourceCount: number;
  contentHash: string;
}

/** Promotes a whole Page Conversation into a single Knowledge Note (ADR 0077).
 * Unlike a Session-derived note, the same conversation is expected to grow as
 * the user asks more follow-ups, so a re-save overwrites the earlier note in
 * place — but only when the earlier note has not been edited by hand. */
export interface CreateConversationKnowledgeNoteInput {
  scope: KnowledgeScope;
  conversationId: string;
  rootSessionId: string;
  headSessionId: string;
  title: string;
  /** The already-rendered Markdown body (without the leading H1 title). */
  body: string;
  sources: ContextAttachment[];
  createdAt?: string;
}

/** Raised when a re-save would clobber a Knowledge Note that a human has since
 * edited by hand (ADR 0077, decision 10). Nothing is written. The typed reason
 * lets the Native Host and Side Panel present the recovery path without parsing
 * a free-text message. */
export class KnowledgeNoteConflictError extends Error {
  readonly reason = "note_conflict" as const;
  readonly existingPath: string;
  constructor(existingPath: string) {
    super(
      `Knowledge Note has local edits and will not be overwritten: ${existingPath}. Rename or remove it, then save again.`,
    );
    this.name = "KnowledgeNoteConflictError";
    this.existingPath = existingPath;
  }
}

export interface SearchKnowledgeNotesInput {
  scope: KnowledgeScope;
  query: string;
  limit?: number;
}

export interface KnowledgeNoteSearchResult {
  title: string;
  path: string;
  sourceSessionId: string;
  snippet: string;
  createdAt?: string;
}

export interface KnowledgeNoteSearch {
  scope: KnowledgeScope;
  path: string;
  query: string;
  results: KnowledgeNoteSearchResult[];
}

export async function createKnowledgeNote(
  workspaceRoot: string,
  input: CreateKnowledgeNoteInput,
): Promise<CreatedKnowledgeNote> {
  const events = (await readTraceFile(
    await findSessionTracePath(workspaceRoot, input.fromSessionId),
  )).filter(isTraceEvent);
  const source = sourceLearningSession(events, input.fromSessionId);
  const hasTitleOverride = Boolean(input.title?.trim());
  const title = input.title?.trim() || titleFromTask(source.task);
  const body = renderKnowledgeNoteBody(title, source.summary, hasTitleOverride);
  const contentHash = hash(body);
  const content = renderKnowledgeNote({
    title,
    sourceSessionId: input.fromSessionId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    contentHash,
    sources: source.attachments,
    body,
  });

  const noteDir = join(workspaceRoot, ".forgelet", "knowledge");
  await mkdir(noteDir, { recursive: true });
  const notePath = join(
    noteDir,
    `${slugForFilename(source.task)}-${input.fromSessionId}.md`,
  );
  const handle = await openExclusive(workspaceRoot, notePath);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }

  return {
    path: relative(workspaceRoot, notePath),
    sourceSessionId: input.fromSessionId,
    sourceCount: source.attachments.length,
    contentHash,
  };
}

export async function createConversationKnowledgeNote(
  workspaceRoot: string,
  input: CreateConversationKnowledgeNoteInput,
): Promise<CreatedKnowledgeNote> {
  const title = input.title.trim() || "Knowledge Note";
  const body = renderKnowledgeNoteBody(title, input.body, false);
  const contentHash = hash(body);
  const content = renderKnowledgeNote({
    title,
    sourceSessionId: input.rootSessionId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    contentHash,
    sources: input.sources,
    body,
    conversationId: input.conversationId,
    rootSessionId: input.rootSessionId,
    headSessionId: input.headSessionId,
  });

  const noteDir = join(workspaceRoot, ".forgelet", "knowledge");
  await mkdir(noteDir, { recursive: true });

  // Locate by conversationId, never by file name: the title (and therefore the
  // file name) is editable, so only the frontmatter identifies the note.
  const existing = await locateNoteByConversationId(noteDir, input.conversationId);
  if (existing) {
    assertNoteUnedited(existing, workspaceRoot);
    await writeFileAtomically(existing.path, content);
    return {
      path: relative(workspaceRoot, existing.path),
      sourceSessionId: input.rootSessionId,
      sourceCount: input.sources.length,
      contentHash,
    };
  }

  const notePath = join(
    noteDir,
    `${slugForFilename(title)}-${input.rootSessionId}.md`,
  );
  const handle = await openExclusive(workspaceRoot, notePath);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return {
    path: relative(workspaceRoot, notePath),
    sourceSessionId: input.rootSessionId,
    sourceCount: input.sources.length,
    contentHash,
  };
}

export async function searchKnowledgeNotes(
  workspaceRoot: string,
  input: SearchKnowledgeNotesInput,
): Promise<KnowledgeNoteSearch> {
  const knowledgeDir = join(workspaceRoot, ".forgelet", "knowledge");
  const notePaths = await listMarkdownFiles(knowledgeDir);
  const query = input.query.toLowerCase();
  const matches: Array<KnowledgeNoteSearchResult & { sortTime: number }> = [];

  for (const notePath of notePaths) {
    const content = await readFile(notePath, "utf8");
    const matchIndex = content.toLowerCase().indexOf(query);
    if (matchIndex === -1) continue;
    const metadata = parseKnowledgeFrontmatter(content);
    const fileStat = await stat(notePath);
    matches.push({
      title: metadata.title || "(untitled)",
      path: relative(workspaceRoot, notePath),
      sourceSessionId: metadata.sourceSessionId || "",
      snippet: buildSnippet(content, matchIndex, input.query.length),
      createdAt: metadata.createdAt,
      sortTime: metadata.createdAt
        ? Date.parse(metadata.createdAt)
        : fileStat.mtimeMs,
    });
  }

  return {
    scope: input.scope,
    path: ".forgelet/knowledge",
    query: input.query,
    results: matches
      .sort((left, right) => right.sortTime - left.sortTime)
      .slice(0, input.limit ?? 10)
      .map(({ sortTime: _sortTime, ...result }) => result),
  };
}

function sourceLearningSession(events: TraceEvent[], sessionId: string): {
  task: string;
  summary: string;
  attachments: ContextAttachment[];
} {
  const started = events.find((event) => event.type === "session_started");
  const finished = events.find((event) => event.type === "session_finished");
  const finalSummary = events.find((event) => event.type === "final_summary");
  const task = events.find((event) => event.type === "user_task");
  const attachments = events
    .filter((event) => event.type === "context_attachment")
    .flatMap((event) =>
      isContextAttachment(event.payload) ? [event.payload] : [],
    );

  if (
    started?.payload.workflow !== "learning" ||
    finished?.payload.status !== "completed" ||
    typeof finalSummary?.payload.summary !== "string" ||
    finalSummary.payload.summary.trim().length === 0 ||
    attachments.length === 0
  ) {
    throw new Error(
      `Knowledge Note creation requires a completed, source-backed Learning Session with a final summary: ${sessionId}`,
    );
  }

  return {
    task: typeof task?.payload.task === "string" ? task.payload.task : sessionId,
    summary: knowledgeNoteBodyFromFinalSummary(finalSummary.payload),
    attachments,
  };
}

function knowledgeNoteBodyFromFinalSummary(
  payload: Record<string, unknown>,
): string {
  if (
    typeof payload.finalContent === "string" &&
    payload.finalContent.trim().length > 0
  )
    return payload.finalContent;

  const summary = typeof payload.summary === "string" ? payload.summary : "";
  return stripTerminalSummaryWrapper(summary);
}

function stripTerminalSummaryWrapper(summary: string): string {
  const firstLearningHeading = summary.search(
    /^##\s+(Summary|Key Concepts|Source Links|Open Questions|Review Prompts)\s*$/im,
  );
  const withoutHeader =
    firstLearningHeading >= 0 ? summary.slice(firstLearningHeading) : summary;
  return withoutHeader
    .replace(/\nTrace:\s+\S+\s*$/m, "")
    .trim();
}

function renderKnowledgeNote(input: {
  title: string;
  sourceSessionId: string;
  createdAt: string;
  contentHash: string;
  sources: ContextAttachment[];
  body: string;
  conversationId?: string;
  rootSessionId?: string;
  headSessionId?: string;
}): string {
  return [
    "---",
    "type: knowledge-note",
    "scope: project",
    `title: ${yamlScalar(input.title)}`,
    `sourceSessionId: ${yamlScalar(input.sourceSessionId)}`,
    ...(input.conversationId
      ? [`conversationId: ${yamlScalar(input.conversationId)}`]
      : []),
    ...(input.rootSessionId
      ? [`rootSessionId: ${yamlScalar(input.rootSessionId)}`]
      : []),
    ...(input.headSessionId
      ? [`headSessionId: ${yamlScalar(input.headSessionId)}`]
      : []),
    "sourceWorkflow: learning",
    `createdAt: ${yamlScalar(input.createdAt)}`,
    `contentHash: ${input.contentHash}`,
    "sources:",
    ...input.sources.flatMap((source) => [
      `  - source: ${yamlScalar(source.source)}`,
      ...(source.title ? [`    title: ${yamlScalar(source.title)}`] : []),
      ...(source.uri ? [`    uri: ${yamlScalar(source.uri)}`] : []),
      `    contentHash: ${yamlScalar(source.contentHash)}`,
      `    contentBytes: ${source.contentBytes}`,
      ...(source.trustLevel
        ? [`    trustLevel: ${yamlScalar(source.trustLevel)}`]
        : []),
    ]),
    "---",
    "",
    input.body,
  ].join("\n");
}

function renderKnowledgeNoteBody(
  title: string,
  summary: string,
  replaceExistingH1: boolean,
): string {
  const trimmed = ensureTrailingNewline(summary.trim());
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (/^#\s+\S/.test(firstLine)) {
    if (!replaceExistingH1) return trimmed;
    return ensureTrailingNewline(
      trimmed.replace(/^#\s+.*(?:\r?\n){1,2}/, `# ${title}\n\n`),
    );
  }
  return ensureTrailingNewline(`# ${title}\n\n${trimmed}`);
}

function titleFromTask(task: string): string {
  const trimmed = task.trim();
  return trimmed || "Knowledge Note";
}

function slugForFilename(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "knowledge-note";
}

async function openExclusive(workspaceRoot: string, path: string) {
  try {
    return await open(path, "wx");
  } catch (error) {
    if (hasErrorCode(error, "EEXIST"))
      throw new Error(
        `Knowledge Note already exists: ${relative(workspaceRoot, path)}`,
      );
    throw error;
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry.name);
        if (entry.isDirectory()) return listMarkdownFiles(path);
        return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
      }),
    );
    return nested.flat();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

function parseKnowledgeFrontmatter(content: string): {
  title?: string;
  sourceSessionId?: string;
  createdAt?: string;
  conversationId?: string;
  contentHash?: string;
} {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  const frontmatter = match?.[1] ?? "";
  return {
    title: readFrontmatterValue(frontmatter, "title"),
    sourceSessionId: readFrontmatterValue(frontmatter, "sourceSessionId"),
    createdAt: readFrontmatterValue(frontmatter, "createdAt"),
    conversationId: readFrontmatterValue(frontmatter, "conversationId"),
    contentHash: readFrontmatterValue(frontmatter, "contentHash"),
  };
}

async function locateNoteByConversationId(
  noteDir: string,
  conversationId: string,
): Promise<{ path: string; content: string } | undefined> {
  for (const path of await listMarkdownFiles(noteDir)) {
    const content = await readFile(path, "utf8");
    if (parseKnowledgeFrontmatter(content).conversationId === conversationId)
      return { path, content };
  }
  return undefined;
}

/** The hash guard behind the in-place overwrite (ADR 0077): the recorded
 * `contentHash` is over the note body alone, so recomputing it from the file on
 * disk reveals any hand edit. A mismatch (or a note predating the field) is
 * treated as edited and refused, protecting the human-facing Markdown the
 * original never-overwrite semantics existed to guard. */
function assertNoteUnedited(
  existing: { path: string; content: string },
  workspaceRoot: string,
): void {
  const recordedHash = parseKnowledgeFrontmatter(existing.content).contentHash;
  if (!recordedHash || recordedHash !== hash(extractNoteBody(existing.content)))
    throw new KnowledgeNoteConflictError(relative(workspaceRoot, existing.path));
}

function extractNoteBody(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (!match) return content;
  const rest = content.slice(match[0].length);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

function readFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const prefix = `${key}:`;
  const line = frontmatter
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length).trim().replace(/^"|"$/g, "");
}

function buildSnippet(content: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(content.length, matchIndex + queryLength + 40);
  const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < content.length ? "..." : ""}`;
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9 ._/:+-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function isContextAttachment(value: unknown): value is ContextAttachment {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.contentBytes === "number" &&
    typeof value.contentHash === "string" &&
    typeof value.preview === "string" &&
    typeof value.trustLevel === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
