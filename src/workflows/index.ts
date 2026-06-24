import type {
  AgentPlan,
  AgentSession,
  BudgetLimits,
  BudgetUsage,
  Capability,
  LoadedContextAttachment,
  ModelClient,
  ModelMessage,
  ModelToolCall,
  SessionFinishStatus,
  SessionStopReason,
  SessionAudit,
  ToolObservation,
  TraceEvent,
  WorkflowKind,
} from "../types.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig, routeModel } from "../config/index.js";
import { loadContextAttachments } from "../context/index.js";
import { compactConversationInPlace } from "../conversation/compaction.js";
import { loadDurableMemory, type LoadedDurableMemory } from "../memory/index.js";
import { createTraceWriter } from "../trace/index.js";
import { createActionableCodingTools } from "../tools/actionable.js";
import { createReadOnlyTools } from "../tools/readOnly.js";
import {
  createToolRegistry,
  type ApprovalHandler,
  type ToolRegistry,
} from "../tools/toolRegistry.js";

export interface RunWorkflowInput {
  workflow: WorkflowKind;
  task: string;
  contextFiles: string[];
  model?: string;
  budgetUsd?: number;
  homeDir?: string;
  workspaceRoot: string;
  modelClient?: ModelClient;
  act?: boolean;
  approvalHandler?: ApprovalHandler;
}

export interface RunWorkflowResult {
  session: AgentSession;
  summary: string;
  tracePath: string;
}

interface ActLoopRoute {
  workflow: WorkflowKind;
  stage: "act_loop";
  model: string;
  reason: string;
}

interface RunReadOnlyLoopInput {
  modelClient: ModelClient;
  session: AgentSession;
  contextAttachments: LoadedContextAttachment[];
  durableMemory?: LoadedDurableMemory;
  workspaceRoot: string;
  route: ActLoopRoute;
  plan: AgentPlan;
  limits: BudgetLimits;
  safeCommands: string[];
  commandTimeoutMs: number;
  maxPatchBytes: number;
  maxObservationBytes: number;
  act: boolean;
  baselineDirtyPaths: Set<string>;
  tracePath: string;
  approvalHandler?: ApprovalHandler;
  appendTrace(type: string, payload: Record<string, unknown>): Promise<void>;
}

interface RunReadOnlyLoopResult {
  status: SessionFinishStatus;
  reason?: SessionStopReason;
  summary: string;
  audit?: SessionAudit;
}

interface BudgetBlockedToolCalls {
  reason: SessionStopReason;
  skippedCount: number;
}

interface RunAuditState {
  changedFiles: Set<string>;
  commands: { command: string; exitCode: number | null; timedOut: boolean }[];
}

const CONTEXT_ATTACHMENT_PROMPT_LIMIT_BYTES = 20 * 1024;
const CONTEXT_ATTACHMENTS_PROMPT_LIMIT_BYTES = 60 * 1024;

/**
 * Runs a Forgelet workflow session with the given input, returning the final
 * session state and a human-readable summary. The workflow graph is executed in
 * a read-only mode: the model can call tools to inspect context and update its
 * plan, but cannot perform any actions that would change the system state.
 */
