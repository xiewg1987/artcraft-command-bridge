#!/usr/bin/env node
/**
 * artcraft-command-bridge — one MCP server for the 15 ArtCraft Crafting Apps.
 *
 * Each Crafting App ships its own MCP server that exposes every engine
 * command as a separate tool (871 tools / 640.8 KB of schema in total). MCP
 * clients register a server's tools in full, and that schema is re-sent on
 * every request — so connecting the 15 apps directly costs ~164k tokens of
 * permanently resident context.
 *
 * This bridge talks to the apps' CLIs instead of their MCP servers and
 * exposes 5 tools. The apps already share one model (`commands` lists stable
 * command IDs, `run` executes them); this is just an argv translation per app.
 *
 * stdio, newline-delimited JSON-RPC. Zero dependencies.
 */

'use strict';

const fs = require('fs');
const os = require('os');

const { APPS, APP_BY_ID } = require('./lib/apps');
const { resolveCli, explain } = require('./lib/resolve');
const { execFile } = require('./lib/exec');
const { getRegistry } = require('./lib/registry');
const {
  MAX_IDS,
  limitValue,
  filterCommands,
  projectCommand,
} = require('./lib/commands');
const {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_STRING_CHARS,
  clampInt,
  redactBase64Text,
  sanitizeValue,
  truncateStream,
} = require('./lib/output');
const {
  previewFromRun,
  previewFromCli,
  imageMeta,
} = require('./lib/preview');

/* ---------------------------------------------------------------- helpers */

const cliCache = new Map();     // app id -> absolute path | null
const versionCache = new Map();  // app id -> version string | null

// Images travel as MCP image blocks, never as text/structuredContent.
const TOOL_IMAGES = Symbol('artcraft.images');

function withImages(result, images) {
  if (images && images.length) result[TOOL_IMAGES] = images;
  return result;
}

function previewMode(value) {
  const mode = value ?? 'auto';
  if (!['auto', 'none', 'image'].includes(mode)) {
    throw new Error('preview must be "auto", "none", or "image"');
  }
  return mode;
}

function previewMaxImages(value) {
  return clampInt(value, 1, 0, 1);
}

/** Build truncated stdout/stderr fields, with base64 redacted. */
function streamFields(text, { app, kind, maxChars, maxStringChars, include = true }) {
  const redacted = redactBase64Text(text || '', { maxStringChars });
  const t = truncateStream(redacted, { app, kind, maxChars });
  const fields = {};
  if (t.truncated) {
    fields[`${kind}_truncated`] = true;
    fields[`${kind}_file`] = t.file;
    fields[`${kind}_chars`] = t.chars;
  }
  if (include && t.text) fields[kind] = t.text;
  return fields;
}

function cliFor(app) {
  if (!cliCache.has(app.id)) {
    const found = resolveCli(app);
    cliCache.set(app.id, found);
    if (!found) {
      process.stderr.write(
        `[artcraft-command-bridge] ${app.label} CLI not found. Set ` +
        `ARTCRAFT_${app.cliName.replace(/-/g, '_').toUpperCase()}_CLI or ARTCRAFT_HOME.\n`
      );
    }
  }
  return cliCache.get(app.id);
}

async function versionOf(app) {
  if (versionCache.has(app.id)) return versionCache.get(app.id);
  const cli = cliFor(app);
  if (!cli) { versionCache.set(app.id, null); return null; }
  const r = await execFile(cli, ['--version'], { timeoutMs: 20000 });
  const m = (r.stdout || r.stderr || '').match(/\d+\.\d+\.\d+[^\s)]*/);
  const v = m ? m[0] : null;
  versionCache.set(app.id, v);
  return v;
}

function parseJsonLines(text) {
  const trimmed = (text || '').trim();
  if (trimmed) {
    try {
      // One pretty-printed document (e.g. a TextureCraft/MaterialCraft batch
      // result) must be parsed as a whole; line splitting would keep braces.
      return [JSON.parse(trimmed)];
    } catch (e) { /* fall through to line-delimited JSON */ }
  }

  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.startsWith('[')) {
      try { out.push(JSON.parse(t)); continue; } catch (e) { /* not json */ }
    }
    out.push(t);
  }
  return out;
}

function requireApp(id) {
  const key = String(id || '').toLowerCase().replace(/[^a-z]/g, '');
  const app = APP_BY_ID.get(key);
  if (!app) {
    throw new Error(`unknown app "${id}". available: ${APPS.map((a) => a.id).join(', ')}`);
  }
  const cli = cliFor(app);
  if (!cli) {
    throw new Error(
      `${app.label} CLI not found. Install ${app.label} or set ` +
      `ARTCRAFT_${app.cliName.replace(/-/g, '_').toUpperCase()}_CLI. Probed: ${explain(app).slice(0, 6).join(' | ')}`
    );
  }
  return { key, app, cli };
}

