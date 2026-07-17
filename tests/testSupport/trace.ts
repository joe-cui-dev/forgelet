import { expect } from "@jest/globals";
import {
  isTraceEvent,
  readTraceFile,
  type KnownTraceEvent,
  type TraceEventType,
} from "../../src/trace/index.js";

/** Reads only validated vocabulary members; tests that exercise forward or
 * malformed evidence should use readTraceFile directly and inspect unknowns. */
export async function readTypedTrace(tracePath: string): Promise<KnownTraceEvent[]> {
  return (await readTraceFile(tracePath)).filter(isTraceEvent);
}

/** Asserts relative order while intentionally allowing unrelated evidence in
 * between the requested Trace events. */
export function expectTraceSubsequence(
  events: KnownTraceEvent[],
  expected: readonly TraceEventType[],
): void {
  let after = -1;
  for (const type of expected) {
    const index = events.findIndex(
      (event, eventIndex) => eventIndex > after && event.type === type,
    );
    expect(index).toBeGreaterThan(after);
    after = index;
  }
}

/** Every executed tool request must record its permission outcome before its
 * matching tool result. Approval evidence may appear between those events. */
export function expectToolCallPermissionBeforeResult(
  events: KnownTraceEvent[],
): void {
  for (const [toolCallIndex, toolCall] of events.entries()) {
    if (toolCall.type !== "tool_call") continue;
    const toolCallId = toolCall.payload.id;
    if (!toolCallId)
      throw new Error("Trace tool_call evidence is missing its id.");

    const permissionIndex = events.findIndex(
      (event, eventIndex) =>
        eventIndex > toolCallIndex &&
        event.type === "permission_decision" &&
        event.payload.toolCallId === toolCallId,
    );
    const resultIndex = events.findIndex(
      (event, eventIndex) =>
        eventIndex > toolCallIndex &&
        event.type === "tool_result" &&
        event.payload.toolCallId === toolCallId,
    );

    expect(permissionIndex).toBeGreaterThan(toolCallIndex);
    expect(resultIndex).toBeGreaterThan(permissionIndex);
  }
}
