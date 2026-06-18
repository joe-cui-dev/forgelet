import type {
  ModelClient,
  ModelTurnInput,
  ModelTurnOutput,
} from "../../types.js";

export class FakeModelClient implements ModelClient {
  readonly turnInputs: ModelTurnInput[] = [];
  private readonly outputs: ModelTurnOutput[];

  constructor(outputs: ModelTurnOutput[]) {
    this.outputs = [...outputs];
  }

  async createTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    this.turnInputs.push(input);
    const output = this.outputs.shift();
    if (!output)
      return { content: "No scripted model output remains.", toolCalls: [] };
    return { ...output, toolCalls: output.toolCalls ?? [] };
  }
}
