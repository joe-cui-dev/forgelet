import type { LoadedBrowserSnapshot } from "../browser/index.js";
import type { ProtocolLauncher, ProtocolLaunchResult } from "../browser/protocol.js";
import type { ExecutionPolicy } from "../kernel/workflowDefinition.js";
import type { SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { LearningPack } from "../workflows/learning.js";

export interface BrowserSummaryInvocation {
  actionId: string;
  invocationId: string;
  workspaceProfileId: string;
  uiLanguage?: string;
  capture: LoadedBrowserSnapshot & { captureId: string; captureReadyMs: number };
}

export interface AuthorizedBrowserLearningLaunch {
  workspaceRoot: string;
  task: string;
  browserSnapshot: LoadedBrowserSnapshot;
  executionPolicy: ExecutionPolicy;
  trigger: {
    actionId: string;
    invocationId: string;
    workspaceProfileId: string;
    captureId: string;
    captureReadyMs: number;
  };
  signal?: AbortSignal;
  onLiveEvent: SessionLiveEventSink;
}

export interface BrowserLearningLauncher {
  startLearning(input: AuthorizedBrowserLearningLaunch): Promise<
    | { status: "completed"; summary: string; learningPack?: LearningPack }
    | { status: "stopped"; reason: string }
    | { status: "failed"; message: string }
  >;
}

export function createBrowserWorkbench(input: {
  resolveProfile(profileId: string): Promise<{ id: string; label: string; path: string }>;
  startLearning: BrowserLearningLauncher["startLearning"];
}): ProtocolLauncher {
  return {
    async launch({ actionId, invocationId, payload, signal, onLiveEvent }): Promise<ProtocolLaunchResult> {
      if (signal?.aborted) throw new Error("Session launch cancelled before Session creation.");
      const invocation = parseBrowserSummaryInvocation(payload, actionId, invocationId);
      const profile = await input.resolveProfile(invocation.workspaceProfileId);
      if (signal?.aborted) throw new Error("Session launch cancelled before Session creation.");
      return input.startLearning({
        workspaceRoot: profile.path,
        task: browserSummaryTask(invocation.uiLanguage),
        browserSnapshot: invocation.capture,
        executionPolicy: "answer_once",
        trigger: {
          actionId: invocation.actionId,
          invocationId: invocation.invocationId,
          workspaceProfileId: profile.id,
          captureId: invocation.capture.captureId,
          captureReadyMs: invocation.capture.captureReadyMs,
        },
        signal,
        onLiveEvent,
      });
    },
  };
}

function browserSummaryTask(uiLanguage: string | undefined): string {
  const base = "Summarize the explicitly shared current browser page as a concise Learning Pack.";
  if (!uiLanguage) return base;
  return `${base} The user's browser UI language is ${uiLanguage}. Keep the Learning Pack headings in English and write all other text in that language.`;
}

function parseBrowserSummaryInvocation(
  payload: Record<string, unknown>,
  actionId: string,
  invocationId: string,
): BrowserSummaryInvocation {
  requireOnlyKeys(payload, ["workspaceProfileId", "uiLanguage", "capture"], "Browser invocation payload");
  const workspaceProfileId = requiredString(payload, "workspaceProfileId", "Browser invocation payload");
  const uiLanguage = optionalLanguageTag(payload, "uiLanguage", "Browser invocation payload");
  const capture = requiredRecord(payload, "capture", "Browser invocation payload");
  requireOnlyKeys(
    capture,
    [
      "url",
      "title",
      "content",
      "contentKind",
      "contentHash",
      "contentBytes",
      "captureId",
      "capturedAt",
      "captureReadyMs",
    ],
    "Browser capture",
  );
  const content = requiredString(capture, "content", "Browser capture");
  if (Buffer.byteLength(content, "utf8") > 64 * 1024) {
    throw new Error("Browser capture exceeds 65536 bytes.");
  }
  const contentKind = requiredString(capture, "contentKind", "Browser capture");
  if (contentKind !== "selectedText" && contentKind !== "mainText") {
    throw new Error("Browser capture has an invalid contentKind.");
  }
  return {
    actionId,
    invocationId,
    workspaceProfileId,
    ...(uiLanguage ? { uiLanguage } : {}),
    capture: {
      url: requiredString(capture, "url", "Browser capture"),
      title: requiredString(capture, "title", "Browser capture"),
      content,
      contentKind,
      contentHash: requiredString(capture, "contentHash", "Browser capture"),
      contentBytes: requiredNumber(capture, "contentBytes", "Browser capture"),
      captureId: requiredString(capture, "captureId", "Browser capture"),
      capturedAt: requiredString(capture, "capturedAt", "Browser capture"),
      captureReadyMs: requiredNumber(capture, "captureReadyMs", "Browser capture"),
      preview: makePreview(content),
    },
  };
}

function requiredRecord(value: Record<string, unknown>, key: string, subject: string): Record<string, unknown> {
  const field = value[key];
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new Error(`${subject} is missing ${key}.`);
  }
  return field as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string, subject: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`${subject} is missing ${key}.`);
  }
  return field;
}

// Mirrors normalizeBrowserUiLanguage in src/browser/extension/workbench.ts; the
// extension drops what this boundary would reject, but the host must not trust it.
const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

function optionalLanguageTag(
  value: Record<string, unknown>,
  key: string,
  subject: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length > 35 || !LANGUAGE_TAG_PATTERN.test(field)) {
    throw new Error(`${subject} has an invalid ${key}.`);
  }
  return field;
}

function requiredNumber(value: Record<string, unknown>, key: string, subject: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
    throw new Error(`${subject} has an invalid ${key}.`);
  }
  return field;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], subject: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${subject} contains forbidden field: ${unexpected}.`);
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
