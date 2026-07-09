import { expect, test } from "@jest/globals";
import {
  createResumeApprovalHandler,
  widenEnvelopeForRequest,
} from "../../src/permissions/envelope.js";
import type { EffectEnvelope } from "../../src/permissions/envelope.js";
import type { ApprovalRequest } from "../../src/tools/toolRegistry.js";
import type { ToolRequest } from "../../src/types.js";

test("createResumeApprovalHandler approves the pending call once, then falls back to the envelope", async () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["src"] });
  const handler = createResumeApprovalHandler(
    "call_pending",
    "approve",
    envelope,
    "unused",
  );

  const pendingDecision = await handler(
    testApprovalRequest({
      toolCall: { id: "call_pending", name: "apply_patch", input: {} },
      toolRequest: testRequest({
        targets: [{ kind: "path", path: "docs/notes.md", classification: "ordinary" }],
      }),
    }),
  );
  expect(pendingDecision).toEqual({
    status: "approved",
    reason: "Approved by user via `forge decide`.",
  });

  // A later call with the same id (should not happen in practice) falls
  // through to the plain envelope check, since the bypass is single-use.
  await expect(
    handler(
      testApprovalRequest({
        toolCall: { id: "call_pending", name: "apply_patch", input: {} },
        toolRequest: testRequest({
          targets: [{ kind: "path", path: "docs/notes.md", classification: "ordinary" }],
        }),
      }),
    ),
  ).rejects.toThrow(/out of the declared Effect Envelope/);
});

test("createResumeApprovalHandler rejects the pending call once with the given reason", async () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["src"] });
  const handler = createResumeApprovalHandler(
    "call_pending",
    "deny",
    envelope,
    "Denied by user via `forge decide`.",
  );

  const decision = await handler(
    testApprovalRequest({
      toolCall: { id: "call_pending", name: "apply_patch", input: {} },
    }),
  );

  expect(decision).toEqual({
    status: "rejected",
    reason: "Denied by user via `forge decide`.",
  });
});

test("createResumeApprovalHandler defers to the envelope for calls other than the pending one", async () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["src"] });
  const handler = createResumeApprovalHandler(
    "call_pending",
    "approve",
    envelope,
    "unused",
  );

  const decision = await handler(
    testApprovalRequest({
      toolCall: { id: "call_sibling", name: "apply_patch", input: {} },
      toolRequest: testRequest({
        targets: [{ kind: "path", path: "src/app.ts", classification: "ordinary" }],
      }),
    }),
  );

  expect(decision.status).toBe("approved");
  expect(decision.reason).toMatch(/Effect Envelope/);
});

test("widenEnvelopeForRequest adds the target's directory to the write scope", () => {
  const envelope: EffectEnvelope = { writeScopePrefixes: ["src"], allowedCommands: [] };
  const request = testRequest({
    targets: [{ kind: "path", path: "docs/notes.md", classification: "ordinary" }],
  });

  const widened = widenEnvelopeForRequest(envelope, request);

  expect(widened).toEqual({
    writeScopePrefixes: ["src", "docs"],
    allowedCommands: [],
  });
});

test("widenEnvelopeForRequest adds the target command to the allowlist", () => {
  const envelope: EffectEnvelope = { writeScopePrefixes: [], allowedCommands: ["npm test"] };
  const request = testRequest({
    toolName: "run_command",
    targets: [{ kind: "command", command: "npm run build", classification: "safe_configured" }],
  });

  const widened = widenEnvelopeForRequest(envelope, request);

  expect(widened).toEqual({
    writeScopePrefixes: [],
    allowedCommands: ["npm test", "npm run build"],
  });
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
