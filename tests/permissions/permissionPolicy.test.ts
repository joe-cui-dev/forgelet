import assert from "node:assert/strict";
import { test } from "../harness.js";
import { createPermissionPolicy } from "../../src/permissions/index.js";
import type { ToolRequest } from "../../src/types.js";

test("PermissionPolicy allows low-risk tool requests", async () => {
  const policy = createPermissionPolicy();

  const decision = await policy.decide(
    testRequest({ riskTier: "low", toolName: "read_file" }),
  );

  assert.deepEqual(decision, {
    kind: "allow",
    riskTier: "low",
    reason: "Low-risk tool request is allowed.",
  });
});

test("PermissionPolicy confirms medium-risk tool requests", async () => {
  const policy = createPermissionPolicy();

  const decision = await policy.decide(
    testRequest({
      capability: "write_workspace",
      riskTier: "medium",
      toolName: "apply_patch",
    }),
  );

  assert.deepEqual(decision, {
    kind: "confirm",
    riskTier: "medium",
    reason: "Medium-risk tool request requires confirmation.",
  });
});

test("PermissionPolicy denies high and forbidden risk tool requests", async () => {
  const policy = createPermissionPolicy();

  assert.deepEqual(
    await policy.decide(
      testRequest({
        capability: "run_safe_command",
        riskTier: "high",
        toolName: "run_command",
      }),
    ),
    {
      kind: "deny",
      riskTier: "high",
      reason: "High-risk tool requests are denied in V1.",
    },
  );

  assert.deepEqual(
    await policy.decide(
      testRequest({
        capability: "write_workspace",
        riskTier: "forbidden",
        toolName: "apply_patch",
      }),
    ),
    {
      kind: "deny",
      riskTier: "forbidden",
      reason: "Forbidden tool requests are denied.",
    },
  );
});

test("PermissionPolicy explains denied path targets when target metadata is present", async () => {
  const policy = createPermissionPolicy();

  const decision = await policy.decide(
    testRequest({
      capability: "write_workspace",
      riskTier: "forbidden",
      toolName: "apply_patch",
      targets: [
        { kind: "path", path: "src/app.ts", classification: "ordinary" },
        { kind: "path", path: ".env", classification: "sensitive" },
      ],
    }),
  );

  assert.deepEqual(decision, {
    kind: "deny",
    riskTier: "forbidden",
    reason: "Forbidden tool requests are denied: .env is sensitive.",
  });
});

function testRequest(overrides: Partial<ToolRequest> = {}): ToolRequest {
  return {
    workflow: "coding",
    toolName: "test_tool",
    capability: "read_workspace",
    riskTier: "low",
    input: {},
    workspaceRoot: "/workspace",
    ...overrides,
  };
}
