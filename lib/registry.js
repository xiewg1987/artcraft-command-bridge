/**
 * Local command-registry cache.
 *
 * `artcraft_commands` used to spawn `<app>-cli commands` on every call. The
 * registry only changes when the app binary changes, so keep it on disk and
 * key the cache by the CLI's path, mtime and size. A cache hit never spawns
 * the CLI.
 *
 * Cache layout (one file per app):
 *   <root>/<app id>.json
 *   {
 *     schema: 1,
 *     app: "figcraft",
 *     cli: "C:\\Program Files\\FigCraft\\figcraft-cli.exe",
 *     cliMtimeMs: 1730000000000,
 *     cliSize: 12345678,
 *     fetchedAt: "2026-11-02T...",
 *     source: "json" | "tools" | "text" | "help",
 *     argv: ["figcraft-cli", "commands", "--json"],
 *     commands: [{ id, label, params, enabled, disabled_reason, description? }],
 *     usage?: "..."
 *   }
 *
 * ARTCRAFT_CACHE_DIR overrides the root.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFile } = require('./exec');

const CACHE_SCHEMA = 1;
const inflight = new Map(); // app id -> Promise
let warnedWrite = false;

/* ---------------------------------------------------------------- paths */

function defaultRoot() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'artcraft-command-bridge', 'registry');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'artcraft-command-bridge', 'registry');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'artcraft-command-bridge', 'registry');
}

function cacheRoot() {
  return process.env.ARTCRAFT_CACHE_DIR
    ? path.resolve(process.env.ARTCRAFT_CACHE_DIR)
    : defaultRoot();
}

function cacheFile(app) {
  return path.join(cacheRoot(), `${app.id}.json`);
}

/* ------------------------------------------------------------- parsing */

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

function normalize(list) {
  return list
    .filter((c) => c && c.id)
    .map((c) => ({
      id: String(c.id),
      label: c.label ?? null,
      params: c.params ?? null,
      enabled: c.enabled ?? null,
      disabled_reason: c.disabledReason ?? null,
      ...(c.description ? { description: c.description } : {}),
    }));
}

/* -------------------------------------------------------------- cache */

function cliSignature(cli) {
  try {
    const st = fs.statSync(cli);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return null;
  }
}

function readCache(app) {
  try {
    const raw = fs.readFileSync(cacheFile(app), 'utf8');
    const entry = JSON.parse(raw);
    return entry && typeof entry === 'object' ? entry : null;
  } catch (e) {
    return null;
  }
}

function isFresh(entry, app, cli, sig) {
  return entry.schema === CACHE_SCHEMA
    && entry.app === app.id
    && entry.cli === cli
    && entry.cliMtimeMs === sig.mtimeMs
    && entry.cliSize === sig.size
    && Array.isArray(entry.commands);
}

function writeCache(app, entry) {
  const file = cacheFile(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can refuse to replace an existing file; remove and retry once.
    try { fs.unlinkSync(file); } catch (_) {}
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return file;
}

function clearCache(app) {
  try {
    fs.unlinkSync(cacheFile(app));
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------- fetch */

/**
 * Read one app's registry from its CLI. Tries the three shapes the apps use:
 * JSON, a plain-text table, and PdfCraft's `tools` list. Falls back to
 * `--help` (cached as source "help") when an app has no registry at all.
 */
async function fetchRegistry(app, cli) {
  let list = null;
  let argv = null;
  let source = null;
  let textOut = null;

  for (const a of [['commands', '--json'], ['commands']]) {
    const r = await execFile(cli, a, { timeoutMs: 60000 });
    if (r.code !== 0) continue;
    const parsed = tryParseJsonArray(r.stdout);
    if (parsed && parsed.length) {
      list = parsed;
      argv = r.argv;
      source = 'json';
      break;
    }
    // Keep the plain-text table around instead of asking the CLI again.
    if (a.length === 1 && r.stdout.trim()) textOut = { text: r.stdout, argv: r.argv };
  }

  if (!list && app.id === 'pdfcraft') {
    const r = await execFile(cli, ['tools'], { timeoutMs: 60000 });
    const parsed = tryParseJsonArray(r.stdout);
    if (parsed && parsed.length) {
      list = parsed.map((t) => ({
        id: t.name,
        label: t.command ? `command: ${t.command}` : null,
        params: t.input_schema ? JSON.stringify(t.input_schema) : null,
        enabled: null,
        disabledReason: null,
        description: t.description,
      }));
      argv = r.argv;
      source = 'tools';
    }
  }

  if (!list && textOut) {
    const parsed = parseTextCommands(textOut.text);
    if (parsed.length) {
      list = parsed;
      argv = textOut.argv;
      source = 'text';
    }
  }

  if (!list) {
    const r = await execFile(cli, ['commands'], { timeoutMs: 60000 });
    if (r.code === 0 && r.stdout.trim()) {
      const parsed = parseTextCommands(r.stdout);
      if (parsed.length) {
        list = parsed;
        argv = r.argv;
        source = 'text';
      }
    }
  }

  if (list) {
    return { source, argv, commands: normalize(list) };
  }

  const r = await execFile(cli, ['--help'], { timeoutMs: 30000 });
  const usage = (r.stdout || r.stderr || '').trim();
  if (r.code !== 0 && !usage) {
    throw new Error(`${app.label} CLI returned no command registry and no help text (exit ${r.code}).`);
  }
  return { source: 'help', argv: r.argv, commands: [], usage: usage.slice(0, 4000) };
}

/* --------------------------------------------------------------- API */

/**
 * Return an app's registry, from the local cache when it is fresh and from the
 * CLI otherwise. Concurrent misses for the same app share one CLI read.
 *
 * @param {object} app  entry from lib/apps.js
 * @param {string} cli  absolute CLI path
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<object>} cache entry plus { cached, file, stale? }
 */
async function getRegistry(app, cli, { refresh = false } = {}) {
  const sig = cliSignature(cli);
  if (!sig) throw new Error(`${app.label} CLI not found at ${cli}`);

  const file = cacheFile(app);
  const cached = readCache(app);
  const fresh = cached && isFresh(cached, app, cli, sig);

  if (!refresh && fresh) {
    return { ...cached, cached: true, file };
  }

  const key = app.id;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const fetched = await fetchRegistry(app, cli);
      const entry = {
        schema: CACHE_SCHEMA,
        app: app.id,
        label: app.label,
        cli,
        cliMtimeMs: sig.mtimeMs,
        cliSize: sig.size,
        fetchedAt: new Date().toISOString(),
        source: fetched.source,
        argv: fetched.argv,
        commands: fetched.commands,
        ...(fetched.usage ? { usage: fetched.usage } : {}),
      };

      try {
        writeCache(app, entry);
      } catch (e) {
        if (!warnedWrite) {
          warnedWrite = true;
          process.stderr.write(`[artcraft-command-bridge] registry cache write failed: ${e.message}\n`);
        }
      }
      return { ...entry, cached: false, file };
    } catch (e) {
      if (fresh) {
        process.stderr.write(`[artcraft-command-bridge] ${app.label} registry refresh failed; using stale cache: ${e.message}\n`);
        return { ...cached, cached: true, stale: true, file };
      }
      throw e;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

module.exports = {
  CACHE_SCHEMA,
  cacheRoot,
  cacheFile,
  readCache,
  clearCache,
  getRegistry,
  fetchRegistry,
};