export const runWorkflowSession = async (
  input: RunWorkflowInput,
): Promise<RunWorkflowResult> => {
  const now = new Date().toISOString();
  const sessionId = `sess_${Date.now().toString(36)}`;
  const taskHash = hashTask(input.task);
  const traceWriter = await createTraceWriter(input.workspaceRoot, sessionId);
  const config = await loadConfig({
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  const baselineDirtyPaths =
    input.act && input.workflow === "coding"
      ? await gitStatusPaths(input.workspaceRoot)
      : new Set<string>();
  const contextAttachments = await loadContextAttachments(
    input.workspaceRoot,
    input.contextFiles,
  );
  const durableMemory = input.modelClient
    ? await loadDurableMemory(input.workspaceRoot)
    : undefined;
  const route = selectRoute(
    input.workflow,
    routeModel(config, input.workflow, input.model),
  );
  const plan: AgentPlan = {
    items: [
      { step: "Create session and load task context", status: "completed" },
      { step: "Run workflow graph with model and tools", status: "pending" },
    ],
  };

  const session: AgentSession = {
    id: sessionId,
    workflow: input.workflow,
    task: input.task,
    taskHash,
    stage: "final",
    plan,
    createdAt: now,
  };

  await traceWriter.append(
    createTraceEvent(sessionId, "session_started", now, {
      workflow: input.workflow,
      startedAt: now,
      taskHash,
    }),
  );
  await traceWriter.append(
    createTraceEvent(sessionId, "user_task", now, { task: input.task }),
  );
  for (const contextAttachment of contextAttachments) {
    await traceWriter.append(
      createTraceEvent(
        sessionId,
        "context_attachment",
        now,
        contextAttachment.attachment as unknown as Record<string, unknown>,
      ),
    );
  }
  if (durableMemory)
    await traceWriter.append(
      createTraceEvent(sessionId, "memory_loaded", now, {
        path: durableMemory.path,
        contentBytes: durableMemory.contentBytes,
        returnedBytes: durableMemory.returnedBytes,
        contentHash: durableMemory.contentHash,
        preview: durableMemory.preview,
        truncated: durableMemory.truncated,
      }),
    );
  await traceWriter.append(
    createTraceEvent(sessionId, "routing_selected", now, { ...route }),
  );
  if (input.act && input.workflow === "coding")
    await traceWriter.append(
      createTraceEvent(sessionId, "workspace_baseline", now, {
        dirtyPaths: [...baselineDirtyPaths],
      }),
    );
  await traceWriter.append(
    createTraceEvent(sessionId, "plan_update", now, { plan }),
  );

  // Real model execution is opt-in for now so the CLI scaffold keeps its
  // current behavior until a provider is wired into the command path.
  if (input.modelClient) {
    const execution = await runReadOnlyLoop({
      modelClient: input.modelClient,
      session,
      contextAttachments,
      durableMemory,
      workspaceRoot: input.workspaceRoot,
      route,
      plan,
      limits: {
        ...config.budgets,
        maxEstimatedCostUsd:
          input.budgetUsd ?? config.budgets.maxEstimatedCostUsd,
      },
      safeCommands: config.safeCommands,
      commandTimeoutMs: config.commandTimeoutMs,
      maxPatchBytes: config.maxPatchBytes,
      maxObservationBytes: config.activeContext.maxObservationBytes,
      act: input.act === true && input.workflow === "coding",
      baselineDirtyPaths,
      tracePath: traceWriter.tracePath,
      approvalHandler: input.approvalHandler,
      appendTrace: (type, payload) =>
        traceWriter.append(
          createTraceEvent(sessionId, type, new Date().toISOString(), payload),
        ),
    });

    await traceWriter.append(
      createTraceEvent(sessionId, "final_summary", new Date().toISOString(), {
        summary: withTracePath(execution.summary, traceWriter.tracePath),
        ...(execution.audit ? { audit: execution.audit } : {}),
      }),
    );
    await traceWriter.append(
      createTraceEvent(
        sessionId,
        "session_finished",
        new Date().toISOString(),
        {
          status: execution.status,
          reason: execution.reason,
          finishedAt: new Date().toISOString(),
        },
      ),
    );

    return {
      session,
      summary: withTracePath(execution.summary, traceWriter.tracePath),
      tracePath: traceWriter.tracePath,
    };
  }

  await traceWriter.append(
    createTraceEvent(sessionId, "final_summary", now, {
      summary: "Execution is scaffolded; no model turn was run.",
    }),
  );
  await traceWriter.append(
    createTraceEvent(sessionId, "session_finished", now, {
      status: "completed",
      finishedAt: now,
    }),
  );

  const details = [
    `Forgelet session created: ${sessionId}`,
    `Workflow: ${input.workflow}`,
    `Task: ${input.task}`,
    `Task hash: ${taskHash}`,
    input.contextFiles.length > 0
      ? `Context attachments: ${input.contextFiles.join(", ")}`
      : "Context attachments: none",
    `Route: ${route.model} (${route.reason})`,
    "Execution: scaffold only; no model turn was run.",
    `Trace: ${traceWriter.tracePath}`,
  ];

  return {
    session,
    summary: details.join("\n"),
    tracePath: traceWriter.tracePath,
  };
};

const hashTask = (task: string): string => {
  const normalized = task.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
};

/**
 * Selects the model and reason for the given workflow and routing decision to
 * determine the route through the workflow graph. The route is used for
 * traceability and to inform the model prompt, but does not affect tool access
 * in this read-only execution mode.
 */
const selectRoute = (
  workflow: WorkflowKind,
  selected: { model: string; reason: string },
): ActLoopRoute => {
  return {
    workflow,
    stage: "act_loop",
    model: selected.model,
    reason: selected.reason,
  };
};

const createTraceEvent = (
  sessionId: string,
  type: string,
  ts: string,
  payload: Record<string, unknown>,
): TraceEvent => {
  return { type, ts, sessionId, payload };
};

/** Runs the core act loop of the workflow graph, where the model generates text
 * and calls tools in a loop until it returns final content with no tool calls, or
 * a budget limit is exceeded. The model can only call tools that are consistent
 * with the workflow's capability grants, and all tool calls are checked and
 * logged by the kernel for traceability and security.
 */
const runReadOnlyLoop = async (
  input: RunReadOnlyLoopInput,
): Promise<RunReadOnlyLoopResult> => {
  const usage: BudgetUsage = {
    modelTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
  const grantedCapabilities = workflowCapabilities(
    input.session.workflow,
    input.act,
  );
  const actionableTools =
    input.act && input.session.workflow === "coding"
      ? createActionableCodingTools({
          safeCommands: input.safeCommands,
          commandTimeoutMs: input.commandTimeoutMs,
          maxPatchBytes: input.maxPatchBytes,
          sessionState: {
            baselineDirtyPaths: input.baselineDirtyPaths,
            forgeletTouchedPaths: new Set(),
          },
        })
      : [];
  const toolRegistry = createToolRegistry(
    [...createReadOnlyTools(input.plan), ...actionableTools],
    { approvalHandler: input.approvalHandler },
  );
  const tools = toolRegistry.listTools(grantedCapabilities);
  const conversation: ModelMessage[] = [];
  const audit: RunAuditState = {
    changedFiles: new Set(),
    commands: [],
  };
  let finalContent = "";

  for (let turnIndex = 0; ; turnIndex += 1) {
    const stopReason = budgetStopReason(usage, input.limits);
    if (stopReason) {
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        stopReason,
        input.limits,
      );
      input.session.stage = "final";
      return { status: "stopped", reason: stopReason, summary };
    }

    const compaction = compactConversationInPlace(conversation, {
      maxObservationBytes: input.maxObservationBytes,
    });
    if (
      compaction.compactedCount > 0 ||
      compaction.beforeObservationBytes > compaction.targetObservationBytes
    )
      await input.appendTrace(
        compaction.compactedCount > 0
          ? "conversation_compacted"
          : "conversation_compaction_attempted",
        { ...compaction },
      );

    const output = await input.modelClient.createTurn({
      task: input.session.task,
      messages: buildMessages(
        input.session,
        input.plan,
        input.route,
        input.contextAttachments,
        input.durableMemory,
        usage,
        input.limits,
        conversation,
        input.act,
        compaction.compactedCount > 0
          ? `Active observations compacted: ${compaction.afterObservationBytes}/${compaction.targetObservationBytes} bytes.`
          : undefined,
      ),
      tools,
    });

    usage.modelTurns += 1;
    usage.inputTokens += output.usage?.inputTokens ?? 0;
    usage.outputTokens += output.usage?.outputTokens ?? 0;
    usage.estimatedCostUsd += output.usage?.estimatedCostUsd ?? 0;

    await input.appendTrace("model_turn", {
      turnIndex,
      model: input.route.model,
      contentPreview: output.content?.slice(0, 500),
      toolCalls: output.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
      })),
      usage: output.usage,
    });
    await input.appendTrace("budget_update", { usage, limits: input.limits });

    const hardBudgetStopReason = tokenOrCostBudgetStopReason(
      usage,
      input.limits,
    );
    if (hardBudgetStopReason && output.toolCalls.length > 0) {
      await input.appendTrace("budget_blocked_tool_calls", {
        reason: hardBudgetStopReason,
        skippedCount: output.toolCalls.length,
        toolNames: output.toolCalls.map((toolCall) => toolCall.name),
      });
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        hardBudgetStopReason,
        input.limits,
        { reason: hardBudgetStopReason, skippedCount: output.toolCalls.length },
      );
      input.session.stage = "final";
      return {
        status: "stopped",
        reason: hardBudgetStopReason,
        summary,
      };
    }

    // No tool calls is the loop exit condition: model content becomes the
    // Session's final answer.
    if (output.toolCalls.length === 0) {
      finalContent = normalizeFinalContentForWorkflow(
        input.session.workflow,
        output.content ?? "",
      );
      input.plan.items = input.plan.items.map((item) => ({
        ...item,
        status: "completed",
      }));
      input.session.stage = "final";
      const sessionAudit = input.act
        ? await buildSessionAudit(input, usage, audit)
        : undefined;
      return {
        status: "completed",
        summary: formatCompletedSummary(
          input.session,
          input.route,
          finalContent,
          usage,
          sessionAudit,
        ),
        audit: sessionAudit,
      };
    }

    conversation.push({
      role: "assistant",
      content: output.content ?? "",
      toolCalls: output.toolCalls,
    });
    for (const toolCall of output.toolCalls) {
      const observation = await executeToolCall({
        toolCall,
        toolRegistry,
        session: input.session,
        workspaceRoot: input.workspaceRoot,
        grantedCapabilities,
        appendTrace: input.appendTrace,
      });
      recordAuditObservation(audit, observation);
      conversation.push({
        role: "tool",
        toolCallId: observation.toolCallId,
        content: JSON.stringify(observationForModel(observation)),
      });
    }
  }
};

