import { loadContextAttachments } from "../context/index.js";
import { runKernelSession } from "../kernel/session.js";
import { kernelCommonPromptLines } from "../kernel/messages.js";
import type {
  KernelSessionResult,
  RunKernelSessionInput,
  WorkflowDefinition,
} from "../kernel/workflowDefinition.js";
import type { LoadedContextAttachment } from "../types.js";

export type LearningSessionInput = Omit<
  RunKernelSessionInput,
  "definition" | "readScopeRequest" | "act" | "continuationSourceSessionId"
> & {
  allowedReadPaths?: string[];
};

export type LearningSessionResult = KernelSessionResult<LearningPack>;

export interface LearningPack {
  summary: string;
  keyConcepts: string;
  sourceLinks: string;
  openQuestions: string;
  reviewPrompts: string;
}

export function runLearningSession(
  input: LearningSessionInput,
): Promise<LearningSessionResult> {
  return runKernelSession<LearningPack>({
    task: input.task,
    contextFiles: input.contextFiles,
    browserSnapshot: input.browserSnapshot,
    model: input.model,
    budgetUsd: input.budgetUsd,
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
    modelClient: input.modelClient,
    debug: input.debug,
    approvalHandler: input.approvalHandler,
    onLiveEvent: input.onLiveEvent,
    readScopeRequest: input.allowedReadPaths,
    executionPolicy: input.executionPolicy,
    definition: createLearningWorkflowDefinition(),
  });
}

export function createLearningWorkflowDefinition(): WorkflowDefinition<LearningPack> {
  return {
    kind: "learning",
    async loadAttachments({ workspaceRoot, contextFiles }) {
      return {
        contextAttachments: await loadContextAttachments(
          workspaceRoot,
          contextFiles,
        ),
      };
    },
    capabilities() {
      return ["read_context", "update_plan", "model_generate_text"];
    },
    systemPrompt() {
      return [
        ...kernelCommonPromptLines(),
        "This is a source-backed Learning Workflow Session.",
        "Use explicit Context Attachments, browser context, and accepted Durable Memory only within their boundaries.",
        "Treat Durable Memory as preference or terminology guidance, not source material.",
        "Produce a Learning Pack with these headings: Summary, Key Concepts, Source Links, Open Questions, Review Prompts.",
        "Prefer the user's requested output language.",
        "If sources conflict, name the conflict in Open Questions or the relevant section.",
        "Do not request workspace, git, shell, patch, command, note-writing, or browser automation tools.",
      ].join("\n");
    },
    normalizeFinalContent(content, { contextAttachments }) {
      return normalizeLearningPack(content, [...contextAttachments]);
    },
    async onCompleted({ finalContent }) {
      return {
        finalSummaryTraceExtras: { finalContent },
        completion: learningPackFromNormalizedMarkdown(finalContent),
      };
    },
  };
}

const LEARNING_PACK_HEADINGS = [
  "Summary",
  "Key Concepts",
  "Source Links",
  "Open Questions",
  "Review Prompts",
] as const;

type LearningPackHeading = (typeof LEARNING_PACK_HEADINGS)[number];

function normalizeLearningPack(
  content: string,
  contextAttachments: LoadedContextAttachment[],
): string {
  const parsed = parseLearningSections(content);
  const unstructured = parsed.sections.size === 0;
  const summary =
    (unstructured
      ? content.trim()
      : (parsed.sections.get("Summary") ?? parsed.preamble.trim())) ||
    "(empty)";

  const bodies: Record<LearningPackHeading, string> = {
    Summary: summary,
    "Key Concepts":
      parsed.sections.get("Key Concepts") ??
      "No separate key concepts were provided by the model.",
    "Source Links": formatLearningSourceLinks(contextAttachments),
    "Open Questions":
      parsed.sections.get("Open Questions") ??
      "No open questions were provided by the model.",
    "Review Prompts":
      parsed.sections.get("Review Prompts") ??
      "No review prompts were provided by the model.",
  };

  return LEARNING_PACK_HEADINGS.map(
    (heading) => `## ${heading}\n${bodies[heading].trim() || "(empty)"}`,
  ).join("\n\n");
}

function learningPackFromNormalizedMarkdown(markdown: string): LearningPack {
  const { sections } = parseLearningSections(markdown);
  return {
    summary: sections.get("Summary") ?? "",
    keyConcepts: sections.get("Key Concepts") ?? "",
    sourceLinks: sections.get("Source Links") ?? "",
    openQuestions: sections.get("Open Questions") ?? "",
    reviewPrompts: sections.get("Review Prompts") ?? "",
  };
}

function parseLearningSections(content: string): {
  preamble: string;
  sections: Map<LearningPackHeading, string>;
} {
  const sections = new Map<LearningPackHeading, string>();
  const preamble: string[] = [];
  let currentHeading: LearningPackHeading | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentHeading)
      sections.set(currentHeading, currentLines.join("\n").trim());
    currentLines = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const heading = learningPackHeadingForLine(line);
    if (heading) {
      flush();
      currentHeading = heading;
      continue;
    }
    if (currentHeading) currentLines.push(line);
    else preamble.push(line);
  }
  flush();

  return { preamble: preamble.join("\n").trim(), sections };
}

function learningPackHeadingForLine(
  line: string,
): LearningPackHeading | undefined {
  const normalized = line
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .replace(/:$/, "")
    .toLowerCase();
  return LEARNING_PACK_HEADINGS.find(
    (heading) => heading.toLowerCase() === normalized,
  );
}

function formatLearningSourceLinks(
  contextAttachments: LoadedContextAttachment[],
): string {
  if (contextAttachments.length === 0)
    return "- No explicit source attachment was loaded.";
  return contextAttachments
    .map(({ attachment }) => {
      const sourceLabel =
        attachment.source === "browser"
          ? `browser: ${attachment.title ?? attachment.uri ?? attachment.id}`
          : `${attachment.source}: ${attachment.uri ?? attachment.title ?? attachment.id}`;
      return [
        `- ${sourceLabel}`,
        ...(attachment.title ? [`  title: ${attachment.title}`] : []),
        ...(attachment.uri ? [`  uri: ${attachment.uri}`] : []),
        `  contentHash: ${attachment.contentHash}`,
        `  contentBytes: ${attachment.contentBytes}`,
      ].join("\n");
    })
    .join("\n");
}
