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

async function initializeSidePanel(): Promise<void> {
  const output = document.getElementById("workbench-output");
  const stop = document.getElementById("stop");
  if (!output || !stop) return;
  const response = await chrome.runtime.sendMessage({ type: "browserWorkbenchReattach" });
  renderSidePanelState(output, response?.state);
  chrome.runtime.onMessage.addListener((message: any) => {
    if (message?.type === "browserWorkbenchState") renderSidePanelState(output, message.state);
  });
  stop.addEventListener("click", async () => {
    const state = await chrome.runtime.sendMessage({ type: "browserWorkbenchReattach" });
    if (state?.state?.invocationId) {
      await chrome.runtime.sendMessage({
        type: "browserWorkbenchStop",
        invocationId: state.state.invocationId,
      });
    }
  });
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initializeSidePanel();
}
