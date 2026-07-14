import { createHash } from "node:crypto";
import type { SessionLiveEvent, SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { PageBrief } from "../workflows/learning.js";
import {
  claimInvocation,
  recordInvocationOutcome,
  type InvocationReceipt,
} from "./invocations.js";

export const BROWSER_PROTOCOL_VERSION = 3;
const MAX_INVOCATION_PAYLOAD_BYTES = 64 * 1024;
export const MAX_FOLLOW_UP_QUESTION_BYTES = 4 * 1024;

export interface BrowserCaptureRequest {
  url: string;
  title: string;
  content: string;
  contentKind: "selectedText" | "mainText";
  contentHash: string;
  contentBytes: number;
  captureId: string;
  capturedAt: string;
  captureReadyMs: number;
  truncated: boolean;
}

interface BrowserInvocationBase {
  version: typeof BROWSER_PROTOCOL_VERSION;
  conversationId: string;
  actionId: string;
  invocationId: string;
  workspaceProfileId: string;
  outputLanguage?: string;
}

export interface BrowserRootInvocationRequest extends BrowserInvocationBase {
  kind: "root";
  capture: BrowserCaptureRequest;
}

export interface BrowserRootRetryInvocationRequest extends BrowserInvocationBase {
  kind: "root_retry";
  captureId: string;
}

export interface BrowserFollowUpInvocationRequest extends BrowserInvocationBase {
  kind: "follow_up";
  captureId: string;
  rootSessionId: string;
  parentSessionId: string;
  question: string;
}

export interface BrowserFollowUpRetryInvocationRequest extends BrowserInvocationBase {
  kind: "follow_up_retry";
  captureId: string;
  rootSessionId: string;
  parentSessionId: string;
  question: string;
}

export type BrowserInvocationRequest =
  | BrowserRootInvocationRequest
  | BrowserRootRetryInvocationRequest
  | BrowserFollowUpInvocationRequest
  | BrowserFollowUpRetryInvocationRequest;

export type BrowserProtocolValidationReason =
  | "protocol_mismatch"
  | "oversized"
  | "malformed";

/** Machine-readable browser outcomes are intentionally distinct from their
 * user-facing messages. The Side Panel can select a stable recovery action
 * without parsing a provider error or a Trace-oriented diagnostic. */
export type BrowserLaunchRejectionCode =
  | BrowserProtocolValidationReason
  | "workspace_profile_unavailable"
  | "source_unavailable"
  | "source_integrity_mismatch"
  | "conversation_history_unavailable";

export type BrowserAttemptFailureCode = "invalid_page_answer";

export class BrowserProtocolValidationError extends Error {
  readonly reason: BrowserProtocolValidationReason;
  constructor(reason: BrowserProtocolValidationReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export function validateBrowserInvocationRequest(
  raw: unknown,
): BrowserInvocationRequest {
  if (!isRecord(raw))
    throw new BrowserProtocolValidationError(
      "malformed",
      "Invocation request must be an object.",
    );
  if (raw.version !== BROWSER_PROTOCOL_VERSION)
    throw new BrowserProtocolValidationError(
      "protocol_mismatch",
      `Browser Workbench protocol mismatch (received v${String(raw.version)}, expected v3). Rebuild Forgelet, reload the unpacked extension, and rerun forge browser install-host if needed.`,
    );
  const payloadBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (payloadBytes > MAX_INVOCATION_PAYLOAD_BYTES)
    throw new BrowserProtocolValidationError(
      "oversized",
      `Invocation payload exceeds ${MAX_INVOCATION_PAYLOAD_BYTES} bytes.`,
    );
  requireOnlyKeys(raw, requestKeys(raw.kind), "Invocation request");
  const base: BrowserInvocationBase = {
    version: BROWSER_PROTOCOL_VERSION,
    conversationId: requiredString(raw, "conversationId", "Invocation request"),
    actionId: requiredString(raw, "actionId", "Invocation request"),
    invocationId: requiredString(raw, "invocationId", "Invocation request"),
    workspaceProfileId: requiredString(raw, "workspaceProfileId", "Invocation request"),
    ...(optionalLanguageTag(raw) ? { outputLanguage: optionalLanguageTag(raw) } : {}),
  };
  if (raw.kind === "root") return { ...base, kind: "root", capture: parseCapture(raw.capture) };
  if (raw.kind === "root_retry") return { ...base, kind: "root_retry", captureId: requiredString(raw, "captureId", "Invocation request") };
  if (raw.kind === "follow_up") {
    const question = requiredString(raw, "question", "Invocation request").trim();
    if (Buffer.byteLength(question, "utf8") > MAX_FOLLOW_UP_QUESTION_BYTES)
      throw new BrowserProtocolValidationError("oversized", `Follow-up question exceeds ${MAX_FOLLOW_UP_QUESTION_BYTES} bytes.`);
    return {
      ...base,
      kind: "follow_up",
      captureId: requiredString(raw, "captureId", "Invocation request"),
      rootSessionId: requiredString(raw, "rootSessionId", "Invocation request"),
      parentSessionId: requiredString(raw, "parentSessionId", "Invocation request"),
      question,
    };
  }
  if (raw.kind === "follow_up_retry") {
    const question = requiredString(raw, "question", "Invocation request").trim();
    if (Buffer.byteLength(question, "utf8") > MAX_FOLLOW_UP_QUESTION_BYTES)
      throw new BrowserProtocolValidationError("oversized", `Follow-up question exceeds ${MAX_FOLLOW_UP_QUESTION_BYTES} bytes.`);
    return { ...base, kind: "follow_up_retry", captureId: requiredString(raw, "captureId", "Invocation request"), rootSessionId: requiredString(raw, "rootSessionId", "Invocation request"), parentSessionId: requiredString(raw, "parentSessionId", "Invocation request"), question };
  }
  throw new BrowserProtocolValidationError("malformed", "Invocation request has an invalid kind.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestKeys(kind: unknown): string[] {
  const base = ["version", "kind", "conversationId", "actionId", "invocationId", "workspaceProfileId", "outputLanguage"];
  if (kind === "root") return [...base, "capture"];
  if (kind === "root_retry") return [...base, "captureId"];
  if (kind === "follow_up" || kind === "follow_up_retry") return [...base, "captureId", "rootSessionId", "parentSessionId", "question"];
  return base;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], subject: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new BrowserProtocolValidationError("malformed", `${subject} contains forbidden field: ${unexpected}.`);
}

function requiredString(value: Record<string, unknown>, key: string, subject: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "")
    throw new BrowserProtocolValidationError("malformed", `${subject} is missing ${key}.`);
  return field;
}

function optionalLanguageTag(value: Record<string, unknown>): string | undefined {
  const field = value.outputLanguage;
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length > 35 || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(field))
    throw new BrowserProtocolValidationError("malformed", "Invocation request has an invalid outputLanguage.");
  return field;
}

function parseCapture(raw: unknown): BrowserCaptureRequest {
  if (!isRecord(raw)) throw new BrowserProtocolValidationError("malformed", "Invocation request is missing capture.");
  requireOnlyKeys(raw, ["url", "title", "content", "contentKind", "contentHash", "contentBytes", "captureId", "capturedAt", "captureReadyMs", "truncated"], "Browser capture");
  const content = requiredString(raw, "content", "Browser capture");
  if (Buffer.byteLength(content, "utf8") > MAX_INVOCATION_PAYLOAD_BYTES)
    throw new BrowserProtocolValidationError("oversized", `Browser capture exceeds ${MAX_INVOCATION_PAYLOAD_BYTES} bytes.`);
  const contentKind = requiredString(raw, "contentKind", "Browser capture");
  if (contentKind !== "selectedText" && contentKind !== "mainText")
    throw new BrowserProtocolValidationError("malformed", "Browser capture has an invalid contentKind.");
  const contentBytes = raw.contentBytes;
  const captureReadyMs = raw.captureReadyMs;
  if (typeof contentBytes !== "number" || !Number.isFinite(contentBytes) || contentBytes < 0 || typeof captureReadyMs !== "number" || !Number.isFinite(captureReadyMs) || captureReadyMs < 0 || typeof raw.truncated !== "boolean")
    throw new BrowserProtocolValidationError("malformed", "Browser capture has invalid metadata.");
  return { url: requiredString(raw, "url", "Browser capture"), title: requiredString(raw, "title", "Browser capture"), content, contentKind, contentHash: requiredString(raw, "contentHash", "Browser capture"), contentBytes, captureId: requiredString(raw, "captureId", "Browser capture"), capturedAt: requiredString(raw, "capturedAt", "Browser capture"), captureReadyMs, truncated: raw.truncated };
}

// The transport envelope from ADR 0039: invocation_accepted, then exactly one
// of launch_rejected | session_ready, then live_event*, then exactly one
// terminal frame. SessionLiveEvent is wrapped inside live_event; it is not
// the protocol itself.
export type BrowserRunFrame =
  | { type: "invocation_accepted"; conversationId: string; invocationId: string; seq: number }
  | {
      type: "launch_rejected";
      conversationId: string;
      invocationId: string;
      seq: number;
      reason: string;
      code?: BrowserLaunchRejectionCode;
    }
  | {
      type: "session_ready";
      conversationId: string;
      invocationId: string;
      seq: number;
      sessionId: string;
      tracePath: string;
    }
  | { type: "live_event"; conversationId: string; invocationId: string; seq: number; event: SessionLiveEvent }
  | {
      type: "page_brief_completed";
      conversationId: string;
      invocationId: string;
      seq: number;
      summary: string;
      pageBrief: PageBrief;
    }
  | {
      type: "page_answer_completed";
      conversationId: string;
      invocationId: string;
      seq: number;
      summary: string;
      pageAnswer: BrowserPageAnswer;
    }
  | { type: "stopped"; conversationId: string; invocationId: string; seq: number; reason: string }
  | {
      type: "failed";
      conversationId: string;
      invocationId: string;
      seq: number;
      message: string;
      code?: BrowserAttemptFailureCode;
    }
  | { type: "action_conflict"; conversationId: string; invocationId: string; seq: number };

export interface BrowserPageAnswer {
  answer: string;
  groundingStatus: "supported" | "not_found";
  evidence: string[];
}

export type ProtocolLaunchResult =
  | { status: "completed"; summary: string; pageBrief?: PageBrief; pageAnswer?: BrowserPageAnswer }
  | { status: "stopped"; reason: string }
  | { status: "failed"; message: string };

/** The seam the protocol drives. A real Adapter (WP9) backs this with the
 * Learning Session Launcher; `launch` rejects only for a preflight failure
 * (no Trace/Session ever existed), matching `runKernelSession` (ADR 0036). */
export interface ProtocolLauncher {
  launch(input: {
    request: BrowserInvocationRequest;
    signal?: AbortSignal;
    onLiveEvent: SessionLiveEventSink;
  }): Promise<ProtocolLaunchResult>;
}

export interface RunBrowserInvocationOptions {
  homeDir?: string;
  now?: Date;
  signal?: AbortSignal;
}

export function runBrowserInvocation(
  request: BrowserInvocationRequest,
  launcher: ProtocolLauncher,
  options: RunBrowserInvocationOptions = {},
): AsyncIterable<BrowserRunFrame> {
  const queue = new AsyncFrameQueue<BrowserRunFrame>();
  let seq = 0;
  const emit = (frame: Record<string, unknown> & { type: string }): void => {
    queue.push({
      ...frame,
      conversationId: request.conversationId,
      invocationId: request.invocationId,
      seq: seq++,
    } as BrowserRunFrame);
  };

  void driveInvocation(request, launcher, options, emit).finally(() => queue.finish());

  return queue;
}

async function driveInvocation(
  request: BrowserInvocationRequest,
  launcher: ProtocolLauncher,
  options: RunBrowserInvocationOptions,
  emit: (frame: Record<string, unknown> & { type: string }) => void,
): Promise<void> {
  let sessionStarted = false;
  emit({ type: "invocation_accepted" });

  const payloadHash = hashPayload(request);
  const claim = await claimInvocation({
    homeDir: options.homeDir,
    actionId: request.actionId,
    invocationId: request.invocationId,
    conversationId: request.conversationId,
    attemptKind: request.kind,
    payloadHash,
    now: options.now,
  });

  if (claim.outcome === "conflict") {
    emit({ type: "action_conflict" });
    return;
  }

  if (claim.outcome === "replay") {
    replayReceipt(claim.receipt, emit);
    return;
  }

  try {
    const result = await launcher.launch({
      request,
      signal: options.signal,
      onLiveEvent: async (event) => {
        if (event.type === "session_ready") {
          sessionStarted = true;
          await recordInvocationOutcome({
            homeDir: options.homeDir,
            actionId: request.actionId,
            invocationId: request.invocationId,
            state: "ready",
            sessionId: event.sessionId,
            tracePath: event.tracePath,
            now: options.now,
          });
          emit({
            type: "session_ready",
            sessionId: event.sessionId,
            tracePath: event.tracePath,
          });
          return;
        }
        emit({ type: "live_event", event });
      },
    });

    const finalResult = result.status === "completed" && !result.pageBrief && !result.pageAnswer
      ? { status: "failed" as const, message: "Browser invocation completed without a Page Brief or Page Answer." }
      : result;
    await recordInvocationOutcome({
      homeDir: options.homeDir,
      actionId: request.actionId,
      invocationId: request.invocationId,
      state: finalResult.status,
      ...(finalResult.status === "completed" ? { summary: finalResult.summary } : {}),
      ...(finalResult.status === "completed" && finalResult.pageBrief
        ? { pageBrief: finalResult.pageBrief }
        : {}),
      ...(finalResult.status === "completed" && finalResult.pageAnswer
        ? { pageAnswer: finalResult.pageAnswer }
        : {}),
      ...(finalResult.status === "stopped" ? { reason: finalResult.reason } : {}),
      ...(finalResult.status === "failed" ? { reason: finalResult.message } : {}),
      now: options.now,
    });
    emit(
      finalResult.status === "completed" && finalResult.pageAnswer
        ? { type: "page_answer_completed", summary: finalResult.summary, pageAnswer: finalResult.pageAnswer }
        : finalResult.status === "completed" && finalResult.pageBrief
          ? { type: "page_brief_completed", summary: finalResult.summary, pageBrief: finalResult.pageBrief }
        : finalResult.status === "stopped"
          ? { type: "stopped", reason: finalResult.reason }
          : { type: "failed", message: finalResult.status === "failed" ? finalResult.message : "Browser invocation failed." },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = sessionStarted
      ? attemptFailureCode(error)
      : launchRejectionCode(error);
    await recordInvocationOutcome({
      homeDir: options.homeDir,
      actionId: request.actionId,
      invocationId: request.invocationId,
      state: sessionStarted ? "failed" : "rejected",
      reason: message,
      ...(code ? { code } : {}),
      now: options.now,
    });
    emit(
      sessionStarted
        ? { type: "failed", message, ...(code ? { code } : {}) }
        : { type: "launch_rejected", reason: message, ...(code ? { code } : {}) },
    );
  }
}

function replayReceipt(
  receipt: InvocationReceipt,
  emit: (frame: Record<string, unknown> & { type: string }) => void,
): void {
  if (receipt.sessionId && receipt.tracePath)
    emit({
      type: "session_ready",
      sessionId: receipt.sessionId,
      tracePath: receipt.tracePath,
    });
  if (receipt.state === "completed")
    emit({
      summary: receipt.summary ?? "",
      ...(receipt.pageAnswer
        ? { type: "page_answer_completed", pageAnswer: receipt.pageAnswer }
        : { type: "page_brief_completed", pageBrief: receipt.pageBrief as PageBrief }),
    });
  else if (receipt.state === "stopped")
    emit({ type: "stopped", reason: receipt.reason ?? "" });
  else if (receipt.state === "failed")
    emit({
      type: "failed",
      message: receipt.reason ?? "",
      ...(receipt.code ? { code: receipt.code as BrowserAttemptFailureCode } : {}),
    });
  else if (receipt.state === "rejected")
    emit({
      type: "launch_rejected",
      reason: receipt.reason ?? "",
      ...(receipt.code ? { code: receipt.code as BrowserLaunchRejectionCode } : {}),
    });
  else emit({ type: "failed", message: "Browser invocation is already in progress; reattach to its active Side Panel." });
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function launchRejectionCode(error: unknown): BrowserLaunchRejectionCode | undefined {
  const reason = errorReason(error);
  return reason === "protocol_mismatch" ||
    reason === "oversized" ||
    reason === "malformed" ||
    reason === "workspace_profile_unavailable" ||
    reason === "source_unavailable" ||
    reason === "source_integrity_mismatch" ||
    reason === "conversation_history_unavailable"
    ? reason
    : undefined;
}

function attemptFailureCode(error: unknown): BrowserAttemptFailureCode | undefined {
  return errorReason(error) === "invalid_page_answer"
    ? "invalid_page_answer"
    : undefined;
}

function errorReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("reason" in error))
    return undefined;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

class AsyncFrameQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: ((result: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffered.push(value);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  private async next(): Promise<IteratorResult<T>> {
    if (this.buffered.length > 0)
      return { value: this.buffered.shift() as T, done: false };
    if (this.done) return { value: undefined, done: true };
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
