import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runAgent } from "../../src/agent/runAgent.js";

test("creates a project session trace for a coding workflow", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-run-"));

  const result = await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "writing",
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
  await writeFile(join(workspaceRoot, "draft.md"), "The room was cold.\n", "utf8");

  const result = await runAgent({
    workflow: "writing",
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
