import { createBraveSearchProvider } from "../../src/publicWeb/brave.js";

test("maps Brave results into bounded Public Web search candidates", async () => {
  const provider = createBraveSearchProvider("test-key", async () =>
    new Response(JSON.stringify({ web: { results: [{ title: "Primary source", url: "https://example.com", description: "A useful page." }] } }), { status: 200 }),
  );
  await expect(provider.search({ query: "example", count: 5 })).resolves.toEqual({
    candidates: [{ title: "Primary source", url: "https://example.com", snippet: "A useful page." }],
    degraded: "partial_results",
  });
});

test("turns Brave rate limits into a typed search failure", async () => {
  const provider = createBraveSearchProvider("test-key", async () => new Response("slow down", { status: 429 }));
  await expect(provider.search({ query: "example", count: 5 })).rejects.toMatchObject({
    code: "web_search_failed",
  });
});
