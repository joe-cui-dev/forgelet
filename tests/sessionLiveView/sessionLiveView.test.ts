import { expect, test } from "@jest/globals";
import {
  createTerminalSessionLiveEventSink,
  formatSessionLiveEvent,
} from "../../src/sessionLiveView/index.js";

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
      type: "session_ready",
      sessionId: "sess_abc123",
      tracePath: "/tmp/work/.forgelet/sessions/sess_abc123.jsonl",
    }),
  ).toBe("Session ready: sess_abc123");

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

test("terminal Session Live View streams the Reasoning Stream under one header, then closes it before the answer", async () => {
  const writes: string[] = [];
  const sink = createTerminalSessionLiveEventSink((text) => {
    writes.push(text);
  });

  await sink({
    type: "model_turn_started",
    turnIndex: 0,
    model: "deepseek-v4-flash",
  });
  await sink({
    type: "model_reasoning_progress",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    bytesSoFar: 1024,
    text: "First I should check the tests.\n",
  });
  await sink({
    type: "model_reasoning_progress",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    bytesSoFar: 2048,
    text: "Then update the docs",
  });
  await sink({
    type: "model_output_delta",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    text: "Done.",
  });

  expect(writes.join("")).toBe(
    [
      "Model turn 1 started: deepseek-v4-flash\n",
      "Model turn 1 thinking:\n",
      "First I should check the tests.\n",
      "Then update the docs",
      "\n",
      "Done.",
    ].join(""),
  );
});

test("terminal Session Live View does not repeat the thinking header within a turn", async () => {
  const writes: string[] = [];
  const sink = createTerminalSessionLiveEventSink((text) => {
    writes.push(text);
  });

  // The first batch happens to end exactly on a newline: the header must
  // still not reprint for the batch that follows it.
  await sink({
    type: "model_reasoning_progress",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    bytesSoFar: 1024,
    text: "A complete sentence.\n",
  });
  await sink({
    type: "model_reasoning_progress",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    bytesSoFar: 1500,
    text: "Another one.",
  });

  expect(writes.join("")).toBe(
    [
      "Model turn 1 thinking:\n",
      "A complete sentence.\n",
      "Another one.",
    ].join(""),
  );
});

test("terminal Session Live View streams model output deltas inline", async () => {
  const writes: string[] = [];
  const sink = createTerminalSessionLiveEventSink((text) => {
    writes.push(text);
  });

  await sink({
    type: "model_turn_started",
    turnIndex: 0,
    model: "deepseek-v4-flash",
  });
  await sink({
    type: "model_output_delta",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    text: "Hello",
  });
  await sink({
    type: "model_output_delta",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    text: " world",
  });
  await sink({
    type: "model_turn_finished",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    toolCallCount: 0,
  });

  expect(writes.join("")).toBe(
    [
      "Model turn 1 started: deepseek-v4-flash\n",
      "Hello world\n",
      "Model turn 1 finished: deepseek-v4-flash, 0 tool calls\n",
    ].join(""),
  );
});
