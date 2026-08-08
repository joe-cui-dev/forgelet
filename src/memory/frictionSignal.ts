import type { KnownTraceEvent } from "../trace/index.js";

/** A place in a finished Session's Trace where its expectation did not match
 * the workspace: a Tool Observation that failed, or a Permission Policy
 * decision that denied the call or required confirmation. A Friction Signal
 * marks where a discovered convention is most likely to be found; it is not a
 * defect report and not a measure of Session quality (CONTEXT.md). */
export type FrictionSignal =
  | {
      kind: "tool_failure";
      toolName: string;
      path?: string;
      errorCode?: string;
      /** The human-readable failure text: the observation's `error.message`,
       * falling back to its `summary`. Both carry the same text in practice. */
      error?: string;
    }
  | {
      kind: "permission_friction";
      decision: "deny" | "confirm";
      toolName?: string;
      capability?: string;
      reason?: string;
    };

export interface FrictionGateResult {
  /** Whether the Session carries at least one Friction Signal and so is
   * examined by a Retrospective Session (ADR 0075). */
  admitted: boolean;
  /** The signals found, in Trace order, as the place a Retrospective Session
   * is told to look. */
  signals: FrictionSignal[];
}

/** The deterministic gate that precedes every Retrospective Session. Filter to
 * `KnownTraceEvent`s with `isTraceEvent` before calling: an unknown or
 * forward-versioned line is never evidence. */
export function detectFrictionSignals(events: KnownTraceEvent[]): FrictionGateResult {
  const signals: FrictionSignal[] = [];

  for (const event of events) {
    if (event.type === "tool_result" && event.payload.ok === false) {
      signals.push(toolFailureSignal(event.payload));
      continue;
    }
    if (event.type === "permission_decision") {
      const decision = event.payload.decision;
      if (decision === "deny" || decision === "confirm")
        signals.push(permissionFrictionSignal(event.payload, decision));
    }
  }

  return { admitted: signals.length > 0, signals };
}

function toolFailureSignal(
  payload: Extract<KnownTraceEvent, { type: "tool_result" }>["payload"],
): FrictionSignal {
  const path = asOptionalString(payload.path);
  const errorCode = asOptionalString(payload.error?.code);
  const error =
    asOptionalString(payload.error?.message) ?? asOptionalString(payload.summary);
  return {
    kind: "tool_failure",
    toolName: asString(payload.toolName),
    ...(path !== undefined ? { path } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function permissionFrictionSignal(
  payload: Extract<KnownTraceEvent, { type: "permission_decision" }>["payload"],
  decision: "deny" | "confirm",
): FrictionSignal {
  const toolName = asOptionalString(payload.toolName);
  const capability = asOptionalString(payload.capability);
  const reason = asOptionalString(payload.reason);
  return {
    kind: "permission_friction",
    decision,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** Distinguishes a genuinely absent field from an empty string so provenance
 * omits keys the Trace never carried. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
