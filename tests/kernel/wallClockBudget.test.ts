import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodingSession, resumeCodingSession } from "../../src/workflows/coding.js";
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

const fakeClock = (stepMs: number): (() => number) => {
  let calls = 0;
  return () => {
    calls += 1;
    return calls * stepMs;
  };
};

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

test("wrap-up triggers once elapsed wall-clock crosses the reserve threshold", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-wallclock-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      budgets: {
        maxWallClockMs: 1000,
        maxModelTurns: 10,
        maxInputTokens: 1_000_000,
        maxEstimatedCostUsd: 100,
      },
    }),
    "utf8",
  );

  const turns = [
    { toolCalls: [{ id: "call_list", name: "list_files", input: {} }] },
    { content: "Here is a summary of progress so far.", toolCalls: [] },
  ];
  let call = 0;
  const modelClient = { async createTurn() { return turns[call++]; } };

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    now: fakeClock(250),
  });

  expect(call).toBe(2);
  const events = await readTraceFile(result.tracePath);
  const wrapupTriggered = events.find((event) => event.type === "budget_wrapup_triggered");
  expect(wrapupTriggered?.payload.reason).toBe("wall_clock_limit_exceeded");
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished?.payload).toMatchObject({
    status: "stopped",
    reason: "wall_clock_limit_exceeded",
  });
});

test("pause/resume accumulates wall-clock across process segments instead of resetting or double-counting", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-wallclock-resume-"));
  await execGit(workspaceRoot, ["init"]);
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      budgets: {
        maxWallClockMs: 1000,
        maxModelTurns: 20,
        maxInputTokens: 1_000_000,
        maxEstimatedCostUsd: 100,
      },
    }),
    "utf8",
  );

  const initialModelClient = {
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

  const initialResult = await runCodingSession({
    task: "write docs",
    contextFiles: [],
    workspaceRoot,
    modelClient: initialModelClient,
    act: true,
    envelope: { writeScopePrefixes: ["src"], allowedCommands: [] },
    now: fakeClock(100),
  });

  const snapshot = await readPauseSnapshot(workspaceRoot, initialResult.session.id);
  // runStartedAtMs consumes the clock's first tick, so pause fires after 3
  // more ticks (turn-start budget checks, then the pause capture itself).
  expect(snapshot.activeWallClockMs).toBe(300);

  const resumeTurns = [
    { toolCalls: [{ id: "call_list_1", name: "list_files", input: {} }] },
    { toolCalls: [{ id: "call_list_2", name: "list_files", input: {} }] },
    { content: "Wrapping up after resume.", toolCalls: [] },
  ];
  let resumeCall = 0;
  const resumeModelClient = { async createTurn() { return resumeTurns[resumeCall++]; } };

  const resumed = await resumeCodingSession({
    workspaceRoot,
    sessionId: initialResult.session.id,
    modelClient: resumeModelClient,
    decision: { kind: "approve" },
    now: fakeClock(100),
  });

  expect(resumeCall).toBe(3);
  const events = await readTraceFile(resumed.tracePath);
  const wrapupTriggered = events.find((event) => event.type === "budget_wrapup_triggered");
  expect(wrapupTriggered?.payload.reason).toBe("wall_clock_limit_exceeded");
  // Prior 300ms carried from the snapshot plus 700ms elapsed on the resumed
  // clock by the time the wrap-up trace fires — proof the prior segment was
  // added once (carried forward), not reset to 0 and not double-counted.
  expect(wrapupTriggered?.payload.elapsedWallClockMs).toBe(1000);
  expect(events.at(-1)?.payload.status).toBe("stopped");
  expect(events.at(-1)?.payload.reason).toBe("wall_clock_limit_exceeded");
});
