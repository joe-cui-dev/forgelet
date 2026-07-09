import { expect, test } from "@jest/globals";
import {
  createEnvelopeApprovalHandler,
  SessionPauseSignal,
} from "../../src/permissions/envelope.js";
import type { EffectEnvelope } from "../../src/permissions/envelope.js";
import { createToolRegistry } from "../../src/tools/toolRegistry.js";
import type {
  ApprovalRequest,
  ApprovalHandler,
} from "../../src/tools/toolRegistry.js";
import type { ModelToolCall, ToolContext, ToolDefinition, ToolRequest } from "../../src/types.js";

test("createEnvelopeApprovalHandler approves in-envelope requests citing the envelope", async () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["src"] });
  const handler = createEnvelopeApprovalHandler(envelope);

  const decision = await handler(
    testApprovalRequest({
      toolRequest: testRequest({
        targets: [{ kind: "path", path: "src/app.ts", classification: "ordinary" }],
      }),
    }),
  );

  expect(decision.status).toBe("approved");
  expect(decision.reason).toMatch(/Effect Envelope/);
  expect(decision.reason).toMatch(/src\/app\.ts/);
});

test("createEnvelopeApprovalHandler throws SessionPauseSignal carrying the pending call for out-of-envelope requests", async () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["src"] });
  const handler = createEnvelopeApprovalHandler(envelope);
  const toolCall: ModelToolCall = {
    id: "call_1",
    name: "apply_patch",
    input: { patch: "diff" },
  };
  const toolRequest = testRequest({
    targets: [{ kind: "path", path: "docs/notes.md", classification: "ordinary" }],
  });

  await expect(
    handler(testApprovalRequest({ toolCall, toolRequest })),
  ).rejects.toThrow(SessionPauseSignal);

  try {
    await handler(testApprovalRequest({ toolCall, toolRequest }));
    throw new Error("expected handler to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionPauseSignal);
    const signal = error as SessionPauseSignal;
    expect(signal.toolCall).toEqual(toolCall);
    expect(signal.toolRequest).toEqual(toolRequest);
  }
});

test("deny-tier tool requests never reach the envelope approval handler", async () => {
  let handlerCalled = false;
  const throwingHandler: ApprovalHandler = async () => {
    handlerCalled = true;
    return { status: "approved", reason: "should not be reached" };
  };

  const registry = createToolRegistry(
    [
      testTool({
        name: "apply_patch",
        capability: "write_workspace",
        classify: (input, ctx) => ({
          workflow: ctx.workflow,
          toolName: "apply_patch",
          capability: "write_workspace",
          riskTier: "forbidden",
          input,
          workspaceRoot: ctx.workspaceRoot,
          targets: [{ kind: "path", path: ".env", classification: "sensitive" }],
        }),
      }),
    ],
    { approvalHandler: throwingHandler },
  );

  const result = await registry.execute(
    { id: "call_patch", name: "apply_patch", input: { patch: "diff" } },
    testContext({ grantedCapabilities: ["write_workspace"] }),
  );

  expect(handlerCalled).toBe(false);
  expect(result.permissionDecision.kind).toBe("deny");
});

function testEnvelope(overrides: Partial<EffectEnvelope> = {}): EffectEnvelope {
  return {
    writeScopePrefixes: [],
    allowedCommands: [],
    ...overrides,
  };
}

function testRequest(overrides: Partial<ToolRequest> = {}): ToolRequest {
  return {
    workflow: "coding",
    toolName: "apply_patch",
    capability: "write_workspace",
    riskTier: "medium",
    input: {},
    workspaceRoot: "/workspace",
    ...overrides,
  };
}

function testApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCall: { id: "call_1", name: "apply_patch", input: { patch: "diff" } },
    toolRequest: testRequest(),
    permissionDecision: { kind: "confirm", riskTier: "medium", reason: "test" },
    ...overrides,
  };
}

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
