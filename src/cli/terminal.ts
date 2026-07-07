import { parseArgs } from "./parseArgs.js";
import {
  createTerminalSessionLiveEventSink,
  type SessionLiveEvent,
  type SessionLiveEventSink,
} from "../sessionLiveView/index.js";

export interface InteractiveTerminalOutputController {
  onLiveEvent: SessionLiveEventSink;
  shouldSuppressFinalStdout: (argv: string[]) => boolean;
  formatSuppressedFinalStdoutFooter: (stdout: string) => string;
}

export function createInteractiveTerminalOutputController(
  write: (text: string) => void,
): InteractiveTerminalOutputController {
  const terminalLiveView = createTerminalSessionLiveEventSink(write);
  const turnsWithStreamedOutput = new Set<number>();
  let finalAnswerStreamed = false;

  return {
    onLiveEvent: async (event) => {
      observeStreamedFinalAnswer(event, turnsWithStreamedOutput, (streamed) => {
        finalAnswerStreamed = streamed;
      });
      await terminalLiveView(event);
    },
    shouldSuppressFinalStdout: (argv) =>
      finalAnswerStreamed && isInteractiveWritingRun(argv),
    formatSuppressedFinalStdoutFooter,
  };
}

function observeStreamedFinalAnswer(
  event: SessionLiveEvent,
  turnsWithStreamedOutput: Set<number>,
  setFinalAnswerStreamed: (streamed: boolean) => void,
): void {
  if (event.type === "model_output_delta" && event.text.length > 0) {
    turnsWithStreamedOutput.add(event.turnIndex);
    return;
  }

  if (
    event.type === "model_turn_finished" &&
    event.toolCallCount === 0 &&
    turnsWithStreamedOutput.has(event.turnIndex)
  ) {
    setFinalAnswerStreamed(true);
  }
}

function isInteractiveWritingRun(argv: string[]): boolean {
  try {
    const command = parseArgs(argv);
    return (
      command.kind === "run" &&
      command.workflow === "writing" &&
      !command.preview
    );
  } catch {
    return false;
  }
}

function formatSuppressedFinalStdoutFooter(stdout: string): string {
  return stdout
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("Writing artifact: ") || line.startsWith("Trace: "),
    )
    .join("\n");
}
