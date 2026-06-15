// Example 02: Retry and Fallback — event listener and fallback provider
import { Orchestrator } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';

async function main() {
  const apiKey = process.env.OPENAI_KEY;
  if (!apiKey) {
    console.error('Usage: OPENAI_KEY=sk-... npx tsx index.ts');
    process.exit(1);
  }

  const primary = new OpenAIProvider({ apiKey, model: 'gpt-4o' });
  const fallback = new OpenAIProvider({ apiKey, model: 'gpt-4o-mini' });

  const orchestrator = new Orchestrator({
    provider: primary,
    fallbackProvider: fallback,
    retry: { maxAttempts: 2 },
  });

  const unsubRetry = orchestrator.on('retry.attempted', (event) => {
    console.log(`Retry attempt ${event.attempt}, reason: ${event.reason}, delay: ${event.delayMs}ms`);
  });

  const unsubFallback = orchestrator.on('fallback.triggered', (event) => {
    console.log(`Fallback triggered — reason: ${event.reason}`);
  });

  const result = await orchestrator.run({ prompt: 'What is 2+2?' });

  unsubRetry();
  unsubFallback();

  console.log('Result:', result.text);
}

main().catch(console.error);
