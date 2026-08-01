import {
  maxConversationBytesForRoute,
  maxObservationBytesForRoute,
  maxOutputTokensForRoute,
  modelRunnability,
  providerForModel,
} from "../../src/models/routing.js";
import type { ForgeletConfig } from "../../src/config/index.js";

const config: Pick<ForgeletConfig, "providers"> = {
  providers: {
    deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY" },
    openai: { apiKeyEnv: "OPENAI_API_KEY" },
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
};

describe("providerForModel", () => {
  it("routes deepseek- models to the deepseek provider", () => {
    expect(providerForModel("deepseek-chat", config)).toEqual({
      name: "deepseek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    });
  });

  it.each(["gpt-4o", "o1-preview", "o3-mini", "o4-mini"])(
    "routes %s to the openai provider",
    (model) => {
      expect(providerForModel(model, config)).toEqual({
        name: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
      });
    },
  );

  it("routes claude- models to the anthropic provider", () => {
    expect(providerForModel("claude-sonnet-5", config)).toEqual({
      name: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
  });

  it("routes unrecognized models to unknown", () => {
    expect(providerForModel("mystery-model", config)).toEqual({
      name: "unknown",
      apiKeyEnv: "unknown",
    });
  });
});

describe("maxConversationBytesForRoute", () => {
  const routingConfig: Pick<ForgeletConfig, "routing" | "activeContext"> = {
    routing: {
      coding: { default: "deepseek-v4-flash", review: "deepseek-v4-flash" },
      writing: { default: "deepseek-v4-flash", review: "deepseek-v4-flash" },
      learning: { default: "deepseek-v4-flash", review: "deepseek-v4-flash" },
      fallback: "gpt-5",
    },
    activeContext: {
      maxConversationBytes: 65_536,
      observationDigestPreviewBytes: 2_048,
      protectedRecentTurns: 3,
    },
  };

  it("falls back to the global default when the route has no override", () => {
    expect(maxConversationBytesForRoute(routingConfig, "coding")).toBe(65_536);
  });

  it("prefers the route's override over the global default", () => {
    const withOverride: Pick<ForgeletConfig, "routing" | "activeContext"> = {
      ...routingConfig,
      routing: {
        ...routingConfig.routing,
        coding: { ...routingConfig.routing.coding, maxConversationBytes: 32_768 },
      },
    };

    expect(maxConversationBytesForRoute(withOverride, "coding")).toBe(32_768);
    expect(maxConversationBytesForRoute(withOverride, "writing")).toBe(65_536);
  });
});

test("derives the output ceiling from the route conversation budget", () => {
  const config: Pick<ForgeletConfig, "routing" | "activeContext"> = {
    routing: {
      coding: { default: "deepseek-v4-flash", review: "deepseek-v4-flash", maxConversationBytes: 65_536 },
      writing: { default: "deepseek-v4-flash", review: "deepseek-v4-flash" },
      learning: { default: "deepseek-v4-flash", review: "deepseek-v4-flash" },
      fallback: "gpt-5",
    },
    activeContext: { maxConversationBytes: 65_536, observationDigestPreviewBytes: 2_048, protectedRecentTurns: 3 },
  };
  expect(maxOutputTokensForRoute(config, "coding", "deepseek-v4-flash")).toBe(4_096);
});

describe("maxObservationBytesForRoute", () => {
  const configWith = (
    maxConversationBytes: number,
  ): Pick<ForgeletConfig, "routing" | "activeContext"> => ({
    routing: {
      coding: { default: "deepseek-v4-flash", review: "deepseek-v4-flash", maxConversationBytes },
      writing: { default: "deepseek-v4-flash", review: "deepseek-v4-flash" },
      learning: { default: "deepseek-v4-flash", review: "deepseek-v4-flash" },
      fallback: "gpt-5",
    },
    activeContext: {
      maxConversationBytes: 512 * 1024,
      observationDigestPreviewBytes: 2_048,
      protectedRecentTurns: 3,
    },
  });

  it("gives one eighth of the route conversation budget to a single observation", () => {
    expect(maxObservationBytesForRoute(configWith(512 * 1024), "coding")).toBe(65_536);
  });

  it("never drops below the limit read-only tools carried before the budget widened", () => {
    expect(maxObservationBytesForRoute(configWith(128 * 1024), "coding")).toBe(20 * 1024);
  });
});

describe("modelRunnability", () => {
  it("rejects retired DeepSeek models with a migration message", () => {
    expect(modelRunnability("deepseek-chat")).toEqual({
      runnable: false,
      errorMessage: "Model deepseek-chat was retired. Migrate to deepseek-v4-flash.",
      previewReason: "model deepseek-chat was retired; migrate to deepseek-v4-flash.",
    });
  });

  it("rejects an effort a profiled model would silently remap", () => {
    expect(modelRunnability("deepseek-v4-pro", "low")).toMatchObject({
      runnable: false,
      errorMessage: expect.stringContaining("does not accept reasoning effort low"),
    });
  });

  it("marks non-deepseek models as not runnable, with distinct wiring and preview texts", () => {
    expect(modelRunnability("gpt-4o")).toEqual({
      runnable: false,
      errorMessage:
        "Model-backed execution currently supports DeepSeek models only. Route selected gpt-4o.",
      previewReason:
        "model-backed execution currently supports DeepSeek routes only; gpt-4o is not runnable.",
    });
  });
});
