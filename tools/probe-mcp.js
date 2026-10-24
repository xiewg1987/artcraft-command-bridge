// ArtCraft MCP stdio probe: verify initialize + tools/list for each CLI.
const { spawn } = require('child_process');
const { APPS } = require('../lib/apps');
const { resolveCli } = require('../lib/resolve');

const TARGETS = APPS.map((app) => ({ label: app.label, exe: resolveCli(app) }));

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1.0' } },
});

function probe(label, exe) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let mode = 'newline';           // newline -> lsp framing
    let initErr = null, initOk = false, tools = null, toolErr = null;
    let settled = false;
    const stderr = [];

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      try { p.kill(); } catch (e) {}
      resolve({ label, mode, initOk, initErr, tools, toolErr, stderr: stderr.join('').slice(0, 200) });
    };

    const send = (obj) => {
      const s = JSON.stringify(obj);
      if (mode === 'newline') { p.stdin.write(s + '\n'); }
      else { p.stdin.write('Content-Length: ' + Buffer.byteLength(s, 'utf8') + '\r\n\r\n' + s); }
    };

    p.stderr.on('data', (d) => stderr.push(d.toString('utf8')));

    p.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.id === 1) {
          if (msg.error) {
            initErr = msg.error.message;
            if (!initOk && mode === 'newline') { mode = 'lsp'; send(JSON.parse(INIT)); }
          } else {
            initOk = true;
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          }
        } else if (msg.id === 2) {
          if (msg.result && msg.result.tools) tools = msg.result.tools.length;
          else toolErr = JSON.stringify(msg.error);
          done();
        }
      }
    });

    p.on('error', (e) => { initErr = 'spawn: ' + e.message; done(); });
    p.on('exit', (c) => { if (!tools) { initErr = initErr || ('exit code ' + c); done(); } });

    const t1 = setTimeout(() => { if (!initOk) { mode = 'lsp'; send(JSON.parse(INIT)); } }, 2500);
    const t2 = setTimeout(() => { if (initOk && tools === null) send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }, 1500);
    const t3 = setTimeout(done, 20000);

    send(JSON.parse(INIT));
  });
}

(async () => {
  const rows = [];
  for (const { label, exe } of TARGETS) {
    if (!exe) { console.log(`${label}: NOT INSTALLED`); continue; }
    const r = await probe(label, exe);
    rows.push(r);
    console.log(
      (r.label + '            ').slice(0, 14) +
      ' handshake=' + (r.initOk ? 'OK' : 'FAIL').padEnd(5) +
      ' framing=' + r.mode.padEnd(8) +
      ' tools=' + String(r.tools === null ? 'n/a' : r.tools).padEnd(4) +
      (r.initErr ? ' err=' + r.initErr.slice(0, 60) : '') +
      (r.toolErr ? ' toolErr=' + r.toolErr.slice(0, 60) : '')
    );
  }
  console.log('\nSUMMARY ok=' + rows.filter(r => r.initOk && r.tools > 0).length + '/' + rows.length);
})();
