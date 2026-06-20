import assert from "node:assert/strict";
import { test } from "../harness.js";
import type { ToolContext, ToolDefinition } from "../../src/types.js";
import { createToolRegistry } from "../../src/tools/toolRegistry.js";

test("ToolRegistry rejects duplicate tool names during construction", () => {
  assert.throws(
    () =>
      createToolRegistry([
        testTool({ name: "read_file" }),
        testTool({ name: "read_file" }),
      ]),
    /Duplicate tool name: read_file/,
  );
});

test("ToolRegistry rejects tools with incomplete metadata during construction", () => {
  assert.throws(
    () => createToolRegistry([testTool({ providerId: "" })]),
    /Tool test_tool is missing providerId/,
  );
  assert.throws(
    () => createToolRegistry([testTool({ capability: undefined })]),
    /Tool test_tool is missing capability/,
  );
  assert.throws(
    () => createToolRegistry([testTool({ description: "" })]),
    /Tool test_tool is missing description/,
  );
  assert.throws(
    () => createToolRegistry([testTool({ inputSchema: undefined })]),
    /Tool test_tool is missing inputSchema/,
  );
});

test("ToolRegistry lists only model-facing schemas for granted capabilities", () => {
  const registry = createToolRegistry([
    testTool({ name: "read_file", capability: "read_workspace" }),
    testTool({ name: "git_diff", providerId: "git", capability: "git_read" }),
  ]);

  assert.deepEqual(registry.listTools(["read_workspace"]), [
    {
      name: "read_file",
      description: "Test tool",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ]);
  assert.equal("execute" in registry.listTools(["read_workspace"])[0], false);
  assert.equal("providerId" in registry.listTools(["read_workspace"])[0], false);
  assert.equal("capability" in registry.listTools(["read_workspace"])[0], false);
});

test("ToolRegistry executes a granted tool and returns an allow decision", async () => {
  const registry = createToolRegistry([
    testTool({
      name: "read_file",
      execute: async () => ({
        ok: true,
        summary: "Read README.md",
        data: { content: "hello", path: "README.md" },
      }),
    }),
  ]);

  const result = await registry.execute(
    { id: "call_1", name: "read_file", input: { path: "README.md" } },
    testContext({ grantedCapabilities: ["read_workspace"] }),
  );

  assert.equal(result.permissionDecision.kind, "allow");
  assert.equal(result.permissionDecision.reason, "Low-risk tool request is allowed.");
  assert.deepEqual(result.observation, {
    ok: true,
    toolCallId: "call_1",
    toolName: "read_file",
    summary: "Read README.md",
    content: "hello",
    error: undefined,
    metadata: { path: "README.md", preview: "hello" },
  });
});

test("ToolRegistry returns a controlled denial for unknown tools", async () => {
  const registry = createToolRegistry([testTool({ name: "read_file" })]);

  const result = await registry.execute(
    { id: "call_missing", name: "missing_tool", input: {} },
    testContext({ grantedCapabilities: ["read_workspace"] }),
  );

  assert.equal(result.permissionDecision.kind, "deny");
  assert.equal(result.permissionDecision.reason, "Unknown tool: missing_tool");
  assert.deepEqual(result.observation, {
    ok: false,
    toolCallId: "call_missing",
    toolName: "missing_tool",
    summary: "Unknown tool: missing_tool",
    error: {
      code: "unknown_tool",
      message: "Unknown tool: missing_tool",
    },
    metadata: {},
  });
});

test("ToolRegistry denies known tools without granted capability", async () => {
  const registry = createToolRegistry([
    testTool({ name: "git_diff", providerId: "git", capability: "git_read" }),
  ]);

  const result = await registry.execute(
    { id: "call_git", name: "git_diff", input: {} },
    testContext({ grantedCapabilities: ["read_workspace"] }),
  );

  assert.equal(result.permissionDecision.kind, "deny");
  assert.equal(result.permissionDecision.reason, "Capability not granted: git_read");
  assert.deepEqual(result.observation, {
    ok: false,
    toolCallId: "call_git",
    toolName: "git_diff",
    summary: "Capability not granted: git_read",
    error: {
      code: "permission_denied",
      message: "Capability not granted: git_read",
    },
    metadata: {},
  });
});

test("ToolRegistry keeps the allow decision when granted tool execution fails", async () => {
  const registry = createToolRegistry([
    testTool({
      name: "read_file",
      execute: async () => {
        throw new Error("Path is outside workspace: secret-link.txt");
      },
    }),
  ]);

  const result = await registry.execute(
    { id: "call_read", name: "read_file", input: { path: "secret-link.txt" } },
    testContext({ grantedCapabilities: ["read_workspace"] }),
  );

  assert.equal(result.permissionDecision.kind, "allow");
  assert.deepEqual(result.observation, {
    ok: false,
    toolCallId: "call_read",
    toolName: "read_file",
    summary: "Path is outside workspace: secret-link.txt",
    error: {
      code: "invalid_input",
      message: "Path is outside workspace: secret-link.txt",
    },
    metadata: {},
  });
});

test("ToolRegistry denies confirmed tool requests when approval is unavailable", async () => {
  let executed = false;
  const registry = createToolRegistry([
    testTool({
      name: "apply_patch",
      capability: "write_workspace",
      classify: (input, ctx) => ({
        workflow: ctx.workflow,
        toolName: "apply_patch",
        capability: "write_workspace",
        riskTier: "medium",
        input,
        workspaceRoot: ctx.workspaceRoot,
      }),
      execute: async () => {
        executed = true;
        return { ok: true, summary: "applied patch" };
      },
    }),
  ]);

  const result = await registry.execute(
    { id: "call_patch", name: "apply_patch", input: { patch: "diff" } },
    testContext({ grantedCapabilities: ["write_workspace"] }),
  );

  assert.equal(executed, false);
  assert.equal(result.permissionDecision.kind, "confirm");
  assert.deepEqual(result.approvalDecision, {
    status: "unavailable",
    reason: "No approval handler is available.",
  });
  assert.deepEqual(result.observation, {
    ok: false,
    toolCallId: "call_patch",
    toolName: "apply_patch",
    summary: "Approval unavailable for apply_patch.",
    error: {
      code: "permission_denied",
      message: "Approval unavailable for apply_patch.",
    },
    metadata: {},
  });
});

test("ToolRegistry executes confirmed tool requests after injected approval", async () => {
  let executed = false;
  const registry = createToolRegistry(
    [
      testTool({
        name: "run_command",
        capability: "run_safe_command",
        classify: (input, ctx) => ({
          workflow: ctx.workflow,
          toolName: "run_command",
          capability: "run_safe_command",
          riskTier: "medium",
          input,
          workspaceRoot: ctx.workspaceRoot,
        }),
        execute: async () => {
          executed = true;
          return {
            ok: true,
            summary: "Command exited 0.",
            data: { content: "passed" },
          };
        },
      }),
    ],
    {
      approvalHandler: async () => ({
        status: "approved",
        reason: "Approved by test.",
      }),
    },
  );

  const result = await registry.execute(
    { id: "call_test", name: "run_command", input: { command: "npm test" } },
    testContext({ grantedCapabilities: ["run_safe_command"] }),
  );

  assert.equal(executed, true);
  assert.deepEqual(result.approvalDecision, {
    status: "approved",
    reason: "Approved by test.",
  });
  assert.deepEqual(result.observation, {
    ok: true,
    toolCallId: "call_test",
    toolName: "run_command",
    summary: "Command exited 0.",
    content: "passed",
    error: undefined,
    metadata: { preview: "passed" },
  });
});

function testTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    providerId: "test",
    capability: "read_workspace",
    description: "Test tool",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => ({ ok: true, summary: "ok" }),
    ...overrides,
  };
}

function testContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: "/workspace",
    sessionId: "sess_test",
    workflow: "coding",
    grantedCapabilities: [],
    ...overrides,
  };
}
