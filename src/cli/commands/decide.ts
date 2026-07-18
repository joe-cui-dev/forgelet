import { resumeCodingSession } from "../../workflows/coding.js";
import type { ResumeDecision } from "../../workflows/coding.js";
import { readPauseSnapshot } from "../../sessions/pauseSnapshot.js";
import { listPausedSessions } from "../../sessions/queue.js";
import {
  createDeepSeekLiveModelClient,
  createTerminalDecidePrompt,
  formatApprovalPrompt,
} from "../wiring.js";
import type { ForgeCommand } from "../parseArgs.js";
import type { RunCliOptions } from "../index.js";

type DecideCommand = Extract<ForgeCommand, { kind: "decide" }>;

export async function runDecideCommand(
  command: DecideCommand,
  ctx: { workspaceRoot: string; options: RunCliOptions },
): Promise<string> {
  const { workspaceRoot, options } = ctx;
  const sessionId = command.sessionId ?? (await resolveSoleQueuedSessionId(workspaceRoot));

  const snapshot = await readPauseSnapshot(workspaceRoot, sessionId);
  const prompt = formatApprovalPrompt({
    toolCall: snapshot.working.pendingToolCall,
    toolRequest: snapshot.working.pendingToolRequest,
    permissionDecision: {
      kind: "confirm",
      riskTier: "medium",
      reason: "Outside the declared Effect Envelope; Session paused for review.",
    },
  });
  const decidePrompt = options.decidePrompt ?? createTerminalDecidePrompt();
  const answer = await decidePrompt(
    `${prompt}\n[a]pprove / [d]eny / [w]iden / [s]top? `,
  );
  const decision = parseDecisionAnswer(answer);

  const modelClient = await (
    options.createLiveModelClient ?? createDeepSeekLiveModelClient
  )({
    workflow: "coding",
    homeDir: options.homeDir,
    workspaceRoot,
    env: options.env ?? process.env,
  });
  const result = await resumeCodingSession({
    workspaceRoot,
    sessionId,
    modelClient,
    decision,
    homeDir: options.homeDir,
    onLiveEvent: options.onLiveEvent,
  });
  return result.summary;
}

async function resolveSoleQueuedSessionId(workspaceRoot: string): Promise<string> {
  const queue = await listPausedSessions(workspaceRoot);
  if (queue.length === 0)
    throw new Error("No Sessions are paused. Run `forge queue` to check.");
  if (queue.length > 1)
    throw new Error(
      `Multiple Sessions are paused; specify one: ${queue
        .map((entry) => entry.sessionId)
        .join(", ")}`,
    );
  const sessionId = queue[0]?.sessionId;
  if (!sessionId) throw new Error("No Sessions are paused. Run `forge queue` to check.");
  return sessionId;
}

function parseDecisionAnswer(rawAnswer: string): ResumeDecision {
  const answer = rawAnswer.trim().toLowerCase();
  if (answer === "a" || answer === "approve") return { kind: "approve" };
  if (answer === "d" || answer === "deny") return { kind: "deny" };
  if (answer === "w" || answer === "widen") return { kind: "widen" };
  if (answer === "s" || answer === "stop") return { kind: "stop" };
  throw new Error(
    `Unrecognized decision: "${rawAnswer}". Enter a, d, w, or s.`,
  );
}
