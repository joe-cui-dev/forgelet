import {
  applyPageConversationFrame,
  createPageConversationProjection,
  evictPageConversationProjection,
  markPageConversationAttemptStopping,
  modelOutputDeltaText,
  startPageConversationAttempt,
  type PageConversationAttemptKind,
  type PageConversationProjection,
} from "./pageConversationProjection.js";
import {
  isMeaningfulPageConversationTransition,
  loadPageConversationProjection,
  savePageConversationProjection,
  type PageConversationSessionStorage,
} from "./pageConversationStore.js";

export interface BrowserWorkspaceProfileProjection {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface BrowserWorkbenchPort {
  postMessage(frame: Record<string, unknown>): void;
  onFrame(listener: (frame: Record<string, unknown>) => void): void;
  onDisconnect?(listener: () => void): void;
  /** Chrome's Port#disconnect. A Page Conversation never keeps an idle port
   * between attempts (ADR 0039): the controller calls this once an attempt
   * reaches a terminal frame. */
  disconnect?(): void;
}

export type PageConversationStartRequest =
  | {
      kind: "root";
      conversationId: string;
      actionId: string;
      invocationId: string;
      workspaceProfileId: string;
      outputLanguage?: string;
      capture: Record<string, unknown>;
    }
  | {
      kind: "root_retry";
      conversationId: string;
      actionId: string;
      invocationId: string;
      workspaceProfileId: string;
      outputLanguage?: string;
      captureId: string;
    }
  | {
      kind: "follow_up" | "follow_up_retry";
      conversationId: string;
      actionId: string;
      invocationId: string;
      workspaceProfileId: string;
      outputLanguage?: string;
      captureId: string;
      rootSessionId: string;
      parentSessionId: string;
      question: string;
    };

export interface PageConversationBridge {
  listProfiles(): Promise<BrowserWorkspaceProfileProjection[]>;
  start(request: PageConversationStartRequest): BrowserWorkbenchPort;
}

export type PageConversationNotice =
  | { kind: "capture_unavailable"; message: string }
  | { kind: "needs_profile"; message: string; profiles: BrowserWorkspaceProfileProjection[] }
  | { kind: "attempt_in_progress"; message: string };

const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

/** Mirrors the outputLanguage validation in src/browser/protocol.ts. A
 * locale the native host would reject is dropped here so it cannot fail the
 * invocation. */
export function normalizeBrowserOutputLanguage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tag = raw.trim();
  if (tag.length === 0 || tag.length > 35 || !LANGUAGE_TAG_PATTERN.test(tag)) return undefined;
  return tag;
}

