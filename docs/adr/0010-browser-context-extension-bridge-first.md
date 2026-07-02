# Browser Context Uses Read-Only Extension Bridge First

Forgelet V2 will use a read-only browser extension bridge as the first browser context provider. The bridge lets the user intentionally share the current page URL, title, selected text, extracted text, and optional screenshot metadata without giving Forgelet click, form submission, cookie, localStorage, or hidden automation powers. MCP browser providers and controlled automation can come later behind the same tool provider and capability boundaries.

The first bridge transport will use browser Native Messaging to write a short-lived local browser context snapshot that the CLI can read through `forge browser read-current` and `--with-browser`. Forgelet will not require a localhost service for the first slice; the snapshot file is the boundary between the user-approved browser share action and a later Workflow Session.

The snapshot may contain the current page URL, title, capture time, selected text, extracted main text, optional screenshot path metadata, content hash, and byte counts. Workflow Sessions convert that snapshot into a browser-sourced Context Attachment with external trust. Trace records only attachment metadata such as URL, title, hash, size, and preview; it must not persist the full page text.

`--with-browser` will accept only a recent snapshot and will show the browser source before creating the Session, including URL, title, capture time, selected-text versus main-text usage, and byte count. Passing `--with-browser` is the user's explicit consent to use that recent snapshot, so the first slice does not add a second interactive confirmation prompt.
