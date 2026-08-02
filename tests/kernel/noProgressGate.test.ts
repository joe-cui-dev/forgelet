import { expect, test } from "@jest/globals";
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import { readTypedTrace } from "../testSupport/trace.js";

// The two shapes of a Coding Session that has stopped converging, both taken
// from recorded runs of the same task against this workspace.
//
//   `sess_msbid1es` re-worded its way through barren searches for six turns
//   while its reasoning grew from 98 to 9764 tokens a turn. Every observation
//   was new, so the turn streak never moved; the gate saw a healthy Session
//   until the user killed it.
//
//   `sess_msb4s8jp` ran the same task and converged in 16 turns, spending under
//   17k reasoning tokens between the acts it took. It is the control: neither
//   road may fire on it.

const searchTurn = (id: string, query: string, reasoningTokens: number) => ({
  toolCalls: [
    { id, name: "search_text", input: { query, path: "example.ts" } },
  ],
  usage: { reasoningTokens },
});

const runSession = async (
  outputs: ConstructorParameters<typeof FakeModelClient>[0],
) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-progress-"));
  await writeFile(
    join(workspaceRoot, "example.ts"),
    "export const answer = 'needle';\n",
    "utf8",
  );
  const modelClient = new FakeModelClient(outputs);
  const result = await runCodingSession({
    task: "check whether README.md needs changes",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });
  const events = await readTypedTrace(result.tracePath ?? "");
  return {
    result,
    modelTurns: modelClient.turnInputs.length,
    noProgress: events.filter((event) => event.type === "session_no_progress"),
  };
};

test("a re-worded barren search is the repeat it is, not new evidence", async () => {
  // Distinct queries, all missing. Before the gate folded barren observations
  // onto one digest per tool, each of these reset the streak.
  const { noProgress, modelTurns, result } = await runSession([
    ...["chat", "token", "peak", "1M-token", "window", "384"].map(
      (query, index) => searchTurn(`call_${index}`, query, 0),
    ),
    { content: "Nothing to change.", toolCalls: [], finishReason: "stop" },
  ]);

  expect(noProgress.map((event) => event.payload)).toMatchObject([
    { noProgressTurns: 1, wrapupTriggered: false },
    { noProgressTurns: 2, wrapupTriggered: false },
    { noProgressTurns: 3, wrapupTriggered: true },
  ]);
  // The reserved wrap-up turn, not a mid-loop cut: three barren turns, then
  // the Session answers. The remaining scripted searches are never reached.
  expect(modelTurns).toBe(5);
  expect(result.summary).toMatch(/Reason: no_progress/);
});

test("reasoning spent without acting reaches the wrap-up on its own", async () => {
  // Every query hits, so every turn learns something new and the streak stays
  // at zero — the shape the turn count cannot see. Only the climbing reasoning
  // spend catches it.
  const { noProgress, modelTurns, result } = await runSession([
    ...["export", "const", "answer", "needle", "=", ";"].map((query, index) =>
      searchTurn(`call_${index}`, query, 6_000),
    ),
    { content: "Nothing to change.", toolCalls: [], finishReason: "stop" },
  ]);

  const tripped = noProgress.filter(
    (event) => event.payload.wrapupTriggered === true,
  );
  expect(tripped).toHaveLength(1);
  expect(tripped[0]?.payload).toMatchObject({
    reasoningLimitReached: true,
    noProgressTurns: 0,
    reasoningTokenLimit: 32_000,
  });
  expect(tripped[0]?.payload.reasoningTokensSinceEffect).toBeGreaterThanOrEqual(
    32_000,
  );
  // Six turns to cross the ceiling, then the reserved wrap-up — not the 32
  // turns the ceiling in `budgets.maxModelTurns` would have allowed.
  expect(modelTurns).toBe(7);
  expect(result.summary).toMatch(/Reason: no_progress/);
});

test("a Session that keeps acting is not cut by either road", async () => {
  // The control. Reasoning well past the ceiling in total, but an effect —
  // here a plan rewrite and a command — clears the counter each time, which is
  // what converging work looks like.
  const { noProgress, result } = await runSession([
    searchTurn("call_0", "needle", 9_000),
    {
      toolCalls: [
        {
          id: "call_plan",
          name: "update_plan",
          input: { items: [{ step: "read the file", status: "in_progress" }] },
        },
      ],
      usage: { reasoningTokens: 9_000 },
    },
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "example.ts" } },
      ],
      usage: { reasoningTokens: 9_000 },
    },
    {
      toolCalls: [
        {
          id: "call_plan2",
          name: "update_plan",
          input: { items: [{ step: "read the file", status: "completed" }] },
        },
      ],
      usage: { reasoningTokens: 9_000 },
    },
    {
      content: "The answer is defined in example.ts.",
      toolCalls: [],
      finishReason: "stop",
      usage: { reasoningTokens: 9_000 },
    },
  ]);

  expect(noProgress).toHaveLength(0);
  expect(result.summary).toMatch(/The answer is defined in example.ts/);
});
