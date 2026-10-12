import Anthropic from "@anthropic-ai/sdk";

/**
 * The small surface the rest of the app needs from a language model.
 * Keeping it this narrow means tests can swap in a fake without touching the network.
 */
export interface LlmClient {
  /** Force the model to answer by calling a single tool, and return that tool's input. */
  structured(args: {
    system: string;
    user: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<unknown>;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;

  constructor(
    apiKey: string | undefined,
    private model: string,
  ) {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set. Add it to your environment or .env file.");
    }
    this.client = new Anthropic({ apiKey });
  }

  async structured(args: {
    system: string;
    user: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: args.maxTokens ?? 4096,
      system: args.system,
      tools: [
        {
          name: args.toolName,
          description: args.toolDescription,
          input_schema: args.inputSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: args.toolName },
      messages: [{ role: "user", content: args.user }],
    });

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error(`Model did not return a ${args.toolName} result (stop_reason: ${response.stop_reason}).`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("Model output was cut off by max_tokens. Try shorter notes or raise maxTokens.");
    }
    return block.input;
  }
}
