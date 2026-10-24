// Exercise the artcraft-mcp aggregation server end to end.
const { spawn } = require('child_process');

const SERVER = require('path').join(__dirname, '..', 'server.js');

function start() {
  const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  p.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));
  p.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); w(m); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    waiters.set(myId, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  return { p, rpc };
}

function show(label, m) {
  if (m.error) { console.log(`\n### ${label}\nERROR ${m.error.message}`); return; }
  const r = m.result;
  if (r.content && r.content[0]) {
    console.log(`\n### ${label}`);
    console.log(r.content[0].text.slice(0, 1200));
  } else {
    console.log(`\n### ${label}`);
    console.log(JSON.stringify(r).slice(0, 1200));
  }
}

(async () => {
  const { p, rpc } = start();
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  });
  console.log('initialize ->', JSON.stringify(init.result?.serverInfo), 'proto', init.result?.protocolVersion);

  const list = await rpc('tools/list', {});
  const tools = list.result.tools;
  console.log(`\ntools/list -> ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  console.log(`schema size -> ${(bytes / 1024).toFixed(1)} KB  (ArtCraft 原生 799 个 = 547.3 KB)`);

  // notification: no reply expected — send raw, do not await
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  show('artcraft_apps', await rpc('tools/call', { name: 'artcraft_apps', arguments: {} }));
  show('artcraft_commands(figcraft, filter=node.create)',
    await rpc('tools/call', { name: 'artcraft_commands', arguments: { app: 'figcraft', filter: 'node.create' } }));
  show('artcraft_run(figcraft: node.create frame)',
    await rpc('tools/call', {
      name: 'artcraft_run', arguments: {
        app: 'figcraft',
        steps: [{ id: 'node.create', params: { type: 'frame', name: 'Probe', width: 320, height: 180 } }],
      },
    }));
  show('artcraft_cli(pdfcraft --version)',
    await rpc('tools/call', { name: 'artcraft_cli', arguments: { app: 'pdfcraft', args: ['--version'] } }));
  show('artcraft_run(bad app)',
    await rpc('tools/call', { name: 'artcraft_run', arguments: { app: 'nope', steps: [{ id: 'x' }] } }));

  p.kill();
})();
