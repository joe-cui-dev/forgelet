import { persistBrowserWorkbenchCapture } from "../browser/captures.js";
import type { AuthorizedBrowserLearningLaunch, BrowserLearningLauncher } from "../browserWorkbench/index.js";
import type {
  LearningSessionInput,
  LearningSessionResult,
  PageBriefSessionInput,
  PageBriefSessionResult,
} from "../workflows/learning.js";
import { runLearningSession } from "../workflows/learning.js";

/** The shared Learning Session Launcher seam for CLI and Browser Workbench.
 * Callers supply already-authorized sources and policy, never CLI parsing or
 * Native Messaging protocol types. */
export function launchLearningSession(
  input: PageBriefSessionInput,
): Promise<PageBriefSessionResult>;
export function launchLearningSession(
  input: LearningSessionInput,
): Promise<LearningSessionResult>;
export async function launchLearningSession(
  input: LearningSessionInput,
): Promise<LearningSessionResult | PageBriefSessionResult> {
  return runLearningSession(input);
}

export function createBrowserLearningLauncher(input: {
  homeDir?: string;
  modelClientForWorkspace(workspaceRoot: string): LearningSessionInput["modelClient"];
}): BrowserLearningLauncher {
  return {
    async startLearning(launch: AuthorizedBrowserLearningLaunch) {
      // Persist the full capture before the Session exists: the Trace keeps
      // only preview and hash, and this file is what makes the hash auditable.
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
        startTraceExtras: {
          trigger: {
            kind: "browser_workbench",
            actionId: launch.trigger.actionId,
            invocationId: launch.trigger.invocationId,
            workspaceProfileId: launch.trigger.workspaceProfileId,
            captureId: launch.trigger.captureId,
            captureReadyMs: launch.trigger.captureReadyMs,
          },
        },
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
  };
}
