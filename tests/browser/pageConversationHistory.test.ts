import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  PageConversationHistoryUnavailableError,
  readPageConversationHistory,
} from "../../src/browserWorkbench/pageConversationHistory.js";

async function writeSession(
  workspaceRoot: string,
  sessionId: string,
  events: { type: string; payload: Record<string, unknown> }[],
): Promise<void> {
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    events
      .map((event, index) =>
        JSON.stringify({
          type: event.type,
          ts: `2026-07-12T00:0${index}:00.000Z`,
          sessionId,
          payload: event.payload,
        }),
      )
      .join("\n"),
    "utf8",
  );
}

function rootSession(input: {
  conversationId: string;
  captureId: string;
  task: string;
  answer: string;
  status?: string;
}): { type: string; payload: Record<string, unknown> }[] {
  return [
    {
      type: "session_started",
      payload: {
        workflow: "learning",
        trigger: {
          kind: "root",
          conversationId: input.conversationId,
          captureId: input.captureId,
        },
      },
    },
    { type: "user_task", payload: { task: input.task } },
    { type: "final_summary", payload: { finalContent: input.answer } },
    { type: "session_finished", payload: { status: input.status ?? "completed" } },
  ];
}

function followUpSession(input: {
  conversationId: string;
  captureId: string;
  parentSessionId: string;
  task: string;
  answer: string;
  status?: string;
  workflow?: string;
}): { type: string; payload: Record<string, unknown> }[] {
  return [
    {
      type: "session_started",
      payload: {
        workflow: input.workflow ?? "learning",
        trigger: {
          kind: "follow_up",
          conversationId: input.conversationId,
          captureId: input.captureId,
          parentSessionId: input.parentSessionId,
        },
      },
    },
    { type: "user_task", payload: { task: input.task } },
    { type: "final_summary", payload: { finalContent: input.answer } },
    { type: "session_finished", payload: { status: input.status ?? "completed" } },
  ];
}

test("reconstructs ordered history from a root Page Brief plus successful follow-up Page Answers", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-"));
  await writeSession(
    workspaceRoot,
    "sess_root",
    rootSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      task: "Summarize the explicitly shared current browser page.",
      answer: "## Summary\nPage summary.\n\n## Key Concepts\nConcept.",
    }),
  );
  await writeSession(
    workspaceRoot,
    "sess_f1",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_root",
      task: "What color is the sky?",
      answer: "## Answer\nBlue.\n\n## Evidence\n- the sky is blue",
    }),
  );
  await writeSession(
    workspaceRoot,
    "sess_f2",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_f1",
      task: "Why is it blue?",
      answer: "## Answer\nRayleigh scattering.\n\n## Evidence\n- scattering explains the color",
    }),
  );

  const history = await readPageConversationHistory({
    workspaceRoot,
    conversationId: "conv_1",
    captureId: "cap_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_f2",
  });

  expect(history).toEqual({
    conversationId: "conv_1",
    captureId: "cap_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_f2",
    turns: [
      {
        sessionId: "sess_root",
        question: "Summarize the explicitly shared current browser page.",
        answer: "## Summary\nPage summary.\n\n## Key Concepts\nConcept.",
      },
      {
        sessionId: "sess_f1",
        question: "What color is the sky?",
        answer: "## Answer\nBlue.\n\n## Evidence\n- the sky is blue",
      },
      {
        sessionId: "sess_f2",
        question: "Why is it blue?",
        answer: "## Answer\nRayleigh scattering.\n\n## Evidence\n- scattering explains the color",
      },
    ],
  });
});

test("a not_found Page Answer Session still counts as a successful turn", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-notfound-"));
  await writeSession(
    workspaceRoot,
    "sess_root",
    rootSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      task: "Summarize the page.",
      answer: "## Summary\nS.\n\n## Key Concepts\nK.",
    }),
  );
  await writeSession(
    workspaceRoot,
    "sess_f1",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_root",
      task: "Does the page mention pricing?",
      answer: "## Answer\nThe page does not say.\n\n## Evidence\nNo supporting passage in the captured page.",
    }),
  );

  const history = await readPageConversationHistory({
    workspaceRoot,
    conversationId: "conv_1",
    captureId: "cap_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_f1",
  });

  expect(history.turns).toHaveLength(2);
  expect(history.turns[1]?.answer).toContain("No supporting passage in the captured page.");
});

test("rejects when the declared head Session did not complete successfully", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-head-failed-"));
  await writeSession(
    workspaceRoot,
    "sess_root",
    rootSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      task: "Summarize the page.",
      answer: "## Summary\nS.\n\n## Key Concepts\nK.",
    }),
  );
  await writeSession(
    workspaceRoot,
    "sess_f1_failed",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_root",
      task: "A question.",
      answer: "irrelevant",
      status: "failed",
    }),
  );

  await expect(
    readPageConversationHistory({
      workspaceRoot,
      conversationId: "conv_1",
      captureId: "cap_1",
      rootSessionId: "sess_root",
      headSessionId: "sess_f1_failed",
    }),
  ).rejects.toBeInstanceOf(PageConversationHistoryUnavailableError);
});

