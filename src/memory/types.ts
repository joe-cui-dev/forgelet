import type { FrictionSignal } from "./frictionSignal.js";

/** A bounded derivation input list that remains honest about omitted items. */
export interface BoundedMemoryEvidence {
  items: string[];
  total: number;
}

/** The bounded Friction Signals a Retrospective Session was pointed at, kept
 * honest about how many were omitted (ADR 0075). */
export interface BoundedFrictionSignals {
  items: FrictionSignal[];
  total: number;
}

/** Immutable, proposal-time evidence for a versioned Memory Suggestion. The
 * derivation shape is additive: a Retrospective-derived record (ADR 0075)
 * carries `frictionSignals`, while a record written by the earlier
 * actionable-audit derivation carries `changedFiles`/`successfulVerificationCommands`.
 * Both remain readable so the schema stays v1. */
export interface MemorySuggestionProvenance {
  derivation: {
    /** Where the Retrospective Session was told to look. Absent on legacy
     * actionable-audit records. */
    frictionSignals?: BoundedFrictionSignals;
    /** Legacy actionable-audit evidence, present only on records written
     * before the Retrospective Workflow (ADR 0075) replaced that derivation. */
    changedFiles?: BoundedMemoryEvidence;
    successfulVerificationCommands?: BoundedMemoryEvidence;
  };
  trace: {
    path: string;
    sha256: string;
    bytes: number;
  };
  session: {
    workflow: string;
    status: string;
    startedAt: string;
    finishedAt: string;
  };
  /** The Retrospective Session that produced this suggestion, so the model
   * judgement is traceable. Optional and additive: absent on legacy records. */
  derivationSessionId?: string;
}

/** The immutable schema-v1 proposal persisted in memory-suggestions.jsonl. */
export interface VersionedMemorySuggestion {
  schemaVersion: 1;
  id: string;
  sourceSessionId: string;
  text: string;
  createdAt: string;
  provenance: MemorySuggestionProvenance;
}
