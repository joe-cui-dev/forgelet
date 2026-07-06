import { expect, test } from "@jest/globals";
import { compactConversationInPlace } from "../../src/conversation/compaction.js";
import type { ModelMessage } from "../../src/types.js";

test("compacts an old large file observation while preserving the newest tool turn", () => {
  const conversation: ModelMessage[] = [
    assistantToolCall("call_old", "read_file"),
    toolObservation("call_old", "read_file", "old.txt", "a".repeat(6_000)),
    assistantToolCall("call_new", "read_file"),
    toolObservation("call_new", "read_file", "new.txt", "b".repeat(6_000)),
  ];
  const newestContent = conversation[3]?.content ?? "";

  const result = compactConversationInPlace(conversation, {
    maxConversationBytes: Buffer.byteLength(newestContent, "utf8") + 1_000,
  });

  expect(result.compactedCount).toBe(1);
  expect(conversation).toHaveLength(4);
  expect(conversation[0]?.toolCalls?.[0]?.id).toBe("call_old");
  expect(conversation[1]?.toolCallId).toBe("call_old");
  expect(JSON.parse(conversation[1]?.content ?? "{}")).toMatchObject({
    toolCallId: "call_old",
    toolName: "read_file",
    compacted: true,
    metadata: { path: "old.txt" },
  });
  expect(conversation[3]?.content).toBe(newestContent);
});

test("compacts old file observations into range-preserving digests", () => {
  const returnedContent = `${"x".repeat(2_500)}middle-slice-content`;
  const conversation: ModelMessage[] = [
    assistantToolCall("call_old", "read_file"),
    rangedToolObservation(
      "call_old",
      "src/cli/index.ts",
      returnedContent,
      {
        offsetBytes: 5_000,
        limitBytes: 5_000,
        returnedStartByte: 5_000,
        returnedEndByte: 10_000,
        nextOffsetBytes: 10_000,
        totalBytes: 14_303,
        truncated: true,
      },
    ),
    assistantToolCall("call_new", "read_file"),
    toolObservation("call_new", "read_file", "new.txt", "n".repeat(6_000)),
  ];

  compactConversationInPlace(conversation, {
    maxConversationBytes: 4_096,
    observationDigestPreviewBytes: 2_048,
  });

  const compacted = JSON.parse(conversation[1]?.content ?? "{}");
  expect(compacted).toMatchObject({
    toolCallId: "call_old",
    toolName: "read_file",
    compacted: true,
    digest:
      "Compacted read_file result for src/cli/index.ts, byte range 5000-10000 of 14303, truncated, next offset 10000.",
    metadata: {
      path: "src/cli/index.ts",
      contentHash: "src/cli/index.ts-hash",
      rangeKind: "byte",
      offsetBytes: 5_000,
      limitBytes: 5_000,
      returnedStartByte: 5_000,
      returnedEndByte: 10_000,
      returnedBytes: Buffer.byteLength(returnedContent, "utf8"),
      totalBytes: 14_303,
      nextOffsetBytes: 10_000,
      truncated: true,
    },
  });
  expect(compacted.metadata.preview).toHaveLength(2_048);
  expect(compacted.metadata.preview).toBe(returnedContent.slice(0, 2_048));
  expect(compacted).not.toHaveProperty("content");
});

test("an oversized newest tool turn preserves every fresh observation", () => {
  const conversation: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_first", name: "read_file", input: { path: "first.txt" } },
        { id: "call_failed", name: "read_file", input: { path: "failed.txt" } },
        { id: "call_last", name: "read_file", input: { path: "last.txt" } },
      ],
    },
    toolObservation("call_first", "read_file", "first.txt", "a".repeat(6_000)),
    failedToolObservation("call_failed", "read_file", "failed.txt"),
    toolObservation("call_last", "read_file", "last.txt", "c".repeat(6_000)),
  ];
  const firstContent = conversation[1]?.content;
  const failedContent = conversation[2]?.content;
  const lastContent = conversation[3]?.content;

  const result = compactConversationInPlace(conversation, {
    maxConversationBytes: 4_096,
  });

  expect(result.compactedCount).toBe(0);
  expect(conversation[1]?.content).toBe(firstContent);
  expect(conversation[2]?.content).toBe(failedContent);
  expect(conversation[3]?.content).toBe(lastContent);
  expect(result.residualOverageBytes).toBeGreaterThan(0);
});

test("a fresh observation batch becomes compactable after a later tool turn", () => {
  const conversation: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_first", name: "read_file", input: { path: "first.txt" } },
        { id: "call_second", name: "read_file", input: { path: "second.txt" } },
      ],
    },
    toolObservation("call_first", "read_file", "first.txt", "a".repeat(6_000)),
    toolObservation("call_second", "read_file", "second.txt", "b".repeat(6_000)),
    assistantToolCall("call_new", "read_file"),
    toolObservation("call_new", "read_file", "new.txt", "new"),
  ];

  const result = compactConversationInPlace(conversation, {
    maxConversationBytes: 4_096,
  });

  expect(result.compactedCount).toBe(2);
  expect(JSON.parse(conversation[1]?.content ?? "{}").compacted).toBe(true);
  expect(JSON.parse(conversation[2]?.content ?? "{}").compacted).toBe(true);
  expect(JSON.parse(conversation[4]?.content ?? "{}").compacted).toBeUndefined();
});

