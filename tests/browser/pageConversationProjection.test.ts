import { expect, test } from "@jest/globals";
import {
  PAGE_CONVERSATION_PROJECTION_SCHEMA_VERSION,
  applyPageConversationFrame,
  createPageConversationProjection,
  evictPageConversationProjection,
  markPageConversationAttemptStopping,
  startPageConversationAttempt,
  type PageConversationProjection,
} from "../../src/browser/extension/pageConversationProjection.js";

const source = {
  url: "https://example.com/docs",
  title: "Example Docs",
  capturedAt: "2026-07-14T00:00:00.000Z",
  truncated: false,
};

function startRoot(): PageConversationProjection {
  return createPageConversationProjection({
    conversationId: "conversation_1",
    actionId: "action_1",
    invocationId: "invocation_1",
    workspaceProfileId: "profile_1",
    captureId: "capture_1",
    source,
  });
}

test("a new projection is schema v3 and carries source, capture, and profile identity with an in-flight root attempt", () => {
  const projection = startRoot();
  expect(projection.schemaVersion).toBe(PAGE_CONVERSATION_PROJECTION_SCHEMA_VERSION);
  expect(projection).toMatchObject({
    conversationId: "conversation_1",
    captureId: "capture_1",
    workspaceProfileId: "profile_1",
    source,
    turns: [],
    terminalCards: [],
    currentAttempt: { invocationId: "invocation_1", actionId: "action_1", kind: "root", status: "starting" },
  });
  expect(projection.rootSessionId).toBeUndefined();
  expect(projection.headSessionId).toBeUndefined();
});

test("a successful Page Brief advances root and head and appends the normalized turn", () => {
  let projection = startRoot();
  projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_1", sessionId: "sess_root", tracePath: "/tmp/sess_root.jsonl" });
  expect(projection.currentAttempt).toMatchObject({ status: "running", sessionId: "sess_root" });

  projection = applyPageConversationFrame(projection, {
    type: "page_brief_completed",
    invocationId: "invocation_1",
    pageBrief: { summary: "A brief.", keyConcepts: "- Concept" },
  });

  expect(projection.rootSessionId).toBe("sess_root");
  expect(projection.headSessionId).toBe("sess_root");
  expect(projection.currentAttempt).toBeUndefined();
  expect(projection.turns).toEqual([
    { invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "A brief.", keyConcepts: "- Concept" } },
  ]);
});

test("a follow-up Page Answer advances head but leaves root unchanged, and a not-found grounding status is still a successful turn", () => {
  let projection = startRoot();
  projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_1", sessionId: "sess_root" });
  projection = applyPageConversationFrame(projection, { type: "page_brief_completed", invocationId: "invocation_1", pageBrief: { summary: "A brief.", keyConcepts: "- Concept" } });

  projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: "action_2", invocationId: "invocation_2", question: "Is there a changelog?" });
  projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_2", sessionId: "sess_f1" });
  projection = applyPageConversationFrame(projection, {
    type: "page_answer_completed",
    invocationId: "invocation_2",
    pageAnswer: { answer: "No supporting passage in the captured page.", groundingStatus: "not_found", evidence: [] },
  });

  expect(projection.rootSessionId).toBe("sess_root");
  expect(projection.headSessionId).toBe("sess_f1");
  expect(projection.currentAttempt).toBeUndefined();
  expect(projection.turns).toHaveLength(2);
  expect(projection.turns[1]).toMatchObject({
    kind: "follow_up",
    question: "Is there a changelog?",
    pageAnswer: { groundingStatus: "not_found" },
  });
});

test.each(["stopped", "failed"] as const)(
  "a %s follow-up attempt leaves the head unchanged, drops partial streamed text, and files a terminal card",
  (terminal) => {
    let projection = startRoot();
    projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_1", sessionId: "sess_root" });
    projection = applyPageConversationFrame(projection, { type: "page_brief_completed", invocationId: "invocation_1", pageBrief: { summary: "A brief.", keyConcepts: "- Concept" } });
    const headBefore = projection.headSessionId;

    projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: "action_2", invocationId: "invocation_2", question: "Why?" });
    projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_2", sessionId: "sess_f1" });
    projection = applyPageConversationFrame(projection, {
      type: "live_event",
      invocationId: "invocation_2",
      event: { type: "model_output_delta", text: "partial streamed text" },
    });
    expect(projection.currentAttempt?.liveText).toBe("partial streamed text");

    projection = applyPageConversationFrame(
      projection,
      terminal === "stopped"
        ? { type: "stopped", invocationId: "invocation_2", reason: "user_stopped" }
        : { type: "failed", invocationId: "invocation_2", message: "invalid_page_answer" },
    );

    expect(projection.headSessionId).toBe(headBefore);
    expect(projection.turns).toHaveLength(1);
    expect(projection.currentAttempt).toBeUndefined();
    expect(projection.terminalCards).toEqual([
      { invocationId: "invocation_2", kind: "follow_up", status: terminal, reason: terminal === "stopped" ? "user_stopped" : "invalid_page_answer", question: "Why?", sessionId: "sess_f1" },
    ]);
  },
);

