# Knowledge Library Uses Markdown as Source of Truth

Forgelet V2 will store user-approved knowledge outputs as Markdown files, with project knowledge under `.forgelet/knowledge/` first and personal knowledge later under `~/.forgelet/knowledge/`. Article outlines, learning summaries, and source-linked notes are human-facing artifacts, not durable agent memory. Future vector indexes may speed up search, but they are rebuildable caches over the Markdown library rather than the source of truth.