export function createPageConversationController(input: {
  bridge: PageConversationBridge;
  storage: PageConversationSessionStorage;
  openSidePanel(windowId: number): Promise<void>;
  captureCurrentPage(): Promise<Record<string, unknown>>;
  createId(): string;
  resolveOutputLanguage?(): string | undefined | Promise<string | undefined>;
  broadcastProjection?(windowId: number, projection: PageConversationProjection): void;
  broadcastDelta?(windowId: number, delta: { invocationId: string; text: string }): void;
  broadcastNotice?(windowId: number, notice: PageConversationNotice): void;
  /** Overrides DEFAULT_PROJECTION_BYTE_BUDGET; exists for tests that need to
   * exercise eviction without hundreds of turns. */
  evictionByteBudget?: number;
}): {
  handleToolbarClick(windowId: number): Promise<void>;
  reattach(windowId: number): Promise<PageConversationProjection | undefined>;
  stop(windowId: number): void;
  sendFollowUp(windowId: number, question: string): Promise<void>;
  retry(windowId: number, invocationId: string): Promise<void>;
} {
  const projections = new Map<number, PageConversationProjection>();
  const ports = new Map<string, BrowserWorkbenchPort>();

  const save = (windowId: number, unbounded: PageConversationProjection): void => {
    const previous = projections.get(windowId);
    // ADR 0052: the projection is bounded before it is stored or broadcast,
    // not just available as a dormant pure function.
    const next = evictPageConversationProjection(unbounded, input.evictionByteBudget);
    projections.set(windowId, next);
    if (isMeaningfulPageConversationTransition(previous, next)) {
      void savePageConversationProjection(input.storage, windowId, next);
    }
    input.broadcastProjection?.(windowId, next);
  };

  const releasePort = (invocationId: string): void => {
    ports.get(invocationId)?.disconnect?.();
    ports.delete(invocationId);
  };

  const attachPort = (windowId: number, invocationId: string, port: BrowserWorkbenchPort): void => {
    ports.set(invocationId, port);
    port.onFrame((frame) => applyFrame(windowId, frame));
    port.onDisconnect?.(() => {
      const current = projections.get(windowId);
      if (current?.currentAttempt?.invocationId !== invocationId) return;
      save(
        windowId,
        applyPageConversationFrame(current, {
          type: "failed",
          invocationId,
          message:
            "Native Messaging transport disconnected; the Browser Workbench presentation can no longer receive this Session.",
        }),
      );
      ports.delete(invocationId);
    });
  };

  const applyFrame = (windowId: number, frame: Record<string, unknown>): void => {
    const previous = projections.get(windowId);
    if (!previous) return;
    const deltaText = modelOutputDeltaText(frame);
    if (deltaText !== undefined) {
      const next = applyPageConversationFrame(previous, frame);
      projections.set(windowId, next);
      const invocationId = typeof frame.invocationId === "string" ? frame.invocationId : "";
      input.broadcastDelta?.(windowId, { invocationId, text: deltaText });
      return;
    }
    const next = applyPageConversationFrame(previous, frame);
    if (next === previous) return;
    save(windowId, next);
    if (previous.currentAttempt && !next.currentAttempt) releasePort(previous.currentAttempt.invocationId);
  };

  const resolveOutputLanguage = async (): Promise<string | undefined> =>
    normalizeBrowserOutputLanguage(await input.resolveOutputLanguage?.());

  return {
    async handleToolbarClick(windowId: number): Promise<void> {
      const current = projections.get(windowId);
      if (current?.currentAttempt) {
        // One in-flight attempt per window (ADR 0053): re-focus rather than
        // capture, launch, or implicitly cancel the running attempt.
        await input.openSidePanel(windowId);
        input.broadcastProjection?.(windowId, current);
        input.broadcastNotice?.(windowId, {
          kind: "attempt_in_progress",
          message: "A Browser Workbench attempt is already running in this window. Wait for it to finish or Stop it.",
        });
        return;
      }

      // Chrome only permits sidePanel.open from the toolbar gesture, so this
      // must occur before capture/profile/native work begins.
      await input.openSidePanel(windowId);

      let capture: Record<string, unknown>;
      try {
        capture = await input.captureCurrentPage();
      } catch (error) {
        input.broadcastNotice?.(windowId, {
          kind: "capture_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const profiles = await input.bridge.listProfiles();
      const profile = profiles.find((candidate) => candidate.isDefault);
      if (!profile) {
        input.broadcastNotice?.(windowId, {
          kind: "needs_profile",
          message: "No default approved workspace profile. Run forge browser profiles approve, then set-default.",
          profiles,
        });
        return;
      }

      const conversationId = input.createId();
      const actionId = input.createId();
      const invocationId = input.createId();
      const projection = createPageConversationProjection({
        conversationId,
        actionId,
        invocationId,
        workspaceProfileId: profile.id,
        captureId: stringField(capture, "captureId"),
        source: {
          url: stringField(capture, "url"),
          title: stringField(capture, "title"),
          capturedAt: stringField(capture, "capturedAt"),
          truncated: capture.truncated === true,
        },
      });
      // A toolbar gesture after terminal state replaces only this window's
      // active projection; every other window is untouched.
      save(windowId, projection);

      const outputLanguage = await resolveOutputLanguage();
      const port = input.bridge.start({
        kind: "root",
        conversationId,
        actionId,
        invocationId,
        workspaceProfileId: profile.id,
        ...outputLanguageField(outputLanguage),
        capture,
      });
      attachPort(windowId, invocationId, port);
    },

    async reattach(windowId: number): Promise<PageConversationProjection | undefined> {
      const inMemory = projections.get(windowId);
      if (inMemory) return inMemory;
      const stored = await loadPageConversationProjection(input.storage, windowId);
      if (stored) projections.set(windowId, stored);
      return stored;
    },

    stop(windowId: number): void {
      const current = projections.get(windowId);
      const attempt = current?.currentAttempt;
      if (!current || !attempt || attempt.status === "stopping") return;
      const port = ports.get(attempt.invocationId);
      if (!port) {
        // After a Service Worker restart there is no port for this
        // invocation; give the panel explicit feedback instead of no-oping.
        save(
          windowId,
          applyPageConversationFrame(current, {
            type: "failed",
            invocationId: attempt.invocationId,
            message: "Native Messaging transport is disconnected; Stop could not reach this Session.",
          }),
        );
        return;
      }
      save(windowId, markPageConversationAttemptStopping(current, attempt.invocationId));
      port.postMessage({ type: "cancel", invocationId: attempt.invocationId });
    },

    async sendFollowUp(windowId: number, question: string): Promise<void> {
      const current = projections.get(windowId);
      if (!current || current.currentAttempt) return;
      if (!current.rootSessionId || !current.headSessionId) return;

      const actionId = input.createId();
      const invocationId = input.createId();
      const next = startPageConversationAttempt(current, { kind: "follow_up", actionId, invocationId, question });
      save(windowId, next);

      const outputLanguage = await resolveOutputLanguage();
      const port = input.bridge.start({
        kind: "follow_up",
        conversationId: current.conversationId,
        actionId,
        invocationId,
        workspaceProfileId: current.workspaceProfileId,
        ...outputLanguageField(outputLanguage),
        captureId: current.captureId,
        rootSessionId: current.rootSessionId,
        parentSessionId: current.headSessionId,
        question,
      });
      attachPort(windowId, invocationId, port);
    },

    async retry(windowId: number, invocationId: string): Promise<void> {
      const current = projections.get(windowId);
      if (!current || current.currentAttempt) return;
      const card = current.terminalCards.find((candidate) => candidate.invocationId === invocationId);
      if (!card) return;

      const retryKind: PageConversationAttemptKind =
        card.kind === "root" || card.kind === "root_retry" ? "root_retry" : "follow_up_retry";
      const actionId = input.createId();
      const newInvocationId = input.createId();
      const next = startPageConversationAttempt(current, {
        kind: retryKind,
        actionId,
        invocationId: newInvocationId,
        ...(card.question !== undefined ? { question: card.question } : {}),
      });
      save(windowId, next);

      const outputLanguage = await resolveOutputLanguage();
      const port =
        retryKind === "root_retry"
          ? input.bridge.start({
              kind: "root_retry",
              conversationId: current.conversationId,
              actionId,
              invocationId: newInvocationId,
              workspaceProfileId: current.workspaceProfileId,
              ...outputLanguageField(outputLanguage),
              captureId: current.captureId,
            })
          : input.bridge.start({
              kind: "follow_up_retry",
              conversationId: current.conversationId,
              actionId,
              invocationId: newInvocationId,
              workspaceProfileId: current.workspaceProfileId,
              ...outputLanguageField(outputLanguage),
              captureId: current.captureId,
              rootSessionId: current.rootSessionId ?? "",
              parentSessionId: current.headSessionId ?? "",
              question: card.question ?? "",
            });
      attachPort(windowId, newInvocationId, port);
    },
  };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function outputLanguageField(outputLanguage: string | undefined): { outputLanguage?: string } {
  return outputLanguage ? { outputLanguage } : {};
}
