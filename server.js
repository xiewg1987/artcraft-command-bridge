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

const { APPS, APP_BY_ID, cleanupGeneratedFiles } = require('./lib/apps');
const { version: SERVER_VERSION } = require('./package.json');
const { resolveCli, explain } = require('./lib/resolve');
const { execFile, DEFAULT_CAPTURE_CHARS } = require('./lib/exec');
const { getRegistry } = require('./lib/registry');
const {
  MAX_IDS,
  DEFAULT_MAX_PARAM_CHARS,
  MAX_PARAM_CHARS,
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
  tempStreamFile,
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
  const mode = value ?? 'none';
  if (!['auto', 'none', 'image'].includes(mode)) {
    throw new Error('preview must be "auto", "none", or "image"');
  }
  return mode;
}

function previewMaxImages(value) {
  return clampInt(value, 1, 0, 1);
}

/** Build bounded stdout/stderr fields, with base64 redacted. */
function streamFields(text, {
  app, kind, maxChars, maxStringChars, include = true,
  streamTruncated = false, streamFile = null, streamChars = null, writeError = null,
}) {
  const redacted = redactBase64Text(text || '', { maxStringChars });
  const t = streamTruncated
    ? { text: redacted.slice(0, maxChars), truncated: true, file: streamFile, chars: streamChars }
    : truncateStream(redacted, { app, kind, maxChars });
  const fields = {};
  if (t.truncated) {
    fields[`${kind}_truncated`] = true;
    fields[`${kind}_file`] = t.file;
    fields[`${kind}_chars`] = t.chars;
  }
  if (include && t.text) fields[kind] = t.text;
  if (writeError) fields[`${kind}_write_error`] = writeError;
  return fields;
}

function captureBudget(maxOutputChars) {
  return Math.max(DEFAULT_CAPTURE_CHARS, Math.min(1024 * 1024, maxOutputChars * 4));
}

/** Drop repeated command/id/status wrappers from CLI step results. */
function compactStepResults(items) {
  const results = [];
  const errors = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const failed = item.ok === false || item.status === 'error' || item.error !== undefined;
      if (failed) {
        errors.push({
          step: index,
          ...(item.command || item.id || item.tool ? { id: item.command || item.id || item.tool } : {}),
          error: item.error ?? item.message ?? 'command failed',
        });
        results.push(null);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(item, 'result')) {
        results.push(item.result);
        continue;
      }
    }
    results.push(item);
  }
  return { results, ...(errors.length ? { errors } : {}) };
}

function compactRunResults(value) {
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] && typeof value[0] === 'object'
      && value[0].ok !== false && Array.isArray(value[0].steps)) {
      return compactStepResults(value[0].steps);
    }
    return compactStepResults(value);
  }
  if (value && typeof value === 'object' && value.ok !== false && Array.isArray(value.steps)) {
    return compactStepResults(value.steps);
  }
  return { results: value == null ? [] : [value] };
}

function boundArray(items, maxChars, app, kind = 'results') {
  const json = JSON.stringify(items || []);
  if (json.length <= maxChars) return { value: items };

  const file = tempStreamFile(app, kind);
  fs.writeFileSync(file, json, 'utf8');
  const kept = [];
  let size = 2;
  for (const item of items || []) {
    const part = JSON.stringify(item);
    if (size + part.length + (kept.length ? 1 : 0) > maxChars) break;
    kept.push(item);
    size += part.length + (kept.length > 1 ? 1 : 0);
  }
  return {
    value: kept,
    truncated: true,
    file,
    chars: json.length,
    omitted: Math.max(0, (items || []).length - kept.length),
  };
}

