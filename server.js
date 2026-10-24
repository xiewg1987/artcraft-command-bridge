#!/usr/bin/env node
/**
 * artcraft-command-bridge — one MCP server for the 13 ArtCraft Crafting Apps.
 *
 * Each Crafting App ships its own MCP server that exposes every engine
 * command as a separate tool (799 tools / 547 KB of schema in total). MCP
 * clients register a server's tools in full, and that schema is re-sent on
 * every request — so connecting the 13 apps directly costs ~140k tokens of
 * permanently resident context.
 *
 * This bridge talks to the apps' CLIs instead of their MCP servers and
 * exposes 5 tools. The apps already share one model (`commands` lists stable
 * command IDs, `run` executes them); this is just an argv translation per app.
 *
 * stdio, newline-delimited JSON-RPC. Zero dependencies.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { APPS, APP_BY_ID } = require('./lib/apps');
const { resolveCli, explain } = require('./lib/resolve');

/* ---------------------------------------------------------------- helpers */

const cliCache = new Map();     // app id -> absolute path | null
const versionCache = new Map();  // app id -> version string | null

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

function execFile(file, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(file, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: `spawn failed: ${e.message}`, argv: [path.basename(file), ...args] });
    }
    let stdout = '', stderr = '', done = false;
    const argv = [path.basename(file), ...args];
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill(); } catch (e) {}
      resolve({ code: -2, stdout, stderr: stderr + `\n[bridge] timed out after ${timeoutMs}ms`, timedOut: true, argv });
    }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    p.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    p.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `spawn error: ${e.message}`, argv });
    });
    p.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, stdout, stderr, argv });
    });
  });
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

/** Parse a JSON array out of CLI stdout, tolerating a BOM or leading noise. */
function tryParseJsonArray(text) {
  if (!text) return null;
  const s = text.replace(/^\uFEFF/, '').trim();
  const start = s.indexOf('[');
  if (start < 0) return null;
  const end = s.lastIndexOf(']');
  if (end <= start) return null;
  try {
    const j = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(j) ? j : null;
  } catch (e) { return null; }
}

/**
 * Parse the plain-text command tables some apps print instead of JSON:
 *   "file.new — New Presentation: {theme?: name, size?: [w,h] pt}"   (DeckCraft)
 *   "session.new      New...      File"                               (SoundCraft)
 */
function parseTextCommands(text) {
  const out = [];
  for (const line of (text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)[ \t]+(.*)$/);
    if (!m) continue;
    const id = m[1];
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id)) continue;
    const rest = m[2].trim();
    const pm = rest.match(/\{.*\}/);
    out.push({
      id,
      label: (pm ? rest.slice(0, pm.index) : rest).replace(/[\u2014\u2013:-]\s*$/, '').trim() || null,
      params: pm ? pm[0] : null,
      enabled: null,
      disabledReason: null,
    });
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

