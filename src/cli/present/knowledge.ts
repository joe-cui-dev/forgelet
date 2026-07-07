import type { CreatedKnowledgeNote, KnowledgeNoteSearch } from "../../knowledge/index.js";

export function formatCreatedKnowledgeNote(note: CreatedKnowledgeNote): string {
  return [
    "Knowledge Note created",
    `Path: ${note.path}`,
    `Source Session: ${note.sourceSessionId}`,
    `Sources: ${note.sourceCount}`,
    `Content hash: ${note.contentHash}`,
  ].join("\n");
}

export function formatKnowledgeNoteSearch(search: KnowledgeNoteSearch): string {
  return [
    "Knowledge Notes Search",
    `Scope: ${search.scope}`,
    `Path: ${search.path}`,
    `Query: ${search.query}`,
    `Results: ${search.results.length}`,
    ...search.results.flatMap((result, index) => [
      "",
      `${index + 1}. ${result.title}`,
      `   Path: ${result.path}`,
      `   Source Session: ${result.sourceSessionId}`,
      `   Snippet: ${result.snippet}`,
    ]),
  ].join("\n");
}
