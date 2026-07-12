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
  persistState?(state: BrowserPanelState): void;
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
    return state;
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
      port.onFrame((frame) =>
        save(applyBrowserFrame(states.get(invocationId) ?? state, frame)),
      );
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
      const port = ports.get(invocationId);
      if (!state || !port || state.status === "stopping" || isTerminal(state.status)) return;
      save({ ...state, status: "stopping", message: "Stopping…" });
      port.postMessage({ type: "cancel", invocationId });
    },
  };
}

function applyBrowserFrame(
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
  if (frame.type === "completed") {
    return {
      ...state,
      status: "completed",
      summary: typeof frame.summary === "string" ? frame.summary : undefined,
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

function isTerminal(status: BrowserPanelState["status"]): boolean {
  return status === "completed" || status === "stopped" || status === "failed" || status === "needs_profile";
}
