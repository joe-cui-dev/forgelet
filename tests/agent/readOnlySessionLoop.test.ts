import { expect, test } from "@jest/globals";
import { execFile } from "child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";
import { runLearningSession } from "../../src/workflows/learning.js";
import { runWritingSession } from "../../src/workflows/writing.js";
import { readDebugTranscript } from "../../src/debugTranscript/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import type { SessionLiveEvent } from "../../src/sessionLiveView/index.js";
import { runKernelSession } from "../../src/kernel/session.js";
import type { WorkflowDefinition } from "../../src/kernel/workflowDefinition.js";

test("a coding Session can search, read, and finish through read-only tools", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-readonly-"));
  await writeFile(
    join(workspaceRoot, "example.ts"),
    "export const answer = 'needle';\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_search", name: "search_text", input: { query: "needle" } },
      ],
    },
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "example.ts" } },
      ],
    },
    {
      content: "The answer is defined in example.ts.",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);

  const result = await runCodingSession({
    task: "find the answer",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.session.stage).toBe("final");
  expect(result.summary).toMatch(/The answer is defined in example.ts/);
  expect(modelClient.turnInputs.length).toBe(3);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(events.map((event) => event.type)).toEqual([
    "session_started",
    "user_task",
    "routing_selected",
    "plan_update",
    "model_turn",
    "budget_update",
    "tool_call",
    "permission_decision",
    "tool_result",
    "model_turn",
    "budget_update",
    "tool_call",
    "permission_decision",
    "tool_result",
    "model_turn",
    "budget_update",
    "final_summary",
    "session_finished",
  ]);

  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  const finalModelTurn = events
    .filter((event) => event.type === "model_turn")
    .at(-1);
  expect(readResult).toBeTruthy();
  expect(readResult.payload.ok).toBe(true);
  expect(readResult.payload.path).toBe("example.ts");
  expect("content" in readResult.payload).toBe(false);
  expect(String(readResult.payload.preview)).toMatch(/needle/);
  expect(finalModelTurn?.payload.finishReason).toBe("stop");
});

test("a model-backed coding Session emits Session Live View events without writing them to the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-live-view-"));
  await writeFile(
    join(workspaceRoot, "example.ts"),
    "export const answer = 'needle';\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "example.ts" } },
      ],
    },
    {
      content: "The answer is defined in example.ts.",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);
  const liveEvents: SessionLiveEvent[] = [];

  const result = await runCodingSession({
    task: "find the answer",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    onLiveEvent: (event) => {
      liveEvents.push(event);
    },
  });

  expect(liveEvents).toEqual([
    {
      type: "session_started",
      workflow: "coding",
      task: "find the answer",
    },
    { type: "trace_path", tracePath: result.tracePath },
    {
      type: "session_ready",
      sessionId: result.session.id,
      tracePath: result.tracePath,
    },
    {
      type: "model_turn_started",
      turnIndex: 0,
      model: "deepseek-v4-flash",
    },
    {
      type: "model_turn_finished",
      turnIndex: 0,
      model: "deepseek-v4-flash",
      toolCallCount: 1,
    },
    {
      type: "tool_call_started",
      toolName: "read_file",
      target: "example.ts",
    },
    {
      type: "permission_checkpoint",
      toolName: "read_file",
      decision: "allow",
    },
    {
      type: "tool_call_finished",
      toolName: "read_file",
      ok: true,
      summary: "Read example.ts.",
    },
    {
      type: "model_turn_started",
      turnIndex: 1,
      model: "deepseek-v4-flash",
    },
    {
      type: "model_turn_finished",
      turnIndex: 1,
      model: "deepseek-v4-flash",
      toolCallCount: 0,
    },
    { type: "session_finished", status: "completed" },
  ]);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const eventTypes = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).type);
  expect(eventTypes).not.toContain("session_live_event");
});

test("a missing context attachment fails launch preflight before any Trace file or live event exists", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-preflight-attachment-"),
  );
  const liveEvents: SessionLiveEvent[] = [];

  await expect(
    runCodingSession({
      task: "find the answer",
      contextFiles: ["missing-context.md"],
      workspaceRoot,
      modelClient: new FakeModelClient([{ content: "unused", toolCalls: [] }]),
      onLiveEvent: (event) => {
        liveEvents.push(event);
      },
    }),
  ).rejects.toThrow();

  expect(liveEvents).toEqual([]);
  const sessionDirExists = await readdir(
    join(workspaceRoot, ".forgelet", "sessions"),
  ).then(
    (entries) => entries.length > 0,
    () => false,
  );
  expect(sessionDirExists).toBe(false);
});

test("corrupt project config fails launch preflight before any Trace file or live event exists", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-preflight-config-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    "{ not valid json",
    "utf8",
  );
  const liveEvents: SessionLiveEvent[] = [];

  await expect(
    runCodingSession({
      task: "find the answer",
      contextFiles: [],
      workspaceRoot,
      modelClient: new FakeModelClient([{ content: "unused", toolCalls: [] }]),
      onLiveEvent: (event) => {
        liveEvents.push(event);
      },
    }),
  ).rejects.toThrow(/Invalid JSON config/);

  expect(liveEvents).toEqual([]);
  const sessionDirExists = await readdir(
    join(workspaceRoot, ".forgelet", "sessions"),
  ).then(
    (entries) => entries.length > 0,
    () => false,
  );
  expect(sessionDirExists).toBe(false);
});

test("an invalid read scope fails launch preflight before any Trace file or live event exists", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-preflight-readscope-"),
  );
  const liveEvents: SessionLiveEvent[] = [];

  await expect(
    runCodingSession({
      task: "find the answer",
      contextFiles: [],
      workspaceRoot,
      allowedReadPaths: ["does-not-exist"],
      modelClient: new FakeModelClient([{ content: "unused", toolCalls: [] }]),
      onLiveEvent: (event) => {
        liveEvents.push(event);
      },
    }),
  ).rejects.toThrow();

  expect(liveEvents).toEqual([]);
  const sessionDirExists = await readdir(
    join(workspaceRoot, ".forgelet", "sessions"),
  ).then(
    (entries) => entries.length > 0,
    () => false,
  );
  expect(sessionDirExists).toBe(false);
});

test("successful preflight appends the real session_started Trace event before the session_ready live event", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-preflight-ready-order-"),
  );
  const modelClient = new FakeModelClient([
    { content: "Inspected the repo.", toolCalls: [] },
  ]);
  let traceContentWhenReady: string | undefined;

  const result = await runCodingSession({
    task: "inspect the repo",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    onLiveEvent: async (event) => {
      if (event.type !== "session_ready") return;
      traceContentWhenReady = await readFile(event.tracePath, "utf8");
    },
  });

  expect(traceContentWhenReady).toBeDefined();
  const typesWhenReady = (traceContentWhenReady ?? "")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).type);
  expect(typesWhenReady).toContain("session_started");
  expect(typesWhenReady).not.toContain("model_turn");
  expect(result.session.stage).toBe("final");
});

test("session_ready live event carries Session identity and Trace path before any model-turn event", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-preflight-ready-identity-"),
  );
  const modelClient = new FakeModelClient([
    { content: "Inspected the repo.", toolCalls: [] },
  ]);
  const liveEvents: SessionLiveEvent[] = [];

  const result = await runCodingSession({
    task: "inspect the repo",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    onLiveEvent: (event) => {
      liveEvents.push(event);
    },
  });

  const readyIndex = liveEvents.findIndex(
    (event) => event.type === "session_ready",
  );
  const firstModelTurnIndex = liveEvents.findIndex(
    (event) => event.type === "model_turn_started",
  );
  expect(readyIndex).toBeGreaterThanOrEqual(0);
  expect(liveEvents[readyIndex]).toEqual({
    type: "session_ready",
    sessionId: result.session.id,
    tracePath: result.tracePath,
  });
  expect(readyIndex).toBeLessThan(firstModelTurnIndex);
});

test("a debug-enabled coding Session writes the full agent-model exchange outside the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-debug-loop-"));
  await writeFile(
    join(workspaceRoot, "example.ts"),
    "export const answer = 'needle';\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "example.ts" } },
      ],
    },
    {
      content: "The answer is defined in example.ts.",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);

  const result = await runCodingSession({
    task: "find the answer",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    debug: true,
  });

  const debugEvents = await readDebugTranscript(
    workspaceRoot,
    result.session.id,
  );
  expect(debugEvents.map((event) => event.type)).toEqual([
    "model_request",
    "model_response",
    "tool_request",
    "tool_result",
    "model_request",
    "model_response",
    "session_debug_finished",
  ]);
  expect(debugEvents[0]?.payload).toMatchObject({
    turnIndex: 0,
    model: "deepseek-v4-flash",
    task: "find the answer",
    finalOnly: false,
  });
  expect(debugEvents[0]?.payload.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("find the answer"),
      }),
    ]),
  );
  expect(debugEvents[0]?.payload.tools).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "read_file" })]),
  );
  expect(debugEvents[3]?.payload).toMatchObject({
    turnIndex: 0,
    toolCallId: "call_read",
    toolName: "read_file",
    observation: {
      ok: true,
      content: expect.stringContaining("needle"),
    },
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "debug_transcript_started",
      "debug_transcript_finished",
    ]),
  );
  const debugFinished = events.find(
    (event) => event.type === "debug_transcript_finished",
  );
  expect(debugFinished?.payload).toMatchObject({
    path: `.forgelet/debug/${result.session.id}.jsonl`,
    status: "completed",
    contentBytes: expect.any(Number),
    contentHash: expect.any(String),
  });
  const tracedReadResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(tracedReadResult?.payload.preview).toMatch(/needle/);
  expect("content" in tracedReadResult.payload).toBe(false);
  expect(trace).not.toContain("full prompt text");
});

