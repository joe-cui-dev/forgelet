import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicWebTools } from "../../src/publicWeb/index.js";
import { createSessionSourceLedger } from "../../src/sourceLedger/index.js";
import type { ToolContext } from "../../src/types.js";

const context: ToolContext = {
  workspaceRoot: "/tmp/workspace",
  sessionId: "sess_test",
  workflow: "learning",
  grantedCapabilities: ["read_public_web"],
};

test("search returns candidates while read adds one persisted, deduplicated Web Source", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-public-web-tools-"));
  const ledger = createSessionSourceLedger({ workspaceRoot, sessionId: "sess_web" });
  const state = { searchCalls: 0, readAttempts: 0 };
  const tools = createPublicWebTools({
    ledger,
    state,
    adapters: {
      searchProvider: {
        async search() {
          return [{ title: "Candidate", url: "https://example.com/article" }];
        },
      },
      reader: {
        async read() {
          return {
            title: "Example article",
            url: "https://example.com/article",
            finalUrl: "https://example.com/article#top",
            httpStatus: 200,
            fetchedBytes: 18,
            contentType: "text/html",
            text: "Useful source text.",
          };
        },
      },
    },
  });
  const search = tools.find((tool) => tool.name === "web_search");
  const read = tools.find((tool) => tool.name === "web_read");
  if (!search || !read) throw new Error("Expected Public Web tools.");

  await expect(search.execute({ query: "example" }, context)).resolves.toMatchObject({
    ok: true,
    data: { requestedCount: 5, returnedCount: 1 },
  });
  expect(ledger.view.contextAttachments()).toHaveLength(0);

  const first = await read.execute({ url: "https://example.com/article" }, context);
  const second = await read.execute({ url: "https://example.com/article" }, context);
  expect(first).toMatchObject({
    ok: true,
    data: { sourceId: "ctx_1", deduplicated: false },
  });
  expect(second).toMatchObject({
    ok: true,
    data: { sourceId: "ctx_1", deduplicated: true },
  });
  expect(ledger.view.contextAttachments()).toMatchObject([
    { attachment: { id: "ctx_1", source: "web", uri: "https://example.com/article" } },
  ]);
  await expect(readFile(join(workspaceRoot, ".forgelet", "web", "sess_web", "ctx_1.json"), "utf8"))
    .resolves.toContain("Useful source text.");
});
