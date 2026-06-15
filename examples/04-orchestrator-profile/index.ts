// Example 04: Orchestrator Profiles — multi-profile setup with context and memory
import { Orchestrator } from '@atisse/core';
import type { Tool } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';
import { RAGContextProvider } from '@atisse/context-rag';
import type { VectorStore, VectorDocument } from '@atisse/context-rag';
import { InMemoryAdapter } from '@atisse/memory-inmemory';

const mockVectorStore: VectorStore = {
  id: 'docs',
  async search(_query: string, _topK?: number): Promise<VectorDocument[]> {
    return [{ content: 'The official documentation covers: setup, configuration, and API reference.', metadata: { source: 'wiki' } }];
  },
};

const formatTextTool: Tool = {
  name: 'formatText',
  description: 'Transform text to uppercase',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    const { text } = input as { text: string };
    return { formatted: text.toUpperCase() };
  },
};

async function main() {
  const apiKey = process.env.OPENAI_KEY;
  if (!apiKey) {
    console.error('Usage: OPENAI_KEY=sk-... npx tsx index.ts');
    process.exit(1);
  }

  const ragProvider = new RAGContextProvider({ vectorStore: mockVectorStore, topK: 2 });
  const inMemoryAdapter = new InMemoryAdapter();

  const orchestrator = new Orchestrator({
    provider: new OpenAIProvider({ apiKey }),
    memoryAdapter: inMemoryAdapter,
    profiles: {
      editor: {
        name: 'editor',
        systemPrompt: 'You are a helpful editor. Improve the user text.',
      },
      analyzer: {
        name: 'analyzer',
        systemPrompt: 'You are a data analyst. Analyze the user query.',
        tools: [formatTextTool],
      },
      support: {
        name: 'support',
        systemPrompt: 'You are a support agent. Answer helpfully.',
        contextProviders: [ragProvider],
      },
    },
  });

  const r1 = await orchestrator.run({ prompt: 'Hello world', profile: 'editor', sessionId: 'demo-session' });
  console.log('[editor]:', r1.text);

  const r2 = await orchestrator.run({ prompt: 'What is 42?', profile: 'analyzer', sessionId: 'demo-session' });
  console.log('[analyzer]:', r2.text);

  const r3 = await orchestrator.run({ prompt: 'How do I reset my password?', profile: 'support', sessionId: 'demo-session' });
  console.log('[support]:', r3.text);
}

main().catch(console.error);
