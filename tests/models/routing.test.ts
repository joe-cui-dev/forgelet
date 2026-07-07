import { modelRunnability, providerForModel } from "../../src/models/routing.js";
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

describe("modelRunnability", () => {
  it("marks deepseek- models as runnable", () => {
    expect(modelRunnability("deepseek-chat")).toEqual({ runnable: true });
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
