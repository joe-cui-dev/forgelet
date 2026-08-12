import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@jest/globals";
import {
  KnowledgeNotePromotionError,
  promotePageConversationToKnowledgeNote,
} from "../../src/browserWorkbench/knowledgeNotePromotion.js";

test("promotes a multi-turn Page Conversation into one ordered Knowledge Note", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-promote-"));
  await writeSession(workspaceRoot, "sess_root", [
    startedRoot("conv_1", "cap_1"),
    captureAttachment(),
    userTask("Summarize the explicitly shared current browser page."),
    finalContent("## Summary\nPage summary.\n\n## Key Concepts\nConcept."),
    finished("completed"),
  ]);
  await writeSession(workspaceRoot, "sess_f1", [
    startedFollowUp("conv_1", "cap_1", "sess_root"),
    userTask("What color is the sky?"),
    finalContent("## Answer\nBlue.\n\n## Evidence\n- the sky is blue"),
    finished("completed"),
  ]);
  await writeSession(workspaceRoot, "sess_f2", [
    startedFollowUp("conv_1", "cap_1", "sess_f1"),
    userTask("Why is it blue?"),
    finalContent(
      "## Answer\nRayleigh scattering.\n\n## Evidence\n- scattering explains the color",
    ),
    finished("completed"),
  ]);

  const result = await promotePageConversationToKnowledgeNote({
    workspaceRoot,
    conversationId: "conv_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_f2",
    title: "Why The Sky Is Blue",
    createdAt: "2026-07-12T00:00:00.000Z",
  });

  const note = await readFile(join(workspaceRoot, result.path), "utf8");
  expect(note).toContain("conversationId: conv_1");
  expect(note).toContain("rootSessionId: sess_root");
  expect(note).toContain("headSessionId: sess_f2");
  expect(note).toContain("uri: https://example.com/article");
  const body = note.slice(note.lastIndexOf("\n---\n") + 5);
  expect(body).toContain(
    [
      "# Why The Sky Is Blue",
      "",
      "## Summary",
      "Page summary.",
      "",
      "## Key Concepts",
      "Concept.",
      "",
      "## Follow-up 1: What color is the sky?",
      "",
      "### Answer",
      "Blue.",
      "",
      "### Evidence",
      "- the sky is blue",
      "",
      "## Follow-up 2: Why is it blue?",
      "",
      "### Answer",
      "Rayleigh scattering.",
      "",
      "### Evidence",
      "- scattering explains the color",
    ].join("\n"),
  );
});

test("excludes turns that are not on the declared head's ancestor chain", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-promote-branch-"));
  await writeSession(workspaceRoot, "sess_root", [
    startedRoot("conv_1", "cap_1"),
    captureAttachment(),
    userTask("Summarize the page."),
    finalContent("## Summary\nS.\n\n## Key Concepts\nK."),
    finished("completed"),
  ]);
  await writeSession(workspaceRoot, "sess_f1", [
    startedFollowUp("conv_1", "cap_1", "sess_root"),
    userTask("The kept question."),
    finalContent("## Answer\nKept.\n\n## Evidence\n- kept passage"),
    finished("completed"),
  ]);
  // A sibling branch off the root that never became the head, plus a failed
  // attempt: neither is reachable by walking parents back from sess_f1.
  await writeSession(workspaceRoot, "sess_branch", [
    startedFollowUp("conv_1", "cap_1", "sess_root"),
    userTask("The abandoned question."),
    finalContent("## Answer\nAbandoned.\n\n## Evidence\n- abandoned passage"),
    finished("completed"),
  ]);
  await writeSession(workspaceRoot, "sess_failed", [
    startedFollowUp("conv_1", "cap_1", "sess_f1"),
    userTask("The failed question."),
    finalContent("## Answer\nFailed.\n\n## Evidence\n- failed passage"),
    finished("failed"),
  ]);

  const result = await promotePageConversationToKnowledgeNote({
    workspaceRoot,
    conversationId: "conv_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_f1",
    title: "Kept Chain",
  });

  const note = await readFile(join(workspaceRoot, result.path), "utf8");
  expect(note).toContain("The kept question.");
  expect(note).not.toContain("The abandoned question.");
  expect(note).not.toContain("The failed question.");
});

test("rejects with conversation_not_found when the root Session is not a Page Conversation root", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-promote-noroot-"));
  await writeSession(workspaceRoot, "sess_plain", [
    { type: "session_started", payload: { workflow: "learning" } },
    userTask("A plain learning task."),
    finalContent("## Summary\nNo trigger."),
    finished("completed"),
  ]);

  await expect(
    promotePageConversationToKnowledgeNote({
      workspaceRoot,
      conversationId: "conv_1",
      rootSessionId: "sess_plain",
      headSessionId: "sess_plain",
      title: "Nope",
    }),
  ).rejects.toMatchObject({
    reason: "conversation_not_found",
  });
  await expect(
    promotePageConversationToKnowledgeNote({
      workspaceRoot,
      conversationId: "conv_1",
      rootSessionId: "sess_plain",
      headSessionId: "sess_plain",
      title: "Nope",
    }),
  ).rejects.toBeInstanceOf(KnowledgeNotePromotionError);
});

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

function startedRoot(conversationId: string, captureId: string) {
  return {
    type: "session_started",
    payload: {
      workflow: "learning",
      trigger: { kind: "root", conversationId, captureId },
    },
  };
}

function startedFollowUp(
  conversationId: string,
  captureId: string,
  parentSessionId: string,
) {
  return {
    type: "session_started",
    payload: {
      workflow: "learning",
      trigger: { kind: "follow_up", conversationId, captureId, parentSessionId },
    },
  };
}

function captureAttachment() {
  return {
    type: "context_attachment",
    payload: {
      id: "ctx_cap_1",
      source: "browser",
      title: "The Article",
      uri: "https://example.com/article",
      mimeType: "text/plain",
      contentBytes: 512,
      contentHash: createHash("sha256").update("capture").digest("hex"),
      preview: "Capture preview",
      trustLevel: "external",
    },
  };
}

function userTask(task: string) {
  return { type: "user_task", payload: { task } };
}

function finalContent(content: string) {
  return { type: "final_summary", payload: { finalContent: content } };
}

function finished(status: string) {
  return { type: "session_finished", payload: { status } };
}
