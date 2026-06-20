import { expect, test } from "@jest/globals";
import type { ToolContext, ToolDefinition } from "../../src/types.js";
import { createToolRegistry } from "../../src/tools/toolRegistry.js";

test("ToolRegistry rejects duplicate tool names during construction", () => {
  expect(() =>
      createToolRegistry([
        testTool({ name: "read_file" }),
        testTool({ name: "read_file" }),
      ])).toThrow(/Duplicate tool name: read_file/);
});

test("ToolRegistry rejects tools with incomplete metadata during construction", () => {
  expect(() => createToolRegistry([testTool({ providerId: "" })])).toThrow(/Tool test_tool is missing providerId/);
  expect(() => createToolRegistry([testTool({ capability: undefined })])).toThrow(/Tool test_tool is missing capability/);
  expect(() => createToolRegistry([testTool({ description: "" })])).toThrow(/Tool test_tool is missing description/);
  expect(() => createToolRegistry([testTool({ inputSchema: undefined })])).toThrow(/Tool test_tool is missing inputSchema/);
});

test("ToolRegistry lists only model-facing schemas for granted capabilities", () => {
  const registry = createToolRegistry([
    testTool({ name: "read_file", capability: "read_workspace" }),
    testTool({ name: "git_diff", providerId: "git", capability: "git_read" }),
  ]);

  expect(registry.listTools(["read_workspace"])).toEqual([
    {
      name: "read_file",
      description: "Test tool",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ]);
  expect("execute" in registry.listTools(["read_workspace"])[0]).toBe(false);
  expect("providerId" in registry.listTools(["read_workspace"])[0]).toBe(false);
  expect("capability" in registry.listTools(["read_workspace"])[0]).toBe(false);
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

  expect(result.permissionDecision.kind).toBe("allow");
  expect(result.permissionDecision.reason).toBe("Low-risk tool request is allowed.");
  expect(result.observation).toEqual({
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

  expect(result.permissionDecision.kind).toBe("deny");
  expect(result.permissionDecision.reason).toBe("Unknown tool: missing_tool");
  expect(result.observation).toEqual({
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

  expect(result.permissionDecision.kind).toBe("deny");
  expect(result.permissionDecision.reason).toBe("Capability not granted: git_read");
  expect(result.observation).toEqual({
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

  expect(result.permissionDecision.kind).toBe("allow");
  expect(result.observation).toEqual({
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

  expect(executed).toBe(false);
  expect(result.permissionDecision.kind).toBe("confirm");
  expect(result.approvalDecision).toEqual({
    status: "unavailable",
    reason: "No approval handler is available.",
  });
  expect(result.observation).toEqual({
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

  expect(executed).toBe(true);
  expect(result.approvalDecision).toEqual({
    status: "approved",
    reason: "Approved by test.",
  });
  expect(result.observation).toEqual({
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
