import {
  formatCreativeStylePresetForWorkspacePrompt,
} from "../creativeStylePresets/index.js";
import { loadContextAttachments } from "../context/index.js";
import { formatLocalTimestampForFilename } from "../fileNames/index.js";
import { runKernelSession } from "../kernel/session.js";
import { kernelCommonPromptLines } from "../kernel/messages.js";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  KernelSessionResult,
  RunKernelSessionInput,
  WorkflowDefinition,
} from "../kernel/workflowDefinition.js";
import type {
  AgentSession,
  CreativeInputKind,
  CreativeStyle,
  WritingArtifact,
  WorkflowVariant,
} from "../types.js";
import {
  applyArtifactToProject,
  saveWritingProject,
  type WritingProjectManifest,
} from "../writingProjects/index.js";

export interface WritingWorkflowDefinitionInput {
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  creativeInputKind?: CreativeInputKind;
  continuationFile?: string;
  hasScopedProject?: boolean;
  project?: WritingProjectManifest;
}

export type WritingSessionInput = Omit<
  RunKernelSessionInput<WritingArtifact>,
  | "definition"
  | "readScopeRequest"
  | "act"
  | "continuationSourceSessionId"
> & {
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  creativeInputKind?: CreativeInputKind;
  continuationFile?: string;
  project?: WritingProjectManifest;
  projectReadScopeMembers?: string[];
  allowedReadPaths?: string[];
};

export type WritingSessionResult = Omit<
  KernelSessionResult<WritingArtifact>,
  "completion"
> & {
  writingArtifact?: WritingArtifact;
};

export async function runWritingSession(
  input: WritingSessionInput,
): Promise<WritingSessionResult> {
  const creativeInputKind =
    input.workflowVariant === "creative"
      ? (input.creativeInputKind ??
        (input.continuationFile
          ? "continuation"
          : input.contextFiles.length > 0
            ? "revision"
            : "draft"))
      : undefined;
  const result = await runKernelSession({
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
    signal: input.signal,
    readScopeRequest:
      input.projectReadScopeMembers ??
      input.project?.members ??
      input.allowedReadPaths,
    definition: createWritingWorkflowDefinition({
      workflowVariant: input.workflowVariant,
      creativeStyle: input.creativeStyle,
      creativeInputKind,
      hasScopedProject: input.project !== undefined,
      project: input.project,
      continuationFile: input.continuationFile,
    }),
  });
  const { completion, ...sessionResult } = result;
  return {
    ...sessionResult,
    ...(completion !== undefined ? { writingArtifact: completion } : {}),
  };
}

