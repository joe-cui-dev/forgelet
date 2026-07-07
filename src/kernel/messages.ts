import type {
  AgentPlan,
  AgentSession,
  BudgetLimits,
  BudgetUsage,
  LoadedContextAttachment,
  ModelMessage,
} from "../types.js";
import type { LoadedDurableMemory } from "../memory/index.js";
import {
  formatContinuationContextForPrompt,
  type ContinuationContext,
} from "../sessions/continuation.js";
import type { WorkflowDefinition } from "./workflowDefinition.js";
import type { ActLoopRoute } from "./reactNode.js";

export function kernelCommonPromptLines(finalOnly: boolean): string[] {
  return [
    "You are running inside the Forgelet Agent Kernel.",
    "Use only the tools provided in this turn.",
    "If a tool call is denied or fails, use the observation to self-correct.",
    "When you can answer the task, return final content with no tool calls.",
    "Tool observations may be compacted into Observation Digests, and older turns may fold into a Rolling Summary paired with a Fact Ledger to keep the active context within budget.",
    "The Fact Ledger records files read with their ranges and hashes, files changed, and commands run with their outcomes; hash-unchanged ranges it already lists need not be re-read unless their content is required.",
    ...(finalOnly
      ? [
          "FINAL ANSWER ONLY: synthesize the best answer from existing evidence.",
          "Do not call or request tools, and do not emit tool-call syntax. If evidence is incomplete, state that limitation in the answer.",
        ]
      : []),
  ];
}

const CONTEXT_ATTACHMENT_PROMPT_LIMIT_BYTES = 20 * 1024;
const CONTEXT_ATTACHMENTS_PROMPT_LIMIT_BYTES = 60 * 1024;

export const buildMessages = (
  definition: WorkflowDefinition<unknown>,
  session: AgentSession,
  plan: AgentPlan,
  route: ActLoopRoute,
  continuationAttachment: LoadedContextAttachment | undefined,
  contextAttachments: LoadedContextAttachment[],
  durableMemory: LoadedDurableMemory | undefined,
  continuationContext: ContinuationContext | undefined,
  usage: BudgetUsage,
  limits: BudgetLimits,
  conversation: ModelMessage[],
  act: boolean,
  compactionStatus?: string,
  rollingSummary?: ModelMessage,
  finalOnly = false,
  finalToolTurn = false,
): ModelMessage[] => {
  const continuationSourceLines = continuationAttachment
    ? formatContextAttachmentsForPrompt(
        [continuationAttachment],
        "Continuation source",
      )
    : [];
  const contextAttachmentLines = formatContextAttachmentsForPrompt(
    contextAttachments,
    continuationAttachment
      ? "Additional context attachments"
      : "Context attachments",
  );
  const durableMemoryLines = formatDurableMemoryForPrompt(durableMemory);
  const continuationContextLines =
    formatContinuationContextForPrompt(continuationContext);
  const workflowPromptContextLines = definition.promptContextLines?.() ?? [];
  const taskLabel = definition.taskLabel?.() ?? "Task";
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: definition.systemPrompt({ act, finalOnly }),
    },
    {
      role: "user",
      content: [
        `Workflow: ${session.workflow}`,
        ...(session.workflowVariant
          ? [`Workflow variant: ${session.workflowVariant}`]
          : []),
        ...(session.creativeStyle
          ? [`Creative style: ${session.creativeStyle}`]
          : []),
        `Stage: ${route.stage}`,
        `${taskLabel}: ${session.task}`,
        "",
        ...continuationContextLines,
        ...(continuationContextLines.length > 0 ? [""] : []),
        ...workflowPromptContextLines,
        ...(workflowPromptContextLines.length > 0 ? [""] : []),
        ...continuationSourceLines,
        ...(continuationSourceLines.length > 0 ? [""] : []),
        ...contextAttachmentLines,
        ...(contextAttachmentLines.length > 0 ? [""] : []),
        ...durableMemoryLines,
        ...(durableMemoryLines.length > 0 ? [""] : []),
        "Current plan:",
        ...plan.items.map((item) => `- ${item.status}: ${item.step}`),
        "",
        `Budget: ${usage.modelTurns}/${limits.maxModelTurns} model turns, $${usage.estimatedCostUsd.toFixed(4)}/$${limits.maxEstimatedCostUsd.toFixed(4)} estimated.`,
        ...(compactionStatus ? [compactionStatus] : []),
        ...(finalToolTurn
          ? [
              "This is the final tool-capable turn. Request only operations still required to finish.",
            ]
          : []),
        ...(finalOnly
          ? [
              "This is the reserved final answer turn. No tools are available.",
              "Return a non-empty final answer from existing evidence. Do not request tools or emit tool-call syntax.",
            ]
          : []),
      ].join("\n"),
    },
  ];

  if (rollingSummary) messages.push(rollingSummary);
  messages.push(
    ...(finalOnly ? conversationForFinalAnswer(conversation) : conversation),
  );
  return messages;
};

