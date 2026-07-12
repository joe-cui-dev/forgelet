// Type-only: erased at compile time, so the copied extension bundle stays
// dependency-free (buildExtension copies compiled files as-is).
import type { LearningPack } from "../../workflows/learning.js";

export type { LearningPack };

export interface BrowserWorkspaceProfileProjection {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface BrowserWorkbenchPort {
  postMessage(frame: Record<string, unknown>): void;
  onFrame(listener: (frame: Record<string, unknown>) => void): void;
  onDisconnect?(listener: () => void): void;
}

export interface BrowserWorkbenchBridge {
  listProfiles(): Promise<BrowserWorkspaceProfileProjection[]>;
  start(input: {
    actionId: string;
    invocationId: string;
    workspaceProfileId: string;
    uiLanguage?: string;
    capture: Record<string, unknown>;
  }): BrowserWorkbenchPort;
}

export interface BrowserPanelState {
  invocationId: string;
  actionId?: string;
  status: "starting" | "needs_profile" | "running" | "stopping" | "completed" | "stopped" | "failed";
  message?: string;
  sessionId?: string;
  tracePath?: string;
  summary?: string;
  profiles?: BrowserWorkspaceProfileProjection[];
  // Live presentation of the running Session: the current model turn's
  // streamed text plus status-line context. Ephemeral — the normalized
  // Learning Pack replaces it on completion.
  liveText?: string;
  turnIndex?: number;
  model?: string;
  activity?: string;
  learningPack?: LearningPack;
}

// Mirrors the uiLanguage validation in src/browserWorkbench/index.ts. A locale
// the native host would reject is dropped here so it cannot fail the invocation.
const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

export function normalizeBrowserUiLanguage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tag = raw.trim();
  if (tag.length === 0 || tag.length > 35 || !LANGUAGE_TAG_PATTERN.test(tag)) return undefined;
  return tag;
}

