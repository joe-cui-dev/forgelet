import { createHash } from "node:crypto";
import type { SessionLiveEvent, SessionLiveEventSink } from "../sessionLiveView/index.js";
import {
  claimInvocation,
  recordInvocationOutcome,
  type InvocationReceipt,
} from "./invocations.js";

export const BROWSER_PROTOCOL_VERSION = 1;
const MAX_INVOCATION_PAYLOAD_BYTES = 64 * 1024;

export interface BrowserInvocationRequest {
  version: number;
  actionId: string;
  invocationId: string;
  payload: Record<string, unknown>;
}

export type BrowserProtocolValidationReason =
  | "unknown_version"
  | "oversized"
  | "malformed";

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
      "unknown_version",
      `Unsupported Browser protocol version: ${String(raw.version)}`,
    );
  if (typeof raw.actionId !== "string" || raw.actionId.trim() === "")
    throw new BrowserProtocolValidationError(
      "malformed",
      "Invocation request is missing actionId.",
    );
  if (typeof raw.invocationId !== "string" || raw.invocationId.trim() === "")
    throw new BrowserProtocolValidationError(
      "malformed",
      "Invocation request is missing invocationId.",
    );
  if (!isRecord(raw.payload))
    throw new BrowserProtocolValidationError(
      "malformed",
      "Invocation request payload must be an object.",
    );
  const payloadBytes = Buffer.byteLength(JSON.stringify(raw.payload), "utf8");
  if (payloadBytes > MAX_INVOCATION_PAYLOAD_BYTES)
    throw new BrowserProtocolValidationError(
      "oversized",
      `Invocation payload exceeds ${MAX_INVOCATION_PAYLOAD_BYTES} bytes.`,
    );
  return {
    version: BROWSER_PROTOCOL_VERSION,
    actionId: raw.actionId,
    invocationId: raw.invocationId,
    payload: raw.payload,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The transport envelope from ADR 0039: invocation_accepted, then exactly one
// of launch_rejected | session_ready, then live_event*, then exactly one
// terminal frame. SessionLiveEvent is wrapped inside live_event; it is not
// the protocol itself.
export type BrowserRunFrame =
  | { type: "invocation_accepted"; invocationId: string; seq: number }
  | { type: "launch_rejected"; invocationId: string; seq: number; reason: string }
  | {
      type: "session_ready";
      invocationId: string;
      seq: number;
      sessionId: string;
      tracePath: string;
    }
  | { type: "live_event"; invocationId: string; seq: number; event: SessionLiveEvent }
  | { type: "completed"; invocationId: string; seq: number; summary: string }
  | { type: "stopped"; invocationId: string; seq: number; reason: string }
  | { type: "failed"; invocationId: string; seq: number; message: string }
  | { type: "action_conflict"; invocationId: string; seq: number };

export type ProtocolLaunchResult =
  | { status: "completed"; summary: string }
  | { status: "stopped"; reason: string }
  | { status: "failed"; message: string };

/** The seam the protocol drives. A real Adapter (WP9) backs this with the
 * Learning Session Launcher; `launch` rejects only for a preflight failure
 * (no Trace/Session ever existed), matching `runKernelSession` (ADR 0036). */
export interface ProtocolLauncher {
  launch(input: {
    payload: Record<string, unknown>;
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
  emit({ type: "invocation_accepted" });

  const payloadHash = hashPayload(request.payload);
  const claim = await claimInvocation({
    homeDir: options.homeDir,
    actionId: request.actionId,
    invocationId: request.invocationId,
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
      payload: request.payload,
      signal: options.signal,
      onLiveEvent: async (event) => {
        if (event.type === "session_ready") {
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

    await recordInvocationOutcome({
      homeDir: options.homeDir,
      actionId: request.actionId,
      invocationId: request.invocationId,
      state: result.status,
      ...(result.status === "completed" ? { summary: result.summary } : {}),
      ...(result.status === "stopped" ? { reason: result.reason } : {}),
      ...(result.status === "failed" ? { reason: result.message } : {}),
      now: options.now,
    });
    emit(
      result.status === "completed"
        ? { type: "completed", summary: result.summary }
        : result.status === "stopped"
          ? { type: "stopped", reason: result.reason }
          : { type: "failed", message: result.message },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordInvocationOutcome({
      homeDir: options.homeDir,
      actionId: request.actionId,
      invocationId: request.invocationId,
      state: "rejected",
      reason: message,
      now: options.now,
    });
    emit({ type: "launch_rejected", reason: message });
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
    emit({ type: "completed", summary: receipt.summary ?? "" });
  else if (receipt.state === "stopped")
    emit({ type: "stopped", reason: receipt.reason ?? "" });
  else if (receipt.state === "failed")
    emit({ type: "failed", message: receipt.reason ?? "" });
  else if (receipt.state === "rejected")
    emit({ type: "launch_rejected", reason: receipt.reason ?? "" });
  // "pending"/"ready" with no terminal state yet: the client sees identity
  // (if known) and no terminal frame, and may check again later.
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
