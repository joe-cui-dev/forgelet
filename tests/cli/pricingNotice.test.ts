import { afterEach, expect, jest, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatPeakPricingNotice } from "../../src/cli/present/pricing.js";
import { runCli } from "../../src/cli/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import { utc } from "../testSupport/utc.js";

test("no notice off-peak, so the common case stays silent", () => {
  expect(formatPeakPricingNotice(utc(12))).toBeUndefined();
  expect(formatPeakPricingNotice(utc(5))).toBeUndefined();
  expect(formatPeakPricingNotice(utc(23, 59))).toBeUndefined();
});

test("the peak notice names when the window closes so waiting can be priced", () => {
  expect(formatPeakPricingNotice(utc(2, 30))).toBe(
    "DeepSeek peak hours until 04:00 UTC — rates are 2x off-peak.",
  );
  expect(formatPeakPricingNotice(utc(9, 59))).toBe(
    "DeepSeek peak hours until 10:00 UTC — rates are 2x off-peak.",
  );
});

test("the notice covers both published peak windows", () => {
  expect(formatPeakPricingNotice(utc(1))).toBeDefined();
  expect(formatPeakPricingNotice(utc(6))).toBeDefined();
  // Boundaries are half-open: the closing hour is already off-peak.
  expect(formatPeakPricingNotice(utc(4))).toBeUndefined();
  expect(formatPeakPricingNotice(utc(10))).toBeUndefined();
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function runCodeSessionAt(instantMs: number): Promise<string[]> {
  jest.spyOn(Date, "now").mockReturnValue(instantMs);
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-peak-"));
  const notices: string[] = [];
  await runCli(["code", "inspect this repo"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () =>
      new FakeModelClient([{ content: "Done.", toolCalls: [] }]),
    notify: (text) => notices.push(text),
  });
  return notices;
}

test("a run started in a peak window notifies before the session begins", async () => {
  expect(await runCodeSessionAt(utc(2, 30))).toEqual([
    "DeepSeek peak hours until 04:00 UTC — rates are 2x off-peak.",
  ]);
});

test("a run started off-peak notifies nothing", async () => {
  expect(await runCodeSessionAt(utc(12))).toEqual([]);
});

test("a resumed session notifies too, since it buys turns at the same rates", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-peak-resume-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_parent.jsonl"),
    [
      traceLine("session_started", {
        workflow: "coding",
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
      traceLine("user_task", { task: "remember cobalt" }),
      traceLine("final_summary", { summary: "The inherited fact is cobalt." }),
      traceLine("session_finished", { status: "completed" }),
    ].join("\n"),
    "utf8",
  );

  jest.spyOn(Date, "now").mockReturnValue(utc(7));
  const notices: string[] = [];
  const result = await runCli(["resume", "sess_parent", "continue"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () =>
      new FakeModelClient([{ content: "Continuing.", toolCalls: [] }]),
    notify: (text) => notices.push(text),
  });

  expect(result.exitCode).toBe(0);
  expect(notices).toEqual([
    "DeepSeek peak hours until 10:00 UTC — rates are 2x off-peak.",
  ]);
});

function traceLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    ts: "2026-06-20T00:00:00.000Z",
    sessionId: "sess_parent",
    payload,
  });
}

test("a preview does not notify, since no money is at stake", async () => {
  jest.spyOn(Date, "now").mockReturnValue(utc(2, 30));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-peak-preview-"));
  const notices: string[] = [];
  await runCli(["code", "--preview", "inspect this repo"], {
    workspaceRoot,
    env: {},
    notify: (text) => notices.push(text),
  });
  expect(notices).toEqual([]);
});
