import { toolResultToObservation } from "../../src/observation/index.js";

test("preserves typed public-web errors and receipt metadata", () => {
  const observation = toolResultToObservation(
    {
      ok: false,
      summary: "The fetch exceeded its byte limit.",
      error: "The fetch exceeded its byte limit.",
      errorCode: "web_content_rejected",
      data: {
        url: "https://example.com/article",
        finalUrl: "https://example.com/article",
        httpStatus: 200,
        fetchedBytes: 1024,
        storedBytes: 512,
        contentType: "text/html",
        sourceId: "ctx_1",
        deduplicated: false,
        requestedCount: 5,
        returnedCount: 3,
      },
    },
    "call_web",
    "web_read",
  );

  expect(observation.error).toEqual({
    code: "web_content_rejected",
    message: "The fetch exceeded its byte limit.",
  });
  expect(observation.metadata).toMatchObject({
    url: "https://example.com/article",
    finalUrl: "https://example.com/article",
    httpStatus: 200,
    fetchedBytes: 1024,
    storedBytes: 512,
    contentType: "text/html",
    sourceId: "ctx_1",
    deduplicated: false,
    requestedCount: 5,
    returnedCount: 3,
  });
});
