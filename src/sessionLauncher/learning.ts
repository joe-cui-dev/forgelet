import type { AuthorizedBrowserLearningLaunch, BrowserLearningLauncher } from "../browserWorkbench/index.js";
import type { LearningSessionInput, LearningSessionResult } from "../workflows/learning.js";
import { runLearningSession } from "../workflows/learning.js";

/** The shared Learning Session Launcher seam for CLI and Browser Workbench.
 * Callers supply already-authorized sources and policy, never CLI parsing or
 * Native Messaging protocol types. */
export async function launchLearningSession(
  input: LearningSessionInput,
): Promise<LearningSessionResult> {
  return runLearningSession(input);
}

export function createBrowserLearningLauncher(input: {
  homeDir?: string;
  modelClientForWorkspace(workspaceRoot: string): LearningSessionInput["modelClient"];
}): BrowserLearningLauncher {
  return {
    async startLearning(launch: AuthorizedBrowserLearningLaunch) {
      let finish: { status: string; reason?: string } | undefined;
      const result = await launchLearningSession({
        task: launch.task,
        contextFiles: [],
        browserSnapshot: launch.browserSnapshot,
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
        ...(result.completion ? { learningPack: result.completion } : {}),
      };
    },
  };
}