/** Remove the throwaway script files that script-style apps need (FigCraft/FilmCraft/TextureCraft/MaterialCraft). */
function cleanupTempFiles(argv) {
  const tmp = os.tmpdir();
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith(tmp)) continue;
    if (!/\.(json|jsonl)$/i.test(a)) continue;
    try { fs.unlinkSync(a); } catch (e) { /* already gone */ }
  }
}

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: 'artcraft_apps',
    description:
      'List the ArtCraft applications available locally (PhotoCraft, LightCraft, VectorCraft, DesignCraft, GridCraft, ' +
      'SoundCraft, DeckCraft, WordCraft, CADCraft, EffectCraft, FilmCraft, FigCraft, TextureCraft, MaterialCraft, ' +
      'PdfCraft) with their purpose, version, install status and how their `run` argv is built. Start here to pick ' +
      'the right app for a task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'artcraft_commands',
    description:
      "Discover an app's stable command IDs from its own registry. List mode returns only {id,label}; a narrow " +
      'filter (<=3 matches) or ids:[...] returns full params. Use ids for the commands you will actually run. ' +
      'The registry is cached locally; pass refresh:true after an app update.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id, e.g. figcraft, photocraft, vectorcraft.' },
        filter: { type: 'string', description: 'Terms matched against id, label and description; multi-word requires all terms. Ranked locally.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_IDS,
          description: `Describe these exact command IDs with full params (max ${MAX_IDS}).`,
        },
        limit: { type: 'number', description: 'Max commands in list/full mode (default 20, max 200).' },
        detail: {
          type: 'string',
          enum: ['auto', 'none', 'full'],
          description: 'auto: full params only for narrow (<=3) matches; none: list only; full: always include params.',
        },
        refresh: { type: 'boolean', description: 'Re-read the registry from the CLI and rewrite the local cache (default false).' },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
  {
    name: 'artcraft_run',
    description:
      "Execute one or more stable command IDs of an ArtCraft app in order (the app's own headless engine). Steps are " +
      '{id, params} pairs; params is a JSON object matching that command\'s documented parameters. Returns each step\'s ' +
      'result plus the exit code. stdout is omitted when results exist unless include_stdout:true; large output is ' +
      'truncated to a temp file; base64 is redacted; visual output can attach one image block.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id, e.g. figcraft, photocraft, vectorcraft.' },
        steps: {
          type: 'array',
          description: 'Commands to execute in order.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable command ID, e.g. node.create.' },
              params: { type: 'object', description: 'Command parameters as a JSON object.' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        input: { type: 'string', description: 'Optional input file (opened as the document for this run).' },
        output: { type: 'string', description: 'Optional output file to write.' },
        params: { type: 'object', description: 'Optional run-level parameters (app-specific, e.g. document skeleton).' },
        preview: {
          type: 'string',
          enum: ['auto', 'none', 'image'],
          description: 'auto: attach an image when output/result is an image; none: never; image: require one (default auto).',
        },
        preview_max_images: { type: 'number', description: 'Max preview images (default 1, max 1).' },
        include_stdout: { type: 'boolean', description: 'Include raw stdout even when results parsed (default false).' },
        max_output_chars: { type: 'number', description: 'Truncate stdout/stderr after this many chars (default 20000).' },
        max_string_chars: { type: 'number', description: 'Redact base64/image strings longer than this (default 4096).' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000).' },
      },
      required: ['app', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'artcraft_cli',
    description:
      'Escape hatch: run any ArtCraft CLI subcommand verbatim (convert / export / render / info / batch / version ...). ' +
      'Use when a capability is not a stable command ID — file conversion, rendering to PNG/SVG/PDF, document info. ' +
      'Args are passed to the CLI exactly as given, no shell interpretation. stdout is truncated; pass preview:auto ' +
      'or preview:image (and optional preview_file) to attach one image block.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id, e.g. figcraft, pdfcraft, photocraft.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument list, e.g. ["export","file.figcraft","-o","out.png","--format","png"].' },
        preview: {
          type: 'string',
          enum: ['auto', 'none', 'image'],
          description: 'auto: infer -o/--out and attach an image if it exists; none: never; image: require one (default auto).',
        },
        preview_file: { type: 'string', description: 'Optional image file to attach; inferred from -o/--out/--export when omitted.' },
        max_output_chars: { type: 'number', description: 'Truncate stdout/stderr after this many chars (default 20000).' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000).' },
      },
      required: ['app', 'args'],
      additionalProperties: false,
    },
  },
  {
    name: 'artcraft_help',
    description:
      "Return an app's own CLI usage text (its --help output). Use to learn the exact subcommand flags of an app when " +
      'artcraft_commands does not cover the operation (e.g. export flags, batch options).',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional extra args, e.g. ["run"].' },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'artcraft_apps': {
      const apps = [];
      for (const app of APPS) {
        const cli = cliFor(app);
        apps.push({
          id: app.id,
          label: app.label,
          purpose: app.kind,
          version: cli ? await versionOf(app) : null,
          installed: !!cli,
          cli: cli || null,
          run_style: app.style,
        });
      }
      return {
        installed_count: apps.filter((a) => a.installed).length,
        apps,
        note: 'Use artcraft_commands for exact command IDs, artcraft_run to execute them.',
      };
    }

    case 'artcraft_commands': {
      const { key, app, cli } = requireApp(args.app);
      const filter = String(args.filter || '').trim();
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : null;
      const detail = args.detail || 'auto';
      if (ids && filter) throw new Error('pass filter or ids, not both');
      if (ids && ids.length > MAX_IDS) throw new Error(`ids supports at most ${MAX_IDS} command IDs`);
      if (!['auto', 'none', 'full'].includes(detail)) {
        throw new Error('detail must be "auto", "none", or "full"');
      }
      const limit = limitValue(args.limit);

      // The registry lives on disk after the first read; a cache hit never
      // spawns the CLI. The cache is keyed by the CLI's path, mtime and size,
      // so an app update invalidates it automatically.
      const entry = await getRegistry(app, cli, { refresh: args.refresh === true });
      const norm = entry.commands;
      const cache = {
        hit: entry.cached,
        file: entry.file,
        fetched_at: entry.fetchedAt,
        ...(entry.stale ? { stale: true } : {}),
      };

      if (!norm.length) {
        return {
          app: key,
          source: entry.source,
          cache,
          detail: 'none',
          note: 'This app exposes no command registry; use artcraft_cli / artcraft_help with its subcommands directly.',
          usage: entry.usage || '',
        };
      }

      // Describe mode: exact IDs, full params, no ranking or truncation.
      if (ids) {
        const byId = new Map(norm.map((c) => [String(c.id).toLowerCase(), c]));
        const requested = [...new Set(ids)];
        const found = [];
        const missing = [];
        for (const id of requested) {
          const command = byId.get(id.toLowerCase());
          if (command) found.push(command); else missing.push(id);
        }
        return {
          app: key,
          source: entry.source,
          cache,
          detail: 'describe',
          total: norm.length,
          requested: requested.length,
          matched: found.length,
          ...(missing.length ? { missing } : {}),
          commands: found.map((c) => projectCommand(c, 'full')),
          hint: missing.length ? `Unknown ids: ${missing.join(', ')}. Use filter to find them.` : undefined,
        };
      }

      const hit = filterCommands(norm, filter);
      const full = detail === 'full'
        || (detail === 'auto' && hit.length > 0 && hit.length <= 3);
      const visible = hit.slice(0, limit);
      const commands = visible.map(({ command }) => projectCommand(command, full ? 'full' : 'list'));

      let hint;
      if (hit.length > limit) {
        hint = `Showing ${limit} of ${hit.length} matches — narrow the filter or pass ids.`;
      } else if (!full) {
        hint = hit.length
          ? `${hit.length} matches; pass ids:[...] to get params for the commands you will run.`
          : 'No commands matched; try a different filter.';
      }

      return {
        app: key,
        source: entry.source,
        cache,
        detail: full ? 'full' : 'list',
        total: norm.length,
        matched: hit.length,
        truncated: hit.length > limit,
        commands,
        hint,
      };
    }

    case 'artcraft_run': {
      const { key, app, cli } = requireApp(args.app);
      const steps = (args.steps || []).map((s) => ({ id: s.id, params: s.params ?? {} }));
      if (!steps.length) throw new Error('steps must contain at least one {id}');

      const mode = previewMode(args.preview);
      const maxImages = previewMaxImages(args.preview_max_images);
      const maxOutput = clampInt(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, 1000, 200000);
      const maxString = clampInt(args.max_string_chars, DEFAULT_MAX_STRING_CHARS, 256, 65536);

      const argv = app.build({ steps, input: args.input, output: args.output, params: args.params });
      let r;
      try {
        r = await execFile(cli, argv, { timeoutMs: args.timeout_ms ?? 120000 });
      } finally {
        cleanupTempFiles(argv);
      }
      const parsed = parseJsonLines(r.stdout);
      // batch-json apps wrap the step results in {completed, failed, results}.
      const batch = app.style === 'batch-json' && parsed.length === 1
        && parsed[0] && typeof parsed[0] === 'object' && Array.isArray(parsed[0].results)
        ? parsed[0] : null;
      const results = batch ? batch.results : parsed;

      const images = [];
      const result = {
        app: key,
        run_style: app.style,
        argv: r.argv,
        exit_code: r.code,
        timed_out: !!r.timedOut,
        results: sanitizeValue(results, { maxStringChars: maxString }),
        ...(batch ? { batch: { completed: batch.completed, failed: batch.failed } } : {}),
        ...streamFields(r.stdout, {
          app: key, kind: 'stdout', maxChars: maxOutput, maxStringChars: maxString,
          include: args.include_stdout === true || results.length === 0,
        }),
        ...streamFields(r.stderr, {
          app: key, kind: 'stderr', maxChars: maxOutput, maxStringChars: maxString,
        }),
      };

      if (maxImages > 0 && mode !== 'none') {
        const found = previewFromRun({ output: args.output, results });
        if (found.image) {
          images.push({ data: found.image.data, mimeType: found.image.mimeType });
          result.preview = imageMeta(found.image);
        } else if (mode === 'image') {
          result.preview_warning = found.warning
            || 'No image output found. Write an image output or export one with artcraft_cli.';
        } else if (found.warning) {
          result.preview_warning = found.warning;
        }
      }

      return withImages(result, images);
    }

    case 'artcraft_cli': {
      const { key, app, cli } = requireApp(args.app);
      const argv = (args.args || []).map(String);
      const mode = previewMode(args.preview);
      const maxOutput = clampInt(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, 1000, 200000);
      const maxString = clampInt(args.max_string_chars, DEFAULT_MAX_STRING_CHARS, 256, 65536);

      const r = await execFile(cli, argv, { timeoutMs: args.timeout_ms ?? 120000 });
      const images = [];
      const result = {
        app: key,
        argv: r.argv,
        exit_code: r.code,
        timed_out: !!r.timedOut,
        ...streamFields(r.stdout, { app: key, kind: 'stdout', maxChars: maxOutput, maxStringChars: maxString }),
        ...streamFields(r.stderr, { app: key, kind: 'stderr', maxChars: maxOutput, maxStringChars: maxString }),
      };

      if (mode !== 'none') {
        const found = previewFromCli({ previewFile: args.preview_file, args: argv });
        if (found.image) {
          images.push({ data: found.image.data, mimeType: found.image.mimeType });
          result.preview = imageMeta(found.image);
        } else if (mode === 'image' || args.preview_file) {
          result.preview_warning = found.warning
            || 'No image preview found. Pass preview_file or an image -o/--out path.';
        }
      }

      return withImages(result, images);
    }

    case 'artcraft_help': {
      const { key, app, cli } = requireApp(args.app);
      const argv = args.args && args.args.length ? args.args : ['--help'];
      const r = await execFile(cli, argv, { timeoutMs: 30000 });
      const usage = redactBase64Text(r.stdout || r.stderr || '', { maxStringChars: DEFAULT_MAX_STRING_CHARS });
      const t = truncateStream(usage, { app: key, kind: 'help', maxChars: DEFAULT_MAX_OUTPUT_CHARS });
      return {
        app: key,
        argv: r.argv,
        exit_code: r.code,
        usage: t.text,
        ...(t.truncated ? { usage_truncated: true, usage_file: t.file, usage_chars: t.chars } : {}),
      };
    }

    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

/* ------------------------------------------------------------ MCP plumbing */

const PROTOCOL = '2024-11-05';

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg).catch(() => {});
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'artcraft-command-bridge', version: '1.2.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args);
      const images = Array.isArray(result[TOOL_IMAGES]) ? result[TOOL_IMAGES] : [];
      delete result[TOOL_IMAGES];

      const content = [{ type: 'text', text: JSON.stringify(result) }];
      for (const image of images.slice(0, 1)) {
        if (image && typeof image.data === 'string' && typeof image.mimeType === 'string') {
          content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
        }
      }

      send({
        jsonrpc: '2.0', id,
        result: {
          content,
          structuredContent: result,
        },
      });
    } catch (e) {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true },
      });
    }
    return;
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

process.on('uncaughtException', (e) => { process.stderr.write(`[artcraft-command-bridge] ${e.stack}\n`); });