const recordAuditObservation = (
  audit: RunAuditState,
  observation: ToolObservation,
): void => {
  if (observation.toolName === "apply_patch" && observation.ok)
    observation.metadata.changedFiles?.forEach((path) =>
      audit.changedFiles.add(path),
    );
  if (observation.toolName === "run_command")
    audit.commands.push({
      command: observation.metadata.command ?? observation.toolName,
      exitCode: observation.metadata.exitCode ?? null,
      timedOut: observation.metadata.timedOut === true,
    });
};

const buildSessionAudit = async (
  input: RunReadOnlyLoopInput,
  usage: BudgetUsage,
  audit: RunAuditState,
): Promise<SessionAudit> => {
  const finalDirtyPaths = await gitStatusPaths(input.workspaceRoot);
  const forgeletChanged = [...audit.changedFiles].sort();
  const preExistingAtSessionStart = [...input.baselineDirtyPaths].sort();
  const otherCurrentWorkspaceChanges = [...finalDirtyPaths]
    .filter(
      (path) =>
        !audit.changedFiles.has(path) && !input.baselineDirtyPaths.has(path),
    )
    .sort();
  const verificationCommands = audit.commands.map((command) => ({
    command: command.command,
    exitCode: command.exitCode,
    timedOut: command.timedOut,
  }));

  return {
    changeGroups: {
      forgeletChanged,
      preExistingAtSessionStart,
      otherCurrentWorkspaceChanges,
    },
    verificationCommands,
    kernelObservedRisks: [
      ...verificationCommands
        .filter((command) => command.timedOut || command.exitCode !== 0)
        .map((command) => ({
          kind: "verification_failed" as const,
          message: command.timedOut
            ? `Verification command timed out: ${command.command}.`
            : `Verification command failed: ${command.command} (exit ${command.exitCode}).`,
          command: command.command,
          exitCode: command.exitCode,
          timedOut: command.timedOut,
        })),
      ...(forgeletChanged.length > 0 && verificationCommands.length === 0
        ? [
            {
              kind: "verification_missing" as const,
              message:
                "No verification command was run for the Forgelet changes.",
            },
          ]
        : []),
      ...(preExistingAtSessionStart.length > 0
        ? [
            {
              kind: "pre_existing_workspace_changes" as const,
              message:
                "Pre-existing workspace changes were present at Session start.",
              paths: preExistingAtSessionStart,
            },
          ]
        : []),
      ...(otherCurrentWorkspaceChanges.length > 0
        ? [
            {
              kind: "other_workspace_changes" as const,
              message:
                "Workspace has current changes not attributed to Forgelet.",
              paths: otherCurrentWorkspaceChanges,
            },
          ]
        : []),
    ],
    modelTurns: usage.modelTurns,
    estimatedCostUsd: usage.estimatedCostUsd,
    tracePath: input.tracePath,
  };
};

