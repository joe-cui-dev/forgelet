import type { SessionFinishStatus, WorkflowKind } from "../types.js";

export type SessionLiveEvent =
  | {
      type: "session_started";
      workflow: WorkflowKind;
      task: string;
    }
  | { type: "trace_path"; tracePath: string }
  | { type: "model_turn_started"; turnIndex: number; model: string }
  | {
      type: "model_output_delta";
      turnIndex: number;
      model: string;
      text: string;
    }
  | {
      type: "model_turn_finished";
      turnIndex: number;
      model: string;
      toolCallCount: number;
    }
  | { type: "tool_call_started"; toolName: string; target?: string }
  | {
      type: "tool_call_finished";
      toolName: string;
      ok: boolean;
      summary?: string;
    }
  | { type: "permission_checkpoint"; toolName: string; decision: string }
  | { type: "command_started"; command: string }
  | {
      type: "command_finished";
      command: string;
      exitCode: number | null;
      timedOut: boolean;
    }
  | {
      type: "session_finished";
      status: SessionFinishStatus;
      reason?: string;
    };

export type SessionLiveEventSink = (
  event: SessionLiveEvent,
) => void | Promise<void>;

export const formatSessionLiveEvent = (event: SessionLiveEvent): string => {
  switch (event.type) {
    case "session_started":
      return `Session started: ${event.workflow} - ${event.task}`;
    case "trace_path":
      return `Trace: ${event.tracePath}`;
    case "model_turn_started":
      return `Model turn ${event.turnIndex + 1} started: ${event.model}`;
    case "model_output_delta":
      return event.text;
    case "model_turn_finished":
      return `Model turn ${event.turnIndex + 1} finished: ${event.model}, ${formatCount(
        event.toolCallCount,
        "tool call",
      )}`;
    case "tool_call_started":
      return `Tool started: ${event.toolName}${event.target ? ` ${event.target}` : ""}`;
    case "tool_call_finished":
      return `Tool finished: ${event.toolName} (${event.ok ? "ok" : "failed"})${
        event.summary ? ` - ${event.summary}` : ""
      }`;
    case "permission_checkpoint":
      return `Permission checkpoint: ${event.toolName} ${event.decision}`;
    case "command_started":
      return `Command started: ${event.command}`;
    case "command_finished":
      return `Command finished: ${event.command} (${
        event.timedOut ? "timed out" : `exit ${event.exitCode}`
      })`;
    case "session_finished":
      return event.reason
        ? `Session ${event.status}: ${event.reason}`
        : `Session ${event.status}`;
  }
};

export const createTerminalSessionLiveEventSink =
  (write: (text: string) => void): SessionLiveEventSink => {
    let lastWriteWasUnterminatedModelOutput = false;
    return (event) => {
      if (event.type === "model_output_delta") {
        write(event.text);
        lastWriteWasUnterminatedModelOutput = !event.text.endsWith("\n");
        return;
      }
      if (lastWriteWasUnterminatedModelOutput) write("\n");
      write(`${formatSessionLiveEvent(event)}\n`);
      lastWriteWasUnterminatedModelOutput = false;
    };
  };

const formatCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