test("a pre-Session launch rejection files a terminal card without a Session identity", () => {
  let projection = startRoot();
  projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_1", sessionId: "sess_root" });
  projection = applyPageConversationFrame(projection, { type: "page_brief_completed", invocationId: "invocation_1", pageBrief: { summary: "A brief.", keyConcepts: "- Concept" } });

  projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: "action_2", invocationId: "invocation_2", question: "Why?" });
  projection = applyPageConversationFrame(projection, { type: "launch_rejected", invocationId: "invocation_2", reason: "source_unavailable" });

  expect(projection.currentAttempt).toBeUndefined();
  expect(projection.terminalCards).toEqual([
    { invocationId: "invocation_2", kind: "follow_up", status: "rejected", reason: "source_unavailable", question: "Why?" },
  ]);
});

test("a Retry starts a fresh attempt identity from the unchanged source, capture, and head", () => {
  let projection = startRoot();
  projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_1", sessionId: "sess_root" });
  projection = applyPageConversationFrame(projection, { type: "page_brief_completed", invocationId: "invocation_1", pageBrief: { summary: "A brief.", keyConcepts: "- Concept" } });
  projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: "action_2", invocationId: "invocation_2", question: "Why?" });
  projection = applyPageConversationFrame(projection, { type: "failed", invocationId: "invocation_2", message: "model unavailable" });
  const beforeRetry = projection;

  const retried = startPageConversationAttempt(projection, { kind: "follow_up_retry", actionId: "action_3", invocationId: "invocation_3", question: "Why?" });

  expect(retried.currentAttempt).toMatchObject({ invocationId: "invocation_3", kind: "follow_up_retry", status: "starting", question: "Why?" });
  expect(retried.headSessionId).toBe(beforeRetry.headSessionId);
  expect(retried.captureId).toBe(beforeRetry.captureId);
  expect(retried.source).toEqual(beforeRetry.source);
  // Retry never reopens the failed attempt: its terminal card stays as history.
  expect(retried.terminalCards).toEqual(beforeRetry.terminalCards);
});

test("Stop marks only the named in-flight attempt as stopping and is a no-op for any other invocation", () => {
  let projection = startRoot();
  const stale = markPageConversationAttemptStopping(projection, "not_the_current_attempt");
  expect(stale).toBe(projection);

  projection = markPageConversationAttemptStopping(projection, "invocation_1");
  expect(projection.currentAttempt?.status).toBe("stopping");
});

test("a stale frame from a superseded attempt is ignored", () => {
  let projection = startRoot();
  projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_1", sessionId: "sess_root" });
  projection = applyPageConversationFrame(projection, { type: "page_brief_completed", invocationId: "invocation_1", pageBrief: { summary: "A brief.", keyConcepts: "- Concept" } });
  projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: "action_2", invocationId: "invocation_2", question: "Why?" });

  // A late frame from a stopped/superseded earlier attempt must never mutate
  // the projection out from under the attempt actually in flight.
  const untouched = applyPageConversationFrame(projection, { type: "page_answer_completed", invocationId: "invocation_stale", pageAnswer: { answer: "Stale.", groundingStatus: "supported", evidence: [] } });
  expect(untouched).toBe(projection);
});

test("eviction preserves the source header, Page Brief, head, and current attempt while evicting oldest terminal cards then oldest middle turns", () => {
  let projection = startRoot();
  projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId: "invocation_1", sessionId: "sess_root" });
  projection = applyPageConversationFrame(projection, { type: "page_brief_completed", invocationId: "invocation_1", pageBrief: { summary: "A brief.", keyConcepts: "- Concept" } });

  for (let index = 0; index < 5; index += 1) {
    const failInvocationId = `invocation_fail_${index}`;
    projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: `action_fail_${index}`, invocationId: failInvocationId, question: `Failing question number ${index} with enough padding to add up.` });
    projection = applyPageConversationFrame(projection, { type: "failed", invocationId: failInvocationId, message: "model unavailable, please retry this attempt later" });
  }

  for (let index = 0; index < 5; index += 1) {
    const invocationId = `invocation_ok_${index}`;
    projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: `action_ok_${index}`, invocationId, question: `Question number ${index} with enough padding text to matter.` });
    projection = applyPageConversationFrame(projection, { type: "session_ready", invocationId, sessionId: `sess_ok_${index}` });
    projection = applyPageConversationFrame(projection, {
      type: "page_answer_completed",
      invocationId,
      pageAnswer: { answer: `Answer number ${index} with quite a lot of descriptive padding text.`, groundingStatus: "supported", evidence: ["A captured passage that is reasonably long for padding."] },
    });
  }

  projection = startPageConversationAttempt(projection, { kind: "follow_up", actionId: "action_current", invocationId: "invocation_current", question: "What is currently running?" });

  const rootTurn = projection.turns[0];
  const headTurn = projection.turns.at(-1);
  const evicted = evictPageConversationProjection(projection, 1200);

  expect(evicted.historyEvicted).toBe(true);
  expect(evicted.source).toEqual(projection.source);
  expect(evicted.turns[0]).toEqual(rootTurn);
  expect(evicted.turns.at(-1)).toEqual(headTurn);
  expect(evicted.currentAttempt).toEqual(projection.currentAttempt);
  expect(evicted.terminalCards.length).toBeLessThan(projection.terminalCards.length);
  expect(evicted.turns.length).toBeLessThanOrEqual(projection.turns.length);
});

test("eviction is a no-op when the projection already fits its byte budget", () => {
  const projection = startRoot();
  const evicted = evictPageConversationProjection(projection, 1024 * 1024);
  expect(evicted).toBe(projection);
  expect(evicted.historyEvicted).toBe(false);
});
