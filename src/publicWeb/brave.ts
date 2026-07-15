import type { PublicWebSearchCandidate, PublicWebSearchProvider } from "./index.js";

export class BraveSearchError extends Error {
  readonly code = "web_search_failed" as const;
}

export function createBraveSearchProvider(
  apiKey: string,
  request: typeof fetch = fetch,
): PublicWebSearchProvider {
  return {
    async search({ query, count }) {
      const response = await request(
        `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) })}`,
        { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
      );
      if (!response.ok)
        throw new BraveSearchError(response.status === 429
          ? "Brave Search rate limited this request."
          : `Brave Search returned HTTP ${response.status}.`);
      const body = await response.json() as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
      const candidates = (body.web?.results ?? []).flatMap((result): PublicWebSearchCandidate[] =>
        typeof result.title === "string" && typeof result.url === "string"
          ? [{ title: result.title, url: result.url, ...(typeof result.description === "string" ? { snippet: result.description } : {}) }]
          : [],
      );
      return {
        candidates,
        ...(candidates.length < count ? { degraded: "partial_results" } : {}),
      };
    },
  };
}