test("workspace_summary returns Markdown observations and compact trace metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-loop-"));
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { test: "jest" } }, null, 2),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [{ id: "call_summary", name: "workspace_summary", input: {} }],
    },
    {
      content: "Workspace summary inspected.",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);

  const result = await runCodingSession({
    task: "summarize workspace",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(toolMessage.content).toMatch(/# Workspace/);
  expect(toolMessage.metadata).toMatchObject({
    path: ".",
    scopeConstrained: false,
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const summaryResult = events.find(
    (event) =>
      event.type === "tool_result" &&
      event.payload.toolName === "workspace_summary",
  );
  expect(summaryResult).toBeTruthy();
  expect("content" in summaryResult.payload).toBe(false);
  expect(summaryResult.payload.preview).toMatch(/# Workspace/);
});

test("a model-backed coding Session streams model output deltas through Session Live View only", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-live-delta-"));
  const modelClient = new FakeModelClient([
    {
      content: "The repo is ready.",
      toolCalls: [],
      finishReason: "stop",
      outputDeltas: ["The repo", " is ready."],
    },
  ]);
  const liveEvents: SessionLiveEvent[] = [];

  const result = await runCodingSession({
    task: "summarize the repo",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    onLiveEvent: (event) => {
      liveEvents.push(event);
    },
  });

  expect(result.summary).toMatch(/The repo is ready\./);
  expect(liveEvents).toEqual(
    expect.arrayContaining([
      {
        type: "model_output_delta",
        turnIndex: 0,
        model: "deepseek-v4-flash",
        text: "The repo",
      },
      {
        type: "model_output_delta",
        turnIndex: 0,
        model: "deepseek-v4-flash",
        text: " is ready.",
      },
    ]),
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const eventTypes = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).type);
  expect(eventTypes).not.toContain("model_output_delta");
});

test("a model execution failure records the failed model turn before rethrowing", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-model-failure-"),
  );
  const modelClient = {
    turnCount: 0,
    async createTurn() {
      this.turnCount += 1;
      if (this.turnCount === 1) {
        return {
          toolCalls: [
            {
              id: "call_plan",
              name: "update_plan",
              input: { items: [{ step: "Draft", status: "in_progress" }] },
            },
          ],
        };
      }
      throw Object.assign(
        new Error("DeepSeek API response aborted before completion."),
        {
          statusCode: 200,
          causeCategory: "response_aborted",
          phase: "response",
          elapsedMs: 60576,
          responseBytes: 11,
          responsePreview: '{"choices":',
        },
      );
    },
  };
  const liveEvents: SessionLiveEvent[] = [];

  await expect(
    runWritingSession({
      workflowVariant: "creative",
      creativeStyle: "vivid",
      task: "write the scene",
      contextFiles: [],
      workspaceRoot,
      modelClient,
      onLiveEvent: (event) => {
        liveEvents.push(event);
      },
    }),
  ).rejects.toThrow("DeepSeek API response aborted before completion.");

  const sessionFiles = await readdir(
    join(workspaceRoot, ".forgelet", "sessions"),
  );
  expect(sessionFiles).toHaveLength(1);
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", sessionFiles[0] ?? ""),
    "utf8",
  );
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finalSummary = events.find((event) => event.type === "final_summary");
  const finished = events.find((event) => event.type === "session_finished");
  const modelTurnError = events.find(
    (event) => event.type === "model_turn_error",
  );

  expect(modelTurnError?.payload).toMatchObject({
    turnIndex: 1,
    model: "deepseek-v4-flash",
    finalOnly: false,
    error: {
      message: "DeepSeek API response aborted before completion.",
      name: "Error",
      statusCode: 200,
      causeCategory: "response_aborted",
      phase: "response",
      elapsedMs: 60576,
      responseBytes: 11,
      responsePreview: '{"choices":',
    },
  });
  expect(finalSummary?.payload).toMatchObject({
    summary: expect.stringContaining(
      "Forgelet session failed: DeepSeek API response aborted before completion.",
    ),
    error: {
      message: "DeepSeek API response aborted before completion.",
      name: "Error",
      statusCode: 200,
      causeCategory: "response_aborted",
      phase: "response",
      elapsedMs: 60576,
      responseBytes: 11,
      responsePreview: '{"choices":',
    },
  });
  expect(finished?.payload).toMatchObject({
    status: "failed",
    reason: "model_execution_error",
    error: {
      message: "DeepSeek API response aborted before completion.",
      name: "Error",
      statusCode: 200,
      causeCategory: "response_aborted",
      phase: "response",
      elapsedMs: 60576,
      responseBytes: 11,
      responsePreview: '{"choices":',
    },
  });
  expect(liveEvents).toContainEqual({
    type: "session_finished",
    status: "failed",
    reason: "model_execution_error",
  });
});

test("a debug-enabled model execution failure records model error and finalizes the transcript", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-debug-failure-"),
  );
  const modelClient = {
    async createTurn() {
      throw Object.assign(
        new Error("DeepSeek API response aborted before completion."),
        {
          statusCode: 200,
          causeCategory: "response_aborted",
          phase: "response",
        },
      );
    },
  };

  await expect(
    runCodingSession({
      task: "inspect this repo",
      contextFiles: [],
      workspaceRoot,
      modelClient,
      debug: true,
    }),
  ).rejects.toThrow("DeepSeek API response aborted before completion.");

  const sessionFiles = await readdir(
    join(workspaceRoot, ".forgelet", "sessions"),
  );
  expect(sessionFiles).toHaveLength(1);
  const debugTrace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", sessionFiles[0] ?? ""),
    "utf8",
  );
  const sessionId = JSON.parse(debugTrace.split("\n")[0] ?? "{}").sessionId;
  const debugEvents = await readDebugTranscript(workspaceRoot, sessionId);
  expect(debugEvents.map((event) => event.type)).toEqual([
    "model_request",
    "model_error",
    "session_debug_finished",
  ]);
  expect(debugEvents[1]?.payload).toMatchObject({
    turnIndex: 0,
    model: "deepseek-v4-flash",
    finalOnly: false,
    error: {
      message: "DeepSeek API response aborted before completion.",
      statusCode: 200,
      causeCategory: "response_aborted",
      phase: "response",
    },
  });
  expect(debugEvents[2]?.payload).toMatchObject({ status: "failed" });

  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", sessionFiles[0] ?? ""),
    "utf8",
  );
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "model_turn_error"),
  ).toBeTruthy();
  expect(
    events.find((event) => event.type === "session_finished")?.payload,
  ).toMatchObject({
    status: "failed",
    reason: "model_execution_error",
  });
  expect(
    events.find((event) => event.type === "debug_transcript_finished")?.payload,
  ).toMatchObject({
    path: `.forgelet/debug/${sessionId}.jsonl`,
    status: "failed",
    contentBytes: expect.any(Number),
    contentHash: expect.any(String),
  });
});

test("a Session Continuation includes Continuation Context in the first model input", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-continuation-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(join(workspaceRoot, "src", "workflows"), { recursive: true });
  await writeFile(
    join(sessionDir, "sess_parent.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
          readScope: ["src/workflows"],
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: { task: "find the original clue" },
      }),
      JSON.stringify({
        type: "context_attachment",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          id: "ctx_1",
          source: "file",
          title: "draft.md",
          uri: "draft.md",
          mimeType: "text/markdown",
          contentBytes: 100,
          contentHash: "hash_parent",
          preview: "parent attachment preview",
          trustLevel: "workspace",
        },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_parent",
        payload: {
          summary: "The inherited fact is cobalt.",
          audit: {
            changeGroups: {
              forgeletChanged: ["src/foo.ts"],
              preExistingAtSessionStart: [],
              otherCurrentWorkspaceChanges: [],
            },
            verificationCommands: [
              { command: "npm test", exitCode: 1, timedOut: false },
            ],
            kernelObservedRisks: [
              {
                kind: "verification_failed",
                message: "Verification command failed: npm test (exit 1).",
                command: "npm test",
                exitCode: 1,
              },
            ],
            modelTurns: 2,
            estimatedCostUsd: 0.01,
            tracePath: ".forgelet/sessions/sess_parent.jsonl",
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Continuing from cobalt.", toolCalls: [] },
  ]);

  const parentTracePath = join(sessionDir, "sess_parent.jsonl");
  const parentTraceBefore = await readFile(parentTracePath, "utf8");

  const result = await runCodingSession({
    task: "continue with the inherited clue",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    continuationSourceSessionId: "sess_parent",
  });

  const firstUserMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "user",
    )?.content ?? "";
  expect(firstUserMessage).toMatch(/Continuation Context:/);
  expect(firstUserMessage).toMatch(/sourceSessionId: sess_parent/);
  expect(firstUserMessage).toMatch(/lineage: sess_parent/);
  expect(firstUserMessage).toMatch(/sourceStatus: completed/);
  expect(firstUserMessage).toMatch(/inheritedReadScope: src\/workflows/);
  expect(firstUserMessage).toMatch(/priorTask: find the original clue/);
  expect(firstUserMessage).toMatch(/sess_parent: The inherited fact is cobalt/);
  expect(firstUserMessage).toMatch(/Prior actionable evidence:/);
  expect(firstUserMessage).toMatch(/sess_parent changed: src\/foo\.ts/);
  expect(firstUserMessage).toMatch(/sess_parent verification: npm test exit 1/);
  expect(firstUserMessage).toMatch(
    /sess_parent risk: Verification command failed: npm test \(exit 1\)\./,
  );
  expect(firstUserMessage).not.toMatch(/diff --git/);
  expect(firstUserMessage).not.toMatch(/parent patch content/);
  expect(firstUserMessage).toMatch(/draft\.md hash=hash_parent/);
  expect(firstUserMessage).not.toMatch(/parent attachment preview/);

  await expect(readFile(parentTracePath, "utf8")).resolves.toBe(
    parentTraceBefore,
  );
  expect(result.tracePath).toBeDefined();
  const childTrace = await readFile(result.tracePath ?? "", "utf8");
  const events = childTrace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "session_started");
  expect(started?.payload.continuation).toEqual({
    sourceSessionId: "sess_parent",
    rootSessionId: "sess_parent",
    lineageSessionIds: ["sess_parent"],
    degraded: false,
  });
  expect(events.map((event) => event.type)).toContain(
    "session_continuation_started",
  );
  expect(events.map((event) => event.type)).toContain(
    "continuation_context_loaded",
  );
  const loaded = events.find(
    (event) => event.type === "continuation_context_loaded",
  );
  expect(loaded?.payload).toMatchObject({
    priorChangedFiles: 1,
    priorVerificationCommands: 1,
    priorRisks: 1,
    inheritedChangedPaths: ["src/foo.ts"],
  });
});

