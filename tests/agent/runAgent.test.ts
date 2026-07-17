import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";
import { runWritingSession } from "../../src/workflows/writing.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import {
  createWritingProject,
  loadWritingProject,
  saveWritingProject,
} from "../../src/writingProjects/index.js";
import { writeStylePresetsFixture } from "../testSupport/stylePresets.js";

test("creates a project session trace for a coding workflow", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-run-"));

  const result = await runCodingSession({
    task: "fix tests",
    contextFiles: [],
    model: "deepseek-v4-pro",
    budgetUsd: 0.25,
    workspaceRoot
  });

  expect(result.session.task).toBe("fix tests");
  expect(result.session.workflow).toBe("coding");
  expect(result.session.stage).toBe("final");
  expect(result.summary).toMatch(/Forgelet session created/);
  expect(result.summary).toMatch(/Workflow: coding/);
  expect(result.summary).toMatch(/Trace:/);

  const traceDir = join(workspaceRoot, ".forgelet", "sessions");
  const traceFiles = await readdir(traceDir);
  expect(traceFiles.length).toBe(1);

  const trace = await readFile(join(traceDir, traceFiles[0] ?? ""), "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual(["session_started", "user_task", "routing_selected", "plan_update", "final_summary", "session_finished"]);
  expect(events[0].sessionId).toBe(result.session.id);
  expect(events[0].payload.workflow).toBe("coding");
  expect(events[2].payload.model).toBe("deepseek-v4-pro");
});

test("records context attachment evidence without storing full content in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-context-"));
  const contextContent = `# Issue\n${"revise this paragraph for clarity. ".repeat(20)}`;
  await writeFile(join(workspaceRoot, "issue.md"), contextContent, "utf8");

  const result = await runCodingSession({
    task: "implement issue",
    contextFiles: ["issue.md"],
    workspaceRoot
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  const attachmentEvent = events.find((event) => event.type === "context_attachment");

  expect(attachmentEvent).toBeTruthy();
  expect(attachmentEvent.payload.title).toBe("issue.md");
  expect(attachmentEvent.payload.mimeType).toBe("text/markdown");
  expect(attachmentEvent.payload.contentBytes).toBe(Buffer.byteLength(contextContent, "utf8"));
  expect(String(attachmentEvent.payload.contentHash)).toMatch(/^[a-f0-9]{64}$/);
  expect("content" in attachmentEvent.payload).toBe(false);
  expect(attachmentEvent.payload.preview).not.toBe(contextContent);
  expect(result.summary).toMatch(/Context attachments: issue.md/);
});

test("selects the built-in model route when project config tries to override defaults", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-routing-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ routing: { writing: { default: "local-writing-model" } } }),
    "utf8"
  );

  const result = await runWritingSession({
    task: "revise this",
    contextFiles: [],
    workspaceRoot
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  const routing = events.find((event) => event.type === "routing_selected");
  expect(routing.payload.model).toBe("deepseek-v4-flash");
  expect(result.summary).toMatch(/Route: deepseek-v4-flash/);
});

test("records creative writing variant metadata in the Session trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-creative-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  await writeFile(join(workspaceRoot, "draft.md"), "The room was cold.\n", "utf8");

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    task: "revise this scene",
    contextFiles: ["draft.md"],
    workspaceRoot
  });

  expect(result.session.workflow).toBe("writing");
  expect(result.session.workflowVariant).toBe("creative");
  expect(result.session.creativeStyle).toBe("vivid");
  expect(result.summary).toMatch(/Workflow variant: creative/);
  expect(result.summary).toMatch(/Creative style: vivid/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "session_started");
  expect(started.payload).toMatchObject({
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid"
  });
  expect(started.payload).not.toHaveProperty("stylePreset");
  expect(started.payload).not.toHaveProperty("stylePresetDefinition");
  expect(started.payload).not.toHaveProperty("creativeStylePreset");
});

test("keeps scoped read tools available for creative Writing Project continuation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-tools-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Chapter one body.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nChapter two body.", toolCalls: [] },
  ]);

  await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    task: "write chapter two",
    contextFiles: [],
    continuationFile: ".forgelet/writing/chapter-1.md",
    project: {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      members: [".forgelet/writing/chapter-1.md"],
      head: ".forgelet/writing/chapter-1.md",
    },
    workspaceRoot,
    modelClient,
  });

  const toolNames = modelClient.turnInputs[0]?.tools.map((tool) => tool.name);
  expect(toolNames).toEqual(
    expect.arrayContaining(["read_file", "list_files", "update_plan"]),
  );
  expect(toolNames).not.toEqual(
    expect.arrayContaining(["apply_patch", "run_command"]),
  );
});