/** The tool execution flow enforces capability grants and appends trace events
 * for all decisions and results. Tool calls that are denied or unknown are not
 * thrown as errors, but returned as observations for the model to self-correct.
 */
const executeToolCall = async (input: {
  toolCall: ModelToolCall;
  toolRegistry: ToolRegistry;
  session: AgentSession;
  workspaceRoot: string;
  grantedCapabilities: Capability[];
  appendTrace(type: string, payload: Record<string, unknown>): Promise<void>;
}): Promise<ToolObservation> => {
  await input.appendTrace("tool_call", {
    id: input.toolCall.id,
    name: input.toolCall.name,
    input: input.toolCall.input,
  });
  const execution = await input.toolRegistry.execute(input.toolCall, {
    workspaceRoot: input.workspaceRoot,
    sessionId: input.session.id,
    workflow: input.session.workflow,
    grantedCapabilities: input.grantedCapabilities,
  });
  await input.appendTrace("permission_decision", {
    toolCallId: input.toolCall.id,
    toolName: input.toolCall.name,
    capability: execution.capability,
    decision: execution.permissionDecision.kind,
    riskTier: execution.permissionDecision.riskTier,
    reason: execution.permissionDecision.reason,
  });
  if (execution.approvalDecision)
    await input.appendTrace("approval_decision", {
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      status: execution.approvalDecision.status,
      reason: execution.approvalDecision.reason,
      fullPatchShown: execution.approvalDecision.fullPatchShown,
    });
  await input.appendTrace(
    "tool_result",
    traceToolObservation(execution.observation),
  );
  // Plan changes are trace-worthy Session state, not just tool output.
  if (execution.observation.ok && input.toolCall.name === "update_plan")
    await input.appendTrace("plan_update", { plan: input.session.plan });
  return execution.observation;
};

