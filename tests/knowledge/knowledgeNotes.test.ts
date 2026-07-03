import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@jest/globals";
import {
  createKnowledgeNote,
  searchKnowledgeNotes,
} from "../../src/knowledge/index.js";

test("creates a project Knowledge Note from a completed source-backed Learning Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-knowledge-"));
  await writeLearningTrace(workspaceRoot, "sess_learn", [
    event("session_started", "sess_learn", {
      workflow: "learning",
      startedAt: "2026-07-03T00:00:00.000Z",
    }),
    event("user_task", "sess_learn", { task: "Teach Me Core Ideas" }),
    event("context_attachment", "sess_learn", {
      id: "ctx_1",
      source: "file",
      title: "paper.md",
      uri: "fixtures/learning/paper.md",
      mimeType: "text/markdown",
      contentBytes: 2048,
      contentHash: createHash("sha256").update("paper").digest("hex"),
      preview: "Paper preview",
      trustLevel: "workspace",
    }),
    event("final_summary", "sess_learn", {
      summary: "## Summary\nCore ideas.\n\n## Key Concepts\n- Workflow graph design",
    }),
    event("session_finished", "sess_learn", { status: "completed" }),
  ]);

  const result = await createKnowledgeNote(workspaceRoot, {
    scope: "project",
    fromSessionId: "sess_learn",
    createdAt: "2026-07-03T01:02:03.000Z",
  });

  expect(result.path).toBe(
    ".forgelet/knowledge/teach-me-core-ideas-sess_learn.md",
  );
  expect(result.sourceSessionId).toBe("sess_learn");
  expect(result.sourceCount).toBe(1);
  expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);

  const note = await readFile(join(workspaceRoot, result.path), "utf8");
  expect(note).toContain("type: knowledge-note");
  expect(note).toContain("scope: project");
  expect(note).toContain("title: Teach Me Core Ideas");
  expect(note).toContain("sourceSessionId: sess_learn");
  expect(note).toContain("sourceWorkflow: learning");
  expect(note).toContain("createdAt: 2026-07-03T01:02:03.000Z");
  expect(note).toContain("uri: fixtures/learning/paper.md");
  expect(note).toContain("# Teach Me Core Ideas\n\n## Summary");
  expect(note).toContain("## Key Concepts\n- Workflow graph design");
});

test("does not overwrite an existing Knowledge Note for the same Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-knowledge-"));
  await writeLearningTrace(workspaceRoot, "sess_learn", [
    event("session_started", "sess_learn", {
      workflow: "learning",
      startedAt: "2026-07-03T00:00:00.000Z",
    }),
    event("user_task", "sess_learn", { task: "Teach Me Core Ideas" }),
    event("context_attachment", "sess_learn", {
      id: "ctx_1",
      source: "file",
      title: "paper.md",
      uri: "paper.md",
      mimeType: "text/markdown",
      contentBytes: 128,
      contentHash: createHash("sha256").update("paper").digest("hex"),
      preview: "Paper preview",
      trustLevel: "workspace",
    }),
    event("final_summary", "sess_learn", { summary: "## Summary\nCore ideas." }),
    event("session_finished", "sess_learn", { status: "completed" }),
  ]);
  const first = await createKnowledgeNote(workspaceRoot, {
    scope: "project",
    fromSessionId: "sess_learn",
    createdAt: "2026-07-03T01:02:03.000Z",
  });
  const firstContent = await readFile(join(workspaceRoot, first.path), "utf8");

  await expect(
    createKnowledgeNote(workspaceRoot, {
      scope: "project",
      fromSessionId: "sess_learn",
      title: "Replacement Title",
      createdAt: "2026-07-04T01:02:03.000Z",
    }),
  ).rejects.toThrow(
    /Knowledge Note already exists: \.forgelet\/knowledge\/teach-me-core-ideas-sess_learn\.md/,
  );
  await expect(readFile(join(workspaceRoot, first.path), "utf8")).resolves.toBe(
    firstContent,
  );
});

test("custom title overrides frontmatter and the Markdown H1 without changing the note path", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-knowledge-"));
  await writeLearningTrace(workspaceRoot, "sess_learn", [
    event("session_started", "sess_learn", {
      workflow: "learning",
      startedAt: "2026-07-03T00:00:00.000Z",
    }),
    event("user_task", "sess_learn", { task: "Teach Me Core Ideas" }),
    event("context_attachment", "sess_learn", {
      id: "ctx_1",
      source: "file",
      title: "paper.md",
      uri: "paper.md",
      mimeType: "text/markdown",
      contentBytes: 128,
      contentHash: createHash("sha256").update("paper").digest("hex"),
      preview: "Paper preview",
      trustLevel: "workspace",
    }),
    event("final_summary", "sess_learn", {
      summary: "# Original Learning Pack\n\n## Summary\nCore ideas.",
    }),
    event("session_finished", "sess_learn", { status: "completed" }),
  ]);

  const result = await createKnowledgeNote(workspaceRoot, {
    scope: "project",
    fromSessionId: "sess_learn",
    title: "Custom Title",
    createdAt: "2026-07-03T01:02:03.000Z",
  });

  expect(result.path).toBe(
    ".forgelet/knowledge/teach-me-core-ideas-sess_learn.md",
  );
  const note = await readFile(join(workspaceRoot, result.path), "utf8");
  expect(note).toContain("title: Custom Title");
  expect(note).toContain("# Custom Title\n\n## Summary");
  expect(note).not.toContain("# Original Learning Pack");
});

