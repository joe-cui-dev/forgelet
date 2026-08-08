import { createHash } from "node:crypto";
import { loadContextAttachments } from "../context/index.js";
import { runKernelSession } from "../kernel/session.js";
import { kernelCommonPromptLines } from "../kernel/messages.js";
import type {
  KernelSessionResult,
  RunKernelSessionInput,
  WorkflowDefinition,
} from "../kernel/workflowDefinition.js";
import type { ContextAttachment, LoadedContextAttachment, ModelClient } from "../types.js";
import type { FrictionSignal } from "../memory/frictionSignal.js";

/** The Anchor Files a Retrospective Session compares candidates against, so a
 * suggestion that merely restates already-declared guidance is dropped
 * (ADR 0075). The current Durable Memory is injected separately by the Kernel. */
export const RETROSPECTIVE_ANCHOR_FILES = [
  "AGENTS.md",
  "CONTEXT.md",
  "README.md",
  "package.json",
] as const;

/** The parsed output of a Retrospective Session: zero or more single-bullet
 * Memory Suggestions, each future-facing guidance for a later Session. */
export interface RetrospectiveSuggestions {
  suggestions: string[];
}

export type RetrospectiveSessionResult = KernelSessionResult<RetrospectiveSuggestions>;

/** The sentinel a Retrospective Session emits when the examined Session
 * discovered nothing worth remembering. */
export const RETROSPECTIVE_NONE_SENTINEL = "NONE";

export interface RetrospectiveSessionInput {
  workspaceRoot: string;
  modelClient: ModelClient;
  /** The finished Session being examined. */
  sourceSessionId: string;
  /** The raw Trace bytes of the source Session, attached as audited source
   * material (ADR 0069 denies reading `.forgelet` with tools). */
  sourceTraceContent: string;
  /** The Friction Signals WP1 found, given to the model as where to look. */
  frictionSignals: FrictionSignal[];
  /** Anchor Files that exist in this workspace; defaults are filtered by the
   * caller so a missing file never fails the launch. */
  anchorFiles?: string[];
  homeDir?: string;
  debug?: boolean;
  budgetUsd?: number;
  now?: RunKernelSessionInput["now"];
  signal?: AbortSignal;
}

/** Runs a Retrospective Session: a single `answer_once` model turn, no tools,
 * no workspace read. It examines one finished Session's Trace against the
 * Anchor Files and the current Durable Memory and proposes 0..N discovered
 * conventions (ADR 0075). */
export function runRetrospectiveSession(
  input: RetrospectiveSessionInput,
): Promise<RetrospectiveSessionResult> {
  return runKernelSession<RetrospectiveSuggestions>({
    task: retrospectiveTask(input.sourceSessionId),
    contextFiles: input.anchorFiles ?? [...RETROSPECTIVE_ANCHOR_FILES],
    workspaceRoot: input.workspaceRoot,
    modelClient: input.modelClient,
    homeDir: input.homeDir,
    debug: input.debug,
    budgetUsd: input.budgetUsd,
    now: input.now,
    signal: input.signal,
    executionPolicy: "answer_once",
    definition: createRetrospectiveWorkflowDefinition({
      sourceSessionId: input.sourceSessionId,
      sourceTraceContent: input.sourceTraceContent,
      frictionSignals: input.frictionSignals,
    }),
  });
}

export interface RetrospectiveWorkflowInput {
  sourceSessionId: string;
  sourceTraceContent: string;
  frictionSignals: FrictionSignal[];
}

