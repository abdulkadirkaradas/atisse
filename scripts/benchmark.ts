/**
 * Benchmark: measures p50 and p95 overhead of orchestrator.run()
 * vs raw MockProvider.generate() call.
 *
 * Run: npx tsx scripts/benchmark.ts
 * Pass threshold: p95 overhead < 5ms
 */
import { Orchestrator } from '../packages/core/src/index.js';
import { MockProvider } from '../packages/core/src/testing/index.js';

const ITERATIONS = 1000;
const WARMUP = 100;
const THRESHOLD_P95_MS = 5;

async function run() {
  const provider = new MockProvider();
  const orchestrator = new Orchestrator({ provider });

  // Warm-up
  for (let i = 0; i < WARMUP; i++) {
    provider.enqueue({ text: 'ok' });
    await orchestrator.run({ prompt: 'bench' });
  }

  // Raw provider baseline
  const rawTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    provider.enqueue({ text: 'ok' });
    await provider.generate({ messages: [{ role: 'user', content: 'bench' }] });
    rawTimes.push(performance.now() - t0);
  }

  // Orchestrator
  const orchTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    provider.enqueue({ text: 'ok' });
    const t0 = performance.now();
    await orchestrator.run({ prompt: 'bench' });
    orchTimes.push(performance.now() - t0);
  }

  const overhead = orchTimes.map((t, i) => t - (rawTimes[i] ?? 0));
  overhead.sort((a, b) => a - b);

  const p50Index = Math.floor(ITERATIONS * 0.5);
  const p95Index = Math.floor(ITERATIONS * 0.95);
  const p50 = overhead[p50Index] ?? 0;
  const p95 = overhead[p95Index] ?? 0;

  console.log(`p50 overhead: ${p50.toFixed(3)}ms`);
  console.log(`p95 overhead: ${p95.toFixed(3)}ms`);
  console.log(
    `Threshold (p95 < ${THRESHOLD_P95_MS}ms): ${p95 < THRESHOLD_P95_MS ? 'PASS' : 'FAIL'}`,
  );

  if (p95 >= THRESHOLD_P95_MS) process.exit(1);
}

run().catch(console.error);