test("rejects when an ancestor Trace is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-missing-"));
  await writeSession(
    workspaceRoot,
    "sess_root",
    rootSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      task: "Summarize the page.",
      answer: "## Summary\nS.\n\n## Key Concepts\nK.",
    }),
  );
  // sess_f1 references a parent that was never written to disk.
  await writeSession(
    workspaceRoot,
    "sess_f1",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_ghost",
      task: "A question.",
      answer: "An answer.",
    }),
  );

  await expect(
    readPageConversationHistory({
      workspaceRoot,
      conversationId: "conv_1",
      captureId: "cap_1",
      rootSessionId: "sess_root",
      headSessionId: "sess_f1",
    }),
  ).rejects.toBeInstanceOf(PageConversationHistoryUnavailableError);
});

test("rejects an ancestor from a different Page Conversation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-cross-conv-"));
  await writeSession(
    workspaceRoot,
    "sess_root",
    rootSession({
      conversationId: "conv_other",
      captureId: "cap_1",
      task: "Summarize the page.",
      answer: "## Summary\nS.\n\n## Key Concepts\nK.",
    }),
  );

  await expect(
    readPageConversationHistory({
      workspaceRoot,
      conversationId: "conv_1",
      captureId: "cap_1",
      rootSessionId: "sess_root",
      headSessionId: "sess_root",
    }),
  ).rejects.toBeInstanceOf(PageConversationHistoryUnavailableError);
});

test("rejects an ancestor that used a different capture", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-cross-capture-"));
  await writeSession(
    workspaceRoot,
    "sess_root",
    rootSession({
      conversationId: "conv_1",
      captureId: "cap_other",
      task: "Summarize the page.",
      answer: "## Summary\nS.\n\n## Key Concepts\nK.",
    }),
  );

  await expect(
    readPageConversationHistory({
      workspaceRoot,
      conversationId: "conv_1",
      captureId: "cap_1",
      rootSessionId: "sess_root",
      headSessionId: "sess_root",
    }),
  ).rejects.toBeInstanceOf(PageConversationHistoryUnavailableError);
});

test("rejects an ancestor that is not a Learning Workflow Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-wrong-workflow-"));
  await writeSession(
    workspaceRoot,
    "sess_root",
    rootSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      task: "Summarize the page.",
      answer: "## Summary\nS.\n\n## Key Concepts\nK.",
    }),
  );
  await writeSession(
    workspaceRoot,
    "sess_f1",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_root",
      task: "A question.",
      answer: "An answer.",
      workflow: "coding",
    }),
  );

  await expect(
    readPageConversationHistory({
      workspaceRoot,
      conversationId: "conv_1",
      captureId: "cap_1",
      rootSessionId: "sess_root",
      headSessionId: "sess_f1",
    }),
  ).rejects.toBeInstanceOf(PageConversationHistoryUnavailableError);
});

test("rejects a chain whose root does not match the declared root Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-wrong-root-"));
  await writeSession(
    workspaceRoot,
    "sess_actual_root",
    rootSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      task: "Summarize the page.",
      answer: "## Summary\nS.\n\n## Key Concepts\nK.",
    }),
  );
  await writeSession(
    workspaceRoot,
    "sess_f1",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_actual_root",
      task: "A question.",
      answer: "An answer.",
    }),
  );

  await expect(
    readPageConversationHistory({
      workspaceRoot,
      conversationId: "conv_1",
      captureId: "cap_1",
      rootSessionId: "sess_declared_but_wrong_root",
      headSessionId: "sess_f1",
    }),
  ).rejects.toBeInstanceOf(PageConversationHistoryUnavailableError);
});

test("rejects a cyclic ancestor chain instead of looping forever", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-page-history-cycle-"));
  await writeSession(
    workspaceRoot,
    "sess_a",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_b",
      task: "Question A.",
      answer: "Answer A.",
    }),
  );
  await writeSession(
    workspaceRoot,
    "sess_b",
    followUpSession({
      conversationId: "conv_1",
      captureId: "cap_1",
      parentSessionId: "sess_a",
      task: "Question B.",
      answer: "Answer B.",
    }),
  );

  await expect(
    readPageConversationHistory({
      workspaceRoot,
      conversationId: "conv_1",
      captureId: "cap_1",
      rootSessionId: "sess_root_never_reached",
      headSessionId: "sess_a",
    }),
  ).rejects.toBeInstanceOf(PageConversationHistoryUnavailableError);
});
