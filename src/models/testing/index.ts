import type {
  ModelClient,
  ModelTurnInput,
  ModelTurnOutput,
} from "../../types.js";

type FakeModelOutput = ModelTurnOutput & {
  outputDeltas?: string[];
};

export class FakeModelClient implements ModelClient {
  readonly turnInputs: ModelTurnInput[] = [];
  private readonly outputs: FakeModelOutput[];

  constructor(outputs: FakeModelOutput[]) {
    this.outputs = [...outputs];
  }

  async createTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    const { onOutputDelta: _onOutputDelta, ...recordedInput } = input;
    this.turnInputs.push(structuredClone(recordedInput));
    const output = this.outputs.shift();
    if (!output)
      return { content: "No scripted model output remains.", toolCalls: [] };
    for (const text of output.outputDeltas ?? [])
      await input.onOutputDelta?.({ text });
    return { ...output, toolCalls: output.toolCalls ?? [] };
  }
}