test("a creative writing Session returns a Revision Pack", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-creative-loop-"),
  );
  await writeFile(
    join(workspaceRoot, "draft.md"),
    "The room was cold.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "The room breathed winter through the walls.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    task: "revise this scene",
    contextFiles: ["draft.md"],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Critique/);
  expect(result.summary).toMatch(/Revision/);
  expect(result.summary).toMatch(/Alternatives/);
  expect(result.summary).toMatch(/Notes/);
  expect(result.summary).toMatch(/The room breathed winter through the walls/);
  expect(result.summary).toMatch(/Writing artifact: \.forgelet\/writing\//);
  expect(result.writingArtifact).toMatchObject({
    contentKind: "revision",
  });
  expect(result.writingArtifact?.path).toMatch(
    /^\.forgelet\/writing\/\d{8}_\d{6}_revision_revise-this-scene\.md$/,
  );
  const artifact = await readFile(
    join(workspaceRoot, result.writingArtifact?.path ?? ""),
    "utf8",
  );
  expect(artifact).toBe("The room breathed winter through the walls.\n");

  const systemMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";
  expect(systemMessage).toMatch(/Style Preset: vivid/);
  expect(systemMessage).toMatch(/Instructions:/);
  expect(systemMessage).toMatch(/Avoid:/);
  expect(systemMessage).toMatch(/Revision focus:/);
  expect(systemMessage).not.toMatch(/Style: vivid/);
  expect(systemMessage).toMatch(/Return a Revision Pack/);
  expect(systemMessage).not.toMatch(/Return a Draft Pack/);
});

test("a creative writing Session uses local Style Preset overrides without tracing the definition", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-creative-local-style-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "draft.md"),
    "The room was cold.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "style-presets.local.json"),
    JSON.stringify({
      vivid: {
        label: "Private visible label.",
        aim: "Private visible aim.",
        instructions: [
          "Private visible instruction one.",
          "Private visible instruction two.",
          "Private visible instruction three.",
        ],
        avoid: ["Private visible avoid one.", "Private visible avoid two."],
        revisionFocus: [
          "Private visible revision one.",
          "Private visible revision two.",
        ],
      },
    }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "The room breathed winter through the walls.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    task: "revise this scene",
    contextFiles: ["draft.md"],
    workspaceRoot,
    modelClient,
  });

  const systemMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";
  expect(systemMessage).toMatch(/Private visible label/);
  expect(systemMessage).toMatch(/Private visible instruction three/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  expect(trace).toMatch(/"creativeStyle":"vivid"/);
  expect(trace).not.toMatch(/Private visible label/);
  expect(trace).not.toMatch(/Private visible instruction/);
});

test("a prompt-only Creative Brief returns only a Draft without context attachments", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-creative-brief-"),
  );
  const modelClient = new FakeModelClient([
    { content: "Rain silvered the convenience store windows.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "cinematic",
    task: "write a rain-soaked convenience store scene",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Draft/);
  expect(result.summary).not.toMatch(/Critique/);
  expect(result.summary).not.toMatch(/Revision/);
  expect(result.summary).not.toMatch(/Alternatives/);
  expect(result.summary).not.toMatch(/Variants/);
  expect(result.summary).not.toMatch(/Notes/);
  expect(result.summary).toMatch(/Rain silvered the convenience store windows/);
  expect(result.summary).toMatch(/Writing artifact: \.forgelet\/writing\//);
  expect(result.writingArtifact).toMatchObject({
    contentKind: "draft",
  });
  expect(result.writingArtifact?.path).toMatch(
    /^\.forgelet\/writing\/\d{8}_\d{6}_draft_write-a-rain-soaked-convenience-store-scene\.md$/,
  );
  const artifact = await readFile(
    join(workspaceRoot, result.writingArtifact?.path ?? ""),
    "utf8",
  );
  expect(artifact).toBe("Rain silvered the convenience store windows.\n");

  const firstUserMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "user",
    )?.content ?? "";
  expect(firstUserMessage).toMatch(
    /Creative brief: write a rain-soaked convenience store scene/,
  );
  expect(firstUserMessage).not.toMatch(/Context attachments:/);
  const systemMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";
  expect(systemMessage).toMatch(/Style Preset: cinematic/);
  expect(systemMessage).toMatch(/Aim:/);
  expect(systemMessage).toMatch(/Instructions:/);
  expect(systemMessage).toMatch(/Avoid:/);
  expect(systemMessage).toMatch(/Revision focus:/);
  expect(systemMessage).not.toMatch(/Style: cinematic/);
  expect(systemMessage).toMatch(/Return only a Draft/);
  expect(systemMessage).not.toMatch(/Return a Revision Pack/);
  expect(systemMessage).not.toMatch(/Variants/);
  expect(systemMessage).not.toMatch(/Notes/);
  expect(modelClient.turnInputs[0]?.tools).toEqual([]);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "context_attachment")).toBe(
    false,
  );
  const artifactEvent = events.find(
    (event) => event.type === "writing_artifact",
  );
  expect(artifactEvent?.payload).toMatchObject({
    path: result.writingArtifact?.path,
    contentKind: "draft",
  });
});

test("a creative Writing Artifact Continuation labels the source separately in the model prompt", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-writing-continuation-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Mara opened the brass door.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "She stepped into a room full of rain.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    continuationFile: ".forgelet/writing/chapter-1.md",
    task: "continue the next chapter",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const firstUserMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "user",
    )?.content ?? "";
  expect(firstUserMessage).toMatch(/Continuation source:/);
  expect(firstUserMessage).toMatch(/uri: \.forgelet\/writing\/chapter-1\.md/);
  expect(firstUserMessage).toMatch(/Mara opened the brass door/);
  expect(firstUserMessage).not.toMatch(/Context attachments:/);
  expect(firstUserMessage).not.toMatch(/Additional context attachments:/);
  expect(result.summary).toMatch(/She stepped into a room full of rain/);
  const systemMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";
  expect(systemMessage).toMatch(/Style Preset: vivid/);
  expect(systemMessage).toMatch(/Instructions:/);
  expect(systemMessage).toMatch(/Avoid:/);
  expect(systemMessage).toMatch(/Revision focus:/);
  expect(systemMessage).not.toMatch(/Style: vivid/);

  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const contextEvents = events.filter(
    (event) => event.type === "context_attachment",
  );
  expect(contextEvents).toHaveLength(1);
  expect(contextEvents[0]?.payload).toMatchObject({
    uri: ".forgelet/writing/chapter-1.md",
    mimeType: "text/markdown",
  });
});

test("a creative Writing Artifact Continuation separates additional context attachments", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-writing-continuation-context-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Mara opened the brass door.\n",
    "utf8",
  );
  const sourceBefore = await readFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "notes.md"),
    "Keep the setting claustrophobic.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "She stepped into a room full of rain.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    continuationFile: ".forgelet/writing/chapter-1.md",
    task: "continue the next chapter",
    contextFiles: ["notes.md"],
    workspaceRoot,
    modelClient,
  });

  const firstUserMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "user",
    )?.content ?? "";
  expect(firstUserMessage).toMatch(/Continuation source:/);
  expect(firstUserMessage).toMatch(/uri: \.forgelet\/writing\/chapter-1\.md/);
  expect(firstUserMessage).toMatch(/Additional context attachments:/);
  expect(firstUserMessage).toMatch(/uri: notes\.md/);
  expect(firstUserMessage).toMatch(/Keep the setting claustrophobic/);
  expect(result.summary).toMatch(/Draft/);
  expect(result.summary).not.toMatch(/Critique/);
  expect(result.summary).not.toMatch(/Revision/);
  expect(result.summary).not.toMatch(/Alternatives/);
  expect(result.summary).not.toMatch(/Notes/);
  expect(result.summary).toMatch(/She stepped into a room full of rain/);
  expect(result.writingArtifact).toMatchObject({
    contentKind: "draft",
  });
  expect(basename(result.writingArtifact?.path ?? "")).toMatch(
    /^\d{8}_\d{6}_draft_continue-the-next-chapter\.md$/,
  );
  const artifact = await readFile(
    join(workspaceRoot, result.writingArtifact?.path ?? ""),
    "utf8",
  );
  expect(artifact).toBe("She stepped into a room full of rain.\n");
  await expect(
    readFile(
      join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
      "utf8",
    ),
  ).resolves.toBe(sourceBefore);
});

test("a Session Read Scope denies read_file outside the allowed paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-read-scope-"));
  await writeFile(join(workspaceRoot, "allowed.txt"), "allowed\n", "utf8");
  await writeFile(join(workspaceRoot, "secret.txt"), "secret\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "secret.txt" } },
      ],
    },
    { content: "The read was denied.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "inspect the allowed file",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  expect(result.session.readScope).toEqual(["allowed.txt"]);
  const denied = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(denied).toMatchObject({
    ok: false,
    toolName: "read_file",
    error: { code: "permission_denied" },
  });

  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "permission_decision")?.payload,
  ).toMatchObject({
    toolName: "read_file",
    decision: "deny",
  });
});

test("a Session Read Scope allows read_file inside the allowed paths", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-read-scope-allowed-"),
  );
  await writeFile(
    join(workspaceRoot, "allowed.txt"),
    "allowed content\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "allowed.txt" } },
      ],
    },
    { content: "The allowed file was read.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "inspect the allowed file",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  expect(
    JSON.parse(modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}"),
  ).toMatchObject({
    ok: true,
    toolName: "read_file",
    content: "allowed content\n",
  });
});

test("a missing file inside the Session Read Scope returns invalid_input", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-read-scope-missing-"),
  );
  await mkdir(join(workspaceRoot, "allowed"), { recursive: true });
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "allowed/missing.txt" },
        },
      ],
    },
    { content: "The missing file was reported.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "inspect the allowed file",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  expect(
    JSON.parse(modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}"),
  ).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
});

test("search_text returns only matches inside the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-search-scope-"));
  await writeFile(
    join(workspaceRoot, "allowed.txt"),
    "needle allowed\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "secret.txt"), "needle secret\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_search", name: "search_text", input: { query: "needle" } },
      ],
    },
    { content: "Only the allowed match was visible.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "find the allowed match",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(observation.content).toMatch(/allowed\.txt/);
  expect(observation.content).not.toMatch(/secret\.txt/);
  expect(observation.metadata.scopeConstrained).toBe(true);
  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find(
      (event) =>
        event.type === "tool_result" &&
        event.payload.toolName === "search_text",
    )?.payload.scopeConstrained,
  ).toBe(true);
});

test("list_files returns only paths inside the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-list-scope-"));
  await mkdir(join(workspaceRoot, "allowed"), { recursive: true });
  await mkdir(join(workspaceRoot, "secret"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "allowed", "visible.txt"),
    "yes\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "secret", "hidden.txt"), "no\n", "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_list", name: "list_files", input: {} }] },
    { content: "Only allowed files were listed.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "list allowed files",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(observation.content).toMatch(/allowed\/visible\.txt/);
  expect(observation.content).not.toMatch(/secret|hidden\.txt/);
  expect(observation.metadata.scopeConstrained).toBe(true);
});