const workflowCapabilities = (
  workflow: WorkflowKind,
  act: boolean,
): Capability[] => {
  if (workflow === "coding")
    return [
      "read_context",
      "read_workspace",
      "git_read",
      "update_plan",
      "model_generate_text",
      ...(act ? (["write_workspace", "run_safe_command"] as const) : []),
    ];
  return ["read_context", "update_plan", "model_generate_text"];
};

const gitStatusPaths = (workspaceRoot: string): Promise<Set<string>> => {
  return new Promise((resolvePaths) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd: workspaceRoot },
      (error, stdout) => {
        if (error) {
          resolvePaths(new Set());
          return;
        }
        resolvePaths(
          new Set(
            stdout
              .split("\n")
              .map((line) => line.slice(3).trim())
              .filter((path) => !isInternalSessionTracePath(path))
              .filter(Boolean),
          ),
        );
      },
    );
  });
};

const isInternalSessionTracePath = (path: string): boolean =>
  path === ".forgelet/sessions" || path.startsWith(".forgelet/sessions/");

const budgetStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
): SessionStopReason | undefined => {
  if (usage.modelTurns >= limits.maxModelTurns) return "max_model_turns";
  return tokenOrCostBudgetStopReason(usage, limits);
};

const tokenOrCostBudgetStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
): SessionStopReason | undefined => {
  if (usage.inputTokens >= limits.maxInputTokens)
    return "input_token_limit_exceeded";
  if (usage.estimatedCostUsd >= limits.maxEstimatedCostUsd)
    return "estimated_cost_budget_exceeded";
  return undefined;
};

