import { persistBrowserWorkbenchCapture } from "../browser/captures.js";
import type {
  AuthorizedBrowserLearningLaunch,
  AuthorizedBrowserPageAnswerLaunch,
  BrowserLearningLauncher,
  BrowserSessionTrigger,
} from "../browserWorkbench/index.js";
import type {
  LearningSessionInput,
  LearningSessionResult,
  PageAnswerSessionInput,
  PageAnswerSessionResult,
  PageBriefSessionInput,
  PageBriefSessionResult,
} from "../workflows/learning.js";
import { runLearningSession } from "../workflows/learning.js";
import type { TraceEventPayloads } from "../trace/index.js";

/** The shared Learning Session Launcher seam for CLI and Browser Workbench.
 * Callers supply already-authorized sources and policy, never CLI parsing or
 * Native Messaging protocol types. */
export function launchLearningSession(
  input: PageBriefSessionInput,
): Promise<PageBriefSessionResult>;
export function launchLearningSession(
  input: PageAnswerSessionInput,
): Promise<PageAnswerSessionResult>;
export function launchLearningSession(
  input: LearningSessionInput,
): Promise<LearningSessionResult>;
export async function launchLearningSession(
  input: LearningSessionInput | PageAnswerSessionInput,
): Promise<LearningSessionResult | PageBriefSessionResult | PageAnswerSessionResult> {
  return runLearningSession(input);
}

/** The `session_started.payload.trigger` shape src/browserWorkbench/
 * pageConversationHistory.ts and followUpPreflight.ts parse back out of the
 * Trace (ADR 0051): this is the single place that renders it. */
function browserSessionTraceExtras(
  trigger: BrowserSessionTrigger,
): Pick<TraceEventPayloads["session_started"], "trigger"> {
  return {
    trigger: {
      kind: trigger.kind,
      conversationId: trigger.conversationId,
      actionId: trigger.actionId,
      invocationId: trigger.invocationId,
      workspaceProfileId: trigger.workspaceProfileId,
      captureId: trigger.captureId,
      ...(trigger.captureReadyMs !== undefined
        ? { captureReadyMs: trigger.captureReadyMs }
        : {}),
      ...(trigger.rootSessionId ? { rootSessionId: trigger.rootSessionId } : {}),
      ...(trigger.parentSessionId
        ? { parentSessionId: trigger.parentSessionId }
        : {}),
      ...(trigger.outputLanguage
        ? { outputLanguage: trigger.outputLanguage }
        : {}),
    },
  };
}

export function createBrowserLearningLauncher(input: {
  homeDir?: string;
  modelClientForWorkspace(workspaceRoot: string): LearningSessionInput["modelClient"];
}): BrowserLearningLauncher {
  return {
    async startLearning(launch: AuthorizedBrowserLearningLaunch) {
      // Persist the full capture before the Session exists: the Trace keeps
      // only preview and hash, and this file is what makes the hash auditable.
      // Root Retry already verified and reloaded the same persisted capture
      // (WP7); re-persisting it here is an idempotent overwrite of identical
      // bytes, not a second source of truth.
      const contentPath = await persistBrowserWorkbenchCapture({
        workspaceRoot: launch.workspaceRoot,
        capture: {
          captureId: launch.trigger.captureId,
          url: launch.browserSnapshot.url,
          title: launch.browserSnapshot.title,
          capturedAt: launch.browserSnapshot.capturedAt,
          contentKind: launch.browserSnapshot.contentKind,
          contentHash: launch.browserSnapshot.contentHash,
          contentBytes: launch.browserSnapshot.contentBytes,
          truncated: launch.browserSnapshot.truncated ?? false,
          content: launch.browserSnapshot.content,
        },
      });
      let finish: { status: string; reason?: string } | undefined;
      const result = await launchLearningSession({
        deliverableShape: "pageBrief",
        task: launch.task,
        contextFiles: [],
        browserSnapshot: { ...launch.browserSnapshot, contentPath },
        modelClient: input.modelClientForWorkspace(launch.workspaceRoot),
        workspaceRoot: launch.workspaceRoot,
        homeDir: input.homeDir,
        executionPolicy: launch.executionPolicy,
        startTraceExtras: browserSessionTraceExtras(launch.trigger),
        debug: launch.debug,
        signal: launch.signal,
        onLiveEvent: async (event) => {
          if (event.type === "session_finished") {
            finish = { status: event.status, ...(event.reason ? { reason: event.reason } : {}) };
          }
          await launch.onLiveEvent(event);
        },
      });
      if (finish?.status === "stopped") {
        return { status: "stopped" as const, reason: finish.reason ?? "user_stopped" };
      }
      return {
        status: "completed" as const,
        summary: result.summary,
        ...(result.completion ? { pageBrief: result.completion } : {}),
      };
    },

    async startPageAnswer(launch: AuthorizedBrowserPageAnswerLaunch) {
      let finish: { status: string; reason?: string } | undefined;
      const result = await launchLearningSession({
        deliverableShape: "pageAnswer",
        task: launch.question,
        contextFiles: [],
        browserSnapshot: launch.browserSnapshot,
        modelClient: input.modelClientForWorkspace(launch.workspaceRoot),
        workspaceRoot: launch.workspaceRoot,
        homeDir: input.homeDir,
        executionPolicy: launch.executionPolicy,
        continuationSourceSessionId: launch.continuationSourceSessionId,
        pageConversationHistory: launch.pageConversationHistory,
        outputLanguage: launch.trigger.outputLanguage,
        startTraceExtras: browserSessionTraceExtras(launch.trigger),
        debug: launch.debug,
        signal: launch.signal,
        onLiveEvent: async (event) => {
          if (event.type === "session_finished") {
            finish = { status: event.status, ...(event.reason ? { reason: event.reason } : {}) };
          }
          await launch.onLiveEvent(event);
        },
      });
      if (finish?.status === "stopped") {
        return { status: "stopped" as const, reason: finish.reason ?? "user_stopped" };
      }
      return {
        status: "completed" as const,
        summary: result.summary,
        ...(result.completion ? { pageAnswer: result.completion } : {}),
      };
    },
  };
}
