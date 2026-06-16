import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "../harness.js";
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

  assert.equal(result.session.task, "fix tests");
  assert.equal(result.session.workflow, "coding");
  assert.equal(result.session.stage, "final");
  assert.match(result.summary, /Forgelet session created/);
  assert.match(result.summary, /Workflow: coding/);
  assert.match(result.summary, /Trace:/);

  const traceDir = join(workspaceRoot, ".forgelet", "sessions");
  const traceFiles = await readdir(traceDir);
  assert.equal(traceFiles.length, 1);

  const trace = await readFile(join(traceDir, traceFiles[0] ?? ""), "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["session_started", "user_task", "routing_selected", "plan_update", "final_summary", "session_finished"]);
  assert.equal(events[0].sessionId, result.session.id);
  assert.equal(events[0].payload.workflow, "coding");
  assert.equal(events[2].payload.model, "deepseek-v4-pro");
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

  assert.ok(attachmentEvent);
  assert.equal(attachmentEvent.payload.title, "issue.md");
  assert.equal(attachmentEvent.payload.mimeType, "text/markdown");
  assert.equal(attachmentEvent.payload.contentBytes, Buffer.byteLength(contextContent, "utf8"));
  assert.match(String(attachmentEvent.payload.contentHash), /^[a-f0-9]{64}$/);
  assert.equal("content" in attachmentEvent.payload, false);
  assert.notEqual(attachmentEvent.payload.preview, contextContent);
  assert.match(result.summary, /Context attachments: issue.md/);
});

test("selects the model route from project config when no CLI override is given", async () => {
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
  assert.equal(routing.payload.model, "local-writing-model");
  assert.match(result.summary, /Route: local-writing-model/);
});
