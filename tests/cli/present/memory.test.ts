import { formatMemoryReviewList } from "../../../src/cli/present/memory.js";
import type { MemoryReviewList } from "../../../src/memoryReview/index.js";

function list(
  items: MemoryReviewList["items"],
  hiddenDecidedCount = 0,
): MemoryReviewList {
  return { items, hiddenDecidedCount };
}

test("a proposed item leads with plain language and points to show", () => {
  const output = formatMemoryReviewList(
    list([
      {
        id: "mem_new",
        state: "proposed",
        createdAt: "2026-07-04T00:00:00Z",
        preview: "Pending guidance.",
      },
    ]),
    { all: false },
  );
  expect(output).toBe(
    [
      "Proposed — awaiting your review",
      '  "Pending guidance."',
      "  Created: 2026-07-04T00:00:00Z   Id: mem_new",
      "  Next: forge memory show mem_new",
    ].join("\n"),
  );
});

test("a Memory Write Gap says accepted but not written and points to re-accept", () => {
  const output = formatMemoryReviewList(
    list([{ id: "mem_gap", state: "accepted-unwritten", preview: "Gapped." }]),
    { all: false },
  );
  expect(output).toBe(
    [
      "Accepted, but not written — re-accept to repair",
      '  "Gapped."',
      "  Created: -   Id: mem_gap",
      "  Next: forge memory accept mem_gap",
    ].join("\n"),
  );
});

test("--all renders decided history in the same layout", () => {
  const output = formatMemoryReviewList(
    list([
      {
        id: "mem_done",
        state: "accepted",
        createdAt: "2026-07-01T00:00:00Z",
        preview: "Done.",
      },
      {
        id: "mem_no",
        state: "rejected",
        createdAt: "2026-07-02T00:00:00Z",
        preview: "Declined.",
      },
    ]),
    { all: true },
  );
  expect(output).toBe(
    [
      "Accepted and written",
      '  "Done."',
      "  Created: 2026-07-01T00:00:00Z   Id: mem_done",
      "  Next: forge memory show mem_done",
      "",
      "Rejected",
      '  "Declined."',
      "  Created: 2026-07-02T00:00:00Z   Id: mem_no",
      "  Next: forge memory show mem_no",
    ].join("\n"),
  );
});

test("empty default view without history", () => {
  expect(formatMemoryReviewList(list([]), { all: false })).toBe(
    "No pending memory suggestions.",
  );
});

test("empty default view names the hidden decided count and points to --all", () => {
  expect(formatMemoryReviewList(list([], 2), { all: false })).toBe(
    [
      "No pending memory suggestions.",
      "2 decided suggestions recorded. Run forge memory list --all to include them.",
    ].join("\n"),
  );
  expect(formatMemoryReviewList(list([], 1), { all: false })).toBe(
    [
      "No pending memory suggestions.",
      "1 decided suggestion recorded. Run forge memory list --all to include it.",
    ].join("\n"),
  );
});

test("empty --all view", () => {
  expect(formatMemoryReviewList(list([]), { all: true })).toBe(
    "No memory suggestions.",
  );
});
