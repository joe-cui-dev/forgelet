import { expect, test } from "@jest/globals";
import { isWithinEnvelope } from "../../src/permissions/envelope.js";
import type { EffectEnvelope } from "../../src/permissions/envelope.js";
import type { ToolRequest } from "../../src/types.js";

test("isWithinEnvelope: in-scope patch is within envelope", () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["src"] });

  const request = testRequest({
    targets: [{ kind: "path", path: "src/app.ts", classification: "ordinary" }],
  });

  expect(isWithinEnvelope(request, envelope)).toBe(true);
});

test("isWithinEnvelope: out-of-scope path is not within envelope", () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["src"] });

  const request = testRequest({
    targets: [{ kind: "path", path: "docs/notes.md", classification: "ordinary" }],
  });

  expect(isWithinEnvelope(request, envelope)).toBe(false);
});

test("isWithinEnvelope: sensitive, delete, and dirty targets are excluded regardless of scope", () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["."] });

  expect(
    isWithinEnvelope(
      testRequest({
        targets: [{ kind: "path", path: ".env", classification: "sensitive" }],
      }),
      envelope,
    ),
  ).toBe(false);

  expect(
    isWithinEnvelope(
      testRequest({
        targets: [{ kind: "path", path: "src/app.ts", classification: "delete_file" }],
      }),
      envelope,
    ),
  ).toBe(false);

  expect(
    isWithinEnvelope(
      testRequest({
        targets: [
          { kind: "path", path: "src/app.ts", classification: "dirty_at_session_start" },
        ],
      }),
      envelope,
    ),
  ).toBe(false);
});

test("isWithinEnvelope: allowlisted command is within envelope", () => {
  const envelope = testEnvelope({ allowedCommands: ["npm test"] });

  const request = testRequest({
    targets: [{ kind: "command", command: "npm test", classification: "safe_configured" }],
  });

  expect(isWithinEnvelope(request, envelope)).toBe(true);
});

test("isWithinEnvelope: safe-configured command not in allowlist is not within envelope", () => {
  const envelope = testEnvelope({ allowedCommands: ["npm test"] });

  const request = testRequest({
    targets: [{ kind: "command", command: "npm build", classification: "safe_configured" }],
  });

  expect(isWithinEnvelope(request, envelope)).toBe(false);
});

test("isWithinEnvelope: multi-target request is within envelope only if every target passes", () => {
  const envelope = testEnvelope({
    writeScopePrefixes: ["src"],
    allowedCommands: ["npm test"],
  });

  const request = testRequest({
    targets: [
      { kind: "path", path: "src/app.ts", classification: "ordinary" },
      { kind: "path", path: "docs/notes.md", classification: "ordinary" },
    ],
  });

  expect(isWithinEnvelope(request, envelope)).toBe(false);
});

test("isWithinEnvelope: '.' write scope covers every ordinary path", () => {
  const envelope = testEnvelope({ writeScopePrefixes: ["."] });

  const request = testRequest({
    targets: [{ kind: "path", path: "anywhere/deep/file.ts", classification: "ordinary" }],
  });

  expect(isWithinEnvelope(request, envelope)).toBe(true);
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
