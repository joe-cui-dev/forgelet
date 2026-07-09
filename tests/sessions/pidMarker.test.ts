import { expect, test } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isProcessAlive,
  readPidMarker,
  removePidMarker,
  writePidMarker,
} from "../../src/sessions/pidMarker.js";

test("writePidMarker and readPidMarker round-trip a pid", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pid-"));

  await writePidMarker(workspaceRoot, "sess_abc", 12345);

  await expect(readPidMarker(workspaceRoot, "sess_abc")).resolves.toBe(12345);
});

test("readPidMarker returns undefined when no marker exists", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pid-"));

  await expect(readPidMarker(workspaceRoot, "sess_missing")).resolves.toBeUndefined();
});

test("removePidMarker deletes the marker and is a no-op if already gone", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pid-"));
  await writePidMarker(workspaceRoot, "sess_abc", 12345);

  await removePidMarker(workspaceRoot, "sess_abc");

  await expect(readPidMarker(workspaceRoot, "sess_abc")).resolves.toBeUndefined();
  await expect(removePidMarker(workspaceRoot, "sess_abc")).resolves.toBeUndefined();
});

test("isProcessAlive distinguishes a live pid from a bogus one", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(999_999_999)).toBe(false);
});
