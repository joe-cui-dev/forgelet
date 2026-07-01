import { expect, test } from "@jest/globals";
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runAgent } from "../../src/agent/runAgent.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import type { SessionLiveEvent } from "../../src/sessionLiveView/index.js";

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

  const result = await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
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
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-model-failure-"));
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
    runAgent({
      workflow: "writing",
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

  const sessionFiles = await readdir(join(workspaceRoot, ".forgelet", "sessions"));
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

  const result = await runAgent({
    workflow: "coding",
    task: "continue with the inherited clue",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    continuationSourceSessionId: "sess_parent",
  });

  const firstUserMessage =
    modelClient.turnInputs[0]?.messages.find((message) => message.role === "user")
      ?.content ?? "";
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

  await expect(readFile(parentTracePath, "utf8")).resolves.toBe(parentTraceBefore);
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
  const loaded = events.find((event) => event.type === "continuation_context_loaded");
  expect(loaded?.payload).toMatchObject({
    priorChangedFiles: 1,
    priorVerificationCommands: 1,
    priorRisks: 1,
    inheritedChangedPaths: ["src/foo.ts"],
  });
});

test("a creative writing Session returns a Revision Pack", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-creative-loop-"));
  await writeFile(join(workspaceRoot, "draft.md"), "The room was cold.\n", "utf8");
  const modelClient = new FakeModelClient([
    { content: "The room breathed winter through the walls.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "writing",
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
  const artifact = await readFile(
    join(workspaceRoot, result.writingArtifact?.path ?? ""),
    "utf8",
  );
  expect(artifact).toBe("The room breathed winter through the walls.\n");

  const systemMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "system",
  )?.content ?? "";
  expect(systemMessage).toMatch(/Return a Revision Pack/);
  expect(systemMessage).not.toMatch(/Return a Draft Pack/);
});

test("a prompt-only Creative Brief returns only a Draft without context attachments", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-creative-brief-"));
  const modelClient = new FakeModelClient([
    { content: "Rain silvered the convenience store windows.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid",
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
  const artifact = await readFile(
    join(workspaceRoot, result.writingArtifact?.path ?? ""),
    "utf8",
  );
  expect(artifact).toBe("Rain silvered the convenience store windows.\n");

  const firstUserMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "user",
  )?.content ?? "";
  expect(firstUserMessage).toMatch(
    /Creative brief: write a rain-soaked convenience store scene/,
  );
  expect(firstUserMessage).not.toMatch(/Context attachments:/);
  const systemMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "system",
  )?.content ?? "";
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
  const artifactEvent = events.find((event) => event.type === "writing_artifact");
  expect(artifactEvent?.payload).toMatchObject({
    path: result.writingArtifact?.path,
    contentKind: "draft",
  });
});

test("a creative Writing Artifact Continuation labels the source separately in the model prompt", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-continuation-"));
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Mara opened the brass door.\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "She stepped into a room full of rain.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    continuationFile: ".forgelet/writing/chapter-1.md",
    task: "continue the next chapter",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const firstUserMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "user",
  )?.content ?? "";
  expect(firstUserMessage).toMatch(/Continuation source:/);
  expect(firstUserMessage).toMatch(/uri: \.forgelet\/writing\/chapter-1\.md/);
  expect(firstUserMessage).toMatch(/Mara opened the brass door/);
  expect(firstUserMessage).not.toMatch(/Context attachments:/);
  expect(firstUserMessage).not.toMatch(/Additional context attachments:/);
  expect(result.summary).toMatch(/She stepped into a room full of rain/);

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
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-continuation-context-"));
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

  const result = await runAgent({
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    continuationFile: ".forgelet/writing/chapter-1.md",
    task: "continue the next chapter",
    contextFiles: ["notes.md"],
    workspaceRoot,
    modelClient,
  });

  const firstUserMessage = modelClient.turnInputs[0]?.messages.find(
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
  const artifact = await readFile(
    join(workspaceRoot, result.writingArtifact?.path ?? ""),
    "utf8",
  );
  expect(artifact).toBe("She stepped into a room full of rain.\n");
  await expect(
    readFile(join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"), "utf8"),
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

  const result = await runAgent({
    workflow: "coding",
    task: "inspect the allowed file",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  expect(result.session.readScope).toEqual(["allowed.txt"]);
  const denied = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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
  await writeFile(join(workspaceRoot, "allowed.txt"), "allowed content\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "allowed.txt" } },
      ],
    },
    { content: "The allowed file was read.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "inspect the allowed file",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  expect(
    JSON.parse(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}"),
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

  await runAgent({
    workflow: "coding",
    task: "inspect the allowed file",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  expect(
    JSON.parse(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}"),
  ).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
});

test("search_text returns only matches inside the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-search-scope-"),
  );
  await writeFile(join(workspaceRoot, "allowed.txt"), "needle allowed\n", "utf8");
  await writeFile(join(workspaceRoot, "secret.txt"), "needle secret\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_search", name: "search_text", input: { query: "needle" } },
      ],
    },
    { content: "Only the allowed match was visible.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "find the allowed match",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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
  await writeFile(join(workspaceRoot, "allowed", "visible.txt"), "yes\n", "utf8");
  await writeFile(join(workspaceRoot, "secret", "hidden.txt"), "no\n", "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_list", name: "list_files", input: {} }] },
    { content: "Only allowed files were listed.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "list allowed files",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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

  await runAgent({
    workflow: "coding",
    task: "list allowed files",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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

  await runAgent({
    workflow: "coding",
    task: "inspect allowed status",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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
  await writeFile(join(workspaceRoot, "allowed.txt"), "before allowed\n", "utf8");
  await writeFile(join(workspaceRoot, "secret.txt"), "before secret\n", "utf8");
  await execGit(workspaceRoot, ["add", "allowed.txt", "secret.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await writeFile(join(workspaceRoot, "allowed.txt"), "after allowed\n", "utf8");
  await writeFile(join(workspaceRoot, "secret.txt"), "after secret\n", "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "Only allowed diff was visible.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "inspect allowed diff",
    contextFiles: [],
    allowedReadPaths: ["allowed.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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
    JSON.stringify({ activeContext: { maxObservationBytes: 4_096 } }),
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

  const result = await runAgent({
    workflow: "coding",
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
    thirdTurnMessages.find((message) => message.role === "user")?.content,
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
    targetObservationBytes: 4_096,
  });
  expect(compacted.payload).toMatchObject({
    compactedCount: 1,
    targetObservationBytes: 4_096,
    toolNames: ["read_file"],
  });
  expect("content" in compacted.payload).toBe(false);
  expect("path" in compacted.payload).toBe(false);
  expect("preview" in compacted.payload).toBe(false);
});

test("context attachments are rendered for the model without storing full content in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-context-"));
  const largeContext = `Important issue context\n${"x".repeat(22 * 1024)}\nHidden tail marker\n`;
  await writeFile(join(workspaceRoot, "allowed.txt"), "allowed\n", "utf8");
  await writeFile(join(workspaceRoot, "issue.md"), largeContext, "utf8");
  const modelClient = new FakeModelClient([
    { content: "I can see the attached issue context.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
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
  expect(firstUserMessage).toMatch(/returnedBytes: 20480/);
  expect(firstUserMessage).toMatch(/truncated: true/);
  expect(firstUserMessage).toMatch(/Important issue context/);
  expect(firstUserMessage).toMatch(/\[truncated: showing 20480 of \d+ bytes\]/);
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

  await runAgent({
    workflow: "coding",
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
    JSON.parse(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}"),
  ).toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  });
});

test("a coding Session can inspect a truncated git diff without storing the full diff in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-git-diff-"));
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "review.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "review.txt"]);
  const changedContent = `changed\n${"x".repeat(25 * 1024)}\nHidden diff tail marker\n`;
  await writeFile(join(workspaceRoot, "review.txt"), changedContent, "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "I reviewed the diff.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "review the diff",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff"),
  ).toBe(true);
  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
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

  await runAgent({
    workflow: "coding",
    task: "inspect available tools",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const tools = modelClient.turnInputs[0]?.tools ?? [];
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_files",
    "search_text",
    "read_file",
    "git_status",
    "git_diff",
    "update_plan",
  ]);
  expect(tools.some((tool) => "execute" in tool)).toBe(false);
  expect(tools.some((tool) => "providerId" in tool)).toBe(false);
  expect(tools.some((tool) => "capability" in tool)).toBe(false);
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

  const result = await runAgent({
    workflow: "coding",
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
  await writeFile(join(workspaceRoot, "parent.txt"), "parent baseline\n", "utf8");
  await writeFile(join(workspaceRoot, "child.txt"), "child baseline\n", "utf8");
  await execGit(workspaceRoot, ["add", "parent.txt", "child.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await writeFile(join(workspaceRoot, "parent.txt"), "parent dirty\n", "utf8");
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
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

  const result = await runAgent({
    workflow: "coding",
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
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
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

  const result = await runAgent({
    workflow: "coding",
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

  await expect(readFile(join(workspaceRoot, "parent.txt"), "utf8")).resolves.toBe(
    "# Parent\n- parent-created\n- child-confirmed\n",
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
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
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

  const result = await runAgent({
    workflow: "coding",
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
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
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

  const result = await runAgent({
    workflow: "coding",
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

  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "original\n",
  );
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
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-action-prompt-"));
  const modelClient = new FakeModelClient([
    { content: "I will use approved tools only.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "make a safe edit",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
  });

  const systemPrompt = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "system",
  )?.content ?? "";

  expect(systemPrompt).toMatch(/apply_patch/);
  expect(systemPrompt).toMatch(/run_command/);
  expect(systemPrompt).toMatch(/permission and approval/);
  expect(systemPrompt).not.toMatch(/do not claim to write files or run commands/);
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

  const result = await runAgent({
    workflow: "writing",
    task: "review git diff",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/cannot inspect git diffs/);
  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff"),
  ).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "").toMatch(
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
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-shape-"));
  await writeFile(join(workspaceRoot, "draft.md"), "This draft is wordy.\n", "utf8");
  const modelClient = new FakeModelClient([
    { content: "Make it shorter.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "writing",
    task: "revise for clarity",
    contextFiles: ["draft.md"],
    workspaceRoot,
    modelClient,
  });

  const systemPrompt = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "system",
  )?.content ?? "";

  expect(systemPrompt).toMatch(/Critique, Revision, Notes/);
  expect(systemPrompt).toMatch(/do not request workspace, git, shell, patch, or command tools/);
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

  const result = await runAgent({
    workflow: "writing",
    task: "revise draft",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/I cannot read workspace files/);
  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "read_file"),
  ).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "").toMatch(
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

  const result = await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs[0]?.tools.length).toBeGreaterThan(0);
  expect(modelClient.turnInputs[0]?.messages[1]?.content).toMatch(
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
  expect(modelClient.turnInputs[1]?.messages[0]?.content).toMatch(
    /FINAL ANSWER ONLY/,
  );
  expect(modelClient.turnInputs[1]?.messages[1]?.content).toMatch(
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

  const result = await runAgent({
    workflow: "coding",
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
        '<｜｜DSML｜｜tool_calls>',
        '<｜｜DSML｜｜invoke name="read_file">',
        "</｜｜DSML｜｜invoke>",
        "</｜｜DSML｜｜tool_calls>",
      ].join("\n"),
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
    task: "answer after retry",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs).toHaveLength(2);
  expect(result.summary).toMatch(/A usable answer/);
});

test("a Session stopped by input token limit reports the precise stop reason and budget details", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-input-budget-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      budgets: {
        maxModelTurns: 8,
        maxInputTokens: 100,
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
    { content: "This should not be called.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "inspect files within a tiny token limit",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs.length).toBe(1);
  expect(result.summary).toMatch(/Reason: input_token_limit_exceeded/);
  expect(result.summary).toMatch(/Model turns: 1\/8/);
  expect(result.summary).toMatch(/Input tokens: 101\/100/);
  expect(result.summary).toMatch(/Output tokens: 7/);
  expect(result.summary).toMatch(/Estimated cost: \$0\.0100\/\$0\.2500/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished.payload.status).toBe("stopped");
  expect(finished.payload.reason).toBe("input_token_limit_exceeded");
});

test("an over-budget actionable turn records budget-blocked tool calls without approval or execution", async () => {
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
        maxInputTokens: 100,
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
    { content: "This should not be called.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "change example within a tiny token limit",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  expect(modelClient.turnInputs.length).toBe(1);
  await expect(
    readFile(join(workspaceRoot, "example.txt"), "utf8"),
  ).resolves.toBe("original\n");
  expect(result.summary).toMatch(/Reason: input_token_limit_exceeded/);
  expect(result.summary).toMatch(
    /Skipped 1 tool call because input_token_limit_exceeded was reached\./,
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "tool_call")).toBe(false);
  expect(events.some((event) => event.type === "permission_decision")).toBe(
    false,
  );
  expect(events.some((event) => event.type === "approval_decision")).toBe(
    false,
  );
  const blocked = events.find(
    (event) => event.type === "budget_blocked_tool_calls",
  );
  expect(blocked?.payload).toEqual({
    reason: "input_token_limit_exceeded",
    skippedCount: 1,
    toolNames: ["apply_patch"],
  });
});

test("large read_file observations are truncated for the model and not stored fully in trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-truncate-"));
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

  const result = await runAgent({
    workflow: "coding",
    task: "read the large file",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
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
    JSON.stringify({ activeContext: { maxObservationBytes: 4_096 } }),
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

  await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
    task: "read a later byte range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
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

  await runAgent({
    workflow: "coding",
    task: "read a line range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
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

  await runAgent({
    workflow: "coding",
    task: "read the file tail",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
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
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-range-conflict-"));
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

  const result = await runAgent({
    workflow: "coding",
    task: "read conflicting ranges",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(false);
  expect(observation.error.code).toBe("invalid_input");
  expect(observation.error.message).toMatch(/range modes are mutually exclusive/i);

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

  await runAgent({
    workflow: "coding",
    task: "read beyond eof",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
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

  await runAgent({
    workflow: "coding",
    task: "read invalid line range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(false);
  expect(observation.error.code).toBe("invalid_input");
  expect(observation.error.message).toMatch(/positive integer input: startLine/);
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

  const result = await runAgent({
    workflow: "coding",
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

  await runAgent({
    workflow: "coding",
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

  const result = await runAgent({
    workflow: "coding",
    task: "read symlink",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
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
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "forgelet-scope-outside-"),
  );
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

  await runAgent({
    workflow: "coding",
    task: "read allowed files",
    contextFiles: [],
    allowedReadPaths: ["allowed"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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

  await runAgent({
    workflow: "coding",
    task: "search the literal file",
    contextFiles: [],
    allowedReadPaths: ["*.txt"],
    workspaceRoot,
    modelClient,
  });

  const observation = JSON.parse(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "{}",
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
