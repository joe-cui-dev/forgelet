import { expect, test } from "@jest/globals";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodingSession, resumeCodingSession } from "../../src/workflows/coding.js";
import { readPidMarker } from "../../src/sessions/pidMarker.js";

test("a pid marker exists while a session runs and is removed once it completes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pid-lifecycle-"));
  let runningEntriesDuringTurn: string[] = [];

  const result = await runCodingSession({
    task: "inspect",
    contextFiles: [],
    workspaceRoot,
    modelClient: {
      async createTurn() {
        runningEntriesDuringTurn = await readdir(
          join(workspaceRoot, ".forgelet", "running"),
        ).catch(() => []);
        return { content: "done", toolCalls: [] };
      },
    },
  });

  expect(runningEntriesDuringTurn).toEqual([`${result.session.id}.pid`]);
  await expect(readPidMarker(workspaceRoot, result.session.id)).resolves.toBeUndefined();
});

test("a pid marker is removed when a session pauses, and rewritten then removed across resume", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pid-lifecycle-pause-"));
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolveExec, rejectExec) => {
    execFile(
      "git",
      ["init"],
      { cwd: workspaceRoot },
      (error) => (error ? rejectExec(error) : resolveExec()),
    );
  });

  const modelClient = {
    async createTurn() {
      return {
        toolCalls: [
          {
            id: "call_notes",
            name: "apply_patch",
            input: {
              patch: [
                "diff --git a/docs/notes.md b/docs/notes.md",
                "new file mode 100644",
                "index 0000000..7e4a5c3",
                "--- /dev/null",
                "+++ b/docs/notes.md",
                "@@ -0,0 +1,1 @@",
                "+notes",
              ].join("\n"),
            },
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

  await expect(readPidMarker(workspaceRoot, paused.session.id)).resolves.toBeUndefined();

  const resumeModelClient = { async createTurn() { return { content: "done", toolCalls: [] }; } };
  const resumed = await resumeCodingSession({
    workspaceRoot,
    sessionId: paused.session.id,
    modelClient: resumeModelClient,
    decision: { kind: "approve" },
  });

  await expect(readPidMarker(workspaceRoot, resumed.session.id)).resolves.toBeUndefined();
});