test("collection reads deny targets that do not overlap the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-list-denied-scope-"),
  );
  await mkdir(join(workspaceRoot, "allowed"), { recursive: true });
  await mkdir(join(workspaceRoot, "secret"), { recursive: true });
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_list", name: "list_files", input: { path: "secret" } },
      ],
    },
    { content: "The directory read was denied.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "list allowed files",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(observation).toMatchObject({
    ok: false,
    toolName: "list_files",
    error: { code: "permission_denied" },
  });
});

test("git_status exposes only paths inside the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-git-status-scope-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "allowed.txt"), "before\n", "utf8");
  await writeFile(join(workspaceRoot, "secret.txt"), "before\n", "utf8");
  await execGit(workspaceRoot, ["add", "allowed.txt", "secret.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await writeFile(join(workspaceRoot, "allowed.txt"), "after\n", "utf8");
  await writeFile(join(workspaceRoot, "secret.txt"), "after\n", "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_status", name: "git_status", input: {} }] },
    { content: "Only allowed status was visible.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "inspect allowed status",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(observation.content).toMatch(/allowed\.txt/);
  expect(observation.content).not.toMatch(/secret\.txt/);
  expect(observation.metadata.scopeConstrained).toBe(true);
});

test("git_diff exposes only content inside the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-git-diff-scope-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(
    join(workspaceRoot, "allowed.txt"),
    "before allowed\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "secret.txt"), "before secret\n", "utf8");
  await execGit(workspaceRoot, ["add", "allowed.txt", "secret.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await writeFile(
    join(workspaceRoot, "allowed.txt"),
    "after allowed\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "secret.txt"), "after secret\n", "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "Only allowed diff was visible.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "inspect allowed diff",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(observation.content).toMatch(/allowed\.txt/);
  expect(observation.content).toMatch(/after allowed/);
  expect(observation.content).not.toMatch(/secret\.txt|after secret/);
  expect(observation.metadata.scopeConstrained).toBe(true);
});

test("a Session compacts old tool observations before a later model turn", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-compaction-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ activeContext: { maxConversationBytes: 4_096 } }),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "first.txt"), "a".repeat(8_000), "utf8");
  await writeFile(join(workspaceRoot, "second.txt"), "b".repeat(8_000), "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_first", name: "read_file", input: { path: "first.txt" } },
      ],
    },
    {
      toolCalls: [
        { id: "call_second", name: "read_file", input: { path: "second.txt" } },
      ],
    },
    { content: "Both files were inspected.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "inspect both files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Both files were inspected/);
  const thirdTurnMessages = modelClient.turnInputs[2]?.messages ?? [];
  const toolMessages = thirdTurnMessages.filter(
    (message) => message.role === "tool",
  );
  expect(JSON.parse(toolMessages[0]?.content ?? "{}").compacted).toBe(true);
  expect(JSON.parse(toolMessages[1]?.content ?? "{}").content).toHaveLength(
    8_000,
  );
  expect(
    thirdTurnMessages.filter((message) => message.role === "user").at(-1)
      ?.content,
  ).toMatch(/Active observations compacted: \d+\/4096 bytes/);

  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const compacted = events.find(
    (event) => event.type === "conversation_compacted",
  );
  const attempted = events.find(
    (event) => event.type === "conversation_compaction_attempted",
  );
  expect(attempted.payload).toMatchObject({
    compactedCount: 0,
    targetConversationBytes: 4_096,
  });
  expect(compacted.payload).toMatchObject({
    compactedCount: 1,
    targetConversationBytes: 4_096,
    toolNames: ["read_file"],
  });
  expect("content" in compacted.payload).toBe(false);
  expect("path" in compacted.payload).toBe(false);
  expect("preview" in compacted.payload).toBe(false);
});

test("a Session folds an old turn into a Rolling Summary when digests alone cannot fit the budget", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-fold-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      activeContext: {
        maxConversationBytes: 4_096,
        protectedRecentTurns: 1,
        observationDigestPreviewBytes: 3_000,
      },
    }),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "old.txt"), "a".repeat(10_000), "utf8");
  await writeFile(join(workspaceRoot, "new.txt"), "b".repeat(2_000), "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_old", name: "read_file", input: { path: "old.txt" } },
      ],
    },
    {
      toolCalls: [
        { id: "call_new", name: "read_file", input: { path: "new.txt" } },
      ],
    },
    {
      content: "Read old.txt and new.txt.",
      usage: { inputTokens: 40, outputTokens: 10, estimatedCostUsd: 0.002 },
      toolCalls: [],
    },
    { content: "Both files were inspected.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "inspect both files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Both files were inspected/);
  expect(result.summary).toMatch(/Model turns: 3/);
  expect(modelClient.turnInputs[2]?.tools).toEqual([]);

  const finalTurnMessages = modelClient.turnInputs[3]?.messages ?? [];
  const rollingSummary = finalTurnMessages.find((message) =>
    message.content.startsWith("Rolling Summary"),
  );
  expect(rollingSummary?.content).toMatch(/Read old\.txt and new\.txt\./);
  expect(rollingSummary?.content).toMatch(/old\.txt/);
  expect(
    finalTurnMessages.filter((message) => message.role === "tool").length,
  ).toBeLessThan(2);

  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const folded = events.find((event) => event.type === "conversation_folded");
  expect(folded.payload.text).toMatch(/Read old\.txt and new\.txt\./);
  expect(folded.payload.text).toMatch(/old\.txt/);

  const budgetUpdates = events.filter(
    (event) => event.type === "budget_update",
  );
  expect(
    budgetUpdates.at(-1)?.payload.usage.inputTokens,
  ).toBeGreaterThanOrEqual(40);
});

test("a Session stops when the fold summarization call itself breaches the cost budget", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-fold-budget-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      activeContext: {
        maxConversationBytes: 4_096,
        protectedRecentTurns: 1,
        observationDigestPreviewBytes: 3_000,
      },
      budgets: { maxEstimatedCostUsd: 0.001 },
    }),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "old.txt"), "a".repeat(10_000), "utf8");
  await writeFile(join(workspaceRoot, "new.txt"), "b".repeat(2_000), "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_old", name: "read_file", input: { path: "old.txt" } },
      ],
    },
    {
      toolCalls: [
        { id: "call_new", name: "read_file", input: { path: "new.txt" } },
      ],
    },
    {
      content: "Read old.txt and new.txt.",
      usage: { inputTokens: 40, outputTokens: 10, estimatedCostUsd: 0.002 },
      toolCalls: [],
    },
    { content: "Both files were inspected.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "inspect both files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Reason: estimated_cost_budget_exceeded/);
  expect(modelClient.turnInputs).toHaveLength(3);
});

test("context attachments are rendered for the model without storing full content in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-context-"));
  const largeContext = `Important issue context\n${"x".repeat(62 * 1024)}\nHidden tail marker\n`;
  await writeFile(join(workspaceRoot, "allowed.txt"), "allowed\n", "utf8");
  await writeFile(join(workspaceRoot, "issue.md"), largeContext, "utf8");
  const modelClient = new FakeModelClient([
    { content: "I can see the attached issue context.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "use the attached issue",
    contextFiles: ["issue.md"],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  const firstUserMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "user",
  )?.content;
  expect(firstUserMessage).toBeTruthy();
  expect(firstUserMessage).toMatch(/Context attachments:/);
  expect(firstUserMessage).toMatch(/id: ctx_1/);
  expect(firstUserMessage).toMatch(/source: file/);
  expect(firstUserMessage).toMatch(/title: issue\.md/);
  expect(firstUserMessage).toMatch(/contentHash:/);
  expect(firstUserMessage).toMatch(/contentBytes:/);
  expect(firstUserMessage).toMatch(/returnedBytes: 61440/);
  expect(firstUserMessage).toMatch(/truncated: true/);
  expect(firstUserMessage).toMatch(/Important issue context/);
  expect(firstUserMessage).toMatch(/\[truncated: showing 61440 of \d+ bytes\]/);
  expect(firstUserMessage).not.toMatch(/Hidden tail marker/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const contextEvent = events.find(
    (event) => event.type === "context_attachment",
  );
  expect(contextEvent).toBeTruthy();
  expect("content" in contextEvent.payload).toBe(false);
  expect(JSON.stringify(contextEvent.payload)).not.toMatch(
    /Hidden tail marker/,
  );
});

test("a Context Attachment does not grant tool access outside the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-context-scope-"),
  );
  await writeFile(join(workspaceRoot, "allowed.txt"), "allowed\n", "utf8");
  await writeFile(join(workspaceRoot, "issue.md"), "attached issue\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "issue.md" } },
      ],
    },
    { content: "The attachment did not expand tool access.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "use the attachment",
    contextFiles: ["issue.md"],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  expect(
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "user",
    )?.content,
  ).toMatch(/attached issue/);
  expect(
    JSON.parse(modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}"),
  ).toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  });
});

test("a coding Session can inspect a truncated git diff without storing the full diff in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-git-diff-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ activeContext: { maxConversationBytes: 200_000 } }),
    "utf8",
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "review.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "review.txt"]);
  const changedContent = `changed\n${"x".repeat(25 * 1024)}\nHidden diff tail marker\n`;
  await writeFile(join(workspaceRoot, "review.txt"), changedContent, "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "I reviewed the diff.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "review the diff",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff"),
  ).toBe(true);
  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.toolName).toBe("git_diff");
  expect(observation.metadata.truncated).toBe(true);
  expect(observation.metadata.returnedBytes).toBe(20 * 1024);
  expect(observation.content).toMatch(/Git diff stat:/);
  expect(observation.content).toMatch(/review\.txt/);
  expect(observation.content).toMatch(/Git diff:/);
  expect(observation.content).toMatch(/changed/);
  expect(observation.content).toMatch(
    /\[truncated: showing 20480 of \d+ bytes\]/,
  );
  expect(observation.content).not.toMatch(/Hidden diff tail marker/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const diffResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "git_diff",
  );
  expect(diffResult).toBeTruthy();
  expect("content" in diffResult.payload).toBe(false);
  expect(diffResult.payload.truncated).toBe(true);
  expect(JSON.stringify(diffResult.payload)).not.toMatch(
    /Hidden diff tail marker/,
  );
});

test("a coding Session exposes only registry-projected tool schemas to the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-tools-"));
  const modelClient = new FakeModelClient([
    { content: "Tools inspected.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "inspect available tools",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const tools = modelClient.turnInputs[0]?.tools ?? [];
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_files",
    "search_text",
    "workspace_summary",
    "read_file",
    "git_status",
    "git_diff",
    "update_plan",
  ]);
  expect(tools.some((tool) => "execute" in tool)).toBe(false);
  expect(tools.some((tool) => "providerId" in tool)).toBe(false);
  expect(tools.some((tool) => "capability" in tool)).toBe(false);
});

