// Example 03: Tool Execution — calculator and weather tools
import { Orchestrator } from '@atisse/core';
import type { Tool } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';

const calculatorTool: Tool = {
  name: 'calculator',
  description: 'Evaluate a mathematical expression',
  inputSchema: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    const { expression } = input as { expression: string };
    // Safe arithmetic evaluator — no eval, no Function constructor (S-7)
    const tokens = expression.match(/\d+(\.\d+)?|[+\-*/()]/g) ?? [];
    let i = 0;
    const next = (): string => tokens[i++];
    const peek = (): string | undefined => tokens[i];

    const parseFactor = (): number => {
      if (peek() === '(') { next(); const v = parseExpr(); next(); return v; }
      return Number(next());
    };

    const parseTerm = (): number => {
      let v = parseFactor();
      while (peek() === '*' || peek() === '/') {
        const op = next();
        const r = parseFactor();
        v = op === '*' ? v * r : v / r;
      }
      return v;
    };

    const parseExpr = (): number => {
      let v = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = next();
        const r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    };

    return { result: parseExpr() };
  },
};

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
    tools: [calculatorTool, weatherTool],
  });

  const result = await orchestrator.run({
    prompt: 'What is 15 * 7? Also, what is the weather in Paris?',
  });

  console.log('Result:', result.text);
  console.log('\nTool results:');
  for (const tr of result.toolResults) {
    console.log(`  ${tr.name}: ${JSON.stringify(tr.output)}`);
  }
}

main().catch(console.error);
