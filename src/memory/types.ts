/** A bounded derivation input list that remains honest about omitted items. */
export interface BoundedMemoryEvidence {
  items: string[];
  total: number;
}

/** Immutable, proposal-time evidence for a versioned Memory Suggestion. */
export interface MemorySuggestionProvenance {
  derivation: {
    changedFiles: BoundedMemoryEvidence;
    successfulVerificationCommands: BoundedMemoryEvidence;
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
