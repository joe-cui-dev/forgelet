declare const chrome: any;
declare const document: any;

const shareButton = document.querySelector("#share-page");
const output = document.querySelector("#share-output");

shareButton?.addEventListener("click", () => {
  setOutput("Sharing...");
  chrome.runtime.sendMessage({ type: "sharePage" }, (response: unknown) => {
    if (chrome.runtime.lastError) {
      setOutput(`Share failed: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (isRecord(response) && typeof response.summary === "string") {
      setOutput(response.summary);
      return;
    }
    setOutput("Share failed: extension did not receive a valid response.");
  });
});

function setOutput(value: string): void {
  if (output) output.textContent = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
