import { expect, test } from "@jest/globals";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDebugTranscriptWriter,
  debugTranscriptPath,
  readDebugTranscript,
  summarizeDebugTranscriptFile,
} from "../../src/debugTranscript/index.js";

test("writes and reads Debug Transcript JSONL events under the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-debug-"));
  const sessionId = "sess_debug";

  expect(debugTranscriptPath(workspaceRoot, sessionId)).toBe(
    join(workspaceRoot, ".forgelet", "debug", "sess_debug.jsonl"),
  );

  const writer = await createDebugTranscriptWriter(workspaceRoot, sessionId);
  await writer.append({
    type: "model_request",
    ts: "2026-07-05T00:00:00.000Z",
    sessionId,
    payload: {
      turnIndex: 1,
      messages: [{ role: "user", content: "full prompt text" }],
      tools: [{ name: "read_file" }],
    },
  });
  await writer.append({
    type: "model_response",
    ts: "2026-07-05T00:00:01.000Z",
    sessionId,
    payload: {
      content: "full model response",
      toolCalls: [],
    },
  });

  await expect(readDebugTranscript(workspaceRoot, sessionId)).resolves.toEqual([
    {
      type: "model_request",
      ts: "2026-07-05T00:00:00.000Z",
      sessionId,
      payload: {
        turnIndex: 1,
        messages: [{ role: "user", content: "full prompt text" }],
        tools: [{ name: "read_file" }],
      },
    },
    {
      type: "model_response",
      ts: "2026-07-05T00:00:01.000Z",
      sessionId,
      payload: {
        content: "full model response",
        toolCalls: [],
      },
    },
  ]);

  const fileContent = await readFile(writer.path, "utf8");
  const summary = await summarizeDebugTranscriptFile(writer.path);
  expect(summary.contentBytes).toBe(Buffer.byteLength(fileContent, "utf8"));
  expect(summary.contentHash).toHaveLength(64);
});
