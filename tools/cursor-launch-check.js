// Verify the aggregate server starts exactly the way Cursor will launch it.
const { spawn } = require('child_process');
const EXE = 'C:\\nvm4w\\nodejs\\node.exe';
const SCRIPT = require('path').join(__dirname, '..', 'server.js');

const p = spawn(EXE, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
p.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));
p.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === 1 && m.result) {
      console.log('serverInfo :', JSON.stringify(m.result.serverInfo));
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    } else if (m.id === 2 && m.result) {
      const t = m.result.tools;
      console.log('tools      :', t.map((x) => x.name).join(', '));
      console.log('schema     :', (Buffer.byteLength(JSON.stringify(t), 'utf8') / 1024).toFixed(1), 'KB');
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'artcraft_apps', arguments: {} } }) + '\n');
    } else if (m.id === 3 && m.result) {
      const apps = JSON.parse(m.result.content[0].text).apps;
      console.log('apps       :', apps.length, '->', apps.map((a) => a.id).join(', '));
      p.kill();
    }
  }
});
p.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cursor-like', version: '1.0' } },
}) + '\n');
setTimeout(() => { p.kill(); }, 20000);