const buildMessages = (
  session: AgentSession,
  plan: AgentPlan,
  route: ActLoopRoute,
  contextAttachments: LoadedContextAttachment[],
  durableMemory: LoadedDurableMemory | undefined,
  usage: BudgetUsage,
  limits: BudgetLimits,
  conversation: ModelMessage[],
  act: boolean,
  compactionStatus?: string,
): ModelMessage[] => {
  const contextAttachmentLines =
    formatContextAttachmentsForPrompt(contextAttachments);
  const durableMemoryLines = formatDurableMemoryForPrompt(durableMemory);
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: systemPromptFor(session.workflow, act),
    },
    {
      role: "user",
      content: [
        `Workflow: ${session.workflow}`,
        `Stage: ${route.stage}`,
        `Task: ${session.task}`,
        "",
        ...contextAttachmentLines,
        ...(contextAttachmentLines.length > 0 ? [""] : []),
        ...durableMemoryLines,
        ...(durableMemoryLines.length > 0 ? [""] : []),
        "Current plan:",
        ...plan.items.map((item) => `- ${item.status}: ${item.step}`),
        "",
        `Budget: ${usage.modelTurns}/${limits.maxModelTurns} model turns, $${usage.estimatedCostUsd.toFixed(4)}/$${limits.maxEstimatedCostUsd.toFixed(4)} estimated.`,
        ...(compactionStatus ? [compactionStatus] : []),
      ].join("\n"),
    },
  ];

  messages.push(...conversation);
  return messages;
};

const normalizeFinalContentForWorkflow = (
  workflow: WorkflowKind,
  content: string,
): string => {
  if (workflow !== "writing") return content;
  if (
    hasMarkdownHeading(content, "Critique") &&
    hasMarkdownHeading(content, "Revision") &&
    hasMarkdownHeading(content, "Notes")
  )
    return content;
  return [
    "Critique",
    "No separate critique was provided by the model.",
    "",
    "Revision",
    content.trim() || "(empty)",
    "",
    "Notes",
    "No additional notes were provided.",
  ].join("\n");
};

const hasMarkdownHeading = (content: string, heading: string): boolean => {
  return new RegExp(`(^|\\n)#{0,6}\\s*${heading}\\s*(\\n|$)`, "i").test(
    content,
  );
};

const systemPromptFor = (workflow: WorkflowKind, act: boolean): string => {
  const common = [
    "You are running inside the Forgelet Agent Kernel.",
    "Use only the tools provided in this turn.",
    "If a tool call is denied or fails, use the observation to self-correct.",
    "When you can answer the task, return final content with no tool calls.",
  ];
  if (workflow === "coding" && act)
    return [
      ...common,
      "This is an actionable Coding Workflow Session.",
      "You may request apply_patch and run_command only when those tools are provided.",
      "Every file edit or command must pass Forgelet permission and approval boundaries before it runs.",
      "Do not claim verification succeeded unless a run_command observation shows the command ran successfully.",
    ].join("\n");
  if (workflow === "coding")
    return [
      ...common,
      "This is a read-only Coding Workflow Session.",
      "Read-only tools may inspect workspace content; do not claim to write files or run commands.",
    ].join("\n");
  return [
    ...common,
    "This is a Writing Workflow Session.",
    "Use the provided context and Durable Memory, but do not request workspace, git, shell, patch, or command tools.",
    "Return the final answer with these headings: Critique, Revision, Notes.",
  ].join("\n");
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
): string[] => {
  if (attachments.length === 0) return [];

  const lines = ["Context attachments:"];
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
    if (attachment.uri) attachmentLines.splice(3, 0, `  uri: ${attachment.uri}`);
    lines.push(...attachmentLines);
  });

  return lines;
};

const indentPromptContent = (content: string): string =>
  content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

const observationForModel = (
  observation: ToolObservation,
): Record<string, unknown> => {
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    content: observation.content,
    error: observation.error,
    metadata: observation.metadata,
  };
};

