import { expect, test } from "@jest/globals";
import { createPermissionPolicy } from "../../src/permissions/index.js";
import type { ToolRequest } from "../../src/types.js";

test("PermissionPolicy allows low-risk tool requests", async () => {
  const policy = createPermissionPolicy();

  const decision = await policy.decide(
    testRequest({ riskTier: "low", toolName: "read_file" }),
  );

  expect(decision).toEqual({
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

  expect(decision).toEqual({
    kind: "confirm",
    riskTier: "medium",
    reason: "Medium-risk tool request requires confirmation.",
  });
});

test("PermissionPolicy denies high and forbidden risk tool requests", async () => {
  const policy = createPermissionPolicy();

  expect(await policy.decide(
      testRequest({
        capability: "run_safe_command",
        riskTier: "high",
        toolName: "run_command",
      }),
    )).toEqual({
      kind: "deny",
      riskTier: "high",
      reason: "High-risk tool requests are denied in V1.",
    });

  expect(await policy.decide(
      testRequest({
        capability: "write_workspace",
        riskTier: "forbidden",
        toolName: "apply_patch",
      }),
    )).toEqual({
      kind: "deny",
      riskTier: "forbidden",
      reason: "Forbidden tool requests are denied.",
    });
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

  expect(decision).toEqual({
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
