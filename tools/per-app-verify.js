// Verify each app's `run` argv translation against its real engine.
const { spawn } = require('child_process');

const SERVER = require('path').join(__dirname, '..', 'server.js');
const APPS = ['photocraft', 'lightcraft', 'vectorcraft', 'designcraft', 'gridcraft', 'soundcraft',
  'deckcraft', 'wordcraft', 'cadcraft', 'effectcraft', 'filmcraft', 'figcraft', 'pdfcraft'];

function start() {
  const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); let id = 0;
  p.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));
  p.stdout.on('data', (d) => {
    buf += d.toString('utf8'); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id; waiters.set(myId, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  return { p, rpc };
}

async function call(rpc, name, args) {
  const m = await rpc('tools/call', { name, arguments: args });
  if (m.result?.isError) return { error: m.result.content[0].text.replace(/^ERROR:\s*/, '') };
  try { return JSON.parse(m.result.content[0].text); } catch (e) { return { raw: m.result.content[0].text }; }
}

(async () => {
  const { p, rpc } = start();
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  for (const app of APPS) {
    const cmds = await call(rpc, 'artcraft_commands', { app, limit: 3 });
    if (cmds.error || cmds.raw) {
      console.log(`${app.padEnd(13)} commands: ${cmds.error ? 'ERR ' + cmds.error.slice(0, 70) : 'RAW ' + String(cmds.raw).slice(0, 70).replace(/\n/g, ' ')}`);
      continue;
    }
    const ids = (cmds.commands || []).map((c) => c.id);
    const first = ids[0];
    console.log(`\n=== ${app} === total=${cmds.total} sample=${JSON.stringify(ids)}`);

    if (!first) { console.log('  (no commands exposed)'); continue; }
    const run = await call(rpc, 'artcraft_run', { app, steps: [{ id: first, params: {} }], timeout_ms: 60000 });
    const argv = JSON.stringify(run.argv || []);
    if (run.error) {
      console.log(`  run(${first}) ERROR ${run.error.slice(0, 90)}`);
      console.log(`  argv ${argv}`);
    } else {
      const out = JSON.stringify(run.results || run.stdout || '').slice(0, 160);
      const stderr = (run.stderr || '').slice(0, 110).replace(/\n/g, ' ');
      console.log(`  run(${first}) exit=${run.exit_code} argv=${argv}`);
      console.log(`    out: ${out}`);
      if (stderr) console.log(`    err: ${stderr}`);
    }
  }
  p.kill();
})();
