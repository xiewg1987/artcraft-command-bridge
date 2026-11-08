#!/usr/bin/env node
/** Token-efficiency and compact MCP response regression test. */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const {
  sanitizeValue,
  redactBase64Text,
  truncateStream,
} = require('../lib/output');
const {
  previewFromRun,
  inspectBase64Image,
  inferOutputPath,
} = require('../lib/preview');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=';
const B64 = 'A'.repeat(8192);

function start() {
  const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  let id = 0;
  p.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));
  p.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      const waiter = waiters.get(m.id);
      if (waiter) { waiters.delete(m.id); waiter(m); }
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
  return message.result;
}

function textOf(result) {
  const block = result.content.find((item) => item.type === 'text');
  return block ? block.text : '';
}

function dataOf(result) {
  return JSON.parse(textOf(result));
}

function imagesOf(result) {
  return result.content.filter((item) => item.type === 'image');
}

(async () => {
  const { p, rpc } = start();
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'token-size-test', version: '2' },
  });
  assert.strictEqual(init.result.serverInfo.version, '2.0.0');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  assert.strictEqual(list.result.tools.length, 5);
  const schemaBytes = Buffer.byteLength(JSON.stringify(list.result.tools), 'utf8');
  assert(schemaBytes < 5000, `tool schemas should stay compact (got ${schemaBytes} bytes)`);
  console.log(`tools=5 schema=${(schemaBytes / 1024).toFixed(1)} KB`);

  let result = await call(rpc, 'artcraft_apps', {});
  let data = dataOf(result);
  assert.strictEqual(data.installed_count, 15);
  assert(Array.isArray(data.installed));
  assert(!('apps' in data));
  assert(!result.structuredContent, 'structuredContent is opt-in');
  const appsChars = textOf(result).length;
  assert(appsChars < 500, `compact app list should stay small (got ${appsChars})`);
  console.log(`artcraft_apps compact: ${appsChars} chars`);

  result = await call(rpc, 'artcraft_commands', { app: 'pdfcraft' });
  data = dataOf(result);
  assert.strictEqual(data.detail, 'list');
  assert.strictEqual(data.commands.length, 10);
  assert(data.commands.every((id) => typeof id === 'string'), 'list mode returns IDs only');
  assert(!('cache' in data));
  const listChars = textOf(result).length;
  assert(listChars < 1000, `pdfcraft list should stay small (got ${listChars})`);
  console.log(`pdfcraft list 10: ${listChars} chars`);

  result = await call(rpc, 'artcraft_cli', {
    app: 'figcraft', args: ['commands'], max_result_chars: 1500,
  });
  data = dataOf(result);
  assert.strictEqual(data.result_truncated, true);
  assert.strictEqual(data.result.omitted, true);
  assert(textOf(result).length < 2500);
  assert(fs.existsSync(data.result.file));
  fs.unlinkSync(data.result.file);

  result = await call(rpc, 'artcraft_commands', { app: 'figcraft', filter: 'node.create' });
  data = dataOf(result);
  assert.strictEqual(data.detail, 'full');
  assert.strictEqual(data.matched, 1);
  assert.strictEqual(data.commands[0].id, 'node.create');
  assert(data.commands[0].params);

  result = await call(rpc, 'artcraft_commands', { app: 'figcraft', filter: 'node', limit: 5 });
  data = dataOf(result);
  assert.strictEqual(data.detail, 'list');
  assert(data.commands.every((id) => typeof id === 'string'));
  assert(/Showing 5/.test(data.hint || ''));

  result = await call(rpc, 'artcraft_commands', {
    app: 'figcraft', filter: 'node.create', detail: 'none',
  });
  data = dataOf(result);
  assert(data.commands.every((id) => typeof id === 'string'));

  result = await call(rpc, 'artcraft_commands', {
    app: 'figcraft', filter: 'node', detail: 'full', limit: 2,
  });
  data = dataOf(result);
  assert.strictEqual(data.commands.length, 2);
  assert(data.commands.every((command) => command.params));

  result = await call(rpc, 'artcraft_commands', {
    app: 'pdfcraft', ids: ['form_set_props'], max_param_chars: 2400,
  });
  data = dataOf(result);
  assert.strictEqual(data.commands[0].params_truncated, true);
  assert.strictEqual(data.commands[0].params.length, 2400);
  assert(data.commands[0].params_chars > 2400);

  result = await call(rpc, 'artcraft_run', {
    app: 'figcraft',
    steps: [{ id: 'node.create', params: { type: 'frame', name: 'TokenProbe', width: 320, height: 180 } }],
  });
  data = dataOf(result);
  assert.deepStrictEqual(data.results, [{ id: 2 }]);
  assert(!('stdout' in data));
  assert(!('argv' in data));
  assert(!('app' in data));
  assert(!('run_style' in data));
  assert.strictEqual(imagesOf(result).length, 0, 'preview defaults to none');
  const figRunChars = textOf(result).length;
  assert(figRunChars < 200);
  console.log(`figcraft compact run: ${figRunChars} chars`);

  result = await call(rpc, 'artcraft_run', {
    app: 'figcraft',
    steps: [{ id: 'node.create', params: { type: 'frame', name: 'TokenProbe2', width: 320, height: 180 } }],
    include_stdout: true,
  });
  data = dataOf(result);
  assert('stdout' in data);

  result = await call(rpc, 'artcraft_run', {
    app: 'pdfcraft',
    steps: [
      { id: 'doc_list', params: {} },
      { id: 'action_list', params: {} },
    ],
  });
  data = dataOf(result);
  assert.strictEqual(data.exit_code, 0);
  assert.strictEqual(data.results.length, 2);
  assert(Array.isArray(data.results[0]));
  const pdfRunChars = textOf(result).length;
  assert(pdfRunChars < 8500, `PdfCraft results must respect the compact budget (got ${pdfRunChars})`);
  console.log(`pdfcraft two-step run: ${pdfRunChars} chars`);

  result = await call(rpc, 'artcraft_run', {
    app: 'pdfcraft', steps: [{ id: 'action_list', params: {} }], max_result_chars: 1000,
  });
  data = dataOf(result);
  assert.strictEqual(data.results_truncated, true);
  assert(fs.existsSync(data.results_file));
  fs.unlinkSync(data.results_file);

  const tempFigOutput = path.join(os.tmpdir(), `artcraft-token-user-${process.pid}.json`);
  result = await call(rpc, 'artcraft_run', {
    app: 'figcraft',
    steps: [{ id: 'node.create', params: { type: 'frame', name: 'KeepMe', width: 100, height: 100 } }],
    output: tempFigOutput,
  });
  assert.strictEqual(dataOf(result).exit_code, 0);
  assert(fs.existsSync(tempFigOutput), 'user output in temp must survive generated-script cleanup');
  fs.unlinkSync(tempFigOutput);

  const tempFilmOutput = path.join(os.tmpdir(), `artcraft-token-film-${process.pid}.fcproj`);
  result = await call(rpc, 'artcraft_run', {
    app: 'filmcraft',
    steps: [{ id: 'file.newProject', params: { name: 'TokenFilm' } }],
    output: tempFilmOutput,
  });
  assert.strictEqual(dataOf(result).exit_code, 0);
  assert(fs.existsSync(tempFilmOutput), 'FilmCraft output must be saved');
  fs.rmSync(tempFilmOutput, { force: true });

  const tempSoundOutput = path.join(os.tmpdir(), `artcraft-token-sound-${process.pid}.scraft`);
  result = await call(rpc, 'artcraft_run', {
    app: 'soundcraft',
    steps: [{ id: 'session.new', params: {} }],
    output: tempSoundOutput,
  });
  assert.strictEqual(dataOf(result).exit_code, 0);
  assert(fs.existsSync(tempSoundOutput), 'SoundCraft native session output must be saved');
  fs.rmSync(tempSoundOutput, { force: true });

  const redacted = redactBase64Text(`prefix data:image/png;base64,${B64} suffix`, { maxStringChars: 64 });
  assert(!redacted.includes(B64));
  assert(redacted.includes('omitted'));

  const truncated = truncateStream('x'.repeat(200), { app: 'test', kind: 'stdout', maxChars: 10 });
  assert.strictEqual(truncated.truncated, true);
  assert.strictEqual(truncated.text.length, 10);
  assert(fs.existsSync(truncated.file));
  fs.unlinkSync(truncated.file);

  const safe = sanitizeValue({ png: B64, note: 'ok' }, { maxStringChars: 64 });
  assert.strictEqual(safe.png.omitted, true);
  assert.strictEqual(safe.note, 'ok');

  const pngFile = path.join(os.tmpdir(), `artcraft-token-${process.pid}.png`);
  fs.writeFileSync(pngFile, Buffer.from(PNG_1X1, 'base64'));

  result = await call(rpc, 'artcraft_cli', {
    app: 'pdfcraft', args: ['--version'], preview_file: pngFile,
  });
  assert.strictEqual(imagesOf(result).length, 0);

  result = await call(rpc, 'artcraft_cli', {
    app: 'pdfcraft', args: ['--version'], preview: 'image', preview_file: pngFile,
  });
  const images = imagesOf(result);
  assert.strictEqual(images.length, 1);
  assert.strictEqual(images[0].data, PNG_1X1);
  const previewData = dataOf(result);
  assert.strictEqual(previewData.preview.width, 1);
  assert(!textOf(result).includes(PNG_1X1));
  assert(!result.structuredContent);

  result = await call(rpc, 'artcraft_cli', {
    app: 'pdfcraft', args: ['--version'], preview: 'none', preview_file: pngFile,
  });
  assert.strictEqual(imagesOf(result).length, 0);

  assert.strictEqual(inferOutputPath(['export', 'in.figcraft', '-o', 'out.png']), 'out.png');
  assert.strictEqual(inferOutputPath(['render', '--out=out.webp']), 'out.webp');

  const found = previewFromRun({ output: pngFile, results: [] });
  assert(found.image);
  assert.strictEqual(found.image.width, 1);
  fs.unlinkSync(pngFile);

  const fakePng = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fakePng);
  fakePng.writeUInt32BE(13, 8);
  fakePng.write('IHDR', 12, 'ascii');
  fakePng.writeUInt32BE(2000, 16);
  fakePng.writeUInt32BE(1000, 20);
  const oversized = inspectBase64Image(fakePng.toString('base64'), 'image/png');
  assert(!oversized.image);
  assert(/at most 1024px/.test(oversized.warning || ''));

  p.kill();
  console.log('\nPASS token-size-test');
})().catch((error) => {
  console.error(`\nFAIL token-size-test: ${error.stack || error.message}`);
  process.exitCode = 1;
});