test("a learning Session exposes only plan updates to the model", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-learning-tools-"),
  );
  await writeFile(
    join(workspaceRoot, "paper.md"),
    "# Paper\nSource text.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "## Summary\nLearned from the source.", toolCalls: [] },
  ]);

  await runLearningSession({
    task: "teach me the core ideas",
    contextFiles: ["paper.md"],
    workspaceRoot,
    modelClient,
  });

  const tools = modelClient.turnInputs[0]?.tools ?? [];
  expect(tools.map((tool) => tool.name)).toEqual(["update_plan"]);
  expect(tools.some((tool) => tool.name === "read_file")).toBe(false);
  expect(tools.some((tool) => tool.name === "git_diff")).toBe(false);
  expect(tools.some((tool) => tool.name === "apply_patch")).toBe(false);
  expect(tools.some((tool) => tool.name === "run_command")).toBe(false);
});

test("a learning Session normalizes model output into a source-linked Learning Pack", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-learning-pack-"),
  );
  await writeFile(
    join(workspaceRoot, "paper.md"),
    "# Paper\nSource text.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "These are the core ideas.", toolCalls: [] },
  ]);

  const result = await runLearningSession({
    task: "teach me the core ideas",
    contextFiles: ["paper.md"],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/## Summary\nThese are the core ideas\./);
  expect(result.summary).toMatch(/## Key Concepts/);
  expect(result.summary).toMatch(/## Source Links/);
  expect(result.summary).toMatch(/- file: paper\.md/);
  expect(result.summary).toMatch(/title: paper\.md/);
  expect(result.summary).toMatch(/uri: paper\.md/);
  expect(result.summary).toMatch(/contentHash: [a-f0-9]{64}/);
  expect(result.summary).toMatch(/contentBytes: 21/);
  expect(result.summary).toMatch(/## Open Questions/);
  expect(result.summary).toMatch(/## Review Prompts/);

  const systemMessage =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";
  expect(systemMessage).toMatch(/source-backed Learning Workflow Session/);
  expect(systemMessage).toMatch(/Learning Pack/);
  expect(systemMessage).toMatch(/Source Links/);
  expect(systemMessage).toMatch(
    /Durable Memory as preference or terminology guidance/,
  );
  expect(systemMessage).toMatch(/note-writing/);
});

test("a Page Answer child Session finishes with a typed invalid_page_answer reason instead of the generic model-execution one", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-page-answer-invalid-"),
  );
  const pageContent = "The captured page says the sky is blue.";
  const modelClient = new FakeModelClient([
    {
      content:
        "## Answer\nThe sky is blue.\n## Evidence\n- a sentence the page never said",
      toolCalls: [],
    },
  ]);

  await expect(
    runLearningSession({
      deliverableShape: "pageAnswer",
      task: "why is the sky blue",
      contextFiles: [],
      workspaceRoot,
      modelClient,
      executionPolicy: "answer_once",
      browserSnapshot: {
        url: "https://example.com/sky",
        title: "Sky",
        capturedAt: "2026-07-12T00:00:00.000Z",
        contentKind: "mainText",
        content: pageContent,
        contentBytes: Buffer.byteLength(pageContent, "utf8"),
        contentHash: "a".repeat(64),
        preview: pageContent,
      },
    }),
  ).rejects.toThrow(
    "Page Answer Evidence excerpt does not match the captured page.",
  );

  const sessionFiles = await readdir(
    join(workspaceRoot, ".forgelet", "sessions"),
  );
  expect(sessionFiles).toHaveLength(1);
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", sessionFiles[0] ?? ""),
    "utf8",
  );
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished?.payload).toMatchObject({
    status: "failed",
    reason: "invalid_page_answer",
  });
});

test("the internal Page Answer continuation path launches a child Session with the right kind, deliverableShape, policy, continuation lineage, capture, and Page Conversation History, and no forbidden tools", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-page-answer-continuation-"),
  );
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_root.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-12T00:00:00.000Z",
        sessionId: "sess_root",
        payload: { workflow: "learning", startedAt: "2026-07-12T00:00:00.000Z" },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-07-12T00:00:00.000Z",
        sessionId: "sess_root",
        payload: { task: "Summarize the page." },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-07-12T00:00:01.000Z",
        sessionId: "sess_root",
        payload: { finalContent: "## Summary\nPage summary.\n\n## Key Concepts\nConcept." },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-07-12T00:00:01.000Z",
        sessionId: "sess_root",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const pageContent = "The captured page says the sky is blue.";
  const modelClient = new FakeModelClient([
    {
      content: "## Answer\nThe sky is blue.\n\n## Evidence\n- the sky is blue",
      toolCalls: [],
    },
  ]);

  const result = await runLearningSession({
    deliverableShape: "pageAnswer",
    task: "Why is the sky blue?",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    executionPolicy: "answer_once",
    continuationSourceSessionId: "sess_root",
    pageConversationHistory: [
      {
        sessionId: "sess_root",
        question: "Summarize the page.",
        answer: "## Summary\nPage summary.\n\n## Key Concepts\nConcept.",
      },
    ],
    browserSnapshot: {
      url: "https://example.com/sky",
      title: "Sky",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      content: pageContent,
      contentBytes: Buffer.byteLength(pageContent, "utf8"),
      contentHash: "a".repeat(64),
      preview: pageContent,
    },
  });

  expect(result.completion).toEqual({
    answer: "The sky is blue.",
    groundingStatus: "supported",
    evidence: ["the sky is blue"],
  });

  const sessionFiles = (
    await readdir(join(workspaceRoot, ".forgelet", "sessions"))
  ).filter((name) => name !== "sess_root.jsonl");
  expect(sessionFiles).toHaveLength(1);
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", sessionFiles[0] ?? ""),
    "utf8",
  );
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "session_started");
  expect(started?.payload).toMatchObject({
    workflow: "learning",
    deliverableShape: "pageAnswer",
    continuation: { sourceSessionId: "sess_root" },
  });

  expect(modelClient.turnInputs).toHaveLength(1);
  expect(modelClient.turnInputs[0]?.tools).toEqual([]);
  const promptContent =
    modelClient.turnInputs[0]?.messages.find((message) => message.role === "user")
      ?.content ?? "";
  expect(promptContent).toContain("Page Conversation History");
  expect(promptContent).toContain("Summarize the page.");
  expect(promptContent).toContain("Page summary.");
  expect(promptContent).toContain(pageContent);
  expect(promptContent).not.toMatch(/run_command|apply_patch|git_diff|web_search|web_read/);
});

test("answer_once performs exactly one successful model turn with no tool schemas, recorded as an explicit policy rather than a turn budget", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-answer-once-"));
  await writeFile(
    join(workspaceRoot, "paper.md"),
    "# Paper\nSource text.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "## Summary\nOne-turn answer.", toolCalls: [] },
  ]);

  const result = await runLearningSession({
    task: "summarize this page",
    contextFiles: ["paper.md"],
    workspaceRoot,
    modelClient,
    executionPolicy: "answer_once",
    maxModelTurns: 8,
  });

  expect(modelClient.turnInputs).toHaveLength(1);
  expect(modelClient.turnInputs[0]?.tools).toEqual([]);
  expect(result.session.stage).toBe("final");
  expect(result.summary).toMatch(/One-turn answer\./);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "session_started");
  expect(started?.payload.executionPolicy).toBe("answer_once");
  expect(started?.payload.limits ?? started?.payload).not.toMatchObject({
    maxModelTurns: 1,
  });
  expect(events.filter((event) => event.type === "model_turn")).toHaveLength(1);
});

test("normal iterative Learning is unaffected by the answer_once policy", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-learning-iterative-"),
  );
  await writeFile(
    join(workspaceRoot, "paper.md"),
    "# Paper\nSource text.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "## Summary\nFinal answer after thinking.", toolCalls: [] },
  ]);

  const result = await runLearningSession({
    task: "summarize this page",
    contextFiles: ["paper.md"],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs[0]?.tools).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "update_plan" })]),
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "session_started");
  expect(started?.payload.executionPolicy).toBe("iterative");
});

test("answer_once retries a transient model error within the same logical turn", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-answer-once-retry-"),
  );
  await writeFile(
    join(workspaceRoot, "paper.md"),
    "# Paper\nSource text.\n",
    "utf8",
  );
  let attempts = 0;
  const modelClient = {
    async createTurn() {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("transient network blip"), {
          causeCategory: "request_error",
        });
      }
      return { content: "## Summary\nRecovered answer.", toolCalls: [] };
    },
  };

  const result = await runLearningSession({
    task: "summarize this page",
    contextFiles: ["paper.md"],
    workspaceRoot,
    modelClient,
    executionPolicy: "answer_once",
  });

  expect(attempts).toBe(2);
  expect(result.summary).toMatch(/Recovered answer\./);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((event) => event.type === "model_turn")).toHaveLength(1);
  expect(
    events.filter((event) => event.type === "model_turn_retry"),
  ).toHaveLength(1);
  expect(
    events.find((event) => event.type === "model_turn")?.payload.turnIndex,
  ).toBe(0);
});

test("answer_once blocks tool calls returned on the single turn and finishes honestly", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-answer-once-blocked-"),
  );
  await writeFile(
    join(workspaceRoot, "paper.md"),
    "# Paper\nSource text.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      content: "I need a tool.",
      toolCalls: [{ id: "call_1", name: "update_plan", input: { items: [] } }],
    },
  ]);

  const result = await runLearningSession({
    task: "summarize this page",
    contextFiles: ["paper.md"],
    workspaceRoot,
    modelClient,
    executionPolicy: "answer_once",
  });

  expect(modelClient.turnInputs).toHaveLength(1);
  expect(result.summary).toMatch(/Reason: answer_once_tool_calls_blocked/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished?.payload).toMatchObject({
    status: "stopped",
    reason: "answer_once_tool_calls_blocked",
  });
  expect(
    events.some((event) => event.type === "budget_blocked_tool_calls"),
  ).toBe(true);
});

test("cancellation before Session creation rejects the launch with no Trace, and repeated cancellation is idempotent", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cancel-preflight-"),
  );
  const controller = new AbortController();
  controller.abort();
  controller.abort();

  await expect(
    runCodingSession({
      task: "find the answer",
      contextFiles: [],
      workspaceRoot,
      modelClient: new FakeModelClient([{ content: "unused", toolCalls: [] }]),
      signal: controller.signal,
    }),
  ).rejects.toThrow(/cancel/i);

  const sessionDirExists = await readdir(
    join(workspaceRoot, ".forgelet", "sessions"),
  ).then(
    (entries) => entries.length > 0,
    () => false,
  );
  expect(sessionDirExists).toBe(false);
});

