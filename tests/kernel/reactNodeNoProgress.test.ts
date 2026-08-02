import { expect, test } from "@jest/globals";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";
import {
  createProgressState,
  NO_PROGRESS_TURN_LIMIT,
  planSignature,
  recordTurnProgress,
} from "../../src/kernel/progressGate.js";
import type { ToolObservation } from "../../src/observation/index.js";

const traceEvents = async (tracePath: string) =>
  (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("reserves the wrap-up turn once repeated reads stop teaching the Session anything", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-no-progress-read-"));
  await writeFile(join(workspaceRoot, "index.ts"), "export {};\n", "utf8");

  const repeatedRead = {
    usage: { reasoningTokens: 4000 },
    toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
  };
  const turns = [
    // The first read is new evidence; the next three repeat it exactly.
    repeatedRead,
    repeatedRead,
    repeatedRead,
    repeatedRead,
    { content: "I kept re-reading the same listing and learned nothing new.", toolCalls: [] },
  ];
  let call = 0;
  const turnInputs: { messages: { content: string }[] }[] = [];
  const modelClient = {
    async createTurn(input: { messages: { content: string }[] }) {
      turnInputs.push(input);
      return turns[call++];
    },
  };

  const result = await runCodingSession({
    task: "check the workspace",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  // Five turns, not the 32 the turn ceiling would have allowed.
  expect(call).toBe(5);
  expect(result.summary).toMatch(/Reason: no_progress/);
  expect(result.summary).toMatch(/I kept re-reading the same listing/);

  const events = await traceEvents(result.tracePath ?? "");
  const barren = events.filter((event) => event.type === "session_no_progress");
  expect(barren.map((event) => event.payload.noProgressTurns)).toEqual([1, 2, 3]);
  expect(barren.at(-1)?.payload).toMatchObject({
    limit: NO_PROGRESS_TURN_LIMIT,
    wrapupTriggered: true,
    // All four turns at 4000 reasoning tokens each: the counter is cleared by
    // an effect, and this Session only ever read, so the opening turn's spend
    // counts too. Still under the ceiling — the streak is what fires here.
    reasoningTokensSinceEffect: 16_000,
    reasoningLimitReached: false,
  });

  // The closing turn is told why it was reserved, so its answer can say so.
  expect(turnInputs.at(-1)?.messages.at(-1)?.content).toContain(
    "the last turns added no new evidence and changed nothing",
  );
});

test("reserves the wrap-up turn when turns return neither an answer nor a tool call", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-no-progress-empty-"));

  const turns = [
    { content: "", toolCalls: [] },
    { content: "", toolCalls: [] },
    { content: "", toolCalls: [] },
    { content: "Here is what I can say from what I have.", toolCalls: [] },
  ];
  let call = 0;
  const modelClient = {
    async createTurn() {
      return turns[call++];
    },
  };

  const result = await runCodingSession({
    task: "answer from nothing",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  // This path used to loop until a budget ran out; it now closes after three.
  expect(call).toBe(4);
  expect(result.summary).toMatch(/Reason: no_progress/);
  expect(result.summary).toMatch(/Here is what I can say/);
});

test("a Session that keeps learning is never cut short by the gate", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-no-progress-mixed-"));
  await writeFile(join(workspaceRoot, "index.ts"), "export {};\n", "utf8");

  const listFiles = { toolCalls: [{ id: "call_list", name: "list_files", input: {} }] };
  const turns = [
    listFiles,
    listFiles, // barren (1)
    listFiles, // barren (2)
    // New evidence resets the streak before it reaches the limit.
    { toolCalls: [{ id: "call_read", name: "read_file", input: { path: "index.ts" } }] },
    listFiles, // barren (1)
    listFiles, // barren (2)
    { content: "Done reading the workspace.", toolCalls: [] },
  ];
  let call = 0;
  const modelClient = {
    async createTurn() {
      return turns[call++];
    },
  };

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(call).toBe(7);
  expect(result.summary).toMatch(/Done reading the workspace\./);
  expect(result.summary).not.toMatch(/Reason: no_progress/);

  const events = await traceEvents(result.tracePath ?? "");
  expect(
    events
      .filter((event) => event.type === "session_no_progress")
      .map((event) => event.payload.noProgressTurns),
  ).toEqual([1, 2, 1, 2]);
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished?.payload).toMatchObject({ status: "completed" });
});

test("an effect counts as progress even when it repeats one already made", () => {
  // Re-running a test suite after an edit is a deliberate act, not a stall, and
  // its observation can be byte-identical to the earlier run.
  const command: ToolObservation = {
    ok: true,
    toolCallId: "call_test",
    toolName: "run_command",
    summary: "Command exited 0.",
    content: "ok",
    metadata: { command: "npm test", exitCode: 0 },
  };
  const state = createProgressState(planSignature([]));

  const first = recordTurnProgress(state, {
    observations: [command],
    planSignature: planSignature([]),
  });
  const repeated = recordTurnProgress(state, {
    observations: [command],
    planSignature: planSignature([]),
  });

  expect(first.advanced).toBe(true);
  expect(repeated.advanced).toBe(true);
  expect(repeated.noProgressTurns).toBe(0);
});

test("rewriting the plan counts as progress, resubmitting the same plan does not", () => {
  const drafted = [{ step: "audit README", status: "in_progress" as const }];
  const state = createProgressState(planSignature([]));

  const rewritten = recordTurnProgress(state, {
    observations: [],
    planSignature: planSignature(drafted),
  });
  const resubmitted = recordTurnProgress(state, {
    observations: [],
    planSignature: planSignature(drafted),
  });

  expect(rewritten.advanced).toBe(true);
  expect(resubmitted.advanced).toBe(false);
  expect(resubmitted.noProgressTurns).toBe(1);
});
