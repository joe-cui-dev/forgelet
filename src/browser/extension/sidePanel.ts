import type { BrowserPanelState } from "./workbench.js";

declare const chrome: any;
declare const document: any;

export function renderSidePanelState(
  target: { textContent: string },
  state: BrowserPanelState | undefined,
): void {
  if (!state) {
    target.textContent = "No Browser Workbench invocation is attached.";
    return;
  }
  target.textContent = [
    `Status: ${state.status}`,
    ...(state.sessionId ? [`Session: ${state.sessionId}`] : []),
    ...(state.tracePath ? [`Trace: ${state.tracePath}`] : []),
    ...(state.profiles && state.profiles.length > 0
      ? [
          "Approved workspace profiles:",
          ...state.profiles.map(
            (profile) => `${profile.isDefault ? "* " : "  "}${profile.label} (${profile.id})`,
          ),
        ]
      : []),
    ...(state.message ? [state.message] : []),
    ...(state.summary ? [state.summary] : []),
  ].join("\n\n");
}

export async function requestBrowserWorkbenchState(
  sendMessage: (message: { type: "browserWorkbenchReattach" }) => Promise<unknown>,
): Promise<BrowserPanelState | undefined> {
  try {
    const response = await sendMessage({ type: "browserWorkbenchReattach" });
    if (!isRecord(response)) return undefined;
    return response.state as BrowserPanelState | undefined;
  } catch {
    return undefined;
  }
}

async function initializeSidePanel(): Promise<void> {
  const output = document.getElementById("workbench-output");
  const stop = document.getElementById("stop");
  if (!output || !stop) return;
  renderSidePanelState(
    output,
    await requestBrowserWorkbenchState((message) => chrome.runtime.sendMessage(message)),
  );
  chrome.runtime.onMessage.addListener((message: any) => {
    if (message?.type === "browserWorkbenchState") renderSidePanelState(output, message.state);
  });
  stop.addEventListener("click", async () => {
    const state = await requestBrowserWorkbenchState((message) => chrome.runtime.sendMessage(message));
    if (state?.invocationId) {
      try {
        await chrome.runtime.sendMessage({
          type: "browserWorkbenchStop",
          invocationId: state.invocationId,
        });
      } catch {
        renderSidePanelState(output, {
          ...state,
          status: "failed",
          message: "Unable to contact the Forgelet Service Worker. Reload the extension and reopen the Side Panel.",
        });
      }
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initializeSidePanel();
}
