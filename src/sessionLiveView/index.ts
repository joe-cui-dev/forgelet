import type { SessionFinishStatus, WorkflowKind } from "../types.js";

export type SessionLiveEvent =
  | {
      type: "session_started";
      workflow: WorkflowKind;
      task: string;
    }
  | { type: "trace_path"; tracePath: string }
  | { type: "session_ready"; sessionId: string; tracePath: string }
  | { type: "model_turn_started"; turnIndex: number; model: string }
  | {
      type: "model_output_delta";
      turnIndex: number;
      model: string;
      text: string;
    }
  | {
      type: "model_reasoning_progress";
      turnIndex: number;
      model: string;
      bytesSoFar: number;
      /** Raw text of Provider Carryover accumulated since the last heartbeat
       * (not cumulative). Reasoning Stream only (ADR 0079): present for the
       * interactive CLI terminal sink, stripped by the Browser protocol
       * before an event crosses into a `live_event` frame. */
      text?: string;
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
    }
  | { type: "session_paused"; sessionId: string }
  | { type: "session_resume_failed"; sessionId: string; reason?: string };

export type SessionLiveEventSink = (
  event: SessionLiveEvent,
) => void | Promise<void>;

export const formatSessionLiveEvent = (event: SessionLiveEvent): string => {
  switch (event.type) {
    case "session_started":
      return `Session started: ${event.workflow} - ${event.task}`;
    case "trace_path":
      return `Trace: ${event.tracePath}`;
    case "session_ready":
      return `Session ready: ${event.sessionId}`;
    case "model_turn_started":
      return `Model turn ${event.turnIndex + 1} started: ${event.model}`;
    case "model_output_delta":
      return event.text;
    // The header for a turn's Reasoning Stream (ADR 0079). The terminal sink
    // prints this once per turn, then writes each event's `text` raw; the
    // event's own bytesSoFar/text never flow through this formatter.
    case "model_reasoning_progress":
      return `Model turn ${event.turnIndex + 1} thinking:`;
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
    case "session_paused":
      return `Session paused: ${event.sessionId}`;
    case "session_resume_failed":
      return `Resume attempt failed${event.reason ? `: ${event.reason}` : ""}. Session remains paused; run \`forge decide ${event.sessionId}\` to retry.`;
  }
};

export const createTerminalSessionLiveEventSink =
  (write: (text: string) => void): SessionLiveEventSink => {
    // Which raw stream is open: both model_output_delta and
    // model_reasoning_progress stream raw text across many events, and this
    // says which one, if either, owns the current line. It gates the
    // Reasoning Stream header to once per turn — it does not reset merely
    // because a batch's own text happens to end in "\n".
    let openRawStream: "none" | "output" | "reasoning" = "none";
    // Whether the most recent write left the cursor mid-line. Tracked apart
    // from openRawStream so a batch ending in "\n" doesn't cause a spurious
    // blank line the next time a stream switches or a formatted line prints.
    let lineIsOpen = false;
    return (event) => {
      if (event.type === "model_output_delta") {
        if (openRawStream === "reasoning" && lineIsOpen) write("\n");
        write(event.text);
        openRawStream = "output";
        lineIsOpen = !event.text.endsWith("\n");
        return;
      }
      if (event.type === "model_reasoning_progress") {
        const text = event.text ?? "";
        if (openRawStream !== "reasoning") {
          if (openRawStream === "output" && lineIsOpen) write("\n");
          write(`${formatSessionLiveEvent(event)}\n`);
        }
        write(text);
        openRawStream = "reasoning";
        lineIsOpen = !text.endsWith("\n");
        return;
      }
      if (lineIsOpen) write("\n");
      write(`${formatSessionLiveEvent(event)}\n`);
      openRawStream = "none";
      lineIsOpen = false;
    };
  };

const formatCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
