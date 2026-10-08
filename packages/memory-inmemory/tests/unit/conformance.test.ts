import { runMemoryAdapterConformanceTests } from '@atisse/core/testing';
import { InMemoryAdapter } from '../../src/index.js';

runMemoryAdapterConformanceTests('InMemoryAdapter', () => new InMemoryAdapter());
