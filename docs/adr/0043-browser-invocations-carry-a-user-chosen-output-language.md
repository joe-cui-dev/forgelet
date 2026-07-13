# Browser Invocations Carry a User-Chosen Output Language

This supersedes ADR 0041.

Browser Workbench keeps a sticky Side Panel selector with `Auto`, `English`, and `中文`. The preference is stored per browser profile in `chrome.storage.local`. At toolbar invocation, Auto resolves Chrome's UI language with a `navigator.language` fallback; explicit choices pass their BCP 47 tag as `outputLanguage`. Browser invocation protocol version 2 introduces the renamed field and Page Brief completion frames. Page Brief section titles stay English while body text follows the selected language.

We rejected following the page language because it removes user control, per-run language buttons because they duplicate a durable preference, and automatic reruns on selector changes because invocation remains the toolbar gesture.