test("prioritizes content-heavy tools before other old observations", () => {
  const conversation: ModelMessage[] = [
    assistantToolCall("call_list", "list_files"),
    toolObservation("call_list", "list_files", ".", "l".repeat(4_000)),
    assistantToolCall("call_read", "read_file"),
    toolObservation("call_read", "read_file", "large.ts", "r".repeat(6_000)),
    assistantToolCall("call_new", "read_file"),
    toolObservation("call_new", "read_file", "new.ts", "n".repeat(500)),
  ];
  const listContent = conversation[1]?.content;

  compactConversationInPlace(conversation, {
    maxConversationBytes: 8_500,
  });

  expect(conversation[1]?.content).toBe(listContent);
  expect(JSON.parse(conversation[3]?.content ?? "{}").compacted).toBe(true);
});

test("keeps unknown tool message payloads and reports residual overage", () => {
  const conversation: ModelMessage[] = [
    assistantToolCall("call_unknown", "read_file"),
    {
      role: "tool",
      toolCallId: "call_unknown",
      content: "not-json ".repeat(1_000),
    },
    assistantToolCall("call_new", "read_file"),
    toolObservation("call_new", "read_file", "new.ts", "new"),
  ];
  const unknownContent = conversation[1]?.content;

  const result = compactConversationInPlace(conversation, {
    maxConversationBytes: 4_096,
  });

  expect(conversation[1]?.content).toBe(unknownContent);
  expect(result.compactedCount).toBe(0);
  expect(result.uncompactableCount).toBe(1);
  expect(result.residualOverageBytes).toBeGreaterThan(0);
});

test("does not compact an already compacted observation again", () => {
  const conversation: ModelMessage[] = [
    assistantToolCall("call_old", "read_file"),
    toolObservation("call_old", "read_file", "old.ts", "o".repeat(6_000)),
    assistantToolCall("call_new", "read_file"),
    toolObservation("call_new", "read_file", "new.ts", "n".repeat(6_000)),
  ];

  compactConversationInPlace(conversation, { maxConversationBytes: 4_096 });
  const compactedContent = conversation[1]?.content;
  const second = compactConversationInPlace(conversation, {
    maxConversationBytes: 4_096,
  });

  expect(conversation[1]?.content).toBe(compactedContent);
  expect(second.compactedCount).toBe(0);
});

test("counts assistant message content toward the conversation-wide budget", () => {
  const conversation: ModelMessage[] = [
    {
      role: "assistant",
      content: "y".repeat(5_000),
      toolCalls: [{ id: "call_old", name: "read_file", input: {} }],
    },
    toolObservation("call_old", "read_file", "old.txt", "a".repeat(500)),
    assistantToolCall("call_new", "read_file"),
    toolObservation("call_new", "read_file", "new.txt", "b".repeat(500)),
  ];

  const result = compactConversationInPlace(conversation, {
    maxConversationBytes: 4_096,
  });

  expect(result.beforeConversationBytes).toBeGreaterThan(5_000);
  expect(result.compactedCount).toBe(1);
});

function assistantToolCall(id: string, name: string): ModelMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, input: { path: `${id}.txt` } }],
  };
}

function toolObservation(
  toolCallId: string,
  toolName: string,
  path: string,
  content: string,
): ModelMessage {
  return {
    role: "tool",
    toolCallId,
    content: JSON.stringify({
      ok: true,
      toolCallId,
      toolName,
      summary: `Read ${path}.`,
      content,
      metadata: {
        path,
        contentHash: `${path}-hash`,
        returnedBytes: Buffer.byteLength(content, "utf8"),
        preview: content.slice(0, 500),
      },
    }),
  };
}

function rangedToolObservation(
  toolCallId: string,
  path: string,
  content: string,
  range: {
    offsetBytes: number;
    limitBytes: number;
    returnedStartByte: number;
    returnedEndByte: number;
    nextOffsetBytes: number;
    totalBytes: number;
    truncated: boolean;
  },
): ModelMessage {
  return {
    role: "tool",
    toolCallId,
    content: JSON.stringify({
      ok: true,
      toolCallId,
      toolName: "read_file",
      summary: `Read ${path} with truncation.`,
      content,
      metadata: {
        path,
        contentHash: `${path}-hash`,
        rangeKind: "byte",
        returnedBytes: Buffer.byteLength(content, "utf8"),
        preview: content.slice(0, 500),
        ...range,
      },
    }),
  };
}

function failedToolObservation(
  toolCallId: string,
  toolName: string,
  path: string,
): ModelMessage {
  return {
    role: "tool",
    toolCallId,
    content: JSON.stringify({
      ok: false,
      toolCallId,
      toolName,
      summary: `Could not read ${path}.`,
      content: "failure details ".repeat(400),
      error: { code: "tool_failed", message: `Could not read ${path}.` },
      metadata: { path },
    }),
  };
}
