import { expect, test } from "@jest/globals";
import { formatWritingArtifactContinueHint } from "../../../src/cli/present/writing.js";
import type { WritingArtifactCatalogEntry } from "../../../src/writingArtifacts/index.js";

const entry: WritingArtifactCatalogEntry = {
  path: ".forgelet/writing/rain.md",
  status: "available",
  contentKind: "draft",
  contentBytes: 10,
  createdAt: "2026-01-01T00:00:00.000Z",
  workflowVariant: "creative",
};

test("continue hint repeats the recorded Style Preset", () => {
  expect(
    formatWritingArtifactContinueHint({ ...entry, creativeStyle: "vivid" }),
  ).toBe(
    'forge write --creative --style vivid --continue .forgelet/writing/rain.md "<brief>"',
  );
});

test("continue hint omits --style when the artifact had no Style Preset", () => {
  expect(formatWritingArtifactContinueHint(entry)).toBe(
    'forge write --creative --continue .forgelet/writing/rain.md "<brief>"',
  );
});
