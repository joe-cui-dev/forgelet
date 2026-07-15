import type { LoadedContextAttachment } from "../types.js";

export interface SessionSourceLedgerView {
  contextAttachments(): readonly LoadedContextAttachment[];
}

export interface SessionSourceLedger {
  readonly view: SessionSourceLedgerView;
  nextContextId(): string;
  append(attachment: LoadedContextAttachment): void;
}

/** Owns the stable source identity sequence for one Session. */
export function createSessionSourceLedger(): SessionSourceLedger {
  const attachments: LoadedContextAttachment[] = [];

  return {
    view: { contextAttachments: () => attachments },
    nextContextId: () => `ctx_${attachments.length + 1}`,
    append: (attachment) => {
      const expectedId = `ctx_${attachments.length + 1}`;
      if (attachment.attachment.id !== expectedId)
        throw new Error(
          `Session source identity must be ${expectedId}, received ${attachment.attachment.id}.`,
        );
      attachments.push(attachment);
    },
  };
}