export function createRetrospectiveWorkflowDefinition(
  input: RetrospectiveWorkflowInput,
): WorkflowDefinition<RetrospectiveSuggestions> {
  return {
    kind: "retrospective",
    async loadAttachments({ workspaceRoot, contextFiles, sourceLedger }) {
      const anchors = await loadContextAttachments(workspaceRoot, contextFiles, {
        sourceLedger,
      });
      const traceAttachment = buildTraceAttachment(
        sourceLedger.nextContextId(),
        input.sourceSessionId,
        input.sourceTraceContent,
      );
      sourceLedger.append(traceAttachment);
      return { contextAttachments: [...anchors, traceAttachment] };
    },
    capabilities() {
      return ["read_context", "model_generate_text"];
    },
    offersTools() {
      return false;
    },
    systemPrompt() {
      return [
        ...kernelCommonPromptLines(),
        "This is a Retrospective Workflow Session.",
        "You examine exactly one finished Session's Trace, attached below as the last Context Attachment, to propose Durable Memory suggestions for later Sessions in this same workspace.",
        "You have no tools and cannot read the workspace; work only from the attachments and the Durable Memory shown to you.",
        "A good suggestion is a convention this Session discovered — a way this workspace actually works — that a later Session would benefit from knowing.",
        "Look where the Friction Signals point: a Tool Observation that failed, or a permission decision that denied or required confirmation, is where an expectation met the workspace and lost.",
        "Compare every candidate against the Anchor Files (AGENTS.md, CONTEXT.md, README.md, package.json) and the current Durable Memory. Drop any candidate that merely restates guidance those already give.",
        "Write each suggestion as future-facing guidance for a later Session, phrased for this workspace, for example \"In this workspace, X is done with Y.\"",
        "Do not propose one-off task facts, secrets, file contents, or anything specific to this Session's particular request; propose only durable conventions.",
        `Output format: one suggestion per line, each line starting with "- ", each one to three sentences. Emit no headings, preamble, or commentary.`,
        `If this Session discovered nothing worth remembering, output exactly ${RETROSPECTIVE_NONE_SENTINEL} and nothing else.`,
      ].join("\n");
    },
    promptContextLines() {
      return formatFrictionSignalsForPrompt(input.frictionSignals);
    },
    normalizeFinalContent(content) {
      return formatRetrospectiveMarkdown(parseSuggestionLines(content));
    },
    async onCompleted({ finalContent }) {
      return {
        finalSummaryTraceExtras: { finalContent },
        completion: { suggestions: parseSuggestionLines(finalContent) },
      };
    },
  };
}

function retrospectiveTask(sourceSessionId: string): string {
  return `Derive Durable Memory suggestions from the finished Session ${sourceSessionId}.`;
}

/** Renders the Friction Signals as a dedicated prompt block, distinct from the
 * attached Trace, telling the model where the examined Session hit a wall. */
export function formatFrictionSignalsForPrompt(signals: FrictionSignal[]): string[] {
  if (signals.length === 0) return [];
  const lines = ["Friction Signals found in this Session (where to look first):"];
  signals.forEach((signal, index) => {
    if (signal.kind === "tool_failure") {
      lines.push(
        `${index + 1}. Failed tool ${signal.toolName}` +
          (signal.path ? ` on ${signal.path}` : "") +
          (signal.errorCode ? ` [${signal.errorCode}]` : "") +
          (signal.error ? `: ${signal.error}` : ""),
      );
    } else {
      lines.push(
        `${index + 1}. Permission ${signal.decision}` +
          (signal.toolName ? ` for ${signal.toolName}` : "") +
          (signal.capability ? ` (${signal.capability})` : "") +
          (signal.reason ? `: ${signal.reason}` : ""),
      );
    }
  });
  return lines;
}

/** Parses the model's bullet output into individual suggestions, dropping the
 * NONE sentinel and any empty or heading lines. */
export function parseSuggestionLines(content: string): string[] {
  const suggestions: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (!bulletMatch) continue;
    const text = bulletMatch[1]?.trim() ?? "";
    if (text.length === 0) continue;
    if (text === RETROSPECTIVE_NONE_SENTINEL) continue;
    suggestions.push(text);
  }
  return suggestions;
}

function formatRetrospectiveMarkdown(suggestions: string[]): string {
  if (suggestions.length === 0) return RETROSPECTIVE_NONE_SENTINEL;
  return suggestions.map((suggestion) => `- ${suggestion}`).join("\n");
}

function buildTraceAttachment(
  id: string,
  sourceSessionId: string,
  content: string,
): LoadedContextAttachment {
  const attachment: ContextAttachment = {
    id,
    source: "file",
    title: `${sourceSessionId} Session Trace`,
    uri: `.forgelet/sessions/${sourceSessionId}.jsonl`,
    mimeType: "application/json",
    contentBytes: Buffer.byteLength(content, "utf8"),
    contentHash: createHash("sha256").update(content).digest("hex"),
    preview: makePreview(content),
    trustLevel: "workspace",
  };
  return { attachment, content };
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