test("cancellation reaches an in-flight model call, stops the Session with Trace evidence, and is not retried", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cancel-inflight-"),
  );
  const controller = new AbortController();
  let createTurnCalls = 0;
  let markStarted: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const modelClient = {
    async createTurn(input: { signal?: AbortSignal }): Promise<never> {
      createTurnCalls += 1;
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          reject(
            Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            }),
          );
        });
      });
    },
  };

  const resultPromise = runCodingSession({
    task: "find the answer",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  controller.abort();
  const result = await resultPromise;

  expect(createTurnCalls).toBe(1);
  expect(result.summary).toMatch(/Reason: user_stopped/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished?.payload).toMatchObject({
    status: "stopped",
    reason: "user_stopped",
  });
});

test("a transport failure unrelated to the owned cancellation signal is not converted to user_stopped", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cancel-unrelated-"),
  );
  const controller = new AbortController();
  const modelClient = {
    async createTurn() {
      throw Object.assign(new Error("Connection reset by peer."), {
        name: "AbortError",
      });
    },
  };

  await expect(
    runCodingSession({
      task: "find the answer",
      contextFiles: [],
      workspaceRoot,
      modelClient,
      signal: controller.signal,
    }),
  ).rejects.toThrow("Connection reset by peer.");

  expect(controller.signal.aborted).toBe(false);
});

test("cancellation before completion effects stops the Session instead of running onCompleted side effects", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cancel-completion-"),
  );
  const controller = new AbortController();
  let onCompletedCalled = false;
  const definition: WorkflowDefinition = {
    kind: "coding",
    async loadAttachments() {
      return { contextAttachments: [] };
    },
    capabilities() {
      return ["update_plan", "model_generate_text"];
    },
    systemPrompt() {
      return "test system prompt";
    },
    async onCompleted() {
      onCompletedCalled = true;
      return {};
    },
  };
  const modelClient = {
    async createTurn() {
      controller.abort();
      return { content: "Final answer.", toolCalls: [] };
    },
  };

  const result = await runKernelSession({
    task: "find the answer",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    definition,
    signal: controller.signal,
  });

  expect(onCompletedCalled).toBe(false);
  expect(result.summary).toMatch(/Reason: user_stopped/);
});

test("an actionable coding Session can patch, run a configured command, inspect diff, and finish", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-actionable-session-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const command = `${process.execPath} -e "console.log('verified')"`;
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ safeCommands: [command], commandTimeoutMs: 5_000 }),
    "utf8",
  );
  await execGit(workspaceRoot, ["add", ".forgelet/config.json"]);
  await execGit(workspaceRoot, ["commit", "-m", "configure safe commands"]);
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-original",
    "+changed",
    "",
  ].join("\n");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "example.txt" } },
      ],
    },
    {
      toolCalls: [{ id: "call_patch", name: "apply_patch", input: { patch } }],
    },
    {
      toolCalls: [
        { id: "call_command", name: "run_command", input: { command } },
      ],
    },
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "Changed example.txt and verified the result.", toolCalls: [] },
  ]);
  const liveEvents: SessionLiveEvent[] = [];

  const result = await runCodingSession({
    task: "change example",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
    onLiveEvent: (event) => {
      liveEvents.push(event);
    },
  });

  expect(modelClient.turnInputs[0]?.tools.map((tool) => tool.name)).toEqual([
    "list_files",
    "search_text",
    "workspace_summary",
    "read_file",
    "git_status",
    "git_diff",
    "update_plan",
    "apply_patch",
    "run_command",
  ]);
  await expect(
    readFile(join(workspaceRoot, "example.txt"), "utf8"),
  ).resolves.toBe("changed\n");
  expect(result.summary).toMatch(/Changed example\.txt and verified/);
  expect(result.summary).toMatch(/Audit/);
  expect(result.summary).toMatch(/Forgelet changed: example\.txt/);
  expect(result.summary).toMatch(
    new RegExp(`Command: ${escapeRegExp(command)} \\(exit 0\\)`),
  );
  expect(result.summary).toMatch(/Trace:/);
  expect(liveEvents).toContainEqual({
    type: "permission_checkpoint",
    toolName: "apply_patch",
    decision: "confirm",
  });
  expect(liveEvents).toContainEqual({
    type: "command_started",
    command,
  });
  expect(liveEvents).toContainEqual({
    type: "command_finished",
    command,
    exitCode: 0,
    timedOut: false,
  });
  expect(liveEvents).toContainEqual({
    type: "session_finished",
    status: "completed",
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "workspace_baseline")).toBe(
    true,
  );
  expect(events.some((event) => event.type === "approval_decision")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "tool_result" &&
        event.payload.toolName === "run_command",
    ),
  ).toBe(true);
  const finalSummary = events.find((event) => event.type === "final_summary");
  expect(finalSummary?.payload.audit).toEqual({
    changeGroups: {
      forgeletChanged: ["example.txt"],
      preExistingAtSessionStart: [],
      otherCurrentWorkspaceChanges: [],
    },
    verificationCommands: [{ command, exitCode: 0, timedOut: false }],
    kernelObservedRisks: [],
    modelTurns: 5,
    estimatedCostUsd: 0,
    tracePath: result.tracePath,
  });
});

test("an actionable Session Continuation audit separates inherited and child changes", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-actionable-continuation-audit-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(
    join(workspaceRoot, "parent.txt"),
    "parent baseline\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "child.txt"), "child baseline\n", "utf8");
  await execGit(workspaceRoot, ["add", "parent.txt", "child.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await writeFile(join(workspaceRoot, "parent.txt"), "parent dirty\n", "utf8");
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_parent.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_parent",
        payload: {
          summary: "Changed parent.txt.",
          audit: {
            changeGroups: {
              forgeletChanged: ["parent.txt"],
              preExistingAtSessionStart: [],
              otherCurrentWorkspaceChanges: [],
            },
            verificationCommands: [
              { command: "npm test", exitCode: 0, timedOut: false },
            ],
            kernelObservedRisks: [],
            modelTurns: 2,
            estimatedCostUsd: 0.01,
            tracePath: ".forgelet/sessions/sess_parent.jsonl",
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  const patch = [
    "diff --git a/child.txt b/child.txt",
    "--- a/child.txt",
    "+++ b/child.txt",
    "@@ -1 +1 @@",
    "-child baseline",
    "+child changed",
    "",
  ].join("\n");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [{ id: "call_patch", name: "apply_patch", input: { patch } }],
    },
    { content: "Changed child.txt.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "finish the child change",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    continuationSourceSessionId: "sess_parent",
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finalSummary = events.find((event) => event.type === "final_summary");

  expect(finalSummary?.payload.audit.changeGroups).toMatchObject({
    inheritedForgeletChanged: ["parent.txt"],
    forgeletChanged: ["child.txt"],
    preExistingAtSessionStart: [],
    otherCurrentWorkspaceChanges: [],
  });
  expect(finalSummary?.payload.audit.verificationCommands).toEqual([]);
  expect(finalSummary?.payload.audit.kernelObservedRisks).toEqual([
    {
      kind: "verification_missing",
      message: "No verification command was run for the Forgelet changes.",
    },
  ]);
});

test("an actionable Session Continuation can continue editing a parent-owned dirty file", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-continuation-owned-dirty-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(
    join(workspaceRoot, "parent.txt"),
    "# Parent\n- parent-created\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_parent.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_parent",
        payload: {
          summary: "Created parent.txt.",
          audit: {
            changeGroups: {
              forgeletChanged: ["parent.txt"],
              preExistingAtSessionStart: [],
              otherCurrentWorkspaceChanges: [],
            },
            verificationCommands: [
              { command: "npm test", exitCode: 0, timedOut: false },
            ],
            kernelObservedRisks: [],
            modelTurns: 2,
            estimatedCostUsd: 0.01,
            tracePath: ".forgelet/sessions/sess_parent.jsonl",
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  const patch = [
    "diff --git a/parent.txt b/parent.txt",
    "--- a/parent.txt",
    "+++ b/parent.txt",
    "@@ -1,2 +1,3 @@",
    " # Parent",
    " - parent-created",
    "+- child-confirmed",
    "",
  ].join("\n");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [{ id: "child_patch", name: "apply_patch", input: { patch } }],
    },
    { content: "Updated parent.txt.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "continue editing the parent file",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    continuationSourceSessionId: "sess_parent",
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  await expect(
    readFile(join(workspaceRoot, "parent.txt"), "utf8"),
  ).resolves.toBe("# Parent\n- parent-created\n- child-confirmed\n");
  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find(
      (event) =>
        event.type === "permission_decision" &&
        event.payload.toolCallId === "child_patch",
    )?.payload,
  ).toMatchObject({
    decision: "confirm",
    riskTier: "medium",
  });
  const finalSummary = events.find((event) => event.type === "final_summary");
  expect(finalSummary?.payload.audit.changeGroups).toMatchObject({
    inheritedForgeletChanged: ["parent.txt"],
    forgeletChanged: ["parent.txt"],
    preExistingAtSessionStart: [],
  });
});

test("an actionable Session Continuation still rejects user-owned dirty files", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-continuation-user-dirty-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "parent.txt"), "parent change\n", "utf8");
  await writeFile(join(workspaceRoot, "user.txt"), "user dirty\n", "utf8");
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_parent.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_parent",
        payload: {
          summary: "Created parent.txt.",
          audit: {
            changeGroups: {
              forgeletChanged: ["parent.txt"],
              preExistingAtSessionStart: [],
              otherCurrentWorkspaceChanges: [],
            },
            verificationCommands: [],
            kernelObservedRisks: [],
            modelTurns: 2,
            estimatedCostUsd: 0.01,
            tracePath: ".forgelet/sessions/sess_parent.jsonl",
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  const patch = [
    "diff --git a/user.txt b/user.txt",
    "--- a/user.txt",
    "+++ b/user.txt",
    "@@ -1 +1 @@",
    "-user dirty",
    "+user changed",
    "",
  ].join("\n");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [{ id: "user_patch", name: "apply_patch", input: { patch } }],
    },
    { content: "Patch was rejected.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "try editing a user-owned dirty file",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    continuationSourceSessionId: "sess_parent",
    approvalHandler: async () => {
      throw new Error("User-owned dirty files should not request approval.");
    },
  });

  await expect(readFile(join(workspaceRoot, "user.txt"), "utf8")).resolves.toBe(
    "user dirty\n",
  );
  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find(
      (event) =>
        event.type === "permission_decision" &&
        event.payload.toolCallId === "user_patch",
    )?.payload,
  ).toMatchObject({
    decision: "deny",
    riskTier: "forbidden",
  });
  const finalSummary = events.find((event) => event.type === "final_summary");
  expect(finalSummary?.payload.audit.changeGroups).toMatchObject({
    inheritedForgeletChanged: ["parent.txt"],
    forgeletChanged: [],
    preExistingAtSessionStart: ["user.txt"],
  });
  expect(finalSummary?.payload.audit.kernelObservedRisks).toContainEqual({
    kind: "pre_existing_workspace_changes",
    message: "Pre-existing workspace changes were present at Session start.",
    paths: ["user.txt"],
  });
});

test("an actionable Session Continuation does not inherit parent approval", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-continuation-approval-boundary-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_parent.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "permission_decision",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_parent",
        payload: {
          toolCallId: "parent_patch",
          toolName: "apply_patch",
          capability: "write_workspace",
          decision: "confirm",
        },
      }),
      JSON.stringify({
        type: "approval_decision",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: {
          toolCallId: "parent_patch",
          toolName: "apply_patch",
          status: "approved",
          reason: "Approved in parent Session.",
        },
      }),
      JSON.stringify({
        type: "tool_result",
        ts: "2026-06-20T00:00:03.000Z",
        sessionId: "sess_parent",
        payload: {
          ok: true,
          toolCallId: "parent_patch",
          toolName: "apply_patch",
          summary: "Applied patch to 1 file(s).",
          changedFiles: ["old.txt"],
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:04.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-original",
    "+changed",
    "",
  ].join("\n");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [{ id: "child_patch", name: "apply_patch", input: { patch } }],
    },
    { content: "Patch was rejected in the child Session.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "try the child patch",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    continuationSourceSessionId: "sess_parent",
    approvalHandler: async () => ({
      status: "rejected",
      reason: "Rejected in child Session.",
    }),
  });

  await expect(
    readFile(join(workspaceRoot, "example.txt"), "utf8"),
  ).resolves.toBe("original\n");
  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "approval_decision")?.payload,
  ).toMatchObject({
    toolCallId: "child_patch",
    status: "rejected",
    reason: "Rejected in child Session.",
  });
  expect(
    events.find(
      (event) =>
        event.type === "tool_result" &&
        event.payload.toolCallId === "child_patch",
    )?.payload,
  ).toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  });
});

