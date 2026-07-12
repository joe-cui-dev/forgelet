import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { approveWorkspaceProfile, setDefaultWorkspaceProfile } from "../browser/workspaceProfiles.js";
import {
  NativeMessageDecoder,
  createNativeHostApplication,
  encodeNativeHostMessage,
  runNativeHostStdio,
} from "../native-host/index.js";
import type { ModelClient } from "../types.js";

/** Deterministic Slice-1 protocol smoke: built Native Messaging framing,
 * approved profile resolution, answer-once Learning, and Trace privacy. */
export async function runBrowserWorkbenchSmoke(): Promise<{ tracePath: string; sessionId: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-smoke-browser-workbench-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-smoke-browser-home-"));
  const profile = await approveWorkspaceProfile({ homeDir, cwd: workspaceRoot, name: "Smoke workspace" });
  await setDefaultWorkspaceProfile({ homeDir, profileId: profile.id });
  const stdin = new PassThrough();
  const outputChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const model: ModelClient = {
    async createTurn() {
      return {
        content: [
          "## Summary",
          "A deterministic summary.",
          "## Key Concepts",
          "- Browser sources are explicit.",
          "## Source Links",
          "- The page is attached by Forgelet.",
          "## Open Questions",
          "- None.",
          "## Review Prompts",
          "- What did the page establish?",
        ].join("\n"),
        toolCalls: [],
      };
    },
  };
  const run = runNativeHostStdio({
    stdin,
    stdout,
    homeDir,
    application: createNativeHostApplication({ homeDir, modelClientForWorkspace: () => model }),
  });
  const pageBody = `PRIVATE_BROWSER_PAGE_BODY_${"x".repeat(512)}`;
  stdin.write(encodeNativeHostMessage({
    type: "browserInvocation",
    request: {
      version: 1,
      actionId: "smoke_action",
      invocationId: "smoke_invocation",
      payload: {
        workspaceProfileId: profile.id,
        capture: {
          url: "https://example.com/smoke",
          title: "Smoke Page",
          content: pageBody,
          contentKind: "mainText",
          contentHash: "b".repeat(64),
          contentBytes: Buffer.byteLength(pageBody, "utf8"),
          captureId: "capture_smoke",
          capturedAt: "2026-07-12T00:00:00.000Z",
          captureReadyMs: 1,
        },
      },
    },
  }));
  await waitFor(() => decodeFrames(Buffer.concat(outputChunks)).some((frame) => isRecord(frame) && frame.type === "completed"));
  stdin.end();
  await run;

  const frames = decodeFrames(Buffer.concat(outputChunks)).filter(isRecord);
  const readyIndex = frames.findIndex((frame) => frame.type === "session_ready");
  const completeIndex = frames.findIndex((frame) => frame.type === "completed");
  if (readyIndex < 0 || readyIndex > completeIndex) {
    throw new Error("Browser Workbench smoke expected session_ready before completed.");
  }
  const ready = frames[readyIndex] as Record<string, unknown>;
  const completed = frames[completeIndex] as Record<string, unknown>;
  if (!isRecord(completed.learningPack) || typeof completed.learningPack.summary !== "string") {
    throw new Error("Browser Workbench smoke expected a normalized Learning Pack.");
  }
  const tracePath = stringValue(ready.tracePath, "session_ready.tracePath");
  const sessionId = stringValue(ready.sessionId, "session_ready.sessionId");
  const trace = await readFile(tracePath, "utf8");
  if (trace.includes(pageBody)) {
    throw new Error("Browser Workbench smoke found the complete page body in Trace.");
  }
  const traces = await readdir(join(workspaceRoot, ".forgelet", "sessions"));
  if (traces.filter((file) => file.endsWith(".jsonl")).length !== 1) {
    throw new Error("Browser Workbench smoke expected exactly one Learning Session Trace.");
  }
  return { tracePath, sessionId };
}

function decodeFrames(buffer: Buffer): unknown[] {
  return new NativeMessageDecoder().push(buffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Missing ${name}.`);
  return value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for Browser Workbench output.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runBrowserWorkbenchSmoke();
  console.log(`Browser Workbench smoke passed.\nTrace: ${result.tracePath}\nSession: ${result.sessionId}`);
}
