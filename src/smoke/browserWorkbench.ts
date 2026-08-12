import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import type { ModelClient, ModelTurnInput, ModelTurnOutput } from "../types.js";

/** Deterministic public v3 gate: exercise the built Native Host through a
 * failed-root Retry, a linear Page Conversation, invalid-Evidence Retry, and
 * Stop/Retry. It deliberately uses one real persisted capture and Session
 * Traces rather than reaching through Workbench implementation seams. */
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

  const evidence = "The captured page says Browser Workbench never fetches the public Web.";
  const pageBody = `PRIVATE_BROWSER_PAGE_BODY\n${evidence}\n${"x".repeat(512)}`;
  const model = new ScriptedSmokeModel([
    new Error("deterministic provider failure"),
    pageBriefOutput(),
    supportedAnswer("It stays within the captured page.", evidence),
    notFoundAnswer("The captured page does not state that."),
    supportedAnswer("This cannot be accepted.", "A fabricated passage."),
    supportedAnswer("Only captured content is used.", evidence),
    "wait_for_stop",
    supportedAnswer("The retried question is answered from the capture.", evidence),
    supportedAnswer("One more grounded answer from the capture.", evidence),
  ]);
  const run = runNativeHostStdio({
    stdin,
    stdout,
    homeDir,
    application: createNativeHostApplication({ homeDir, modelClientForWorkspace: () => model }),
  });
  const capture = {
    url: "https://example.com/smoke",
    title: "Smoke Page",
    content: pageBody,
    contentKind: "mainText" as const,
    contentHash: createHash("sha256").update(pageBody).digest("hex"),
    contentBytes: Buffer.byteLength(pageBody, "utf8"),
    captureId: "capture_smoke",
    capturedAt: "2026-07-14T00:00:00.000Z",
    captureReadyMs: 1,
    truncated: true,
  };
  const conversationId = "conversation_smoke";

  sendInvocation(stdin, rootRequest({
    conversationId,
    actionId: "action_root_failed",
    invocationId: "inv_root_failed",
    workspaceProfileId: profile.id,
    capture,
  }));
  await waitForTerminal(outputChunks, "inv_root_failed");
  assertFrame(lastFrameFor(outputChunks, "inv_root_failed"), { type: "failed" }, "failed root terminal");
  const failedRootSessionId = sessionIdFor(outputChunks, "inv_root_failed");

  // A provider failure happens after capture persistence, so root Retry must
  // reuse the identical capture without a fresh body on the protocol wire.
  const capturePath = join(workspaceRoot, ".forgelet", "browser", "capture_smoke.json");
  const persistedCapture = JSON.parse(await readFile(capturePath, "utf8"));
  if (persistedCapture.content !== pageBody || persistedCapture.truncated !== true)
    throw new Error("Browser Workbench smoke expected the failed root to persist its exact partial capture.");

  sendInvocation(stdin, {
    version: 3,
    kind: "root_retry",
    conversationId,
    actionId: "action_root_retry",
    invocationId: "inv_root_retry",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId: failedRootSessionId,
  });
  await waitForTerminal(outputChunks, "inv_root_retry");
  const rootSessionId = sessionIdFor(outputChunks, "inv_root_retry");
  assertFrame(lastFrameFor(outputChunks, "inv_root_retry"), { type: "page_brief_completed" }, "root Retry terminal");

  const firstQuestion = "Does this use the public Web?";
  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_follow_up_one",
    invocationId: "inv_follow_up_one",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: rootSessionId,
    question: firstQuestion,
  }));
  await waitForTerminal(outputChunks, "inv_follow_up_one");
  const firstAnswerSessionId = sessionIdFor(outputChunks, "inv_follow_up_one");
  assertFrame(
    lastFrameFor(outputChunks, "inv_follow_up_one"),
    { type: "page_answer_completed", pageAnswer: { groundingStatus: "supported", evidence: [evidence] } },
    "supported Page Answer terminal",
  );

  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_follow_up_two",
    invocationId: "inv_follow_up_two",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: firstAnswerSessionId,
    question: "What does the page say about external browsing?",
  }));
  await waitForTerminal(outputChunks, "inv_follow_up_two");
  const notFoundSessionId = sessionIdFor(outputChunks, "inv_follow_up_two");
  assertFrame(
    lastFrameFor(outputChunks, "inv_follow_up_two"),
    { type: "page_answer_completed", pageAnswer: { groundingStatus: "not_found", evidence: [] } },
    "not-found Page Answer terminal",
  );

  const retryQuestion = "Can you cite the page's source boundary?";
  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_invalid",
    invocationId: "inv_invalid",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: notFoundSessionId,
    question: retryQuestion,
  }));
  await waitForTerminal(outputChunks, "inv_invalid");
  assertFrame(
    lastFrameFor(outputChunks, "inv_invalid"),
    { type: "failed", code: "invalid_page_answer" },
    "invalid Evidence terminal",
  );

  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_invalid_retry",
    invocationId: "inv_invalid_retry",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: notFoundSessionId,
    question: retryQuestion,
    kind: "follow_up_retry",
  }));
  await waitForTerminal(outputChunks, "inv_invalid_retry");
  const retrySessionId = sessionIdFor(outputChunks, "inv_invalid_retry");
  assertFrame(lastFrameFor(outputChunks, "inv_invalid_retry"), { type: "page_answer_completed" }, "invalid Evidence Retry terminal");

  // Replaying this exact Retry must return its recorded terminal frame and
  // never advance the chain or create another Session Trace.
  const traceCountBeforeReplay = await countSessionTraces(workspaceRoot);
  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_invalid_retry",
    invocationId: "inv_invalid_retry",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: notFoundSessionId,
    question: retryQuestion,
    kind: "follow_up_retry",
  }));
  await waitForFrames(outputChunks, (frames) => frames.filter((frame) => frame.invocationId === "inv_invalid_retry" && frame.type === "page_answer_completed").length === 2);
  if (await countSessionTraces(workspaceRoot) !== traceCountBeforeReplay)
    throw new Error("Browser Workbench smoke replay created another Session Trace.");

  const stopQuestion = "Stop this child attempt.";
  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_stop",
    invocationId: "inv_stop",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: retrySessionId,
    question: stopQuestion,
  }));
  await waitForFrames(outputChunks, (frames) => frames.some((frame) => frame.invocationId === "inv_stop" && frame.type === "session_ready"));
  stdin.write(encodeNativeHostMessage({ type: "cancel", invocationId: "inv_stop" }));
  await waitForTerminal(outputChunks, "inv_stop");
  assertFrame(lastFrameFor(outputChunks, "inv_stop"), { type: "stopped", reason: "user_stopped" }, "Stop terminal");

  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_stop_retry",
    invocationId: "inv_stop_retry",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: retrySessionId,
    question: stopQuestion,
    kind: "follow_up_retry",
  }));
  await waitForTerminal(outputChunks, "inv_stop_retry");
  const finalSessionId = sessionIdFor(outputChunks, "inv_stop_retry");
  assertFrame(lastFrameFor(outputChunks, "inv_stop_retry"), { type: "page_answer_completed" }, "Stop Retry terminal");

  // Promote the whole Page Conversation into a single Knowledge Note (ADR
  // 0077): save, grow the chain, re-save (in-place overwrite), then hand-edit
  // the note and confirm a re-save is refused without touching the file.
  const noteTitle = "Browser Workbench Smoke Note";
  const knowledgeDir = join(workspaceRoot, ".forgelet", "knowledge");
  sendSave(stdin, {
    version: 3,
    conversationId,
    rootSessionId,
    headSessionId: finalSessionId,
    workspaceProfileId: profile.id,
    title: noteTitle,
  });
  const firstSave = await waitForSaveResponse(outputChunks, 1);
  if (firstSave.ok !== true) throw new Error("Browser Workbench smoke expected the first Note save to succeed.");
  const notePath = join(workspaceRoot, stringField(firstSave, "path"));
  const firstNote = await readFile(notePath, "utf8");
  if (!firstNote.includes(`# ${noteTitle}`) || !firstNote.includes(`conversationId: ${conversationId}`))
    throw new Error("Browser Workbench smoke expected the saved Note to carry its title and conversation identity.");
  if (await countMarkdownNotes(knowledgeDir) !== 1)
    throw new Error("Browser Workbench smoke expected exactly one Knowledge Note after the first save.");

  sendInvocation(stdin, followUpRequest({
    conversationId,
    actionId: "action_grow",
    invocationId: "inv_grow",
    workspaceProfileId: profile.id,
    captureId: capture.captureId,
    rootSessionId,
    parentSessionId: finalSessionId,
    question: "Is one more grounded question still within the capture?",
  }));
  await waitForTerminal(outputChunks, "inv_grow");
  const grownHeadSessionId = sessionIdFor(outputChunks, "inv_grow");
  assertFrame(lastFrameFor(outputChunks, "inv_grow"), { type: "page_answer_completed" }, "grow terminal");

  sendSave(stdin, {
    version: 3,
    conversationId,
    rootSessionId,
    headSessionId: grownHeadSessionId,
    workspaceProfileId: profile.id,
    title: noteTitle,
  });
  const secondSave = await waitForSaveResponse(outputChunks, 2);
  if (secondSave.ok !== true) throw new Error("Browser Workbench smoke expected the unedited Note re-save to overwrite.");
  if (stringField(secondSave, "path") !== stringField(firstSave, "path"))
    throw new Error("Browser Workbench smoke expected the overwrite to keep the same Note path.");
  const secondNote = await readFile(notePath, "utf8");
  if (secondNote === firstNote)
    throw new Error("Browser Workbench smoke expected the re-save to grow the Note with the new turn.");
  if (await countMarkdownNotes(knowledgeDir) !== 1)
    throw new Error("Browser Workbench smoke expected the overwrite to leave exactly one Knowledge Note.");

  const handEdited = `${secondNote}\nA human annotation the save must never clobber.\n`;
  await writeFile(notePath, handEdited, "utf8");
  sendSave(stdin, {
    version: 3,
    conversationId,
    rootSessionId,
    headSessionId: grownHeadSessionId,
    workspaceProfileId: profile.id,
    title: noteTitle,
  });
  const thirdSave = await waitForSaveResponse(outputChunks, 3);
  if (thirdSave.ok !== false || thirdSave.code !== "note_conflict")
    throw new Error("Browser Workbench smoke expected a hand-edited Note re-save to be refused with note_conflict.");
  if (await readFile(notePath, "utf8") !== handEdited)
    throw new Error("Browser Workbench smoke expected the refused save to leave the hand-edited Note byte-for-byte.");

  stdin.end();
  await run;

  const traces = await readdir(join(workspaceRoot, ".forgelet", "sessions"));
  const traceFiles = traces.filter((file) => file.endsWith(".jsonl"));
  if (traceFiles.length !== 9)
    throw new Error(`Browser Workbench smoke expected 9 Learning Session Traces, found ${traceFiles.length}.`);
  const traceContents = await Promise.all(traceFiles.map((file) => readFile(join(workspaceRoot, ".forgelet", "sessions", file), "utf8")));
  const allTraceText = traceContents.join("\n");
  if (allTraceText.includes(pageBody))
    throw new Error("Browser Workbench smoke found the complete page body in Trace.");
  if (!allTraceText.includes(evidence))
    throw new Error("Browser Workbench smoke expected bounded verified Evidence in Trace.");
  if (!allTraceText.includes('"truncated":true'))
    throw new Error("Browser Workbench smoke expected truncation metadata in Trace.");
  if (!allTraceText.includes(conversationId) || !allTraceText.includes("inv_stop_retry"))
    throw new Error("Browser Workbench smoke expected conversation and attempt identities in Trace.");

  const finalReady = frameFor(outputChunks, "inv_stop_retry", "session_ready");
  return {
    tracePath: stringField(finalReady, "tracePath"),
    sessionId: finalSessionId,
  };
}