function boundValue(value, maxChars, app, kind = 'result') {
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return { value };
  const file = tempStreamFile(app, kind);
  fs.writeFileSync(file, json, 'utf8');
  return {
    value: { omitted: true, chars: json.length, file },
    truncated: true,
    chars: json.length,
  };
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
    const labelled = t.match(/^[^:\s]+:\s*([\[{][\s\S]*)$/);
    if (labelled) {
      try { out.push(JSON.parse(labelled[1])); continue; } catch (e) { /* not json */ }
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

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: 'artcraft_apps',
    description:
      'List installed ArtCraft apps. Returns a compact installed/missing list by default; use detail:"full" only for paths and purposes.',
    inputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['brief', 'full'], description: 'Default brief.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'artcraft_commands',
    description:
      "Find an app's command IDs. Keep filter narrow. List mode returns only IDs; ids:[...] returns parameters for the selected commands.",
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id, e.g. figcraft, photocraft, vectorcraft.' },
        filter: { type: 'string', description: 'Terms matched against id, label and description; multi-word requires all terms. Ranked locally.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_IDS,
          description: `Describe exact IDs (max ${MAX_IDS}).`,
        },
        limit: { type: 'number', description: 'List/full result cap (default 10, max 100).' },
        detail: {
          type: 'string',
          enum: ['auto', 'none', 'full'],
          description: 'auto: params for <=3 matches; none: IDs only; full: params for all returned matches.',
        },
        max_param_chars: { type: 'number', description: 'Cap each params string (default 2400, max 12000).' },
        cache_info: { type: 'boolean', description: 'Include cache diagnostics.' },
        refresh: { type: 'boolean', description: 'Re-read the registry from the CLI and rewrite the local cache (default false).' },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
  {
    name: 'artcraft_run',
    description:
      'Execute {id,params} steps in one headless session. Returns compact results; raw output and image previews are opt-in.',
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
          description: 'none (default): no image; auto: attach a <=1024px image if found; image: require one.',
        },
        preview_max_images: { type: 'number', description: 'Max preview images (default 1, max 1).' },
        include_stdout: { type: 'boolean', description: 'Include raw stdout even when results parsed (default false).' },
        max_output_chars: { type: 'number', description: 'Raw stdout/stderr cap (default 6000, max 50000).' },
        max_string_chars: { type: 'number', description: 'Redact base64/image strings longer than this (default 2048).' },
        max_result_chars: { type: 'number', description: 'Structured result cap (default 8000).' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000).' },
      },
      required: ['app', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'artcraft_cli',
    description:
      'Run a CLI subcommand verbatim. Parses JSON output compactly; raw output and image previews are opt-in.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id, e.g. figcraft, pdfcraft, photocraft.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument list, e.g. ["export","file.figcraft","-o","out.png","--format","png"].' },
        preview: {
          type: 'string',
          enum: ['auto', 'none', 'image'],
          description: 'none (default); auto: infer output image; image: require a preview.',
        },
        preview_file: { type: 'string', description: 'Optional image file to attach; inferred from -o/--out/--export when omitted.' },
        include_stdout: { type: 'boolean', description: 'Include raw stdout even when JSON was parsed.' },
        max_output_chars: { type: 'number', description: 'Raw stdout/stderr cap (default 6000).' },
        max_string_chars: { type: 'number', description: 'Redact long base64/image strings (default 2048).' },
        max_result_chars: { type: 'number', description: 'Parsed JSON result cap (default 8000).' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000).' },
      },
      required: ['app', 'args'],
      additionalProperties: false,
    },
  },
  {
    name: 'artcraft_help',
    description:
      "Return an app's help text, capped by default. Use when command parameters do not cover export/import flags.",
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App id.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional extra args, e.g. ["run"].' },
        max_output_chars: { type: 'number', description: 'Help text cap (default 6000).' },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'artcraft_apps': {
      const detail = args.detail || 'brief';
      if (!['brief', 'full'].includes(detail)) {
        throw new Error('detail must be "brief" or "full"');
      }
      const apps = await Promise.all(APPS.map(async (app) => {
        const cli = cliFor(app);
        return {
          id: app.id,
          label: app.label,
          purpose: app.kind,
          version: detail === 'full' && cli ? await versionOf(app) : null,
          installed: !!cli,
          cli: cli || null,
          run_style: app.style,
        };
      }));
      if (detail === 'full') return { installed_count: apps.filter((a) => a.installed).length, apps };

      const installed = apps.filter((a) => a.installed).map((a) => a.id);
      const missing = apps.filter((a) => !a.installed).map((a) => a.id);
      return {
        installed_count: installed.length,
        installed,
        ...(missing.length ? { missing } : {}),
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
      const maxParamChars = clampInt(
        args.max_param_chars,
        DEFAULT_MAX_PARAM_CHARS,
        256,
        MAX_PARAM_CHARS
      );

      // The registry lives on disk after the first read; a cache hit never
      // spawns the CLI. The cache is keyed by the CLI's path, mtime and size,
      // so an app update invalidates it automatically.
      const entry = await getRegistry(app, cli, { refresh: args.refresh === true });
      const norm = entry.commands;
      const stale = entry.stale ? { stale: true } : {};
      const cache = args.cache_info === true ? {
        cache: {
          hit: entry.cached,
          file: entry.file,
          fetched_at: entry.fetchedAt,
        },
      } : {};

      if (!norm.length) {
        return {
          app: key,
          detail: 'none',
          note: 'This app exposes no command registry; use artcraft_cli / artcraft_help with its subcommands directly.',
          usage: entry.usage || '',
          ...cache,
          ...stale,
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
          detail: 'describe',
          ...(missing.length ? { missing } : {}),
          commands: found.map((c) => projectCommand(c, 'full', { maxParamChars })),
          ...cache,
          ...stale,
        };
      }

      const hit = filterCommands(norm, filter);
      const full = detail === 'full'
        || (detail === 'auto' && hit.length > 0 && hit.length <= 3);
      const visible = hit.slice(0, limit);
      const commands = visible.map(({ command }) => projectCommand(
        command,
        full ? 'full' : 'list',
        { maxParamChars }
      ));

      let hint;
      if (hit.length > limit) {
        hint = `Showing ${limit} of ${hit.length}; narrow the filter or pass ids.`;
      } else if (!hit.length) {
        hint = 'No commands matched.';
      }

      return {
        app: key,
        detail: full ? 'full' : 'list',
        matched: hit.length,
        ...(hit.length > limit ? { truncated: true } : {}),
        commands,
        hint,
        ...cache,
        ...stale,
      };
    }

    case 'artcraft_run': {
      const { key, app, cli } = requireApp(args.app);
      const steps = (args.steps || []).map((s) => ({ id: s.id, params: s.params ?? {} }));
      if (!steps.length) throw new Error('steps must contain at least one {id}');

      const mode = previewMode(args.preview);
      const maxImages = previewMaxImages(args.preview_max_images);
      const maxOutput = clampInt(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, 500, 50000);
      const maxString = clampInt(args.max_string_chars, DEFAULT_MAX_STRING_CHARS, 256, 65536);
      const maxResult = clampInt(args.max_result_chars, 8000, 1000, 50000);
      const timeoutMs = clampInt(args.timeout_ms, 120000, 1000, 1800000);

      const argv = app.build({ steps, input: args.input, output: args.output, params: args.params });
      let r;
      try {
        r = await execFile(cli, argv, {
          timeoutMs,
          captureMaxChars: captureBudget(maxOutput),
        });
      } finally {
        cleanupGeneratedFiles(argv);
      }
      const parsed = parseJsonLines(r.stdout);
      // batch-json apps wrap the step results in {completed, failed, results}.
      const batch = app.style === 'batch-json' && parsed.length === 1
        && parsed[0] && typeof parsed[0] === 'object' && Array.isArray(parsed[0].results)
        ? parsed[0] : null;
      const rawResults = batch ? batch.results : parsed;
      const compact = compactRunResults(rawResults);
      const safeResults = sanitizeValue(compact.results, { maxStringChars: maxString });
      const boundedResults = boundArray(safeResults, maxResult, key);
      const boundedErrors = compact.errors
        ? boundArray(
          sanitizeValue(compact.errors, { maxStringChars: maxString }),
          Math.min(maxResult, 4000),
          key,
          'errors'
        )
        : null;

      const images = [];
      const result = {
        exit_code: r.code,
        ...(r.timedOut ? { timed_out: true } : {}),
        results: boundedResults.value,
        ...(boundedResults.truncated ? {
          results_truncated: true,
          results_file: boundedResults.file,
          results_chars: boundedResults.chars,
          omitted_results: boundedResults.omitted,
        } : {}),
        ...(boundedErrors ? { errors: boundedErrors.value } : {}),
        ...(boundedErrors?.truncated ? {
          errors_truncated: true,
          errors_file: boundedErrors.file,
          errors_chars: boundedErrors.chars,
        } : {}),
        ...(batch ? { batch: { completed: batch.completed, failed: batch.failed } } : {}),
        ...streamFields(r.stdout, {
          app: key, kind: 'stdout', maxChars: maxOutput, maxStringChars: maxString,
          include: args.include_stdout === true || rawResults.length === 0,
          streamTruncated: r.stdoutTruncated, streamFile: r.stdoutFile,
          streamChars: r.stdoutChars, writeError: r.stdoutWriteError,
        }),
        ...streamFields(r.stderr, {
          app: key, kind: 'stderr', maxChars: maxOutput, maxStringChars: maxString,
          streamTruncated: r.stderrTruncated, streamFile: r.stderrFile,
          streamChars: r.stderrChars, writeError: r.stderrWriteError,
        }),
        ...(r.code !== 0 ? { argv: r.argv } : {}),
      };

      if (maxImages > 0 && mode !== 'none') {
        const found = previewFromRun({ output: args.output, results: rawResults });
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
      const maxOutput = clampInt(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, 500, 50000);
      const maxString = clampInt(args.max_string_chars, DEFAULT_MAX_STRING_CHARS, 256, 65536);
      const maxResult = clampInt(args.max_result_chars, 8000, 1000, 50000);
      const timeoutMs = clampInt(args.timeout_ms, 120000, 1000, 1800000);

      const r = await execFile(cli, argv, {
        timeoutMs,
        captureMaxChars: captureBudget(maxOutput),
      });
      const parsed = parseJsonLines(r.stdout);
      const structured = parsed.some((item) => item && typeof item === 'object');
      const parsedValue = sanitizeValue(parsed.length === 1 ? parsed[0] : parsed, {
        maxStringChars: maxString,
      });
      const boundedResult = structured ? boundValue(parsedValue, maxResult, key) : null;
      const images = [];
      const result = {
        exit_code: r.code,
        ...(r.timedOut ? { timed_out: true } : {}),
        ...(boundedResult ? { result: boundedResult.value } : {}),
        ...(boundedResult?.truncated ? {
          result_truncated: true,
          result_chars: boundedResult.chars,
        } : {}),
        ...streamFields(r.stdout, {
          app: key, kind: 'stdout', maxChars: maxOutput, maxStringChars: maxString,
          include: !structured || args.include_stdout === true,
          streamTruncated: r.stdoutTruncated, streamFile: r.stdoutFile,
          streamChars: r.stdoutChars, writeError: r.stdoutWriteError,
        }),
        ...streamFields(r.stderr, {
          app: key, kind: 'stderr', maxChars: maxOutput, maxStringChars: maxString,
          streamTruncated: r.stderrTruncated, streamFile: r.stderrFile,
          streamChars: r.stderrChars, writeError: r.stderrWriteError,
        }),
        ...(r.code !== 0 ? { argv: r.argv } : {}),
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
      const maxOutput = clampInt(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, 500, 30000);
      const r = await execFile(cli, argv, {
        timeoutMs: 30000,
        captureMaxChars: captureBudget(maxOutput),
      });
      const fromStdout = !!r.stdout;
      const usage = redactBase64Text(r.stdout || r.stderr || '', { maxStringChars: DEFAULT_MAX_STRING_CHARS });
      const t = fromStdout && r.stdoutTruncated
        ? { text: usage.slice(0, maxOutput), truncated: true, file: r.stdoutFile, chars: r.stdoutChars }
        : !fromStdout && r.stderrTruncated
          ? { text: usage.slice(0, maxOutput), truncated: true, file: r.stderrFile, chars: r.stderrChars }
          : truncateStream(usage, { app: key, kind: 'help', maxChars: maxOutput });
      return {
        ...(r.code !== 0 ? { exit_code: r.code } : {}),
        ...(r.timedOut ? { timed_out: true } : {}),
        usage: t.text,
        ...(t.truncated ? { usage_truncated: true, usage_file: t.file, usage_chars: t.chars } : {}),
        ...(r.code !== 0 ? { argv: r.argv } : {}),
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
      serverInfo: { name: 'artcraft-command-bridge', version: SERVER_VERSION },
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

      const response = { content };
      if (process.env.ARTCRAFT_STRUCTURED === '1') response.structuredContent = result;
      send({
        jsonrpc: '2.0', id,
        result: response,
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