test("an actionable coding Session prompts the model with action and approval boundaries", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-action-prompt-"),
  );
  const modelClient = new FakeModelClient([
    { content: "I will use approved tools only.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "make a safe edit",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
  });

  const systemPrompt =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";

  expect(systemPrompt).toMatch(/apply_patch/);
  expect(systemPrompt).toMatch(/run_command/);
  expect(systemPrompt).toMatch(/permission and approval/);
  expect(systemPrompt).toMatch(/workspace_summary/);
  expect(systemPrompt).not.toMatch(
    /do not claim to write files or run commands/,
  );
});

test("a read-only coding Session prompts the model to use workspace_summary for unfamiliar workspaces", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-summary-prompt-"),
  );
  const modelClient = new FakeModelClient([
    { content: "I will summarize the workspace first.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "understand this workspace",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const systemPrompt =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";

  expect(systemPrompt).toMatch(/workspace_summary/);
  expect(systemPrompt).toMatch(/unfamiliar workspace/);
  expect(systemPrompt).toMatch(/search_text/);
  expect(systemPrompt).toMatch(/read_file/);
  expect(systemPrompt).toMatch(/git_status/);
  expect(systemPrompt).toMatch(/git_diff/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a writing Session requesting git_diff receives a controlled registry denial", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-git-"));
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "I cannot inspect git diffs in this workflow.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    task: "review git diff",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/cannot inspect git diffs/);
  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff"),
  ).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "").toMatch(
    /permission_denied/,
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const denial = events.find(
    (event) =>
      event.type === "permission_decision" &&
      event.payload.toolName === "git_diff",
  );
  expect(denial).toBeTruthy();
  expect(denial.payload.decision).toBe("deny");
  expect(denial.payload.reason).toBe("Capability not granted: git_read");
});

test("a writing Session returns the V1 Critique Revision Notes shape", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-writing-shape-"),
  );
  await writeFile(
    join(workspaceRoot, "draft.md"),
    "This draft is wordy.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Make it shorter.", toolCalls: [] },
  ]);

  const result = await runWritingSession({
    task: "revise for clarity",
    contextFiles: ["draft.md"],
    workspaceRoot,
    modelClient,
  });

  const systemPrompt =
    modelClient.turnInputs[0]?.messages.find(
      (message) => message.role === "system",
    )?.content ?? "";

  expect(systemPrompt).toMatch(/Critique, Revision, Notes/);
  expect(systemPrompt).toMatch(
    /do not request workspace, git, shell, patch, or command tools/,
  );
  expect(systemPrompt).not.toMatch(/workspace_summary/);
  expect(result.summary).toMatch(/Critique\n/);
  expect(result.summary).toMatch(/Revision\nMake it shorter\./);
  expect(result.summary).toMatch(/Notes\n/);
});

test("an ungranted tool call returns a denial observation and the Session can recover", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-deny-"));
  await writeFile(join(workspaceRoot, "draft.md"), "private draft\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "draft.md" } },
      ],
    },
    {
      content: "I cannot read workspace files in this workflow.",
      toolCalls: [],
    },
  ]);

  const result = await runWritingSession({
    task: "revise draft",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/I cannot read workspace files/);
  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "read_file"),
  ).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "").toMatch(
    /permission_denied/,
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const denial = events.find(
    (event) =>
      event.type === "permission_decision" &&
      event.payload.toolName === "read_file",
  );
  expect(denial).toBeTruthy();
  expect(denial.payload.decision).toBe("deny");
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished.payload.status).toBe("completed");
});

test("a one-turn Session reserves its only model turn for a final answer", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-budget-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 1 } }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 },
      content: "A direct final answer.",
      toolCalls: [],
    },
  ]);

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs.length).toBe(1);
  expect(modelClient.turnInputs[0]?.tools).toEqual([]);
  expect(result.summary).toMatch(/A direct final answer/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const modelTurn = events.find((event) => event.type === "model_turn");
  expect(modelTurn.payload.finalOnly).toBe(true);
  const budgetUpdate = events.find((event) => event.type === "budget_update");
  expect(budgetUpdate.payload.usage.modelTurns).toBe(1);
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished.payload.status).toBe("completed");
});

test("a Session warns on its final tool turn and then removes tools for the final answer", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-final-turn-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 2 } }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
    },
    { content: "The final answer uses the listed files.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs[0]?.tools.length).toBeGreaterThan(0);
  expect(modelClient.turnInputs[0]?.messages.at(-1)?.content).toMatch(
    /final tool-capable turn/,
  );
  expect(modelClient.turnInputs[1]?.tools).toEqual([]);
  expect(
    modelClient.turnInputs[1]?.messages.some(
      (message) =>
        message.role === "tool" || (message.toolCalls?.length ?? 0) > 0,
    ),
  ).toBe(false);
  expect(
    modelClient.turnInputs[1]?.messages.some((message) =>
      message.content.includes("Listed"),
    ),
  ).toBe(true);
  expect(modelClient.turnInputs[1]?.messages[0]?.content).not.toMatch(
    /FINAL ANSWER ONLY/,
  );
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content).toMatch(
    /FINAL ANSWER ONLY/,
  );
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content).toMatch(
    /reserved final answer turn/,
  );
  expect(result.summary).toMatch(/The final answer uses the listed files/);

  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events
      .filter((event) => event.type === "model_turn")
      .map((event) => event.payload.finalOnly),
  ).toEqual([false, true]);
});

test("tool calls returned on the final answer turn are blocked", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-final-turn-tools-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 1 } }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      content: "I still want to inspect.",
      toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
    },
  ]);

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Reason: max_model_turns/);
  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "tool_call")).toBe(false);
  expect(
    events.find((event) => event.type === "budget_blocked_tool_calls")?.payload,
  ).toEqual({
    reason: "max_model_turns",
    skippedCount: 1,
    toolNames: ["list_files"],
  });
  expect(
    events.find((event) => event.type === "session_finished")?.payload,
  ).toMatchObject({ status: "stopped", reason: "max_model_turns" });
});

test("textual tool-call markup is not accepted as a final answer", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-final-turn-markup-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 1 } }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      content: [
        "<｜｜DSML｜｜tool_calls>",
        '<｜｜DSML｜｜invoke name="read_file">',
        "</｜｜DSML｜｜invoke>",
        "</｜｜DSML｜｜tool_calls>",
      ].join("\n"),
      toolCalls: [],
    },
  ]);

  const result = await runCodingSession({
    task: "answer directly",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Reason: max_model_turns/);
  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "session_finished")?.payload,
  ).toMatchObject({ status: "stopped", reason: "max_model_turns" });
});

test("empty content on the final answer turn stops the Session", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-empty-final-turn-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 1 } }),
    "utf8",
  );
  const modelClient = new FakeModelClient([{ content: "   ", toolCalls: [] }]);

  const result = await runCodingSession({
    task: "answer directly",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/Reason: max_model_turns/);
  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "session_finished")?.payload,
  ).toMatchObject({ status: "stopped", reason: "max_model_turns" });
});

test("empty final content before the reserved turn is retried", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-empty-final-retry-"),
  );
  const modelClient = new FakeModelClient([
    { content: "   ", toolCalls: [] },
    { content: "A usable answer.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "answer after retry",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs).toHaveLength(2);
  expect(result.summary).toMatch(/A usable answer/);
});

test("input-token telemetry does not stop a Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-input-budget-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      budgets: {
        maxModelTurns: 8,
        maxEstimatedCostUsd: 0.25,
      },
    }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      usage: { inputTokens: 101, outputTokens: 7, estimatedCostUsd: 0.01 },
      content: "I need another turn.",
      toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
    },
    { content: "The second turn is allowed.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "inspect files despite high token telemetry",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs.length).toBe(2);
  expect(result.summary).toMatch(/The second turn is allowed/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished.payload.status).toBe("completed");
  const budgetUpdate = events.find((event) => event.type === "budget_update");
  expect(budgetUpdate.payload.limits).not.toHaveProperty("maxInputTokens");
});

