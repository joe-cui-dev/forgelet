import { expect, test } from "@jest/globals";
import { mkdtemp, readFile, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";

const transientError = (): Error =>
  Object.assign(new Error("socket hang up"), {
    causeCategory: "request_error",
    phase: "request",
  });

test("retries a transient model turn error and completes the session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-retry-"));
  let calls = 0;
  const modelClient = {
    async createTurn() {
      calls += 1;
      if (calls <= 2) throw transientError();
      return { content: "Done.", toolCalls: [] };
    },
  };

  const result = await runCodingSession({
    task: "fix tests",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(calls).toBe(3);
  expect(result.session.stage).toBe("final");
  expect(result.summary).toMatch(/Done\./);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const retries = events.filter((event) => event.type === "model_turn_retry");
  expect(retries).toHaveLength(2);
  expect(retries[0]?.payload).toMatchObject({
    turnIndex: 0,
    attempt: 1,
    maxRetries: 2,
    error: { message: "socket hang up", causeCategory: "request_error" },
  });
  expect(retries[1]?.payload).toMatchObject({
    turnIndex: 0,
    attempt: 2,
    maxRetries: 2,
  });
  expect(typeof retries[0]?.payload.delayMs).toBe("number");

  const modelTurn = events.find((event) => event.type === "model_turn");
  expect(modelTurn?.payload.usage).toBeUndefined();
});

test("a non-retryable model error fails fast without retry attempts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-retry-fatal-"));
  let calls = 0;
  const modelClient = {
    async createTurn() {
      calls += 1;
      throw Object.assign(new Error("invalid api key"), { statusCode: 401 });
    },
  };

  await expect(
    runCodingSession({
      task: "fix tests",
      contextFiles: [],
      workspaceRoot,
      modelClient,
    }),
  ).rejects.toThrow("invalid api key");

  expect(calls).toBe(1);

  const sessionFiles = await readdir(join(workspaceRoot, ".forgelet", "sessions"));
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", sessionFiles[0] ?? ""),
    "utf8",
  );
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((event) => event.type === "model_turn_retry")).toHaveLength(0);
  expect(events.find((event) => event.type === "model_turn_error")).toBeTruthy();
});

test("exhausts bounded retries and fails with model_turn_error", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-retry-exhausted-"));
  let calls = 0;
  const modelClient = {
    async createTurn() {
      calls += 1;
      throw transientError();
    },
  };

  await expect(
    runCodingSession({
      task: "fix tests",
      contextFiles: [],
      workspaceRoot,
      modelClient,
    }),
  ).rejects.toThrow("socket hang up");

  expect(calls).toBe(3);

  const sessionFiles = await readdir(join(workspaceRoot, ".forgelet", "sessions"));
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", sessionFiles[0] ?? ""),
    "utf8",
  );
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const retries = events.filter((event) => event.type === "model_turn_retry");
  expect(retries.map((event) => event.payload.attempt)).toEqual([1, 2]);
  expect(events.find((event) => event.type === "model_turn_error")).toBeTruthy();
});
