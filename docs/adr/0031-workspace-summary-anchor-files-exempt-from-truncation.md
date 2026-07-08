# Workspace Summary Guarantees Anchor Files Beyond Max-Files Truncation

`workspace_summary` listed files in sorted order and applied `slice(0, maxFiles)` before any
signal detection ran, so in a workspace with more files than `maxFiles` (default 200) the
files that matter most — `package.json`, `README.md`, `AGENTS.md`, `CONTEXT.md` — could fall
past the truncation line purely by alphabetical accident, silently erasing scripts,
dependencies, entrypoints, and excerpts from the summary. We now guarantee **Anchor Files**
(see CONTEXT.md): the four named files located directly at the summary's effective scan root
are always detected and excerpted, as a union added *beyond* the `maxFiles` slice rather than
by occupying slots inside it, so `scannedFiles` may exceed `maxFiles` by at most 4 and the
guarantee holds even for tiny explicit `maxFiles` values.

Boundaries chosen deliberately:

- **Scan-root only, never nested.** Anchor matching applies to the effective scan root's
  direct children (the `path` argument decides the root, matching existing narrowed-path
  behavior). Guaranteeing every nested `package.json` in a monorepo would make the exemption
  unbounded and recreate the truncation problem it exists to fix; monorepo shape is already
  visible through the untruncated `directories` listing, and callers can rescan with a
  narrower `path`. Lockfiles are not Anchor Files: they carry no shape signal worth an
  excerpt and were never rendered.
- **Anchors never bypass Session Read Scope.** Detection runs against the scope-filtered
  listing, so an anchor outside the scope stays invisible — the Workspace Summary glossary
  entry already forbids scope bypass and the exemption does not weaken it.
- **Case-insensitive basename match, byte-order tie-break.** Exact-name matching made anchor
  detection filesystem-dependent (`Readme.md` repos lose their anchor on Linux but not on
  macOS). All four names match case-insensitively; if multiple casings coexist on a
  case-sensitive filesystem, the byte-order-smallest path wins, keeping the result
  deterministic.
- **Entrypoint verification moves to the full scope-filtered listing.** An anchored
  `package.json` whose `main` pointed past the truncation line previously produced an
  incoherent summary (scripts and dependencies reported, entrypoint reported absent). The
  full listing is already in memory, so verification costs nothing extra.
- **Config and test-convention detection stay on the truncated list.** Running them on the
  full listing would let the rendered `configs` line grow unbounded in large monorepos
  (hundreds of `tsconfig*.json`); bounding those inventories is what `maxFiles` still
  usefully protects.
- **The excerpt budget does not grow.** The total stays at 5 excerpts: the four anchors take
  priority (previously README/CONTEXT/AGENTS competed for a single slot), and the remaining
  non-anchor slot is filled in the order entrypoint > test sample > tsconfig, since configs
  and test conventions are already listed in their own sections. Worst-case payload into
  Active Context is unchanged.
- **Honest reporting.** The summary header always lists the detected Anchor Files, and the
  Limits section states how many anchors were scanned beyond `maxFiles`, so
  `scannedFiles > maxFiles` reads as the documented guarantee rather than a bug. The
  internal `manifests` field is renamed `anchorFiles` to follow the glossary (`manifest` is
  reserved for the Writing Workflow's Project Manifest).

## Considered Options

- **Sort anchors first, keep them inside the `maxFiles` slice** — preserves the
  `scannedFiles ≤ maxFiles` invariant, but breaks the guarantee exactly when it matters
  (an explicit `maxFiles` smaller than the anchor count truncates the anchors themselves).
- **Exempt anchors from the excerpt cap too (up to 9 excerpts)** — honors "always excerpts"
  more loudly but nearly doubles the worst-case bytes flowing into Active Context for a tool
  whose purpose is a compact shape overview.
- **Run every detector on the full listing** — trivial CPU cost, but turns the rendered
  config inventory into an unbounded list in large monorepos and quietly deletes the one
  bound `maxFiles` still provides.
- **Union anchors beyond the slice, bounded at scan root, budgets unchanged (chosen).**

## Consequences

`scannedFiles` may exceed a caller's explicit `maxFiles` by up to 4; any consumer asserting
`scannedFiles ≤ maxFiles` must be updated. Repos whose anchor files use nonstandard casing
gain anchors they previously lost silently. Nested manifests remain best-effort within the
truncated list — this is the documented boundary, not an oversight.
