import type { BrowserWorkbenchCapture } from "../browser/captures.js";
import type { LoadedBrowserSnapshot } from "../browser/index.js";
import type {
  BrowserInvocationRequest,
  ProtocolLauncher,
  ProtocolLaunchResult,
} from "../browser/protocol.js";
import type { ExecutionPolicy } from "../kernel/workflowDefinition.js";
import type { SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { PageAnswer, PageAnswerConversationTurn, PageBrief } from "../workflows/learning.js";
import {
  preflightBrowserFollowUp,
  verifyPersistedCapture,
  type ResolvedBrowserProfile,
} from "./followUpPreflight.js";

/** Recorded in every Session start Trace (ADR 0051): lets root/child identity
 * relationships be reconstructed from Traces alone, without extension storage. */
export interface BrowserSessionTrigger {
  kind: "root" | "root_retry" | "follow_up" | "follow_up_retry";
  conversationId: string;
  actionId: string;
  invocationId: string;
  workspaceProfileId: string;
  captureId: string;
  captureReadyMs?: number;
  rootSessionId?: string;
  parentSessionId?: string;
  outputLanguage?: string;
}

export interface AuthorizedBrowserLearningLaunch {
  workspaceRoot: string;
  task: string;
  browserSnapshot: LoadedBrowserSnapshot;
  executionPolicy: ExecutionPolicy;
  trigger: BrowserSessionTrigger;
  signal?: AbortSignal;
  onLiveEvent: SessionLiveEventSink;
}

export interface AuthorizedBrowserPageAnswerLaunch {
  workspaceRoot: string;
  question: string;
  browserSnapshot: LoadedBrowserSnapshot;
  continuationSourceSessionId: string;
  pageConversationHistory: PageAnswerConversationTurn[];
  executionPolicy: ExecutionPolicy;
  trigger: BrowserSessionTrigger;
  signal?: AbortSignal;
  onLiveEvent: SessionLiveEventSink;
}

export type BrowserLearningLaunchOutcome =
  | { status: "completed"; summary: string; pageBrief?: PageBrief }
  | { status: "stopped"; reason: string }
  | { status: "failed"; message: string };

export type BrowserPageAnswerLaunchOutcome =
  | { status: "completed"; summary: string; pageAnswer?: PageAnswer }
  | { status: "stopped"; reason: string }
  | { status: "failed"; message: string };

export interface BrowserLearningLauncher {
  startLearning(
    input: AuthorizedBrowserLearningLaunch,
  ): Promise<BrowserLearningLaunchOutcome>;
  startPageAnswer(
    input: AuthorizedBrowserPageAnswerLaunch,
  ): Promise<BrowserPageAnswerLaunchOutcome>;
}

export function createBrowserWorkbench(input: {
  resolveProfile(profileId: string): Promise<ResolvedBrowserProfile>;
  startLearning: BrowserLearningLauncher["startLearning"];
  startPageAnswer: BrowserLearningLauncher["startPageAnswer"];
}): ProtocolLauncher {
  return {
    async launch({ request, signal, onLiveEvent }): Promise<ProtocolLaunchResult> {
      assertNotCancelled(signal);
      if (request.kind === "root")
        return launchRoot(request, input, signal, onLiveEvent);
      if (request.kind === "root_retry")
        return launchRootRetry(request, input, signal, onLiveEvent);
      return launchFollowUp(request, input, signal, onLiveEvent);
    },
  };
}

async function launchRoot(
  request: Extract<BrowserInvocationRequest, { kind: "root" }>,
  deps: Parameters<typeof createBrowserWorkbench>[0],
  signal: AbortSignal | undefined,
  onLiveEvent: SessionLiveEventSink,
): Promise<ProtocolLaunchResult> {
  const profile = await deps.resolveProfile(request.workspaceProfileId);
  assertNotCancelled(signal);
  const result = await deps.startLearning({
    workspaceRoot: profile.path,
    task: browserSummaryTask(request.outputLanguage),
    browserSnapshot: { ...request.capture, preview: makePreview(request.capture.content) },
    executionPolicy: "answer_once",
    trigger: {
      kind: "root",
      conversationId: request.conversationId,
      actionId: request.actionId,
      invocationId: request.invocationId,
      workspaceProfileId: profile.id,
      captureId: request.capture.captureId,
      captureReadyMs: request.capture.captureReadyMs,
      ...(request.outputLanguage ? { outputLanguage: request.outputLanguage } : {}),
    },
    signal,
    onLiveEvent,
  });
  return mapLaunchOutcome("pageBrief", result);
}

async function launchRootRetry(
  request: Extract<BrowserInvocationRequest, { kind: "root_retry" }>,
  deps: Parameters<typeof createBrowserWorkbench>[0],
  signal: AbortSignal | undefined,
  onLiveEvent: SessionLiveEventSink,
): Promise<ProtocolLaunchResult> {
  const profile = await deps.resolveProfile(request.workspaceProfileId);
  assertNotCancelled(signal);
  // Root Retry carries no fresh capture bytes: it must reload and verify the
  // same persisted capture the original root attempt captured (ADR 0044).
  const capture = await verifyPersistedCapture(profile.path, request.captureId);
  assertNotCancelled(signal);
  const result = await deps.startLearning({
    workspaceRoot: profile.path,
    task: browserSummaryTask(request.outputLanguage),
    browserSnapshot: captureToBrowserSnapshot(capture),
    executionPolicy: "answer_once",
    trigger: {
      kind: "root_retry",
      conversationId: request.conversationId,
      actionId: request.actionId,
      invocationId: request.invocationId,
      workspaceProfileId: profile.id,
      captureId: capture.captureId,
      ...(request.outputLanguage ? { outputLanguage: request.outputLanguage } : {}),
    },
    signal,
    onLiveEvent,
  });
  return mapLaunchOutcome("pageBrief", result);
}

async function launchFollowUp(
  request: Extract<
    BrowserInvocationRequest,
    { kind: "follow_up" | "follow_up_retry" }
  >,
  deps: Parameters<typeof createBrowserWorkbench>[0],
  signal: AbortSignal | undefined,
  onLiveEvent: SessionLiveEventSink,
): Promise<ProtocolLaunchResult> {
  const preflight = await preflightBrowserFollowUp({
    workspaceProfileId: request.workspaceProfileId,
    conversationId: request.conversationId,
    captureId: request.captureId,
    rootSessionId: request.rootSessionId,
    headSessionId: request.parentSessionId,
    resolveProfile: deps.resolveProfile,
  });
  assertNotCancelled(signal);
  const result = await deps.startPageAnswer({
    workspaceRoot: preflight.workspaceRoot,
    question: request.question,
    browserSnapshot: captureToBrowserSnapshot(preflight.capture),
    continuationSourceSessionId: request.parentSessionId,
    pageConversationHistory: preflight.history.turns,
    executionPolicy: "answer_once",
    trigger: {
      kind: request.kind,
      conversationId: request.conversationId,
      actionId: request.actionId,
      invocationId: request.invocationId,
      workspaceProfileId: preflight.workspaceProfileId,
      captureId: request.captureId,
      rootSessionId: request.rootSessionId,
      parentSessionId: request.parentSessionId,
      ...(request.outputLanguage ? { outputLanguage: request.outputLanguage } : {}),
    },
    signal,
    onLiveEvent,
  });
  return mapLaunchOutcome("pageAnswer", result);
}

function mapLaunchOutcome(
  deliverable: "pageBrief" | "pageAnswer",
  outcome:
    | { status: "completed"; summary: string; pageBrief?: PageBrief; pageAnswer?: PageAnswer }
    | { status: "stopped"; reason: string }
    | { status: "failed"; message: string },
): ProtocolLaunchResult {
  if (outcome.status !== "completed") return outcome;
  const completion = outcome[deliverable];
  return {
    status: "completed",
    summary: outcome.summary,
    ...(completion ? { [deliverable]: completion } : {}),
  };
}

function captureToBrowserSnapshot(
  capture: BrowserWorkbenchCapture,
): LoadedBrowserSnapshot {
  return {
    url: capture.url,
    title: capture.title,
    capturedAt: capture.capturedAt,
    contentKind: capture.contentKind,
    content: capture.content,
    contentBytes: capture.contentBytes,
    contentHash: capture.contentHash,
    truncated: capture.truncated,
    preview: makePreview(capture.content),
  };
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new Error("Session launch cancelled before Session creation.");
}

function browserSummaryTask(outputLanguage: string | undefined): string {
  const base = "Summarize the explicitly shared current browser page as a concise Page Brief.";
  if (!outputLanguage) return base;
  return `${base} Write all body text in ${outputLanguage}; keep the Page Brief headings in English.`;
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
