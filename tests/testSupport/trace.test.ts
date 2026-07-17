import { expect, test } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expectToolCallPermissionBeforeResult,
  expectTraceSubsequence,
  readTypedTrace,
} from "./trace.js";

test("reads known Trace evidence and asserts semantic ordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgelet-trace-support-"));
  const tracePath = join(directory, "session.jsonl");
  await writeFile(
    tracePath,
    [
      { type: "session_started", payload: { workflow: "coding" } },
      { type: "tool_call", payload: { id: "call_1", name: "read_file" } },
      {
        type: "permission_decision",
        payload: { toolCallId: "call_1", toolName: "read_file" },
      },
      {
        type: "tool_result",
        payload: { toolCallId: "call_1", toolName: "read_file", ok: true, summary: "Read file." },
      },
      { type: "future_event", payload: {} },
    ]
      .map((event) => JSON.stringify({ ...event, ts: "2026-07-17T00:00:00.000Z", sessionId: "sess_test" }))
      .join("\n"),
    "utf8",
  );

  const events = await readTypedTrace(tracePath);

  expect(events.map((event) => event.type)).toEqual([
    "session_started",
    "tool_call",
    "permission_decision",
    "tool_result",
  ]);
  expectTraceSubsequence(events, ["session_started", "tool_call", "tool_result"]);
  expectToolCallPermissionBeforeResult(events);
  expect(() =>
    expectToolCallPermissionBeforeResult([
      events[0]!,
      events[1]!,
      events[3]!,
      events[2]!,
    ]),
  ).toThrow();
});