/** Remove the throwaway script files that script-style apps need (FigCraft/FilmCraft). */
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
      'SoundCraft, DeckCraft, WordCraft, CADCraft, EffectCraft, FilmCraft, FigCraft, PdfCraft) with their purpose, ' +
      'version, install status and how their `run` argv is built. Start here to pick the right app for a task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'artcraft_commands',
    description:
      "List an app's stable command IDs with their parameter documentation (from the app's own command registry). " +
      'Use this to discover exact command IDs and parameter names before calling artcraft_run.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id, e.g. figcraft, photocraft, vectorcraft.' },
        filter: { type: 'string', description: 'Optional substring filter on id or label (applied here, not by the app).' },
        limit: { type: 'number', description: 'Max commands to return (default 60).' },
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
      'result plus stdout/stderr and the exit code. This is the deterministic path — prefer it over image models for asset work.',
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
      'Args are passed to the CLI exactly as given, no shell interpretation.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id, e.g. figcraft, pdfcraft, photocraft.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument list, e.g. ["export","file.figcraft","-o","out.png","--format","png"].' },
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
      const filter = String(args.filter || '').toLowerCase();
      const limit = Math.max(1, Math.min(500, args.limit ?? 60));

      // Apps disagree on how the registry is exposed:
      //   JSON      — PhotoCraft/VectorCraft/FigCraft/...: `commands --json`
      //   plain JSON— CADCraft/DesignCraft: `commands` (no --json)
      //   text table— DeckCraft/SoundCraft
      //   tools     — PdfCraft has no `commands` at all: `tools`
      // So try each shape and normalise here.
      let list = null;
      let argv = null;
      let source = null;

      for (const a of [['commands', '--json'], ['commands']]) {
        const r = await execFile(cli, a, { timeoutMs: 60000 });
        if (r.code !== 0) continue;
        const parsed = tryParseJsonArray(r.stdout);
        if (parsed && parsed.length) { list = parsed; argv = r.argv; source = 'json'; break; }
      }

      if (!list && key === 'pdfcraft') {
        const r = await execFile(cli, ['tools'], { timeoutMs: 60000 });
        const parsed = tryParseJsonArray(r.stdout);
        if (parsed) {
          list = parsed.map((t) => ({
            id: t.name,
            label: t.command ? `command: ${t.command}` : null,
            params: t.input_schema ? JSON.stringify(t.input_schema) : null,
            enabled: null,
            disabledReason: null,
            description: t.description,
            read_only: t.read_only ?? null,
          }));
          argv = r.argv; source = 'tools';
        }
      }

      if (!list) {
        for (const a of [['commands'], ['commands', ...(args.filter ? [String(args.filter)] : [])]]) {
          const r = await execFile(cli, a, { timeoutMs: 60000 });
          if (r.code !== 0 || !r.stdout.trim()) continue;
          const parsed = parseTextCommands(r.stdout);
          if (parsed.length) { list = parsed; argv = r.argv; source = 'text'; break; }
        }
      }

      if (!list) {
        const r = await execFile(cli, ['--help'], { timeoutMs: 30000 });
        return {
          app: key,
          note: 'This app exposes no command registry; use artcraft_cli / artcraft_help with its subcommands directly.',
          usage: (r.stdout || r.stderr || '').slice(0, 4000),
        };
      }

      const norm = list.map((c) => ({
        id: c.id,
        label: c.label ?? null,
        params: c.params ?? null,
        enabled: c.enabled ?? null,
        disabled_reason: c.disabledReason ?? null,
        ...(c.description ? { description: c.description } : {}),
      }));
      const hit = filter
        ? norm.filter((c) => String(c.id).toLowerCase().includes(filter)
          || String(c.label || '').toLowerCase().includes(filter)
          || String(c.description || '').toLowerCase().includes(filter))
        : norm;
      return {
        app: key,
        source,
        argv,
        total: norm.length,
        matched: hit.length,
        truncated: hit.length > limit,
        commands: hit.slice(0, limit),
        hint: hit.length > limit ? `Showing ${limit} of ${hit.length} matches — narrow the filter.` : undefined,
      };
    }

    case 'artcraft_run': {
      const { key, app, cli } = requireApp(args.app);
      const steps = (args.steps || []).map((s) => ({ id: s.id, params: s.params ?? {} }));
      if (!steps.length) throw new Error('steps must contain at least one {id}');
      const argv = app.build({ steps, input: args.input, output: args.output, params: args.params });
      let r;
      try {
        r = await execFile(cli, argv, { timeoutMs: args.timeout_ms ?? 120000 });
      } finally {
        cleanupTempFiles(argv);
      }
      const parsed = parseJsonLines(r.stdout);
      return {
        app: key,
        run_style: app.style,
        argv: r.argv,
        exit_code: r.code,
        timed_out: !!r.timedOut,
        results: parsed,
        stdout: parsed.length === 1 ? undefined : r.stdout,
        stderr: r.stderr || undefined,
      };
    }

    case 'artcraft_cli': {
      const { key, app, cli } = requireApp(args.app);
      const argv = (args.args || []).map(String);
      const r = await execFile(cli, argv, { timeoutMs: args.timeout_ms ?? 120000 });
      return {
        app: key,
        argv: r.argv,
        exit_code: r.code,
        timed_out: !!r.timedOut,
        stdout: r.stdout,
        stderr: r.stderr || undefined,
      };
    }

    case 'artcraft_help': {
      const { key, app, cli } = requireApp(args.app);
      const argv = args.args && args.args.length ? args.args : ['--help'];
      const r = await execFile(cli, argv, { timeoutMs: 30000 });
      return { app: key, argv: r.argv, exit_code: r.code, usage: r.stdout || r.stderr };
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
      serverInfo: { name: 'artcraft-command-bridge', version: '1.0.0' },
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
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
