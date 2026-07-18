import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodingSession, resumeCodingSession } from "../../src/workflows/coding.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import { readPauseSnapshot } from "../../src/sessions/pauseSnapshot.js";
import { readPidMarker } from "../../src/sessions/pidMarker.js";
import { foldSessionTrace } from "../../src/sessions/index.js";
import { listPausedSessions } from "../../src/sessions/queue.js";
import { readTraceFile } from "../../src/trace/index.js";
import { readTypedTrace } from "../testSupport/trace.js";

function execGit(workspaceRoot: string, args: string[]): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args],
      { cwd: workspaceRoot },
      (error) => {
        if (error) rejectExec(error);
        else resolveExec();
      },
    );
  });
}

const newFilePatch = (path: string, content: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..7e4a5c3",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    `+${content}`,
  ].join("\n");

async function pauseOnOutOfEnvelopePatch(toolCalls: {
  id: string;
  patchPath: string;
  patchContent: string;
}[]) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-resume-"));
  await execGit(workspaceRoot, ["init"]);

  const modelClient = new FakeModelClient([
    {
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        name: "apply_patch",
        input: { patch: newFilePatch(call.patchPath, call.patchContent) },
      })),
    },
  ]);

  const result = await runCodingSession({
    task: "write docs",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    envelope: { writeScopePrefixes: ["src"], allowedCommands: [] },
  });

  return { workspaceRoot, result };
}

test("approve: resuming applies the pending patch and the session completes", async () => {
  const { workspaceRoot, result } = await pauseOnOutOfEnvelopePatch([
    { id: "call_notes", patchPath: "docs/notes.md", patchContent: "notes" },
  ]);

  const resumeModelClient = new FakeModelClient([
    { content: "Applied the notes.", toolCalls: [] },
  ]);
  const resumed = await resumeCodingSession({
    workspaceRoot,
    sessionId: result.session.id,
    modelClient: resumeModelClient,
    decision: { kind: "approve" },
  });

  expect(resumed.summary).toMatch(/Forgelet session completed/);
  await expect(readFile(join(workspaceRoot, "docs/notes.md"), "utf8")).resolves.toBe(
    "notes\n",
  );
  await expect(readPauseSnapshot(workspaceRoot, result.session.id)).rejects.toThrow();

  const events = await readTraceFile(resumed.tracePath);
  expect(events.some((event) => event.type === "session_resumed")).toBe(true);
  const approval = events.find(
    (event) =>
      event.type === "approval_decision" && event.payload.toolCallId === "call_notes",
  );
  expect(approval?.payload.status).toBe("approved");
  expect(approval?.payload.reason).toMatch(/forge decide/);
  expect(events.at(-1)?.type).toBe("session_finished");
  expect(events.at(-1)?.payload.status).toBe("completed");
});

test("approve: resuming a partially executed batch preserves every declared tool observation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-resume-partial-batch-"));
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "source.txt"), "source\n", "utf8");

  const initialModelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "source.txt" } },
        {
          id: "call_notes",
          name: "apply_patch",
          input: { patch: newFilePatch("docs/notes.md", "notes") },
        },
      ],
    },
  ]);
  const paused = await runCodingSession({
    task: "read source and write notes",
    contextFiles: [],
    workspaceRoot,
    modelClient: initialModelClient,
    act: true,
    envelope: { writeScopePrefixes: ["src"], allowedCommands: [] },
  });
  expect(paused.status).toBe("paused");

  const resumeModelClient = new FakeModelClient([
    { content: "Read source and wrote notes.", toolCalls: [] },
  ]);
  await resumeCodingSession({
    workspaceRoot,
    sessionId: paused.session.id,
    modelClient: resumeModelClient,
    decision: { kind: "approve" },
  });

  const toolMessages = resumeModelClient.turnInputs[0]?.messages.filter(
    (message) => message.role === "tool",
  );
  expect(toolMessages?.map((message) => message.toolCallId)).toEqual([
    "call_read",
    "call_notes",
  ]);
  const declaredToolCallIds = resumeModelClient.turnInputs[0]?.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.toolCalls?.map((toolCall) => toolCall.id) ?? []);
  expect(toolMessages?.map((message) => message.toolCallId)).toEqual(declaredToolCallIds);
});

test("deny: resuming denies the pending patch, the model is told, and the session continues", async () => {
  const { workspaceRoot, result } = await pauseOnOutOfEnvelopePatch([
    { id: "call_notes", patchPath: "docs/notes.md", patchContent: "notes" },
  ]);

  const resumeModelClient = new FakeModelClient([
    { content: "Understood, skipping that file.", toolCalls: [] },
  ]);
  const resumed = await resumeCodingSession({
    workspaceRoot,
    sessionId: result.session.id,
    modelClient: resumeModelClient,
    decision: { kind: "deny" },
  });

  await expect(readFile(join(workspaceRoot, "docs/notes.md"), "utf8")).rejects.toThrow();
  await expect(readPauseSnapshot(workspaceRoot, result.session.id)).rejects.toThrow();

  const toolMessages = resumeModelClient.turnInputs[0]?.messages.filter(
    (message) => message.role === "tool",
  );
  expect(toolMessages).toHaveLength(1);
  const observation = JSON.parse(toolMessages?.[0]?.content ?? "{}");
  expect(observation.ok).toBe(false);
  expect(observation.summary).toMatch(/Approval rejected/);

  const events = await readTraceFile(resumed.tracePath);
  const approval = events.find(
    (event) =>
      event.type === "approval_decision" && event.payload.toolCallId === "call_notes",
  );
  expect(approval?.payload.status).toBe("rejected");
  expect(approval?.payload.reason).toMatch(/Denied by user/);
  expect(events.at(-1)?.payload.status).toBe("completed");
});

