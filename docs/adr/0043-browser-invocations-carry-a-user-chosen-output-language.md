# Browser Invocations Carry a User-Chosen Output Language

This supersedes ADR 0041.

Browser Workbench keeps a sticky Side Panel selector with `Auto`, `English`, and `中文`. The preference is stored per browser profile in `chrome.storage.local`. At each toolbar or Page Conversation Send gesture, Auto resolves Chrome's UI language with a `navigator.language` fallback; explicit choices pass their BCP 47 tag as `outputLanguage`. Changing the selector never reruns or rewrites a completed Page Brief or Page Answer; it affects only the next browser-launched Session. Browser protocol v3 carries the chosen language on root and follow-up requests. Page Brief and Page Answer section titles stay English while body text follows the selected language; deterministic UI messages such as Page Answer not-found Evidence are localized from the same per-turn language without another model call.

We rejected following the page or question language because it removes explicit user control, per-run language buttons because they duplicate a durable preference, and automatic reruns on selector changes because output language is snapshotted only by an explicit launch gesture.