test("keeps prompt-only creative writing runs tool-free outside Writing Projects", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-creative-tools-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nA quiet opening.", toolCalls: [] },
  ]);

  await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "draft",
    task: "write an opening",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs[0]?.tools).toEqual([]);
});

test("narrows Writing Project read scope to project members", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-scope-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Chapter one.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-2.md"),
    "Chapter two.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nChapter three.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    task: "write chapter three",
    contextFiles: [],
    continuationFile: ".forgelet/writing/chapter-2.md",
    project: {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      members: [
        ".forgelet/writing/chapter-1.md",
        ".forgelet/writing/chapter-2.md",
      ],
      head: ".forgelet/writing/chapter-2.md",
    },
    workspaceRoot,
    modelClient,
  });

  expect(result.session.readScope).toEqual([
    ".forgelet/writing/chapter-1.md",
    ".forgelet/writing/chapter-2.md",
  ]);
  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  expect(events[0].payload.readScope).toEqual(result.session.readScope);
});

test("denies workspace reads when a Writing Project has no readable members", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-empty-project-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  await writeFile(join(workspaceRoot, "secret.txt"), "repo secret\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "secret.txt" } },
      ],
    },
    { content: "Draft\n\nChapter one.", toolCalls: [] },
  ]);

  await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    task: "write chapter one",
    contextFiles: [],
    project: {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      members: [],
      head: null,
    },
    projectReadScopeMembers: [],
    workspaceRoot,
    modelClient,
  });

  const toolNames = modelClient.turnInputs[0]?.tools.map((tool) => tool.name);
  expect(toolNames).not.toEqual(
    expect.arrayContaining(["read_file", "list_files", "search_text"]),
  );
  const laterTurns = JSON.stringify(modelClient.turnInputs.slice(1));
  expect(laterTurns).not.toContain("repo secret");
});

test("includes a Writing Project member list in the model prompt", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-prompt-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Chapter one.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-2.md"),
    "Chapter two.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nChapter three.", toolCalls: [] },
  ]);

  await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    task: "write chapter three",
    contextFiles: [],
    continuationFile: ".forgelet/writing/chapter-2.md",
    project: {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      members: [
        ".forgelet/writing/chapter-1.md",
        ".forgelet/writing/chapter-2.md",
      ],
      head: ".forgelet/writing/chapter-2.md",
    },
    workspaceRoot,
    modelClient,
  });

  const prompt = modelClient.turnInputs[0]?.messages
    .map((message) => message.content)
    .join("\n");
  expect(prompt).toMatch(/Writing Project: my-novel/);
  expect(prompt).toMatch(/\.forgelet\/writing\/chapter-1\.md/);
  expect(prompt).toMatch(/\.forgelet\/writing\/chapter-2\.md \(head\)/);
});

test("records Writing Project slug in session_started trace metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-trace-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Chapter one.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nChapter two.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    task: "write chapter two",
    contextFiles: [],
    continuationFile: ".forgelet/writing/chapter-1.md",
    project: {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      members: [".forgelet/writing/chapter-1.md"],
      head: ".forgelet/writing/chapter-1.md",
    },
    workspaceRoot,
    modelClient,
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "session_started");
  expect(started.payload.projectSlug).toBe("my-novel");
  expect(started.payload).not.toHaveProperty("project");
  expect(started.payload).not.toHaveProperty("members");
});

test("updates Writing Project manifest and trace when project writing creates an artifact", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-update-"));
  await writeStylePresetsFixture(workspaceRoot, ["vivid"]);
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Chapter one.\n",
    "utf8",
  );
  const project = await createWritingProject(workspaceRoot, "my-novel");
  await saveWritingProject(workspaceRoot, {
    ...project,
    head: ".forgelet/writing/chapter-1.md",
    members: [".forgelet/writing/chapter-1.md"],
  });
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nChapter two.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    task: "write chapter two",
    contextFiles: [],
    continuationFile: ".forgelet/writing/chapter-1.md",
    project: await loadWritingProject(workspaceRoot, "my-novel"),
    workspaceRoot,
    modelClient,
  });

  const updated = await loadWritingProject(workspaceRoot, "my-novel");
  expect(updated.members).toEqual([
    ".forgelet/writing/chapter-1.md",
    result.writingArtifact?.path,
  ]);
  expect(updated.head).toBe(result.writingArtifact?.path);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  const projectUpdated = events.find(
    (event) => event.type === "writing_project_updated",
  );
  expect(projectUpdated.payload).toEqual({
    slug: "my-novel",
    memberAdded: result.writingArtifact?.path,
    headBefore: ".forgelet/writing/chapter-1.md",
    headAfter: result.writingArtifact?.path,
  });
});
