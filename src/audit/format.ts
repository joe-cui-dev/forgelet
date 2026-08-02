import type { AuditVerificationCommand } from "../types.js";

// Shared by the Session summary footer, `forge explain`, and the Session read
// model. The marker is the whole point of the shape, so it is written once: a
// surface that renders `exit 0` and drops "ran before the final change" reports
// the Session as verified when the audit knows it is not.
export const formatAuditVerificationCommand = (
  command: AuditVerificationCommand,
): string => {
  const outcome = command.timedOut
    ? "timed out"
    : `exit ${command.exitCode}`;
  return `${command.command} (${outcome}${
    command.ranBeforeFinalChange ? ", ran before the final change" : ""
  })`;
};