export function createBrowserWorkbenchController(input: {
  bridge: BrowserWorkbenchBridge;
  openSidePanel(): Promise<void>;
  captureCurrentPage(): Promise<Record<string, unknown>>;
  createId(): string;
  detectUiLanguage?(): string | undefined;
  /** Durable storage write; called only on status transitions, never per delta. */
  persistState?(state: BrowserPanelState): void;
  /** Full-state notification to an attached panel; triggers a re-render. */
  broadcastState?(state: BrowserPanelState): void;
  /** Incremental streamed-text notification; the panel appends without re-rendering. */
  broadcastDelta?(delta: { invocationId: string; text: string }): void;
}): {
  summarizeCurrentPage(): Promise<BrowserPanelState>;
  reattach(invocationId: string): BrowserPanelState | undefined;
  stop(invocationId: string): void;
} {
  const states = new Map<string, BrowserPanelState>();
  const ports = new Map<string, BrowserWorkbenchPort>();
  const save = (state: BrowserPanelState): BrowserPanelState => {
    states.set(state.invocationId, state);
    input.persistState?.(state);
    input.broadcastState?.(state);
    return state;
  };
  const applyFrame = (fallback: BrowserPanelState, frame: Record<string, unknown>): void => {
    const previous = states.get(fallback.invocationId) ?? fallback;
    const next = applyBrowserFrame(previous, frame);
    states.set(next.invocationId, next);
    const deltaText = modelOutputDeltaText(frame);
    if (deltaText !== undefined) {
      input.broadcastDelta?.({ invocationId: next.invocationId, text: deltaText });
      return;
    }
    if (next === previous) return;
    if (next.status !== previous.status) input.persistState?.(next);
    input.broadcastState?.(next);
  };

  return {
    async summarizeCurrentPage(): Promise<BrowserPanelState> {
      // Chrome only permits sidePanel.open from the action gesture, so this
      // must occur before capture/profile/native work begins.
      await input.openSidePanel();
      const actionId = input.createId();
      const invocationId = input.createId();
      let capture: Record<string, unknown>;
      try {
        capture = await input.captureCurrentPage();
      } catch (error) {
        return save({
          actionId,
          invocationId,
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const profiles = await input.bridge.listProfiles();
      const profile = profiles.find((candidate) => candidate.isDefault);
      if (!profile) {
        return save({
          actionId,
          invocationId,
          status: "needs_profile",
          message: "No default approved workspace profile. Run forge browser profiles approve, then set-default.",
          profiles,
        });
      }

      const state = save({ actionId, invocationId, status: "starting", profiles });
      const uiLanguage = normalizeBrowserUiLanguage(input.detectUiLanguage?.());
      const port = input.bridge.start({
        actionId,
        invocationId,
        workspaceProfileId: profile.id,
        ...(uiLanguage ? { uiLanguage } : {}),
        capture,
      });
      ports.set(invocationId, port);
      port.onFrame((frame) => applyFrame(state, frame));
      port.onDisconnect?.(() => {
        const current = states.get(invocationId);
        if (current && !isTerminal(current.status)) {
          save({
            ...current,
            status: "failed",
            message: "Native Messaging transport disconnected; the Browser Workbench presentation can no longer receive this Session.",
          });
        }
      });
      return state;
    },
    reattach(invocationId: string): BrowserPanelState | undefined {
      return states.get(invocationId);
    },
    stop(invocationId: string): void {
      const state = states.get(invocationId);
      if (state && (state.status === "stopping" || isTerminal(state.status))) return;
      const port = ports.get(invocationId);
      if (!port) {
        // After a Service Worker restart there is no port for this
        // invocation; give the panel explicit feedback instead of no-oping.
        save({
          ...(state ?? { invocationId }),
          status: "failed",
          message: "Native Messaging transport is disconnected; Stop could not reach this Session.",
        });
        return;
      }
      if (!state) return;
      save({ ...state, status: "stopping", message: "Stopping…" });
      port.postMessage({ type: "cancel", invocationId });
    },
  };
}

export function applyBrowserFrame(
  state: BrowserPanelState,
  frame: Record<string, unknown>,
): BrowserPanelState {
  if (frame.type === "session_ready") {
    return {
      ...state,
      status: "running",
      sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
      tracePath: typeof frame.tracePath === "string" ? frame.tracePath : undefined,
    };
  }
  if (frame.type === "live_event") {
    return applyLiveEvent(state, frame.event);
  }
  if (frame.type === "completed") {
    // The normalized Learning Pack is the authoritative outcome; the streamed
    // text was live presentation only and is replaced entirely.
    return {
      ...state,
      status: "completed",
      summary: typeof frame.summary === "string" ? frame.summary : undefined,
      learningPack: learningPackFromFrame(frame.learningPack),
      liveText: undefined,
      activity: undefined,
    };
  }
  if (frame.type === "stopped") {
    return { ...state, status: "stopped", message: String(frame.reason ?? "user_stopped") };
  }
  if (frame.type === "failed" || frame.type === "launch_rejected") {
    return { ...state, status: "failed", message: String(frame.message ?? frame.reason ?? "Browser Workbench failed.") };
  }
  return state;
}

function applyLiveEvent(
  state: BrowserPanelState,
  event: unknown,
): BrowserPanelState {
  if (!isRecord(event)) return state;
  if (event.type === "model_turn_started") {
    // The stream area shows the current turn only.
    return {
      ...state,
      turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : state.turnIndex,
      model: typeof event.model === "string" ? event.model : state.model,
      liveText: "",
      activity: undefined,
    };
  }
  if (event.type === "model_output_delta") {
    return {
      ...state,
      turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : state.turnIndex,
      model: typeof event.model === "string" ? event.model : state.model,
      liveText: (state.liveText ?? "") + (typeof event.text === "string" ? event.text : ""),
    };
  }
  if (event.type === "tool_call_started") {
    const target = typeof event.target === "string" ? ` ${event.target}` : "";
    return { ...state, activity: `Tool started: ${String(event.toolName ?? "")}${target}` };
  }
  if (event.type === "tool_call_finished") {
    return {
      ...state,
      activity: `Tool finished: ${String(event.toolName ?? "")} (${event.ok ? "ok" : "failed"})`,
    };
  }
  return state;
}

export function modelOutputDeltaText(frame: Record<string, unknown>): string | undefined {
  if (frame.type !== "live_event" || !isRecord(frame.event)) return undefined;
  if (frame.event.type !== "model_output_delta") return undefined;
  return typeof frame.event.text === "string" ? frame.event.text : "";
}

function learningPackFromFrame(value: unknown): LearningPack | undefined {
  if (!isRecord(value)) return undefined;
  const fields = ["summary", "keyConcepts", "sourceLinks", "openQuestions", "reviewPrompts"] as const;
  if (!fields.every((field) => typeof value[field] === "string")) return undefined;
  return {
    summary: value.summary as string,
    keyConcepts: value.keyConcepts as string,
    sourceLinks: value.sourceLinks as string,
    openQuestions: value.openQuestions as string,
    reviewPrompts: value.reviewPrompts as string,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTerminal(status: BrowserPanelState["status"]): boolean {
  return status === "completed" || status === "stopped" || status === "failed" || status === "needs_profile";
}
