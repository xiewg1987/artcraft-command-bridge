#!/usr/bin/env node
// Verify that artcraft_commands reads the local registry cache on the second
// call and does not spawn the CLI again.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const APP = 'figcraft';

function start() {
  const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiters = new Map();
  let id = 0;
  p.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); w(m); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    waiters.set(myId, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  return { p, rpc };
}

async function call(rpc, args) {
  const m = await rpc('tools/call', { name: 'artcraft_commands', arguments: args });
  if (m.result?.isError) throw new Error(m.result.content[0].text);
  return JSON.parse(m.result.content[0].text);
}

(async () => {
  const { p, rpc } = start();
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cache-test', version: '1' },
  });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  let t0 = Date.now();
  const first = await call(rpc, { app: APP, filter: 'node.create', limit: 5, refresh: true });
  const firstMs = Date.now() - t0;

  t0 = Date.now();
  const second = await call(rpc, { app: APP, filter: 'node.create', limit: 5 });
  const secondMs = Date.now() - t0;

  p.kill();

  console.log(`${APP} refresh:true -> cache.hit=${first.cache.hit} total=${first.total} ${firstMs}ms`);
  console.log(`${APP} cache hit  -> cache.hit=${second.cache.hit} total=${second.total} ${secondMs}ms`);
  console.log(`cache file: ${second.cache.file}`);

  const ok = first.cache.hit === false
    && second.cache.hit === true
    && first.total > 0
    && second.total === first.total;

  if (!ok) {
    console.error('FAIL: expected refresh miss then cache hit');
    process.exit(1);
  }
  console.log('PASS');
})().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
