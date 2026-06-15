// Example 05: Streaming with Tools — streaming output with one tool call
import { Orchestrator } from '@atisse/core';
import type { Tool } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';

const weatherTool: Tool = {
  name: 'weather',
  description: 'Get weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    const { city } = input as { city: string };
    return { city, temperature: 22, conditions: 'sunny' };
  },
};

async function main() {
  const apiKey = process.env.OPENAI_KEY;
  if (!apiKey) {
    console.error('Usage: OPENAI_KEY=sk-... npx tsx index.ts');
    process.exit(1);
  }

  const provider = new OpenAIProvider({ apiKey });
  const orchestrator = new Orchestrator({
    provider,
    tools: [weatherTool],
    // NOTE: No fallbackProvider — stream + fallback is forbidden in v1 (ADR-017)
  });

  const stream = await orchestrator.run({
    prompt: 'What is the weather in Tokyo and also tell me a fun fact?',
    stream: true,
  });

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text':
        process.stdout.write(chunk.delta);
        break;
      case 'tool_call':
        console.log(`\n[Tool call: ${chunk.toolCall.name} with ${JSON.stringify(chunk.toolCall.input)}]\n`);
        break;
      case 'tool_result':
        console.log(`\n[Tool result: ${JSON.stringify(chunk.toolResult.output)}]\n`);
        break;
      case 'done':
        console.log(`\n[Done — usage: ${JSON.stringify(chunk.usage)}]`);
        break;
      case 'error':
        console.log(`\n[Error: ${chunk.error.message}]`);
        break;
    }
  }

  console.log();
}

main().catch(console.error);