const conversationForFinalAnswer = (
  conversation: ModelMessage[],
): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  for (const message of conversation) {
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: `Earlier tool observation:\n${message.content}`,
      });
      continue;
    }
    if (message.role === "assistant" && message.content.trim()) {
      messages.push({ role: "assistant", content: message.content });
    }
  }
  return messages;
};

const formatDurableMemoryForPrompt = (
  durableMemory: LoadedDurableMemory | undefined,
): string[] => {
  if (!durableMemory) return [];
  return [
    "Accepted Durable Memory:",
    `- path: ${durableMemory.path}`,
    `  contentHash: ${durableMemory.contentHash}`,
    `  contentBytes: ${durableMemory.contentBytes}`,
    `  returnedBytes: ${durableMemory.returnedBytes}`,
    `  truncated: ${durableMemory.truncated}`,
    "  content:",
    "  ```",
    indentPromptContent(
      durableMemory.truncated
        ? `${durableMemory.content}\n[truncated: showing ${durableMemory.returnedBytes} of ${durableMemory.contentBytes} bytes]`
        : durableMemory.content,
    ),
    "  ```",
  ];
};

const formatContextAttachmentsForPrompt = (
  attachments: LoadedContextAttachment[],
  title: string,
): string[] => {
  if (attachments.length === 0) return [];

  const lines = [`${title}:`];
  let remainingBudget = CONTEXT_ATTACHMENTS_PROMPT_LIMIT_BYTES;

  attachments.forEach(({ attachment, content }) => {
    const contentBytes = Buffer.byteLength(content, "utf8");
    const returnedBytes = Math.min(
      contentBytes,
      CONTEXT_ATTACHMENT_PROMPT_LIMIT_BYTES,
      remainingBudget,
    );
    const rendered = Buffer.from(content, "utf8")
      .subarray(0, returnedBytes)
      .toString("utf8");
    const truncated = returnedBytes < contentBytes;
    remainingBudget -= returnedBytes;

    const attachmentLines = [
      `- id: ${attachment.id}`,
      `  source: ${attachment.source}`,
      `  title: ${attachment.title ?? "(untitled)"}`,
      `  mimeType: ${attachment.mimeType}`,
      `  contentHash: ${attachment.contentHash}`,
      `  contentBytes: ${attachment.contentBytes}`,
      `  returnedBytes: ${returnedBytes}`,
      `  truncated: ${truncated}`,
      "  content:",
      "  ```",
      indentPromptContent(
        truncated
          ? `${rendered}\n[truncated: showing ${returnedBytes} of ${contentBytes} bytes]`
          : rendered,
      ),
      "  ```",
    ];
    if (attachment.uri)
      attachmentLines.splice(3, 0, `  uri: ${attachment.uri}`);
    lines.push(...attachmentLines);
  });

  return lines;
};

const indentPromptContent = (content: string): string =>
  content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
