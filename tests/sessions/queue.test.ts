import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listPausedSessions } from "../../src/sessions/queue.js";
import { runCodingSession, resumeCodingSession } from "../../src/workflows/coding.js";

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

test("listPausedSessions lists a paused session's pending action", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-queue-"));
  await execGit(workspaceRoot, ["init"]);
  const modelClient = {
    async createTurn() {
      return {
        toolCalls: [
          {
            id: "call_notes",
            name: "apply_patch",
            input: { patch: newFilePatch("docs/notes.md", "notes") },
          },
        ],
      };
    },
  };

  const result = await runCodingSession({
    task: "write docs",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    envelope: { writeScopePrefixes: ["src"], allowedCommands: [] },
  });

  const queue = await listPausedSessions(workspaceRoot);

  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({
    sessionId: result.session.id,
    task: "write docs",
    pendingToolName: "apply_patch",
    pendingTargets: ["docs/notes.md"],
  });
  expect(typeof queue[0]?.pausedAt).toBe("string");
});

test("listPausedSessions excludes sessions that have since been resumed", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-queue-resumed-"));
  await execGit(workspaceRoot, ["init"]);
  const modelClient = {
    async createTurn() {
      return {
        toolCalls: [
          {
            id: "call_notes",
            name: "apply_patch",
            input: { patch: newFilePatch("docs/notes.md", "notes") },
          },
        ],
      };
    },
  };
  const paused = await runCodingSession({
    task: "write docs",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    envelope: { writeScopePrefixes: ["src"], allowedCommands: [] },
  });

  await resumeCodingSession({
    workspaceRoot,
    sessionId: paused.session.id,
    modelClient: { async createTurn() { return { content: "done", toolCalls: [] }; } },
    decision: { kind: "approve" },
  });

  const queue = await listPausedSessions(workspaceRoot);

  expect(queue).toEqual([]);
});

test("listPausedSessions returns an empty list when nothing is paused", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-queue-empty-"));

  await expect(listPausedSessions(workspaceRoot)).resolves.toEqual([]);
});
