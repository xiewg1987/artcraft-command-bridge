#!/usr/bin/env node
/** Check that common native/output paths really produce files through the MCP bridge. */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

function start() {
  const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  let id = 0;
  p.stderr.on('data', (data) => process.stderr.write('[srv] ' + data.toString()));
  p.stdout.on('data', (data) => {
    buf += data.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (e) { continue; }
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    waiters.set(myId, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  return { p, rpc };
}

async function call(rpc, name, args) {
  const message = await rpc('tools/call', { name, arguments: args });
  if (message.result?.isError) throw new Error(message.result.content[0].text);
  return JSON.parse(message.result.content[0].text);
}

const SPECS = [
  { app: 'photocraft', id: 'file.new', params: {}, ext: '.png' },
  { app: 'vectorcraft', id: 'file.new', params: {}, ext: '.svg' },
  { app: 'designcraft', id: 'file.new', params: {}, ext: '.pdf' },
  { app: 'gridcraft', id: 'file.new', params: {}, ext: '.xlsx' },
  { app: 'wordcraft', id: 'file.new', params: {}, ext: '.docx' },
  { app: 'cadcraft', id: 'new', params: {}, ext: '.dxf' },
  { app: 'effectcraft', id: 'file.newProject', params: {}, ext: '.ecproj' },
  { app: 'filmcraft', id: 'file.newProject', params: { name: 'OutputProbe' }, ext: '.fcproj' },
  { app: 'materialcraft', id: 'file.new', params: {}, ext: '.sbs' },
  { app: 'figcraft', id: 'node.create', params: { type: 'frame', name: 'OutputProbe', width: 100, height: 100 }, ext: '.figcraft' },
  { app: 'soundcraft', id: 'session.new', params: {}, ext: '.scraft' },
  { app: 'anicraft', id: 'file.new', params: {}, ext: '.anicraft' },
  { app: 'mailcraft', id: 'file.new', params: {}, ext: '.mailcraft' },
  { app: 'solidcraft', id: 'sketch.create', params: { plane: 'XY' }, ext: '.sc' },
];

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artcraft-output-test-'));
  const { p, rpc } = start();
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'output-integration-test', version: '1' },
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const apps = await call(rpc, 'artcraft_apps', {});
    const installed = new Set(apps.installed || []);
    for (const spec of SPECS) {
      if (!installed.has(spec.app)) {
        console.log(`${spec.app.padEnd(13)} SKIP (not installed)`);
        continue;
      }
      const output = path.join(root, `${spec.app}${spec.ext}`);
      const result = await call(rpc, 'artcraft_run', {
        app: spec.app,
        steps: [{ id: spec.id, params: spec.params }],
        output,
      });
      assert.strictEqual(result.exit_code, 0, `${spec.app} exited nonzero: ${result.stderr || ''}`);
      assert(fs.existsSync(output), `${spec.app} did not create ${output}`);
      assert(fs.statSync(output).size > 0, `${spec.app} created an empty output`);
      console.log(`${spec.app.padEnd(13)} OK ${fs.statSync(output).size} bytes`);
    }

    if (installed.has('deckcraft')) {
      const first = path.join(root, 'deckcraft.deckcraft');
      const second = path.join(root, 'deckcraft-open.pptx');
      let result = await call(rpc, 'artcraft_run', {
        app: 'deckcraft', steps: [{ id: 'file.new', params: {} }], output: first,
      });
      assert.strictEqual(result.exit_code, 0, result.stderr || 'DeckCraft create failed');
      assert(fs.existsSync(first));
      result = await call(rpc, 'artcraft_run', {
        app: 'deckcraft', input: first, steps: [{ id: 'file.new', params: {} }], output: second,
      });
      assert.strictEqual(result.exit_code, 0, result.stderr || 'DeckCraft input failed');
      assert(fs.existsSync(second));
      console.log('deckcraft     OK input + native/pptx output');
    }

    for (const app of ['effectcraft', 'filmcraft']) {
      if (!installed.has(app)) continue;
      const ext = app === 'filmcraft' ? '.fcproj' : '.ecproj';
      const first = path.join(root, `${app}${ext}`);
      const second = path.join(root, `${app}-reopened${ext}`);
      const result = await call(rpc, 'artcraft_run', {
        app,
        input: first,
        steps: [{ id: 'file.newProject', params: app === 'filmcraft' ? { name: 'Reopened' } : {} }],
        output: second,
      });
      assert.strictEqual(result.exit_code, 0, `${app} input failed: ${result.stderr || ''}`);
      assert(fs.existsSync(second), `${app} did not save a reopened project`);
      console.log(`${app.padEnd(13)} OK input + output`);
    }

    if (installed.has('texturecraft')) {
      const first = path.join(root, 'texturecraft-source.tcraft');
      const second = path.join(root, 'texturecraft-copy.tcraft');
      let result = await call(rpc, 'artcraft_cli', {
        app: 'texturecraft', args: ['new', 'builtin:cube', first],
      });
      assert.strictEqual(result.exit_code, 0, result.stderr || 'TextureCraft source creation failed');
      assert(fs.existsSync(first));
      result = await call(rpc, 'artcraft_run', {
        app: 'texturecraft',
        input: first,
        steps: [{ id: 'edit.history', params: {} }],
        output: second,
      });
      assert.strictEqual(result.exit_code, 0, result.stderr || 'TextureCraft input/output failed');
      assert(fs.existsSync(second));
      console.log('texturecraft  OK input + native output');
    }

    if (installed.has('craft-anything')) {
      // Craft Anything has no run form: the bridge must refuse artcraft_run
      // and point at the escape hatch instead.
      const refused = await rpc('tools/call', {
        name: 'artcraft_run',
        arguments: { app: 'craft-anything', steps: [{ id: 'core-session-show', params: {} }] },
      });
      assert(refused.result?.isError, 'Craft Anything must refuse artcraft_run');
      assert(
        /artcraft_cli/.test(refused.result.content[0].text),
        'the refusal must name the escape hatch'
      );
      const result = await call(rpc, 'artcraft_cli', {
        app: 'craft-anything', args: ['core-session-show', '--format', 'json'],
      });
      assert.strictEqual(result.exit_code, 0, result.stderr || 'Craft Anything tool failed');
      console.log('craft-anything OK run refused, cli tool ran');
    }

    console.log('PASS output-integration-test');
  } finally {
    p.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(`FAIL output-integration-test: ${error.stack || error.message}`);
  process.exitCode = 1;
});
