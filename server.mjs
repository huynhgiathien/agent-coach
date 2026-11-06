#!/usr/bin/env node
// Minimal stdio MCP server (newline-delimited JSON-RPC 2.0) exposing agent usage analysis.

import os from 'node:os';
import { createInterface } from 'node:readline';
import { publishDashboard } from './lib/dashboard.mjs';
import { SOURCES, buildDigest, digestJson, filterDigest, formatAssets, formatExamples, renderMarkdown } from './lib/digest.mjs';
import { listAssets } from './lib/inventory.mjs';
import { auditFile, formatAudit } from './lib/standards.mjs';
import { readLastDigest, recordDecision } from './lib/state.mjs';

const KINDS = ['skill', 'agent', 'command', 'context', 'memory'];

/** Digest window, sources and thresholds shared by usage_digest and usage_dashboard. */
const DIGEST_PARAMS = {
  since_days: { type: 'number', description: 'Days of history to analyze (default 90)' },
  sources: { type: 'array', items: { type: 'string', enum: SOURCES }, description: 'CLIs to read (default all)' },
  min_count: { type: 'number', description: 'Minimum occurrences for a prompt pattern (default 3)' },
  include_decided: { type: 'boolean', description: 'Also show findings already accepted or dismissed' },
  name: {
    type: 'string',
    description: 'Only findings whose trigger or target is the skill/agent/command with this name',
  },
};
const digestOf = ({ since_days = 90, sources = SOURCES, min_count = 3, include_decided = false }) =>
  buildDigest({ home: os.homedir(), sinceDays: since_days, sources, minCount: min_count, includeDecided: include_decided });

const TOOLS = [
  {
    name: 'usage_digest',
    annotations: { title: 'Agent usage digest', readOnlyHint: true, openWorldHint: false },
    description:
      'Analyze local Claude Code, Codex, Cursor and omp history: sessions, skill/agent/command use, token cost (with its ' +
      'basis: recorded, allocated or unpriced) and prompt-cache hit rates, repeated prompts, follow-up corrections after a ' +
      'skill/agent/mode/command, costly, overlapping and unused assets, memories worth promoting, skill-standard scores ' +
      'and the measured impact of accepted changes. Each finding has an id for finding_examples and record_decision. ' +
      'Prompt text is redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        ...DIGEST_PARAMS,
        format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format (default markdown)' },
      },
    },
    run: async ({ format = 'markdown', name, ...params }) => {
      const shown = filterDigest(await digestOf(params), name);
      return format === 'json' ? digestJson(shown) : renderMarkdown(shown);
    },
  },
  {
    name: 'usage_dashboard',
    annotations: {
      title: 'Agent usage dashboard',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Build the usage digest, write it as a self-contained HTML dashboard to ~/.agent-coach/dashboard.html (charts of ' +
      'activity and cost, findings, standards, impact) and open it in the default browser. Returns the dashboard path ' +
      'and the markdown digest.',
    inputSchema: {
      type: 'object',
      properties: { ...DIGEST_PARAMS, open: { type: 'boolean', description: 'Open the dashboard in the browser (default true)' } },
    },
    run: async ({ open = true, name, ...params }) => {
      const digest = filterDigest(await digestOf(params), name);
      return `${await publishDashboard(os.homedir(), digest, open)}\n\n${renderMarkdown(digest)}`;
    },
  },
  {
    name: 'check_asset',
    annotations: { title: 'Check a skill against the standards', readOnlyHint: true, openWorldHint: false },
    description:
      'Score one skill, agent or command file against the skill-standards rubric (frontmatter, trigger, size, links, ' +
      'boundary, done criteria, unmeasured claims, agent tools). Returns the score and each failed check.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to SKILL.md or an agent/command .md file; ~ is expanded' } },
      required: ['path'],
    },
    run: async ({ path: file }) => {
      if (typeof file !== 'string' || !file) throw new Error('path is required');
      return formatAudit(await auditFile(file));
    },
  },
  {
    name: 'list_assets',
    annotations: { title: 'List agent assets', readOnlyHint: true, openWorldHint: false },
    description:
      'List skills, agents, commands, context files (CLAUDE.md/AGENTS.md) and memory files with origin, editable flag, ' +
      'uses and last use from the last usage_digest run, and path. Memory lines add project and memory type.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: KINDS, description: 'Only this kind of asset' } },
    },
    run: async ({ kind }) => {
      const home = os.homedir();
      const assets = (await listAssets({ home })).filter((a) => !kind || a.kind === kind);
      return formatAssets(assets, await readLastDigest(home));
    },
  },
  {
    name: 'finding_examples',
    annotations: { title: 'Finding examples', readOnlyHint: true, openWorldHint: false },
    description:
      'Show the stored, redacted examples of one finding from the last usage_digest run: date, CLI, cwd, prompt text, ' +
      'and the prompt or cost it followed.',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'Finding id from usage_digest' },
        limit: { type: 'number', description: 'Maximum examples (default 20)' },
      },
      required: ['finding_id'],
    },
    run: async ({ finding_id, limit = 20 }) => formatExamples(await readLastDigest(os.homedir()), finding_id, limit),
  },
  {
    name: 'record_decision',
    annotations: {
      title: 'Record finding decision',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Record that a finding was accepted (applied) or dismissed. Dismissed findings never reappear; accepted ones ' +
      'reappear only if the pattern keeps happening after today. Accepting stores a baseline metric that later ' +
      'digests compare in their Impact section.',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'Finding id from usage_digest' },
        status: { type: 'string', enum: ['accepted', 'dismissed'] },
        note: { type: 'string', description: 'Optional reason or summary of the change' },
      },
      required: ['finding_id', 'status'],
    },
    run: ({ finding_id, status, note }) => recordDecision(os.homedir(), { id: finding_id, status, note }),
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-coach', version: '0.1.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool ${params?.name}`), { code: -32602 });
      try {
        return { content: [{ type: 'text', text: await tool.run(params.arguments ?? {}) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined;
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message))
    return send({ id: null, error: { code: -32600, message: 'Invalid Request' } });
  try {
    const result = await handle(message);
    if (message.id !== undefined) send({ id: message.id, result });
  } catch (error) {
    if (message.id !== undefined) send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
