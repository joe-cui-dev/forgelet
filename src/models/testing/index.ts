import type {
  ModelClient,
  ModelTurnInput,
  ModelTurnOutput,
} from "../../types.js";

type FakeModelOutput = ModelTurnOutput & {
  outputDeltas?: string[];
  /** Raw incremental Provider Carryover chunks to report while the turn
   * streams, in order. Byte counts are derived, not scripted: `bytesSoFar`
   * is cumulative over these chunks, matching a real provider's deltas. */
  reasoningDeltas?: string[];
};

export class FakeModelClient implements ModelClient {
  readonly turnInputs: ModelTurnInput[] = [];
  private readonly outputs: FakeModelOutput[];

  constructor(outputs: FakeModelOutput[]) {
    this.outputs = [...outputs];
  }

  async createTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    const {
      onOutputDelta: _onOutputDelta,
      onReasoningDelta: _onReasoningDelta,
      ...recordedInput
    } = input;
    this.turnInputs.push(structuredClone(recordedInput));
    const output = this.outputs.shift();
    if (!output)
      return { content: "No scripted model output remains.", toolCalls: [] };
    let reasoningBytesSoFar = 0;
    for (const text of output.reasoningDeltas ?? []) {
      reasoningBytesSoFar += Buffer.byteLength(text, "utf8");
      await input.onReasoningDelta?.({ bytesSoFar: reasoningBytesSoFar, text });
    }
    for (const text of output.outputDeltas ?? [])
      await input.onOutputDelta?.({ text });
    return { ...output, toolCalls: output.toolCalls ?? [] };
  }
}
