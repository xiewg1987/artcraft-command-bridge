#!/usr/bin/env node
/**
 * Pull command registries into the local cache.
 *
 *   node tools/sync-registry.js                 # fetch every installed app
 *   node tools/sync-registry.js --check         # only fill missing/stale entries
 *   node tools/sync-registry.js --app figcraft  # one or more apps
 *   node tools/sync-registry.js --clear         # delete cached files
 *
 * The cache is keyed by each CLI's path + mtime + size, so updating an app
 * invalidates its entry automatically.
 */

'use strict';

const { APPS } = require('../lib/apps');
const { resolveCli } = require('../lib/resolve');
const { getRegistry, cacheRoot, clearCache } = require('../lib/registry');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const wanted = argv.filter((a) => !a.startsWith('--'));
const refresh = !flags.has('--check');
const clear = flags.has('--clear');

if (flags.has('--help') || flags.has('-h')) {
  console.log(`Usage: node tools/sync-registry.js [options] [app ...]

  (no flag)        fetch every installed app and rewrite the cache
  --check          use the cache when fresh; fetch only missing/stale entries
  --app <ids...>   limit to these app ids (positional, e.g. figcraft pdfcraft)
  --clear          delete cached files instead of fetching
  --help, -h       show this text`);
  return;
}

const known = new Set(APPS.map((a) => a.id));
for (const id of wanted) {
  if (!known.has(id)) {
    console.error(`unknown app "${id}". available: ${APPS.map((a) => a.id).join(', ')}`);
    process.exit(1);
  }
}

(async () => {
  if (clear) {
    let n = 0;
    for (const app of APPS) {
      if (wanted.length && !wanted.includes(app.id)) continue;
      if (clearCache(app)) n++;
    }
    console.log(`Cleared ${n} cached registr${n === 1 ? 'y' : 'ies'} under ${cacheRoot()}`);
    return;
  }

  let total = 0, bytes = 0, fetched = 0, hits = 0;
  for (const app of APPS) {
    if (wanted.length && !wanted.includes(app.id)) continue;
    const cli = resolveCli(app);
    if (!cli) {
      console.log(`${app.label.padEnd(13)} NOT INSTALLED`);
      continue;
    }
    const t0 = Date.now();
    try {
      const entry = await getRegistry(app, cli, { refresh });
      const ms = Date.now() - t0;
      const size = Buffer.byteLength(JSON.stringify(entry.commands), 'utf8');
      total += entry.commands.length;
      bytes += size;
      if (entry.cached) hits++; else fetched++;
      console.log(
        `${app.label.padEnd(13)} ${String(entry.commands.length).padStart(4)} commands  ` +
        `${(size / 1024).toFixed(1).padStart(7)} KB  ${String(entry.source).padEnd(5)}  ` +
        `${entry.cached ? 'cache' : 'fetch'}  ${ms}ms`
      );
    } catch (e) {
      console.log(`${app.label.padEnd(13)} ERROR ${e.message}`);
    }
  }

  console.log(`\n${total} commands, ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`cache: ${cacheRoot()}`);
  console.log(`${fetched} fetched, ${hits} cache hit`);
})();
