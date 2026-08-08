import { detectFrictionSignals } from "../../src/memory/frictionSignal.js";
import type { KnownTraceEvent } from "../../src/trace/index.js";

function event(type: KnownTraceEvent["type"], payload: Record<string, unknown>): KnownTraceEvent {
  return { type, ts: "2026-08-08T00:00:00.000Z", sessionId: "sess_test", payload } as KnownTraceEvent;
}

test("a Session with no failed observation and no denied decision is not admitted", () => {
  const result = detectFrictionSignals([
    event("tool_result", { ok: true, toolName: "read_file", path: "src/a.ts", summary: "ok" }),
    event("permission_decision", { toolName: "read_file", capability: "read_workspace", decision: "allow", reason: "" }),
  ]);

  expect(result.admitted).toBe(false);
  expect(result.signals).toEqual([]);
});

test("a failed Tool Observation admits the Session and carries toolName/path/error", () => {
  const result = detectFrictionSignals([
    event("tool_result", {
      ok: false,
      toolName: "read_file",
      path: "src/missing.ts",
      error: { code: "invalid_input", message: "ENOENT: no such file" },
      summary: "ENOENT: no such file",
    }),
  ]);

  expect(result.admitted).toBe(true);
  expect(result.signals).toEqual([
    {
      kind: "tool_failure",
      toolName: "read_file",
      path: "src/missing.ts",
      errorCode: "invalid_input",
      error: "ENOENT: no such file",
    },
  ]);
});

test("a denied permission decision admits the Session with capability/reason", () => {
  const result = detectFrictionSignals([
    event("permission_decision", {
      toolName: "run_command",
      capability: "run_safe_command",
      decision: "deny",
      reason: "command not on safe list",
    }),
  ]);

  expect(result.admitted).toBe(true);
  expect(result.signals).toEqual([
    {
      kind: "permission_friction",
      decision: "deny",
      toolName: "run_command",
      capability: "run_safe_command",
      reason: "command not on safe list",
    },
  ]);
});

test("a confirm permission decision is also a Friction Signal", () => {
  const result = detectFrictionSignals([
    event("permission_decision", {
      toolName: "apply_patch",
      capability: "write_workspace",
      decision: "confirm",
      reason: "writes outside the declared scope",
    }),
  ]);

  expect(result.admitted).toBe(true);
  expect(result.signals[0]).toMatchObject({ kind: "permission_friction", decision: "confirm" });
});

test("an allow decision alongside a failure yields only the failure signal", () => {
  const result = detectFrictionSignals([
    event("permission_decision", { toolName: "read_file", capability: "read_workspace", decision: "allow", reason: "" }),
    event("tool_result", { ok: false, toolName: "run_command", summary: "exit 1" }),
  ]);

  expect(result.admitted).toBe(true);
  expect(result.signals).toEqual([
    { kind: "tool_failure", toolName: "run_command", error: "exit 1" },
  ]);
});

test("signals preserve trace order across mixed friction kinds", () => {
  const result = detectFrictionSignals([
    event("permission_decision", { toolName: "run_command", capability: "run_safe_command", decision: "deny", reason: "unsafe" }),
    event("tool_result", { ok: false, toolName: "read_file", path: "src/x.ts", summary: "boom" }),
  ]);

  expect(result.signals.map((signal) => signal.kind)).toEqual([
    "permission_friction",
    "tool_failure",
  ]);
});

test("optional fields are omitted rather than emitted as undefined", () => {
  const result = detectFrictionSignals([
    event("tool_result", { ok: false, toolName: "run_command", summary: "" }),
  ]);

  expect(result.signals[0]).toEqual({ kind: "tool_failure", toolName: "run_command" });
});
