# Issue tracker: GitHub

Issues and PRDs live in GitHub Issues for `joe-cui-dev/forgelet`. Use the `gh` CLI from this clone; the GitHub plugin may be used for ordinary issue reads and writes.

External PRs are not a triage request surface.

## Core operations

- Create: `gh issue create`
- Read: `gh issue view <number> --comments`
- List: `gh issue list`
- Comment: `gh issue comment <number>`
- Label or assign: `gh issue edit <number>`
- Close: `gh issue close <number>`

## Wayfinding operations

- A map is an issue labelled `wayfinder:map`.
- Tickets are child issues labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Link tickets through GitHub sub-issues. If unavailable, add `Part of #<map>` to the ticket and maintain a task list in the map.
- Represent blocking with GitHub native issue dependencies. If unavailable, add `Blocked by: #<issue>` to the ticket body.
- The frontier is the map's open, unblocked, unassigned child issues.
- Claim a ticket before work with `gh issue edit <number> --add-assignee @me`.
- Resolve by commenting with the answer, closing the ticket, then appending a short linked gist to the map's Decisions-so-far.
