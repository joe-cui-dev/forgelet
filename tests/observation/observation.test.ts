import { expect, test } from "@jest/globals";
import {
  formatObservationRange,
  mergeObservationRanges,
  observationForModel,
  parseObservation,
  toObservationDigest,
  toolResultToObservation,
} from "../../src/observation/index.js";

test("ingests registered metadata by runtime category and derives a bounded preview", () => {
  const observation = toolResultToObservation(
    {
      ok: true,
      summary: "Read source.",
      data: {
        content: "x".repeat(600),
        path: "src/index.ts",
        totalBytes: 600,
        truncated: false,
        exitCode: 7,
        changedFiles: ["src/a.ts", 7, "src/b.ts"],
        url: 7,
      },
    },
    "call_1",
    "read_file",
  );

  expect(observation.metadata).toEqual({
    path: "src/index.ts",
    totalBytes: 600,
    truncated: false,
    exitCode: 7,
    changedFiles: ["src/a.ts", "src/b.ts"],
    preview: "x".repeat(500),
  });
});

test("ingests both exit-code variants", () => {
  const observation = toolResultToObservation(
    { ok: true, summary: "No process status.", data: { exitCode: null } },
    "call_null_exit",
    "run_command",
  );

  expect(observation.metadata.exitCode).toBeNull();
});

test("round-trips a model observation and preserves web source identity in its digest", () => {
  const observation = toolResultToObservation(
    {
      ok: true,
      summary: "Read web source.",
      data: {
        content: "web content",
        url: "https://example.com/article",
        returnedStartByte: 0,
        returnedEndByte: 11,
        totalBytes: 11,
        truncated: false,
      },
    },
    "call_2",
    "web_read",
  );

  const parsed = parseObservation(JSON.stringify(observationForModel(observation)));
  expect(parsed).toEqual(observation);
  expect(toObservationDigest(parsed!, 2_048)).toMatchObject({
    digest:
      "Compacted web_read result for https://example.com/article, byte range 0-11 of 11, complete.",
    metadata: { url: "https://example.com/article" },
  });
});

test("merges overlapping and adjacent equal-total ranges without merging unequal totals", () => {
  const merged = mergeObservationRanges([
    { kind: "byte", start: 0, end: 10, total: 30 },
    { kind: "byte", start: 11, end: 20, total: 30 },
    { kind: "byte", start: 21, end: 30, total: 31 },
    { kind: "line", start: 4, end: 5 },
    { kind: "line", start: 6, end: 8 },
  ]);

  expect(merged).toEqual([
    { kind: "byte", start: 0, end: 20, total: 30 },
    { kind: "byte", start: 21, end: 30, total: 31 },
    { kind: "line", start: 4, end: 8 },
  ]);
  expect(merged.map(formatObservationRange)).toEqual([
    "byte range 0-20 of 30",
    "byte range 21-30 of 31",
    "line range 4-8",
  ]);
});