type SmokeTurn = ModelTurnOutput | Error | "wait_for_stop";

class ScriptedSmokeModel implements ModelClient {
  constructor(private readonly turns: SmokeTurn[]) {}

  async createTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("Browser Workbench smoke exhausted scripted model turns.");
    if (turn instanceof Error) throw turn;
    if (turn !== "wait_for_stop") return turn;
    await new Promise<void>((_resolve, reject) => {
      if (input.signal?.aborted) reject(new Error("aborted"));
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    throw new Error("unreachable");
  }
}

function pageBriefOutput(): ModelTurnOutput {
  return {
    content: "## Summary\nA deterministic summary.\n\n## Key Concepts\n- Browser sources are explicit.",
    toolCalls: [],
  };
}

function supportedAnswer(answer: string, evidence: string): ModelTurnOutput {
  return { content: `## Answer\n${answer}\n\n## Evidence\n- ${evidence}`, toolCalls: [] };
}

function notFoundAnswer(answer: string): ModelTurnOutput {
  return {
    content: "## Answer\n" + answer + "\n\n## Evidence\nNo supporting passage in the captured page.",
    toolCalls: [],
  };
}

function rootRequest(input: {
  conversationId: string;
  actionId: string;
  invocationId: string;
  workspaceProfileId: string;
  capture: Record<string, unknown>;
}): Record<string, unknown> {
  return { version: 3, kind: "root", ...input };
}

function followUpRequest(input: {
  conversationId: string;
  actionId: string;
  invocationId: string;
  workspaceProfileId: string;
  captureId: string;
  rootSessionId: string;
  parentSessionId: string;
  question: string;
  kind?: "follow_up" | "follow_up_retry";
}): Record<string, unknown> {
  return { version: 3, kind: input.kind ?? "follow_up", ...input };
}

function sendInvocation(stdin: PassThrough, request: Record<string, unknown>): void {
  stdin.write(encodeNativeHostMessage({ type: "browserInvocation", request }));
}

function sendSave(stdin: PassThrough, request: Record<string, unknown>): void {
  stdin.write(encodeNativeHostMessage({ type: "saveKnowledgeNote", request }));
}

/** The Knowledge Note save is a one-shot request/response frame with no
 * invocationId, so responses are matched positionally as they arrive. */
async function waitForSaveResponse(
  chunks: Buffer[],
  count: number,
): Promise<Record<string, unknown>> {
  await waitForFrames(
    chunks,
    (frames) => frames.filter((frame) => typeof frame.ok === "boolean").length >= count,
  );
  return decodeFrames(chunks).filter((frame) => typeof frame.ok === "boolean")[count - 1]!;
}

async function countMarkdownNotes(knowledgeDir: string): Promise<number> {
  try {
    return (await readdir(knowledgeDir)).filter((file) => file.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function decodeFrames(chunks: Buffer[]): Record<string, unknown>[] {
  return new NativeMessageDecoder()
    .push(Buffer.concat(chunks))
    .filter(isRecord);
}

function frameFor(chunks: Buffer[], invocationId: string, type: string): Record<string, unknown> {
  const frame = decodeFrames(chunks).find(
    (candidate) => candidate.invocationId === invocationId && candidate.type === type,
  );
  if (!frame) throw new Error(`Browser Workbench smoke expected ${type} for ${invocationId}.`);
  return frame;
}

function lastFrameFor(chunks: Buffer[], invocationId: string): Record<string, unknown> {
  const frames = decodeFrames(chunks).filter((frame) => frame.invocationId === invocationId);
  const frame = frames.at(-1);
  if (!frame) throw new Error(`Browser Workbench smoke expected frames for ${invocationId}.`);
  return frame;
}

function sessionIdFor(chunks: Buffer[], invocationId: string): string {
  return stringField(frameFor(chunks, invocationId, "session_ready"), "sessionId");
}

function assertFrame(actual: Record<string, unknown>, expected: Record<string, unknown>, name: string): void {
  for (const [key, value] of Object.entries(expected)) {
    if (!matchesExpected(actual[key], value))
      throw new Error(`Browser Workbench smoke expected ${name} field ${key} to equal ${JSON.stringify(value)}.`);
  }
}

function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (!isRecord(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  if (!isRecord(actual)) return false;
  return Object.entries(expected).every(([key, value]) => matchesExpected(actual[key], value));
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") throw new Error(`Missing ${key}.`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function countSessionTraces(workspaceRoot: string): Promise<number> {
  return (await readdir(join(workspaceRoot, ".forgelet", "sessions"))).filter((file) => file.endsWith(".jsonl")).length;
}

async function waitForTerminal(chunks: Buffer[], invocationId: string): Promise<void> {
  await waitForFrames(
    chunks,
    (frames) => frames.some((frame) => frame.invocationId === invocationId && ["page_brief_completed", "page_answer_completed", "stopped", "failed", "launch_rejected", "action_conflict"].includes(String(frame.type))),
  );
}

async function waitForFrames(
  chunks: Buffer[],
  predicate: (frames: Record<string, unknown>[]) => boolean,
): Promise<void> {
  const started = Date.now();
  while (!predicate(decodeFrames(chunks))) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for Browser Workbench output.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runBrowserWorkbenchSmoke();
  console.log(`Browser Workbench smoke passed.\nTrace: ${result.tracePath}\nSession: ${result.sessionId}`);
}