test("input-token telemetry does not block actionable tool calls", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-budget-block-tool-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      budgets: {
        maxModelTurns: 8,
        maxEstimatedCostUsd: 0.25,
      },
    }),
    "utf8",
  );
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-original",
    "+changed",
    "",
  ].join("\n");
  const modelClient = new FakeModelClient([
    {
      usage: { inputTokens: 101, outputTokens: 7, estimatedCostUsd: 0.01 },
      content: "I will patch this file.",
      toolCalls: [{ id: "call_patch", name: "apply_patch", input: { patch } }],
    },
    { content: "The patch was applied.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "change example despite high token telemetry",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  expect(modelClient.turnInputs.length).toBe(2);
  await expect(
    readFile(join(workspaceRoot, "example.txt"), "utf8"),
  ).resolves.toBe("changed\n");
  expect(result.summary).toMatch(/The patch was applied/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "tool_call")).toBe(true);
  expect(events.some((event) => event.type === "budget_blocked_tool_calls")).toBe(false);
});

test("large read_file observations are truncated for the model and not stored fully in trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-truncate-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ activeContext: { maxConversationBytes: 200_000 } }),
    "utf8",
  );
  const largeContent = `start\n${"x".repeat(25 * 1024)}\nneedle-at-end\n`;
  await writeFile(join(workspaceRoot, "large.txt"), largeContent, "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "large.txt" } },
      ],
    },
    { content: "The large file was truncated.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "read the large file",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.metadata.truncated).toBe(true);
  expect(observation.metadata.totalBytes).toBe(
    Buffer.byteLength(largeContent, "utf8"),
  );
  expect(observation.content.length).toBe(20 * 1024);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult.payload.truncated).toBe(true);
  expect(readResult.payload.totalBytes).toBe(
    Buffer.byteLength(largeContent, "utf8"),
  );
  expect("content" in readResult.payload).toBe(false);
  expect(String(readResult.payload.preview)).not.toMatch(/needle-at-end/);
});

test("a fresh observation batch is visible in full once before compaction", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-fresh-batch-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ activeContext: { maxConversationBytes: 4_096 } }),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "first.txt"), "a".repeat(6_000), "utf8");
  await writeFile(join(workspaceRoot, "second.txt"), "b".repeat(6_000), "utf8");
  await writeFile(join(workspaceRoot, "third.txt"), "third", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_first", name: "read_file", input: { path: "first.txt" } },
        { id: "call_second", name: "read_file", input: { path: "second.txt" } },
      ],
    },
    {
      toolCalls: [
        { id: "call_third", name: "read_file", input: { path: "third.txt" } },
      ],
    },
    { content: "All evidence inspected.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "inspect all evidence",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const freshBatch = modelClient.turnInputs[1]?.messages.filter(
    (message) => message.role === "tool",
  );
  expect(freshBatch).toHaveLength(2);
  expect(
    freshBatch?.map((message) => JSON.parse(message.content).compacted),
  ).toEqual([undefined, undefined]);

  const laterObservations = modelClient.turnInputs[2]?.messages.filter(
    (message) => message.role === "tool",
  );
  expect(
    laterObservations
      ?.slice(0, 2)
      .map((message) => JSON.parse(message.content).compacted),
  ).toEqual([true, true]);
  expect(JSON.parse(laterObservations?.[2]?.content ?? "{}").compacted).toBe(
    undefined,
  );
});

test("read_file can continue from a byte offset without returning the first chunk again", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-byte-range-"));
  const content = `${"a".repeat(64)}SECOND_CHUNK${"b".repeat(64)}`;
  await writeFile(join(workspaceRoot, "range.txt"), content, "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "range.txt", offsetBytes: 64, limitBytes: 12 },
        },
      ],
    },
    { content: "Read the requested byte range.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "read a later byte range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("SECOND_CHUNK");
  expect(observation.metadata.rangeKind).toBe("byte");
  expect(observation.metadata.offsetBytes).toBe(64);
  expect(observation.metadata.limitBytes).toBe(12);
  expect(observation.metadata.returnedStartByte).toBe(64);
  expect(observation.metadata.returnedEndByte).toBe(76);
  expect(observation.metadata.nextOffsetBytes).toBe(76);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult.payload.rangeKind).toBe("byte");
  expect(readResult.payload.returnedStartByte).toBe(64);
  expect(readResult.payload.returnedEndByte).toBe(76);
});

test("read_file can return a one-based line range without line number prefixes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-line-range-"));
  await writeFile(
    join(workspaceRoot, "lines.ts"),
    ["line one", "line two", "line three", "line four"].join("\n"),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "lines.ts", startLine: 2, lineCount: 2 },
        },
      ],
    },
    { content: "Read the requested line range.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "read a line range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("line two\nline three");
  expect(observation.content).not.toMatch(/^2:/);
  expect(observation.metadata.rangeKind).toBe("line");
  expect(observation.metadata.startLine).toBe(2);
  expect(observation.metadata.lineCount).toBe(2);
  expect(observation.metadata.returnedStartLine).toBe(2);
  expect(observation.metadata.returnedEndLine).toBe(3);
});

test("read_file tail reads return the end of a file instead of the first chunk", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-tail-range-"));
  await writeFile(
    join(workspaceRoot, "tail.txt"),
    ["first line", "middle line", "tail one", "tail two"].join("\n"),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "tail.txt", tailLines: 2 },
        },
      ],
    },
    { content: "Read the tail.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "read the file tail",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("tail one\ntail two");
  expect(observation.content).not.toMatch(/first line/);
  expect(observation.metadata.rangeKind).toBe("tail");
  expect(observation.metadata.tailLines).toBe(2);
  expect(observation.metadata.returnedStartLine).toBe(3);
  expect(observation.metadata.returnedEndLine).toBe(4);
});

test("read_file rejects conflicting range modes as invalid input", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-range-conflict-"),
  );
  await writeFile(join(workspaceRoot, "conflict.txt"), "one\ntwo\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: {
            path: "conflict.txt",
            startLine: 1,
            lineCount: 1,
            tailLines: 1,
          },
        },
      ],
    },
    { content: "Saw the range conflict.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "read conflicting ranges",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(false);
  expect(observation.error.code).toBe("invalid_input");
  expect(observation.error.message).toMatch(
    /range modes are mutually exclusive/i,
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult.payload.ok).toBe(false);
  expect(readResult.payload.error.code).toBe("invalid_input");
});

test("read_file byte ranges beyond the end return an empty successful observation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-range-eof-"));
  await writeFile(join(workspaceRoot, "short.txt"), "short", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "short.txt", offsetBytes: 100, limitBytes: 10 },
        },
      ],
    },
    { content: "Saw the empty range.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "read beyond eof",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("");
  expect(observation.metadata.rangeKind).toBe("byte");
  expect(observation.metadata.totalBytes).toBe(5);
  expect(observation.metadata.returnedBytes).toBe(0);
  expect(observation.metadata.returnedStartByte).toBe(5);
  expect(observation.metadata.returnedEndByte).toBe(5);
  expect(observation.metadata.nextOffsetBytes).toBeUndefined();
});

test("read_file rejects zero as a one-based start line", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-line-zero-"));
  await writeFile(join(workspaceRoot, "lines.txt"), "one\ntwo\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "lines.txt", startLine: 0, lineCount: 1 },
        },
      ],
    },
    { content: "Saw the invalid line range.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "read invalid line range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(false);
  expect(observation.error.code).toBe("invalid_input");
  expect(observation.error.message).toMatch(
    /positive integer input: startLine/,
  );
});

test("update_plan records the changed Session plan in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-plan-"));
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_plan",
          name: "update_plan",
          input: {
            items: [
              { step: "Inspect workspace", status: "completed" },
              { step: "Answer user", status: "in_progress" },
            ],
          },
        },
      ],
    },
    { content: "Plan updated and answer prepared.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "make a plan",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const planUpdates = events.filter((event) => event.type === "plan_update");
  expect(planUpdates.length).toBe(2);
  expect(planUpdates.at(-1)?.payload.plan.items).toEqual([
    { step: "Inspect workspace", status: "completed" },
    { step: "Answer user", status: "in_progress" },
  ]);
});

test("update_plan tells the model the required plan item shape", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-plan-schema-"));
  const modelClient = new FakeModelClient([
    { content: "No plan update needed.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "inspect the plan tool",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const updatePlan = modelClient.turnInputs[0]?.tools.find(
    (tool) => tool.name === "update_plan",
  );
  expect(updatePlan?.inputSchema).toEqual({
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  });
});

test("read-only tools do not follow workspace symlinks outside the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-symlink-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "forgelet-outside-"));
  await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n", "utf8");
  await symlink(
    join(outsideRoot, "secret.txt"),
    join(workspaceRoot, "secret-link.txt"),
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "secret-link.txt" },
        },
      ],
    },
    { content: "The file is outside the workspace.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "read symlink",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "";
  expect(toolMessage).toMatch(/outside workspace/);
  expect(toolMessage).not.toMatch(/outside secret/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult.payload.ok).toBe(false);
  expect(readResult.payload.error.code).toBe("invalid_input");
});

test("a Session Read Scope denies symlinks that escape an allowed directory", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-scope-symlink-"),
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), "forgelet-scope-outside-"));
  await mkdir(join(workspaceRoot, "allowed"), { recursive: true });
  await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n", "utf8");
  await symlink(
    join(outsideRoot, "secret.txt"),
    join(workspaceRoot, "allowed", "secret-link.txt"),
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "allowed/secret-link.txt" },
        },
      ],
    },
    { content: "The escaping symlink was denied.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "read allowed files",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(observation).toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  });
  expect(JSON.stringify(observation)).not.toMatch(/outside secret/);
});

test("Session Read Scope entries are literal paths rather than globs", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-literal-scope-"),
  );
  await writeFile(join(workspaceRoot, "*.txt"), "needle literal\n", "utf8");
  await writeFile(join(workspaceRoot, "secret.txt"), "needle secret\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_search", name: "search_text", input: { query: "needle" } },
      ],
    },
    { content: "The literal path was searched.", toolCalls: [] },
  ]);

  await runCodingSession({
    task: "search the literal file",
    contextFiles: [],
    allowedReadPaths: ["*.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-2)?.content ?? "{}",
  );
  expect(observation.content).toMatch(/\*\.txt/);
  expect(observation.content).not.toMatch(/secret\.txt/);
});

function execGit(workspaceRoot: string, args: string[]): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        ...args,
      ],
      { cwd: workspaceRoot },
      (error) => {
        if (error) rejectExec(error);
        else resolveExec();
      },
    );
  });
}
