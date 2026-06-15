#!/usr/bin/env node
/**
 * MCP Server — Handoff Persistence Tool
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { ZodError } from 'zod';
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

const SAFE_LABEL_REGEX = /^(SPSA|SPBED|SPQAE)-[a-z0-9_-]+-\d{4}$/;
const SAFE_TOKEN_REGEX = /^[a-zA-Z0-9._-]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const HandoffSchema = z.object({
  schema_version: z.literal('1.0'),
  task_id: z.string().uuid(),
  task_label: z.string().regex(SAFE_LABEL_REGEX, 'Invalid task_label format'),
  source: z.enum(['SPSA', 'SPBED', 'SPQAE']),
  destination: z.enum(['SPSA', 'SPBED', 'SPQAE', 'USER']),
  routing_reason: z.string().min(1).max(2000),
  iteration: z.number().int().min(1).max(1000),
  status: z.enum(['completed', 'flagged', 'approved', 'rejected', 'needs_review']),
  artifacts: z.array(z.string().min(1).max(200).regex(SAFE_TOKEN_REGEX)).max(100),
  flags: z.array(z.string().min(1).max(100).regex(SAFE_TOKEN_REGEX)).max(50),
  required_action: z.string().min(1).max(5000),
  context_summary: z.string().min(1).max(10000),
  created_at: z.string().datetime({ offset: true }),
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
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

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, '..', '..', '.opencode', 'handoffs');
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
// INDEX
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
// save_handoff
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'save_handoff',
  {
    title: 'Save Handoff',
    description: 'Stores validated handoff with atomic writes',
    inputSchema: z.object({
      handoff_json: z.string(),
      conversation_md: z.string(),
      include_full_conversation: z.boolean().default(false),
      allow_overwrite: z.boolean().default(false),
    }),
  },

  async (input) => {
    try {
      const baseDir = resolveDir();
      await fs.mkdir(baseDir, { recursive: true });

      if (input.handoff_json.length > MAX_JSON_SIZE) {
        throw new Error('handoff_json too large');
      }

      if (input.conversation_md.length > MAX_MD_SIZE) {
        throw new Error('conversation_md too large');
      }

      let handoff;

      try {
        const parsed = JSON.parse(input.handoff_json);
        handoff = HandoffSchema.parse(parsed);
      } catch (err: any) {
        if (err instanceof ZodError) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ type: 'validation_error', issues: err.issues }, null, 2),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      const safe = path.basename(handoff.task_label);
      const taskDir = path.join(baseDir, safe);
      await fs.mkdir(taskDir, { recursive: true });

      const index = await loadIndex(baseDir);

      if (index.by_task_id[handoff.task_id] && !input.allow_overwrite) {
        return {
          content: [{ type: 'text', text: 'ERROR: task_id already exists' }],
          isError: true,
        };
      }

      let jsonPath = path.join(taskDir, `${safe}.json`);
      let mdPath = path.join(taskDir, `${safe}.md`);

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
// get_handoff
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'get_handoff',
  {
    title: 'Get Handoff',
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
// list_handoffs
// ─────────────────────────────────────────────────────────────────────────────

server.registerTool(
  'list_handoffs',
  {
    title: 'List Handoffs',
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
