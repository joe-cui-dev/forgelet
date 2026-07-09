import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodingSession, resumeCodingSession } from "../../src/workflows/coding.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import { readPauseSnapshot } from "../../src/sessions/pauseSnapshot.js";
import { readTraceFile } from "../../src/trace/index.js";

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
