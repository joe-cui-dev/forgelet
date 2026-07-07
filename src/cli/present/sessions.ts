import type { listSessions, showSession } from "../../sessions/index.js";
import type { SessionAudit } from "../../types.js";
import { formatList } from "./shared.js";

export function formatSessionList(sessions: Awaited<ReturnType<typeof listSessions>>): string {
  if (sessions.length === 0) return "No Forgelet sessions found.";
  return sessions.map((session) => `${session.id}\t${session.workflow}\t${session.status}\t${session.startedAt}\t${session.taskHash || "none"}\t${session.task}`).join("\n");
}

export function formatSessionDetail(session: Awaited<ReturnType<typeof showSession>>): string {
  const context = session.contextAttachments.length > 0 ? session.contextAttachments.map((attachment) => attachment.title ?? attachment.id).join(", ") : "none";
  const route = session.route ? `${session.route.model} (${session.route.reason})` : "none";
  return [
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    `Workflow: ${session.workflow}`,
    `Task: ${session.task}`,
    `Task hash: ${session.taskHash || "none"}`,
    `Started: ${session.startedAt}`,
    `Context attachments: ${context}`,
    `Route: ${route}`,
    `Final summary: ${session.finalSummary}`,
    ...formatSessionAuditHighlights(session.audit),
    `Trace: ${session.tracePath}`
  ].join("\n");
}

export function formatSessionAuditHighlights(audit: SessionAudit | undefined): string[] {
  if (!audit) return [];
  return [
    "Audit:",
    ...(audit.changeGroups.inheritedForgeletChanged &&
    audit.changeGroups.inheritedForgeletChanged.length > 0
      ? [
          `Inherited Forgelet changes: ${formatList(
            audit.changeGroups.inheritedForgeletChanged,
          )}`,
        ]
      : []),
    `Forgelet changed: ${formatList(audit.changeGroups.forgeletChanged)}`,
    `Pre-existing at Session start: ${formatList(audit.changeGroups.preExistingAtSessionStart)}`,
    `Other current workspace changes: ${formatList(audit.changeGroups.otherCurrentWorkspaceChanges)}`,
    audit.verificationCommands.length > 0
      ? "Verification commands:"
      : "Verification commands: none",
    ...audit.verificationCommands.map(
      (command) =>
        `- ${command.command} (${command.timedOut ? "timed out" : `exit ${command.exitCode}`})`,
    ),
    audit.kernelObservedRisks.length > 0
      ? "Kernel-observed risks:"
      : "Kernel-observed risks: none",
    ...audit.kernelObservedRisks.map((risk) => `- ${risk.message}`),
  ];
}
