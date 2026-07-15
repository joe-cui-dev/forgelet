import { createSessionSourceLedger } from "../../src/sourceLedger/index.js";
import type { LoadedContextAttachment } from "../../src/types.js";

function loadedAttachment(id: string, title: string): LoadedContextAttachment {
  return {
    attachment: {
      id,
      source: "file",
      title,
      uri: title,
      mimeType: "text/plain",
      contentBytes: 4,
      contentHash: "hash",
      preview: "text",
      trustLevel: "workspace",
    },
    content: "text",
  };
}

test("assigns one continuous context identity sequence across source kinds", () => {
  const ledger = createSessionSourceLedger();
  const file = loadedAttachment(ledger.nextContextId(), "article.md");
  ledger.append(file);

  const browser: LoadedContextAttachment = {
    ...loadedAttachment(ledger.nextContextId(), "Example page"),
    attachment: {
      ...loadedAttachment("unused", "Example page").attachment,
      id: "ctx_2",
      source: "browser",
      uri: "https://example.com",
      trustLevel: "external",
    },
  };
  ledger.append(browser);

  expect(ledger.view.contextAttachments().map(({ attachment }) => attachment.id)).toEqual([
    "ctx_1",
    "ctx_2",
  ]);
  expect(ledger.view.contextAttachments().map(({ attachment }) => attachment.source)).toEqual([
    "file",
    "browser",
  ]);
  expect(ledger.nextContextId()).toBe("ctx_3");
});
