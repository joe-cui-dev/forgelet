import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "../harness.js";
import { listSessions } from "../../src/sessions/index.js";
import { showSession } from "../../src/sessions/index.js";
import { runAgent } from "../../src/agent/runAgent.js";

test("lists completed and incomplete project sessions from traces", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-sessions-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_completed.jsonl"),
    [
      JSON.stringify({ type: "session_started", ts: "2026-06-16T00:00:00.000Z", sessionId: "sess_completed", payload: { workflow: "coding", startedAt: "2026-06-16T00:00:00.000Z" } }),
      JSON.stringify({ type: "user_task", ts: "2026-06-16T00:00:00.000Z", sessionId: "sess_completed", payload: { task: "fix tests" } }),
      JSON.stringify({ type: "session_finished", ts: "2026-06-16T00:00:01.000Z", sessionId: "sess_completed", payload: { status: "completed" } })
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(sessionDir, "sess_incomplete.jsonl"),
    JSON.stringify({ type: "session_started", ts: "2026-06-16T00:01:00.000Z", sessionId: "sess_incomplete", payload: { workflow: "writing", startedAt: "2026-06-16T00:01:00.000Z" } }),
    "utf8"
  );

  const sessions = await listSessions(workspaceRoot);

  assert.deepEqual(
    sessions.map((session) => ({ id: session.id, workflow: session.workflow, status: session.status, task: session.task })),
    [
      { id: "sess_incomplete", workflow: "writing", status: "incomplete", task: "" },
      { id: "sess_completed", workflow: "coding", status: "completed", task: "fix tests" }
    ]
  );
});

test("shows a session summary from its trace events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-show-"));
  await writeFile(join(workspaceRoot, "draft.md"), "Please make this clearer.", "utf8");
  const result = await runAgent({
    workflow: "writing",
    task: "revise this",
    contextFiles: ["draft.md"],
    workspaceRoot
  });

  const session = await showSession(workspaceRoot, result.session.id);

  assert.equal(session.id, result.session.id);
  assert.equal(session.workflow, "writing");
  assert.equal(session.status, "completed");
  assert.equal(session.task, "revise this");
  assert.equal(session.contextAttachments.length, 1);
  assert.equal(session.contextAttachments[0]?.title, "draft.md");
  assert.equal(session.route?.model, "deepseek-v4-flash");
  assert.match(session.finalSummary, /no model turn was run/);
});
