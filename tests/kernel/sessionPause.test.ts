import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodingSession } from "../../src/workflows/coding.js";
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

test("a session auto-approves an in-envelope patch, then pauses on an out-of-envelope patch", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  await execGit(workspaceRoot, ["init"]);

  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_in_envelope",
          name: "apply_patch",
          input: { patch: newFilePatch("src/app.ts", "console.log(1);") },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_out_of_envelope",
          name: "apply_patch",
          input: { patch: newFilePatch("docs/notes.md", "notes") },
        },
      ],
    },
  ]);

  const result = await runCodingSession({
    task: "write app and notes",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    envelope: { writeScopePrefixes: ["src"], allowedCommands: [] },
  });

  expect(result.status).toBe("paused");
  expect(result.summary).toMatch(/forge decide/);
  expect(result.snapshotPath).toBeDefined();

  const snapshot = await readPauseSnapshot(workspaceRoot, result.session.id);
  expect(snapshot.pendingToolCall.id).toBe("call_out_of_envelope");
  expect(snapshot.pendingToolRequest.targets).toEqual([
    { kind: "path", path: "docs/notes.md", classification: "ordinary" },
  ]);
  expect(snapshot.remainingToolCalls).toEqual([]);
  expect(snapshot.sessionState.forgeletTouchedPaths).toEqual(new Set(["src/app.ts"]));
  expect(snapshot.tracePath).toBe(result.tracePath);
  expect(snapshot.envelope).toEqual({
    writeScopePrefixes: ["src"],
    allowedCommands: [],
  });

  const events = await readTraceFile(result.tracePath);
  const approvalDecisions = events.filter((event) => event.type === "approval_decision");
  expect(approvalDecisions).toHaveLength(1);
  expect(approvalDecisions[0]?.payload.reason).toMatch(/Effect Envelope/);

  expect(events.at(-1)?.type).toBe("session_paused");
  expect(events.some((event) => event.type === "session_finished")).toBe(false);
  const pausedEvent = events.find((event) => event.type === "session_paused");
  expect(pausedEvent?.payload.reason).toBe("out_of_envelope");
  expect(pausedEvent?.payload.toolName).toBe("apply_patch");
});