test("searches project Knowledge Notes with case-insensitive matching, ordering, and limit", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-knowledge-"));
  await writeLearningTrace(workspaceRoot, "sess_old", [
    event("session_started", "sess_old", { workflow: "learning" }),
    event("user_task", "sess_old", { task: "Old Workflow Notes" }),
    sourceAttachmentEvent("sess_old", "workflow-old.md"),
    event("final_summary", "sess_old", {
      summary: "## Summary\nWorkflow graph design appears here.",
    }),
    event("session_finished", "sess_old", { status: "completed" }),
  ]);
  await writeLearningTrace(workspaceRoot, "sess_new", [
    event("session_started", "sess_new", { workflow: "learning" }),
    event("user_task", "sess_new", { task: "New Workflow Notes" }),
    sourceAttachmentEvent("sess_new", "workflow-new.md"),
    event("final_summary", "sess_new", {
      summary: "## Summary\nA newer note about workflow graph design.",
    }),
    event("session_finished", "sess_new", { status: "completed" }),
  ]);
  await createKnowledgeNote(workspaceRoot, {
    scope: "project",
    fromSessionId: "sess_old",
    createdAt: "2026-07-03T01:00:00.000Z",
  });
  await createKnowledgeNote(workspaceRoot, {
    scope: "project",
    fromSessionId: "sess_new",
    createdAt: "2026-07-03T02:00:00.000Z",
  });

  const result = await searchKnowledgeNotes(workspaceRoot, {
    scope: "project",
    query: "WORKFLOW GRAPH",
    limit: 1,
  });

  expect(result.path).toBe(".forgelet/knowledge");
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toEqual(
    expect.objectContaining({
      title: "New Workflow Notes",
      path: ".forgelet/knowledge/new-workflow-notes-sess_new.md",
      sourceSessionId: "sess_new",
    }),
  );
  expect(result.results[0]?.snippet.toLowerCase()).toContain("workflow graph");
});

test("rejects ineligible source Sessions for Knowledge Note creation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-knowledge-"));
  await writeLearningTrace(workspaceRoot, "sess_writing", [
    event("session_started", "sess_writing", { workflow: "writing" }),
    event("user_task", "sess_writing", { task: "Revise this" }),
    sourceAttachmentEvent("sess_writing", "draft.md"),
    event("final_summary", "sess_writing", { summary: "Revision" }),
    event("session_finished", "sess_writing", { status: "completed" }),
  ]);
  await writeLearningTrace(workspaceRoot, "sess_sourceless", [
    event("session_started", "sess_sourceless", { workflow: "learning" }),
    event("user_task", "sess_sourceless", { task: "Teach me" }),
    event("final_summary", "sess_sourceless", { summary: "## Summary\nNo source." }),
    event("session_finished", "sess_sourceless", { status: "completed" }),
  ]);
  await writeLearningTrace(workspaceRoot, "sess_failed", [
    event("session_started", "sess_failed", { workflow: "learning" }),
    event("user_task", "sess_failed", { task: "Teach me" }),
    sourceAttachmentEvent("sess_failed", "paper.md"),
    event("final_summary", "sess_failed", { summary: "## Summary\nFailed." }),
    event("session_finished", "sess_failed", { status: "failed" }),
  ]);

  for (const sessionId of ["sess_writing", "sess_sourceless", "sess_failed"]) {
    await expect(
      createKnowledgeNote(workspaceRoot, {
        scope: "project",
        fromSessionId: sessionId,
      }),
    ).rejects.toThrow(
      /Knowledge Note creation requires a completed, source-backed Learning Session with a final summary/,
    );
  }
});

test("searching a missing project Knowledge Library returns no results", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-knowledge-"));

  await expect(
    searchKnowledgeNotes(workspaceRoot, {
      scope: "project",
      query: "workflow graph",
    }),
  ).resolves.toEqual({
    scope: "project",
    path: ".forgelet/knowledge",
    query: "workflow graph",
    results: [],
  });
});

async function writeLearningTrace(
  workspaceRoot: string,
  sessionId: string,
  events: unknown[],
): Promise<void> {
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    events.map((entry) => JSON.stringify(entry)).join("\n"),
    "utf8",
  );
}

function sourceAttachmentEvent(sessionId: string, uri: string): Record<string, unknown> {
  return event("context_attachment", sessionId, {
    id: "ctx_1",
    source: "file",
    title: uri,
    uri,
    mimeType: "text/markdown",
    contentBytes: 128,
    contentHash: createHash("sha256").update(uri).digest("hex"),
    preview: "Paper preview",
    trustLevel: "workspace",
  });
}

function event(
  type: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type,
    ts: "2026-07-03T00:00:00.000Z",
    sessionId,
    payload,
  };
}
