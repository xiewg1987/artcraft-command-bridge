// Measure the real schema weight of ArtCraft MCP tools.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { APPS } = require('../lib/apps');
const { resolveCli } = require('../lib/resolve');

const REGISTRY = path.join(__dirname, '..', 'registry');

const TARGETS = APPS.map((app) => [app.label, resolveCli(app)]);

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'measure', version: '1.0' } },
});

function measure(label, exe) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; try { p.kill(); } catch (e) {} resolve(null); } }, 25000);
    p.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.id === 1 && m.result) {
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (m.id === 2 && m.result && m.result.tools) {
          settled = true; clearTimeout(t);
          const json = JSON.stringify(m.result.tools);
          const out = { label, count: m.result.tools.length, bytes: Buffer.byteLength(json, 'utf8') };
          fs.mkdirSync(REGISTRY, { recursive: true });
          fs.writeFileSync(path.join(REGISTRY, `${label}.json`), json, 'utf8');
          try { p.kill(); } catch (e) {}
          resolve(out);
        }
      }
    });
    p.on('error', () => { settled = true; clearTimeout(t); resolve(null); });
    p.stdin.write(INIT + '\n');
  });
}

(async () => {
  let totalTools = 0, totalBytes = 0;
  for (const [label, exe] of TARGETS) {
    if (!exe) { console.log(`${label.padEnd(14)} NOT INSTALLED`); continue; }
    const r = await measure(label, exe);
    if (!r) { console.log(`${label}: FAILED`); continue; }
    totalTools += r.count; totalBytes += r.bytes;
    console.log(`${label.padEnd(14)} tools=${String(r.count).padStart(4)}  schema=${(r.bytes / 1024).toFixed(1).padStart(7)} KB  avg=${Math.round(r.bytes / r.count)} B/tool`);
  }
  console.log(`\nTOTAL          tools=${totalTools}  schema=${(totalBytes / 1024).toFixed(1)} KB`);
  console.log(`token estimate (~3.5 bytes/char for JSON, 4 chars/token => bytes/4):`);
  console.log(`  full tools/list as token text ~= ${Math.round(totalBytes / 4).toLocaleString()} tokens`);
  const perTool = totalBytes / totalTools;
  console.log(`  per-tool average = ${Math.round(perTool)} bytes = ~${Math.round(perTool / 4)} tokens`);
})();