export function createWritingWorkflowDefinition(
  input: WritingWorkflowDefinitionInput,
): WorkflowDefinition<WritingArtifact> {
  let creativeStylePresetBlock: string | undefined;
  return {
    kind: "writing",
    sessionTraits: {
      ...(input.workflowVariant
        ? { workflowVariant: input.workflowVariant }
        : {}),
      ...(input.creativeStyle ? { creativeStyle: input.creativeStyle } : {}),
      ...(input.creativeInputKind
        ? { creativeInputKind: input.creativeInputKind }
        : {}),
      ...(input.project
        ? { startTraceExtras: { projectSlug: input.project.slug } }
        : {}),
    },
    async loadAttachments({ workspaceRoot, contextFiles }) {
      if (!input.continuationFile)
        return {
          contextAttachments: await loadContextAttachments(
            workspaceRoot,
            contextFiles,
          ),
        };

      let continuationAttachments;
      try {
        continuationAttachments = await loadContextAttachments(workspaceRoot, [
          input.continuationFile,
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Unable to read continuation artifact: ${input.continuationFile}. Pass an explicit Markdown artifact path, such as .forgelet/writing/<artifact>.md. ${message}`,
        );
      }
      return {
        continuationAttachment: continuationAttachments[0],
        contextAttachments: await loadContextAttachments(
          workspaceRoot,
          contextFiles,
          { startIndex: continuationAttachments.length },
        ),
      };
    },
    capabilities({ readScope }) {
      return [
        "read_context",
        ...(input.hasScopedProject && readScope !== undefined
          ? (["read_workspace"] as const)
          : []),
        "update_plan",
        "model_generate_text",
      ];
    },
    offersTools({ continuationAttachment, contextAttachments }) {
      const creativeDraftLike =
        input.workflowVariant === "creative" &&
        !input.project &&
        (input.creativeInputKind === "draft" ||
          input.creativeInputKind === "continuation" ||
          (!input.creativeInputKind &&
            !continuationAttachment &&
            contextAttachments.length === 0));
      return !creativeDraftLike;
    },
    async prepareSession({ workspaceRoot }) {
      if (input.workflowVariant !== "creative") return;
      creativeStylePresetBlock =
        await formatCreativeStylePresetForWorkspacePrompt(
          input.creativeStyle ?? "plain",
          workspaceRoot,
        );
    },
    systemPrompt() {
      if (
        input.workflowVariant === "creative" &&
        input.creativeInputKind === "draft"
      )
        return [
          ...kernelCommonPromptLines(),
          "This is a Creative Writing Workflow variant.",
          creativeStylePresetBlock,
          "Use the Creative Brief and Durable Memory for original drafting, but do not request workspace, git, shell, patch, or command tools.",
          "Return only a Draft heading followed by the drafted prose.",
        ].join("\n");
      if (
        input.workflowVariant === "creative" &&
        input.creativeInputKind === "continuation"
      )
        return [
          ...kernelCommonPromptLines(),
          "This is a Creative Writing Workflow variant.",
          creativeStylePresetBlock,
          "Use the Creative Brief, Continuation source, Additional context attachments, and Durable Memory to continue the source prose, but do not request workspace, git, shell, patch, or command tools.",
          "Return only a Draft heading followed by the continued prose.",
        ].join("\n");
      if (input.workflowVariant === "creative")
        return [
          ...kernelCommonPromptLines(),
          "This is a Creative Writing Workflow variant.",
          creativeStylePresetBlock,
          "Use the Creative Brief, any provided Context Attachments, and Durable Memory, but do not request workspace, git, shell, patch, or command tools.",
          "If the brief asks for revision but no source text is attached or included, state that limitation and produce the best original draft or useful next step from the brief.",
          "Return a Revision Pack with these headings: Critique, Revision, Alternatives, Notes.",
          "Alternatives must include exactly two options: one more vivid/literary and one clearer/tighter.",
        ].join("\n");
      return [
        ...kernelCommonPromptLines(),
        "This is a Writing Workflow Session.",
        "Use the provided context and Durable Memory, but do not request workspace, git, shell, patch, or command tools.",
        "Return the final answer with these headings: Critique, Revision, Notes.",
      ].join("\n");
    },
    taskLabel() {
      return input.workflowVariant === "creative" ? "Creative brief" : "Task";
    },
    promptContextLines() {
      return formatWritingProjectForPrompt(input.project);
    },
    normalizeFinalContent(content) {
      return normalizeWritingFinalContent(content, input);
    },
    async onCompleted({
      workspaceRoot,
      session,
      finalContent,
      contextAttachments,
      appendTrace,
    }) {
      const writingArtifact = await writeWritingArtifact({
        workspaceRoot,
        session,
        finalContent,
        creativeInputKind: input.creativeInputKind,
        contextAttachmentCount: contextAttachments.length,
      });
      await appendTrace(
        "writing_artifact",
        writingArtifact as unknown as Record<string, unknown>,
      );
      if (input.project) {
        const update = applyArtifactToProject(input.project, {
          artifactPath: writingArtifact.path,
          continuationSource: input.continuationFile ?? null,
        });
        await saveWritingProject(workspaceRoot, update.manifest);
        await appendTrace("writing_project_updated", {
          slug: input.project.slug,
          memberAdded: update.memberAdded,
          headBefore: update.headBefore,
          headAfter: update.headAfter,
        });
      }
      return {
        summaryLines: [appendWritingArtifactLine(writingArtifact)],
        finalSummaryTraceExtras: { writingArtifact },
        completion: writingArtifact,
      };
    },
  };
}

function normalizeWritingFinalContent(
  content: string,
  input: WritingWorkflowDefinitionInput,
): string {
  if (input.workflowVariant === "creative") {
    const creativeInputKind =
      input.creativeInputKind ?? ("revision" as CreativeInputKind);
    if (creativeInputKind === "draft" || creativeInputKind === "continuation") {
      if (hasMarkdownHeading(content, "Draft")) return content;
      return ["Draft", content.trim() || "(empty)"].join("\n");
    }
    if (
      hasMarkdownHeading(content, "Critique") &&
      hasMarkdownHeading(content, "Revision") &&
      hasMarkdownHeading(content, "Alternatives") &&
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
      "Alternatives",
      "1. No vivid/literary alternative was provided by the model.",
      "2. No clearer/tighter alternative was provided by the model.",
      "",
      "Notes",
      "No additional notes were provided.",
    ].join("\n");
  }
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
}

function formatWritingProjectForPrompt(
  project: { slug: string; members: string[]; head: string | null } | undefined,
): string[] {
  if (!project) return [];
  return [
    `Writing Project: ${project.slug}`,
    "Members:",
    ...project.members.map(
      (member) => `- ${member}${member === project.head ? " (head)" : ""}`,
    ),
  ];
}

function hasMarkdownHeading(content: string, heading: string): boolean {
  return new RegExp(`(^|\\n)#{0,6}\\s*${heading}\\s*(\\n|$)`, "i").test(
    content,
  );
}

async function writeWritingArtifact(input: {
  workspaceRoot: string;
  session: AgentSession;
  finalContent: string;
  creativeInputKind?: CreativeInputKind;
  contextAttachmentCount: number;
}): Promise<WritingArtifact> {
  const contentKind = writingArtifactContentKind(
    input.session,
    input.creativeInputKind,
    input.contextAttachmentCount,
  );
  const heading = contentKind === "draft" ? "Draft" : "Revision";
  const body =
    (extractKnownWritingSection(input.finalContent, heading) ??
      input.finalContent.trim()) ||
    "(empty)";
  const content = ensureTrailingNewline(body);
  const artifactDir = join(input.workspaceRoot, ".forgelet", "writing");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = join(
    artifactDir,
    await uniqueMarkdownFileName(
      artifactDir,
      [
        formatLocalTimestampForFilename(new Date(input.session.createdAt)),
        contentKind,
        slugTaskForFilename(input.session.task),
      ].join("_"),
    ),
  );
  await writeFile(artifactPath, content, "utf8");
  return {
    path: relative(input.workspaceRoot, artifactPath),
    contentKind,
    contentBytes: Buffer.byteLength(content, "utf8"),
  };
}

function writingArtifactContentKind(
  session: AgentSession,
  creativeInputKind: CreativeInputKind | undefined,
  contextAttachmentCount: number,
): WritingArtifact["contentKind"] {
  if (
    session.workflowVariant === "creative" &&
    (creativeInputKind === "draft" || creativeInputKind === "continuation")
  )
    return "draft";
  if (session.workflowVariant === "creative" && contextAttachmentCount === 0)
    return "draft";
  return "revision";
}

const KNOWN_WRITING_HEADINGS = new Set([
  "draft",
  "critique",
  "revision",
  "alternatives",
  "notes",
]);

function extractKnownWritingSection(
  content: string,
  heading: "Draft" | "Revision",
): string | undefined {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex(
    (line) => normalizeWritingHeading(line) === heading.toLowerCase(),
  );
  if (startIndex === -1) return undefined;
  const endIndex = lines.findIndex(
    (line, index) =>
      index > startIndex &&
      KNOWN_WRITING_HEADINGS.has(normalizeWritingHeading(line)),
  );
  return lines
    .slice(startIndex + 1, endIndex === -1 ? lines.length : endIndex)
    .join("\n")
    .trim();
}

function normalizeWritingHeading(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .toLowerCase();
}

function slugTaskForFilename(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return /[a-z]/.test(slug) ? slug : "writing";
}

async function uniqueMarkdownFileName(
  dir: string,
  baseName: string,
): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `_${String(index).padStart(2, "0")}`;
    const fileName = `${baseName}${suffix}.md`;
    if (!(await pathExists(join(dir, fileName)))) return fileName;
  }
  return `${baseName}_${Date.now().toString(36)}.md`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function appendWritingArtifactLine(artifact: WritingArtifact): string {
  return `Writing artifact: ${artifact.path} (${artifact.contentKind}, ${artifact.contentBytes} bytes)`;
}