const traceToolObservation = (
  observation: ToolObservation,
): Record<string, unknown> => {
  // Trace payloads intentionally omit `content`; full read-only results should
  // only live in the active model observation.
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    error: observation.error,
    path: observation.metadata.path,
    truncated: observation.metadata.truncated,
    totalBytes: observation.metadata.totalBytes,
    returnedBytes: observation.metadata.returnedBytes,
    contentHash: observation.metadata.contentHash,
    rangeKind: observation.metadata.rangeKind,
    offsetBytes: observation.metadata.offsetBytes,
    limitBytes: observation.metadata.limitBytes,
    startLine: observation.metadata.startLine,
    lineCount: observation.metadata.lineCount,
    tailLines: observation.metadata.tailLines,
    returnedStartByte: observation.metadata.returnedStartByte,
    returnedEndByte: observation.metadata.returnedEndByte,
    returnedStartLine: observation.metadata.returnedStartLine,
    returnedEndLine: observation.metadata.returnedEndLine,
    nextOffsetBytes: observation.metadata.nextOffsetBytes,
    preview: observation.metadata.preview,
    changedFiles: observation.metadata.changedFiles,
    command: observation.metadata.command,
    exitCode: observation.metadata.exitCode,
    durationMs: observation.metadata.durationMs,
    timedOut: observation.metadata.timedOut,
  };
};

const formatCompletedSummary = (
  session: AgentSession,
  route: ActLoopRoute,
  finalContent: string,
  usage: BudgetUsage,
  audit?: SessionAudit,
): string => {
  return [
    `Forgelet session completed: ${session.id}`,
    `Workflow: ${session.workflow}`,
    `Task: ${session.task}`,
    `Task hash: ${session.taskHash}`,
    `Route: ${route.model} (${route.reason})`,
    `Model turns: ${usage.modelTurns}`,
    finalContent,
    ...(audit ? [formatAuditFooter(audit)] : []),
  ].join("\n");
};

const formatAuditFooter = (audit: SessionAudit): string => {
  return [
    "",
    "Audit:",
    `Forgelet changed: ${formatList(audit.changeGroups.forgeletChanged)}`,
    `Pre-existing at Session start: ${formatList(audit.changeGroups.preExistingAtSessionStart)}`,
    `Other current workspace changes: ${formatList(audit.changeGroups.otherCurrentWorkspaceChanges)}`,
    audit.verificationCommands.length > 0
      ? "Verification commands:"
      : "Verification commands: none",
    ...audit.verificationCommands.map(
      (command) =>
        `- Command: ${command.command} (${command.timedOut ? "timed out" : `exit ${command.exitCode}`})`,
    ),
    audit.kernelObservedRisks.length > 0
      ? "Remaining risks:"
      : "Remaining risks: none",
    ...audit.kernelObservedRisks.map((risk) => `- ${risk.message}`),
  ].join("\n");
};

const formatList = (items: string[]): string =>
  items.length > 0 ? items.join(", ") : "none";

const withTracePath = (summary: string, tracePath: string): string => {
  return summary.includes("\nTrace: ")
    ? summary
    : [summary, `Trace: ${tracePath}`].join("\n");
};

const formatStoppedSummary = (
  session: AgentSession,
  route: ActLoopRoute,
  usage: BudgetUsage,
  reason: SessionStopReason,
  limits: BudgetLimits,
  blockedToolCalls?: BudgetBlockedToolCalls,
): string => {
  return [
    `Forgelet session stopped: ${session.id}`,
    `Workflow: ${session.workflow}`,
    `Task: ${session.task}`,
    `Task hash: ${session.taskHash}`,
    `Route: ${route.model} (${route.reason})`,
    `Reason: ${reason}`,
    `Model turns: ${usage.modelTurns}/${limits.maxModelTurns}`,
    `Input tokens: ${usage.inputTokens}/${limits.maxInputTokens}`,
    `Output tokens: ${usage.outputTokens}`,
    `Estimated cost: $${usage.estimatedCostUsd.toFixed(4)}/$${limits.maxEstimatedCostUsd.toFixed(4)}`,
    ...(blockedToolCalls
      ? [
          `Skipped ${blockedToolCalls.skippedCount} tool call${blockedToolCalls.skippedCount === 1 ? "" : "s"} because ${blockedToolCalls.reason} was reached.`,
        ]
      : []),
  ].join("\n");
};
