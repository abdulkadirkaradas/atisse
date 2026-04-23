#!/usr/bin/env node
/**
 * MCP Server — Handoff Persistence Tool
 * Saves handoff packages to .opencode/handoffs/[task_label]/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MD_SIZE = 1_000_000;
const MAX_JSON_SIZE = 200_000;
const INDEX_FILE = 'index.json';

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA (UNCHANGED BEHAVIOR)
// ─────────────────────────────────────────────────────────────────────────────

const HandoffSchema = z.object({
  schema_version: z.literal('1.0'),
  task_id: z.string().uuid(),
  task_label: z.string().regex(/^(SPSA|SPBED|SPQAE)-[a-z0-9_-]+-\d{4}$/),
  source: z.enum(['SPSA', 'SPBED', 'SPQAE']),
  destination: z.enum(['SPSA', 'SPBED', 'SPQAE', 'USER']),
  routing_reason: z.string(),
  iteration: z.number().int().min(1),
  status: z.enum(['completed', 'flagged', 'approved', 'rejected', 'needs_review']),
  artifacts: z.array(z.string()),
  flags: z.array(z.string()),
  required_action: z.string(),
  context_summary: z.string(),
  created_at: z.string().datetime(),
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS (UNCHANGED LOGIC)
// ─────────────────────────────────────────────────────────────────────────────

function resolveDir(): string {
  const envBase = process.env.OPENCODE_HANDOFF_DIR;

  if (envBase) return envBase;

  let dir = process.cwd();

  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.opencode');
    if (fsSync.existsSync(candidate)) {
      return path.join(candidate, 'handoffs');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // fallback: module-relative (last resort, not recommended)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, '..', '..', '.opencode', 'handoffs');
}

function assertSafeLabel(label: string) {
  if (label.includes('..') || label.includes('/') || label.includes('\\')) {
    throw new Error('Invalid task_label');
  }
}

async function atomicWrite(filePath: string, data: string) {
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INDEX LAYER (UNCHANGED BEHAVIOR)
// ─────────────────────────────────────────────────────────────────────────────

async function loadIndex(baseDir: string) {
  try {
    const raw = await fs.readFile(path.join(baseDir, INDEX_FILE), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { by_task_id: {} };
  }
}

async function saveIndex(baseDir: string, index: any) {
  await atomicWrite(path.join(baseDir, INDEX_FILE), JSON.stringify(index, null, 2));
}

async function updateIndex(baseDir: string, entry: any) {
  const index = await loadIndex(baseDir);
  index.by_task_id[entry.task_id] = entry;
  await saveIndex(baseDir, index);
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'handoff-package',
  version: '1.0.0',
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL: save_handoff (COMPATIBLE)
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'save_handoff',
  {
    title: 'Save Handoff',
    description: 'Stores validated handoff with atomic writes, versioning, and index',
    inputSchema: z.object({
      handoff_json: z.string(),
      conversation_md: z.string(),
      include_full_conversation: z.boolean().default(false),
      allow_overwrite: z.boolean().default(false),
    }),
  },

  async (input, ctx) => {
    try {
      const baseDir = resolveDir();

      if (input.handoff_json.length > MAX_JSON_SIZE) {
        throw new Error('handoff_json too large');
      }

      if (input.conversation_md.length > MAX_MD_SIZE) {
        throw new Error('conversation_md too large');
      }

      let parsed = JSON.parse(input.handoff_json);
      const handoff = HandoffSchema.parse(parsed);

      assertSafeLabel(handoff.task_label);
      const safe = path.basename(handoff.task_label);

      const taskDir = path.join(baseDir, safe);
      await fs.mkdir(taskDir, { recursive: true });

      let jsonPath = path.join(taskDir, `${safe}.json`);
      let mdPath = path.join(taskDir, `${safe}.md`);

      // versioning (UNCHANGED LOGIC)
      if (!input.allow_overwrite) {
        let v = 1;
        while (await exists(jsonPath)) {
          jsonPath = path.join(taskDir, `${safe}_v${v}.json`);
          mdPath = path.join(taskDir, `${safe}_v${v}.md`);
          v++;
        }
      }

      let md = input.conversation_md;
      if (!input.include_full_conversation) {
        md = md.slice(0, 10_000);
      }

      await atomicWrite(jsonPath, JSON.stringify(handoff, null, 2));
      await atomicWrite(mdPath, md);

      // index update (UNCHANGED BEHAVIOR)
      await updateIndex(baseDir, {
        task_id: handoff.task_id,
        task_label: handoff.task_label,
        json_path: jsonPath,
        md_path: mdPath,
        status: handoff.status,
        source: handoff.source,
        created_at: handoff.created_at,
      });

      return {
        content: [{ type: 'text', text: 'Saved successfully' }],
        structuredContent: {
          jsonPath,
          mdPath,
          task_id: handoff.task_id,
        },
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `ERROR: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL: get_handoff (COMPATIBLE)
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'get_handoff',
  {
    title: 'Get Handoff',
    description: 'Fetch single handoff by task_id',
    inputSchema: z.object({
      task_id: z.string(),
      include_conversation: z.boolean().default(false),
    }),
  },

  async (input) => {
    const baseDir = resolveDir();
    const index = await loadIndex(baseDir);

    const entry = index.by_task_id[input.task_id];
    if (!entry) throw new Error('Handoff not found');

    const json = JSON.parse(await fs.readFile(entry.json_path, 'utf8'));

    let conversation = null;
    if (input.include_conversation) {
      try {
        conversation = await fs.readFile(entry.md_path, 'utf8');
      } catch {}
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ...json, conversation }, null, 2),
        },
      ],
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL: list_handoffs (COMPATIBLE)
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'list_handoffs',
  {
    title: 'List Handoffs',
    description: 'List all handoffs using index',
    inputSchema: z.object({
      status: z.enum(['completed', 'flagged', 'approved', 'rejected', 'needs_review']).optional(),
      source: z.enum(['SPSA', 'SPBED', 'SPQAE']).optional(),
      limit: z.number().default(20),
    }),
  },

  async (input) => {
    const baseDir = resolveDir();
    const index = await loadIndex(baseDir);

    let items = Object.values(index.by_task_id);

    if (input.status) {
      items = items.filter((x: any) => x.status === input.status);
    }

    if (input.source) {
      items = items.filter((x: any) => x.source === input.source);
    }

    items = items
      .sort((a: any, b: any) => +new Date(b.created_at ?? 0) - +new Date(a.created_at ?? 0))
      .slice(0, input.limit);

    return {
      content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
