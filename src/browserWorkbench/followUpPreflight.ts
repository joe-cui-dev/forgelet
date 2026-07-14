import { createHash } from "node:crypto";
import {
  isSafeCaptureId,
  readBrowserWorkbenchCapture,
  type BrowserWorkbenchCapture,
} from "../browser/captures.js";
import { findSessionTracePath, readTraceFile } from "../trace/index.js";
import {
  readPageConversationHistory,
  type PageConversationHistory,
} from "./pageConversationHistory.js";

export type BrowserFollowUpPreflightRejectionReason =
  | "workspace_profile_unavailable"
  | "source_unavailable"
  | "source_integrity_mismatch"
  | "conversation_history_unavailable";

/** Thrown before any child Session identity or Trace exists (ADR 0044, ADR
 * 0036, ADR 0047): a follow-up whose authority or source evidence can no
 * longer be trusted must be rejected outright, never repaired by silently
 * recapturing, switching workspace, or trusting the disposable browser
 * projection. Rendered separately from in-Session failures (WP7 gate). */
export class BrowserFollowUpPreflightError extends Error {
  readonly reason: BrowserFollowUpPreflightRejectionReason;
  constructor(reason: BrowserFollowUpPreflightRejectionReason, message: string) {
    // Prefixed so the typed reason survives being flattened to `error.message`
    // at the protocol boundary (`launch_rejected.reason` is free text, per
    // the existing protocol_mismatch precedent in src/browser/protocol.ts).
    super(`${reason}: ${message}`);
    this.reason = reason;
    this.name = "BrowserFollowUpPreflightError";
  }
}

export interface ResolvedBrowserProfile {
  id: string;
  label: string;
  path: string;
}

export interface BrowserFollowUpPreflightResult {
  workspaceRoot: string;
  workspaceProfileId: string;
  capture: BrowserWorkbenchCapture;
  history: PageConversationHistory;
}

/**
 * Verifies a Page Conversation follow-up's authority and source evidence
 * before any child Session is created: the pinned root Workspace Profile
 * (ADR 0036), the persisted capture's identity and content hash (ADR 0044),
 * and the linear Page Conversation History (ADR 0047, WP5). Any failure
 * rejects the launch with a typed reason and leaves no child Session or
 * Trace behind.
 */
export async function preflightBrowserFollowUp(input: {
  workspaceProfileId: string;
  conversationId: string;
  captureId: string;
  rootSessionId: string;
  headSessionId: string;
  resolveProfile(id: string): Promise<ResolvedBrowserProfile>;
}): Promise<BrowserFollowUpPreflightResult> {
  const profile = await resolvePinnedProfile(input);
  const capture = await verifyPersistedCapture(profile.path, input.captureId);
  const history = await resolveHistory({ ...input, workspaceRoot: profile.path });

  return {
    workspaceRoot: profile.path,
    workspaceProfileId: profile.id,
    capture,
    history,
  };
}

async function resolvePinnedProfile(input: {
  workspaceProfileId: string;
  rootSessionId: string;
  resolveProfile(id: string): Promise<ResolvedBrowserProfile>;
}): Promise<ResolvedBrowserProfile> {
  let profile: ResolvedBrowserProfile;
  try {
    profile = await input.resolveProfile(input.workspaceProfileId);
  } catch (error) {
    throw new BrowserFollowUpPreflightError(
      "workspace_profile_unavailable",
      `Workspace Profile is unavailable: ${describeError(error)}`,
    );
  }

  // A root Trace this profile cannot even find is a history problem, not a
  // profile one: defer to resolveHistory's own conversation_history_unavailable
  // rather than guessing at profile authority from evidence that does not exist.
  const rootTrigger = await readRootTrigger(profile.path, input.rootSessionId);
  if (
    rootTrigger.found &&
    rootTrigger.workspaceProfileId !== input.workspaceProfileId
  )
    throw new BrowserFollowUpPreflightError(
      "workspace_profile_unavailable",
      `Follow-up Workspace Profile ${input.workspaceProfileId} does not match the Page Conversation's pinned root profile.`,
    );

  return profile;
}

type RootTrigger =
  | { found: true; workspaceProfileId: string | undefined }
  | { found: false };

async function readRootTrigger(
  workspaceRoot: string,
  rootSessionId: string,
): Promise<RootTrigger> {
  let events;
  try {
    events = await readTraceFile(
      await findSessionTracePath(workspaceRoot, rootSessionId),
    );
  } catch {
    return { found: false };
  }
  const started = events.find((event) => event.type === "session_started");
  if (!started) return { found: false };
  const trigger = started.payload.trigger;
  if (typeof trigger !== "object" || trigger === null)
    return { found: true, workspaceProfileId: undefined };
  const workspaceProfileId = (trigger as Record<string, unknown>).workspaceProfileId;
  return {
    found: true,
    workspaceProfileId:
      typeof workspaceProfileId === "string" ? workspaceProfileId : undefined,
  };
}

/** Reloads a persisted browser capture and verifies its identity and content
 * hash (ADR 0044). Shared by follow-up preflight and root Retry, which also
 * reloads the original capture rather than accepting fresh bytes on the wire. */
export async function verifyPersistedCapture(
  workspaceRoot: string,
  captureId: string,
): Promise<BrowserWorkbenchCapture> {
  if (!isSafeCaptureId(captureId))
    throw new BrowserFollowUpPreflightError(
      "source_unavailable",
      `Capture identity is unsafe: ${captureId}.`,
    );

  let capture: BrowserWorkbenchCapture;
  try {
    capture = await readBrowserWorkbenchCapture(workspaceRoot, captureId);
  } catch (error) {
    if (isEnoent(error))
      throw new BrowserFollowUpPreflightError(
        "source_unavailable",
        `Captured page is no longer available: ${captureId}.`,
      );
    throw new BrowserFollowUpPreflightError(
      "source_integrity_mismatch",
      `Persisted capture is unreadable: ${describeError(error)}`,
    );
  }

  if (capture.captureId !== captureId)
    throw new BrowserFollowUpPreflightError(
      "source_integrity_mismatch",
      `Persisted capture identity ${capture.captureId} does not match the requested capture ${captureId}.`,
    );

  const recomputedHash = createHash("sha256").update(capture.content).digest("hex");
  if (recomputedHash !== capture.contentHash)
    throw new BrowserFollowUpPreflightError(
      "source_integrity_mismatch",
      `Persisted capture content hash no longer matches its recorded hash: ${captureId}.`,
    );

  return capture;
}

async function resolveHistory(input: {
  workspaceRoot: string;
  conversationId: string;
  captureId: string;
  rootSessionId: string;
  headSessionId: string;
}): Promise<PageConversationHistory> {
  try {
    return await readPageConversationHistory(input);
  } catch (error) {
    throw new BrowserFollowUpPreflightError(
      "conversation_history_unavailable",
      describeError(error),
    );
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