test("widen: approve-and-widen amends the envelope and auto-approves a sibling out-of-scope write", async () => {
  const { workspaceRoot, result } = await pauseOnOutOfEnvelopePatch([
    { id: "call_notes", patchPath: "docs/notes.md", patchContent: "notes" },
    { id: "call_other", patchPath: "docs/other.md", patchContent: "other" },
  ]);

  const resumeModelClient = new FakeModelClient([
    { content: "Wrote both docs files.", toolCalls: [] },
  ]);
  const resumed = await resumeCodingSession({
    workspaceRoot,
    sessionId: result.session.id,
    modelClient: resumeModelClient,
    decision: { kind: "widen" },
  });

  await expect(readFile(join(workspaceRoot, "docs/notes.md"), "utf8")).resolves.toBe(
    "notes\n",
  );
  await expect(readFile(join(workspaceRoot, "docs/other.md"), "utf8")).resolves.toBe(
    "other\n",
  );
  await expect(readPauseSnapshot(workspaceRoot, result.session.id)).rejects.toThrow();

  const events = await readTraceFile(resumed.tracePath);
  const amendment = events.find((event) => event.type === "envelope_amended");
  expect(amendment).toBeDefined();
  expect(amendment?.payload.after).toEqual({
    writeScopePrefixes: ["src", "docs"],
    allowedCommands: [],
  });

  const pendingApproval = events.find(
    (event) =>
      event.type === "approval_decision" && event.payload.toolCallId === "call_notes",
  );
  expect(pendingApproval?.payload.reason).toMatch(/forge decide/);
  const siblingApproval = events.find(
    (event) =>
      event.type === "approval_decision" && event.payload.toolCallId === "call_other",
  );
  expect(siblingApproval?.payload.status).toBe("approved");
  expect(siblingApproval?.payload.reason).toMatch(/Effect Envelope/);
});

test("stop: resuming forces a wrap-up turn and finishes as stopped", async () => {
  const { workspaceRoot, result } = await pauseOnOutOfEnvelopePatch([
    { id: "call_notes", patchPath: "docs/notes.md", patchContent: "notes" },
  ]);

  const resumeModelClient = new FakeModelClient([
    { content: "Wrapping up now.", toolCalls: [] },
  ]);
  const resumed = await resumeCodingSession({
    workspaceRoot,
    sessionId: result.session.id,
    modelClient: resumeModelClient,
    decision: { kind: "stop" },
  });

  expect(resumed.summary).toMatch(/user_stopped/);
  expect(resumed.summary).toMatch(/Wrapping up now\./);
  await expect(readFile(join(workspaceRoot, "docs/notes.md"), "utf8")).rejects.toThrow();
  await expect(readPauseSnapshot(workspaceRoot, result.session.id)).rejects.toThrow();

  const events = await readTraceFile(resumed.tracePath);
  expect(events.at(-1)?.type).toBe("session_finished");
  expect(events.at(-1)?.payload.status).toBe("stopped");
  expect(events.at(-1)?.payload.reason).toBe("user_stopped");
});

test("a failed resume records attempt evidence, re-arms the pause, and preserves the snapshot for retry", async () => {
  const { workspaceRoot, result } = await pauseOnOutOfEnvelopePatch([
    { id: "call_notes", patchPath: "docs/notes.md", patchContent: "notes" },
  ]);
  const liveEvents: unknown[] = [];

  await expect(
    resumeCodingSession({
      workspaceRoot,
      sessionId: result.session.id,
      modelClient: {
        async createTurn() {
          throw new Error("DeepSeek API response aborted before completion.");
        },
      },
      decision: { kind: "approve" },
      onLiveEvent: (event) => {
        liveEvents.push(event);
      },
    }),
  ).rejects.toThrow("DeepSeek API response aborted before completion.");

  const events = await readTraceFile(result.tracePath);
  const resumeFailed = events.find(
    (event) => event.type === "session_resume_failed",
  );
  expect(resumeFailed?.payload).toMatchObject({
    reason: "model_execution_error",
    error: { message: "DeepSeek API response aborted before completion." },
  });
  // Attempt evidence only: the Session did not finish, so terminal evidence
  // must not appear (ADR 0061).
  expect(events.some((event) => event.type === "final_summary")).toBe(false);
  expect(events.some((event) => event.type === "session_finished")).toBe(false);
  expect(liveEvents).toContainEqual({
    type: "session_resume_failed",
    sessionId: result.session.id,
    reason: "model_execution_error",
  });
  await expect(readPidMarker(workspaceRoot, result.session.id)).resolves.toBeUndefined();
  await expect(readPauseSnapshot(workspaceRoot, result.session.id)).resolves.toMatchObject({
    sessionId: result.session.id,
  });

  // The pause is back in force: the fold reads paused and the Decision Queue
  // lists the Session again.
  const folded = foldSessionTrace(await readTypedTrace(result.tracePath));
  expect(folded?.status).toBe("paused");
  const queue = await listPausedSessions(workspaceRoot);
  expect(queue.map((entry) => entry.sessionId)).toContain(result.session.id);

  const retried = await resumeCodingSession({
    workspaceRoot,
    sessionId: result.session.id,
    modelClient: new FakeModelClient([{ content: "Retried successfully.", toolCalls: [] }]),
    decision: { kind: "approve" },
  });
  expect(retried.summary).toMatch(/Retried successfully\./);
  await expect(readPauseSnapshot(workspaceRoot, result.session.id)).rejects.toThrow();
  const foldedAfterRetry = foldSessionTrace(await readTypedTrace(result.tracePath));
  expect(foldedAfterRetry?.status).toBe("completed");
});
