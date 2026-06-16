# Browser Context Uses Read-Only Extension Bridge First

Forgelet V2 will use a read-only browser extension bridge as the first browser context provider. The bridge lets the user intentionally share the current page URL, title, selected text, extracted text, and optional screenshot metadata without giving Forgelet click, form submission, cookie, localStorage, or hidden automation powers. MCP browser providers and controlled automation can come later behind the same tool provider and capability boundaries.
