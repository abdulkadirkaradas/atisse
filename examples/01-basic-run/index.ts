// Example 01: Basic Run — minimal Orchestrator setup with OpenAI
import { Orchestrator } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';

async function main() {
  const apiKey = process.env.OPENAI_KEY;
  if (!apiKey) {
    console.error('API Key not found. Please set the OPENAI_KEY environment variable.');
    process.exit(1);
  }

  const provider = new OpenAIProvider({ apiKey });
  const orchestrator = new Orchestrator({ provider });

  const result = await orchestrator.run({ prompt: 'What is the capital of France?' });

  console.log('Result:', result.text);
  console.log('Duration (ms):', result.durationMs);
  console.log('Total tokens:', result.usage.total);
}

main().catch(console.error);
