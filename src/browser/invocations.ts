import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LearningPack, PageBrief } from "../workflows/learning.js";
import type {
  BrowserAttemptFailureCode,
  BrowserLaunchRejectionCode,
  BrowserPageAnswer,
} from "./protocol.js";

type BrowserAttemptKind = "root" | "root_retry" | "follow_up" | "follow_up_retry";

export type InvocationState =
  | "pending"
  | "ready"
  | "completed"
  | "stopped"
  | "failed"
  | "rejected";

export interface InvocationReceipt {
  schemaVersion: 3;
  conversationId: string;
  actionId: string;
  invocationId: string;
  attemptKind: BrowserAttemptKind;
  payloadHash: string;
  state: InvocationState;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  tracePath?: string;
  reason?: string;
  code?: BrowserAttemptFailureCode | BrowserLaunchRejectionCode;
  summary?: string;
  learningPack?: LearningPack;
  pageBrief?: PageBrief;
  pageAnswer?: BrowserPageAnswer;
}

export type ClaimInvocationResult =
  | { outcome: "claimed" }
  | { outcome: "replay"; receipt: InvocationReceipt }
  | { outcome: "conflict" };

export async function claimInvocation(input: {
  homeDir?: string;
  actionId: string;
  invocationId: string;
  conversationId?: string;
  attemptKind?: BrowserAttemptKind;
  payloadHash: string;
  now?: Date;
}): Promise<ClaimInvocationResult> {
  const path = receiptPath(input.homeDir, "v3", input.invocationId);
  await mkdir(join(receiptsDir(input.homeDir)), { recursive: true });
  const nowIso = (input.now ?? new Date()).toISOString();
  const receipt: InvocationReceipt = {
    schemaVersion: 3,
    conversationId: input.conversationId ?? "legacy_test_conversation",
    actionId: input.actionId,
    invocationId: input.invocationId,
    attemptKind: input.attemptKind ?? "root",
    payloadHash: input.payloadHash,
    state: "pending",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  try {
    // Atomic claim: exclusive create fails if another process already
    // reserved this identity, which is what makes the exactly-once
    // guarantee survive a Native Host restart (no in-memory port needed).
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { outcome: "claimed" };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = await readReceipt(path);
    if (
      existing.payloadHash !== input.payloadHash ||
      existing.conversationId !== (input.conversationId ?? "legacy_test_conversation") ||
      existing.actionId !== input.actionId ||
      existing.attemptKind !== (input.attemptKind ?? "root")
    ) return { outcome: "conflict" };
    return { outcome: "replay", receipt: existing };
  }
}

export async function recordInvocationOutcome(input: {
  homeDir?: string;
  actionId: string;
  invocationId: string;
  state: InvocationState;
  sessionId?: string;
  tracePath?: string;
  reason?: string;
  code?: BrowserAttemptFailureCode | BrowserLaunchRejectionCode;
  summary?: string;
  learningPack?: LearningPack;
  pageBrief?: PageBrief;
  pageAnswer?: BrowserPageAnswer;
  now?: Date;
}): Promise<void> {
  const path = receiptPath(input.homeDir, "v3", input.invocationId);
  const existing = await readReceipt(path);
  const updated: InvocationReceipt = {
    ...existing,
    state: input.state,
    updatedAt: (input.now ?? new Date()).toISOString(),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.tracePath !== undefined ? { tracePath: input.tracePath } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.learningPack !== undefined ? { learningPack: input.learningPack } : {}),
    ...(input.pageBrief !== undefined ? { pageBrief: input.pageBrief } : {}),
    ...(input.pageAnswer !== undefined ? { pageAnswer: input.pageAnswer } : {}),
  };
  await writeReceiptAtomically(path, updated);
}

export async function pruneInvocationReceipts(input: {
  homeDir?: string;
  now?: Date;
  maxAgeMs: number;
}): Promise<number> {
  const dir = receiptsDir(input.homeDir);
  const nowMs = (input.now ?? new Date()).getTime();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    const receipt = await readReceipt(path).catch(() => undefined);
    const updatedAtMs = receipt ? Date.parse(receipt.updatedAt) : NaN;
    const isStale =
      !receipt || !Number.isFinite(updatedAtMs) || nowMs - updatedAtMs > input.maxAgeMs;
    if (isStale) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function receiptsDir(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".forgelet", "browser", "invocations");
}

// invocationId is extension-supplied provenance data, never trusted as a
// filename directly; hash it before using it as a receipt path.
function receiptPath(homeDir: string | undefined, actionId: string, invocationId: string): string {
  const digest = createHash("sha256")
    .update(`${actionId}\0${invocationId}`)
    .digest("hex");
  return join(receiptsDir(homeDir), `${digest}.json`);
}

async function readReceipt(path: string): Promise<InvocationReceipt> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      throw new Error(`Invocation receipt is missing: ${path}`);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invocation receipt is corrupt (invalid JSON) at ${path}.`);
  }
  if (!isRecord(value) || value.schemaVersion !== 3 || typeof value.invocationId !== "string")
    throw new Error(`Invocation receipt is corrupt (unexpected shape) at ${path}.`);
  return value as unknown as InvocationReceipt;
}

async function writeReceiptAtomically(path: string, receipt: InvocationReceipt): Promise<void> {
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
