import { expect, test } from "@jest/globals";
import {
  buildFactLedger,
  renderFactLedger,
} from "../../src/conversation/factLedger.js";
import type { ModelMessage } from "../../src/types.js";

test("records a read file's path, hash, and range from a folded observation", () => {
  const messages: ModelMessage[] = [
    toolObservation({
      toolCallId: "call_1",
      toolName: "read_file",
      path: "src/index.ts",
      contentHash: "src/index.ts-hash",
      returnedStartByte: 0,
      returnedEndByte: 500,
      totalBytes: 500,
    }),
  ];

  const ledger = buildFactLedger(messages);

  expect(ledger.files).toEqual([
    {
      path: "src/index.ts",
      contentHash: "src/index.ts-hash",
      ranges: ["byte range 0-500 of 500"],
    },
  ]);
});

test("records changed files and command outcomes from folded observations", () => {
  const messages: ModelMessage[] = [
    {
      role: "tool",
      toolCallId: "call_patch",
      content: JSON.stringify({
        ok: true,
        toolCallId: "call_patch",
        toolName: "apply_patch",
        summary: "Patched files.",
        metadata: { changedFiles: ["src/a.ts", "src/b.ts"] },
      }),
    },
    {
      role: "tool",
      toolCallId: "call_run",
      content: JSON.stringify({
        ok: true,
        toolCallId: "call_run",
        toolName: "run_command",
        summary: "Ran tests.",
        metadata: { command: "npm test", exitCode: 0, durationMs: 1200 },
      }),
    },
  ];

  const ledger = buildFactLedger(messages);

  expect(ledger.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  expect(renderFactLedger(ledger)).toContain("- npm test (exit 0, 1200ms)");
});

test("carries a previous ledger forward across refolds, merging by path", () => {
  const previousLedger = buildFactLedger([
    toolObservation({
      toolCallId: "call_1",
      toolName: "read_file",
      path: "src/index.ts",
      contentHash: "hash-v1",
      returnedStartByte: 0,
      returnedEndByte: 500,
      totalBytes: 1000,
    }),
  ]);

  const refolded = buildFactLedger(
    [
      toolObservation({
        toolCallId: "call_2",
        toolName: "read_file",
        path: "src/index.ts",
        contentHash: "hash-v2",
        returnedStartByte: 500,
        returnedEndByte: 1000,
        totalBytes: 1000,
      }),
      toolObservation({
        toolCallId: "call_3",
        toolName: "read_file",
        path: "src/other.ts",
        contentHash: "other-hash",
        returnedStartByte: 0,
        returnedEndByte: 200,
        totalBytes: 200,
      }),
    ],
    previousLedger,
  );

  expect(refolded.files).toEqual([
    {
      path: "src/index.ts",
      contentHash: "hash-v2",
      ranges: ["byte range 0-1000 of 1000"],
    },
    {
      path: "src/other.ts",
      contentHash: "other-hash",
      ranges: ["byte range 0-200 of 200"],
    },
  ]);
});

test("deduplicates commands by command string and keeps the latest exit code plus run count", () => {
  const ledger = buildFactLedger([
    commandObservation("call_1", "npm test", 1),
    commandObservation("call_2", "npm run typecheck", 0),
    commandObservation("call_3", "npm test", 0),
  ]);

  expect(renderFactLedger(ledger)).toContain("- npm test (exit 0, 2 runs)");
  expect(renderFactLedger(ledger)).toContain("- npm run typecheck (exit 0)");
});

test("bounds rendered ledger bytes by evicting old commands before old file reads", () => {
  const ledger = buildFactLedger([
    commandObservation("call_1", `node ${"a".repeat(80)}`, 0),
    commandObservation("call_2", `node ${"b".repeat(80)}`, 0),
    toolObservation({
      toolCallId: "call_file_old",
      toolName: "read_file",
      path: `src/${"old".repeat(20)}.ts`,
      contentHash: "old-hash",
      returnedStartByte: 0,
      returnedEndByte: 100,
      totalBytes: 100,
    }),
    toolObservation({
      toolCallId: "call_file_new",
      toolName: "read_file",
      path: "src/new.ts",
      contentHash: "new-hash",
      returnedStartByte: 0,
      returnedEndByte: 100,
      totalBytes: 100,
    }),
    {
      role: "tool",
      toolCallId: "call_patch",
      content: JSON.stringify({
        ok: true,
        toolCallId: "call_patch",
        toolName: "apply_patch",
        summary: "Patched files.",
        metadata: { changedFiles: ["src/changed.ts"] },
      }),
    },
  ]);

  const rendered = renderFactLedger(ledger, { maxConversationBytes: 840 });

  expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(210);
  expect(rendered).toContain("src/changed.ts");
  expect(rendered).toContain("src/new.ts");
  expect(rendered).not.toContain("node ");
  expect(rendered).not.toContain("oldold");
  expect(rendered).toContain(
    "Ledger truncated: evicted 2 command entries and 1 file-read entry; see Trace for full evidence.",
  );
});

test("renders a deterministic text form of a populated ledger", () => {
  const ledger = buildFactLedger([
    toolObservation({
      toolCallId: "call_1",
      toolName: "read_file",
      path: "src/index.ts",
      contentHash: "hash-1",
      returnedStartByte: 0,
      returnedEndByte: 500,
      totalBytes: 500,
    }),
    {
      role: "tool",
      toolCallId: "call_patch",
      content: JSON.stringify({
        ok: true,
        toolCallId: "call_patch",
        toolName: "apply_patch",
        summary: "Patched files.",
        metadata: { changedFiles: ["src/a.ts"] },
      }),
    },
    {
      role: "tool",
      toolCallId: "call_run",
      content: JSON.stringify({
        ok: true,
        toolCallId: "call_run",
        toolName: "run_command",
        summary: "Ran tests.",
        metadata: { command: "npm test", exitCode: 0, durationMs: 1200 },
      }),
    },
  ]);

  expect(renderFactLedger(ledger)).toBe(
    [
      "Fact Ledger:",
      "Files read:",
      "- src/index.ts (hash: hash-1): byte range 0-500 of 500",
      "Files changed:",
      "- src/a.ts",
      "Commands run:",
      "- npm test (exit 0, 1200ms)",
    ].join("\n"),
  );
});

test("renders an empty ledger as a marker", () => {
  expect(renderFactLedger(buildFactLedger([]))).toBe("Fact Ledger: (empty)");
});

function toolObservation(options: {
  toolCallId: string;
  toolName: string;
  path: string;
  contentHash?: string;
  returnedStartByte?: number;
  returnedEndByte?: number;
  totalBytes?: number;
}): ModelMessage {
  return {
    role: "tool",
    toolCallId: options.toolCallId,
    content: JSON.stringify({
      ok: true,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      summary: `Read ${options.path}.`,
      metadata: {
        path: options.path,
        contentHash: options.contentHash,
        returnedStartByte: options.returnedStartByte,
        returnedEndByte: options.returnedEndByte,
        totalBytes: options.totalBytes,
      },
    }),
  };
}

function commandObservation(
  toolCallId: string,
  command: string,
  exitCode: number,
): ModelMessage {
  return {
    role: "tool",
    toolCallId,
    content: JSON.stringify({
      ok: exitCode === 0,
      toolCallId,
      toolName: "run_command",
      summary: `Ran ${command}.`,
      metadata: { command, exitCode },
    }),
  };
}
