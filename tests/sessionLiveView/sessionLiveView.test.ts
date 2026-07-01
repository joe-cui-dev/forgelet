import { expect, test } from "@jest/globals";
import { formatSessionLiveEvent } from "../../src/sessionLiveView/index.js";

test("formats concise terminal Session Live View events", () => {
  expect(
    formatSessionLiveEvent({
      type: "session_started",
      workflow: "coding",
      task: "fix tests",
    }),
  ).toBe("Session started: coding - fix tests");

  expect(
    formatSessionLiveEvent({
      type: "trace_path",
      tracePath: "/tmp/work/.forgelet/sessions/sess_123.jsonl",
    }),
  ).toBe("Trace: /tmp/work/.forgelet/sessions/sess_123.jsonl");

  expect(
    formatSessionLiveEvent({
      type: "model_turn_finished",
      turnIndex: 1,
      model: "deepseek-v4-flash",
      toolCallCount: 2,
    }),
  ).toBe("Model turn 2 finished: deepseek-v4-flash, 2 tool calls");

  expect(
    formatSessionLiveEvent({
      type: "command_finished",
      command: "npm test",
      exitCode: 0,
      timedOut: false,
    }),
  ).toBe("Command finished: npm test (exit 0)");

  expect(
    formatSessionLiveEvent({
      type: "session_finished",
      status: "failed",
      reason: "model_execution_error",
    }),
  ).toBe("Session failed: model_execution_error");
});
