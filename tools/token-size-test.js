#!/usr/bin/env node
/**
 * Token-efficiency regression test.
 *
 * Checks list/describe discovery, stdout de-duplication, base64 redaction,
 * truncation, compact MCP text and the one-image preview path.
 */
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
const { previewFromRun, inspectBase64Image, inferOutputPath } = require('../lib/preview');

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

async function call(rpc, name, args) {
  const m = await rpc('tools/call', { name, arguments: args });
  if (m.result?.isError) throw new Error(m.result.content[0].text);
  return m.result;
}

function textOf(result) {
  const block = result.content.find((c) => c.type === 'text');
  return block ? block.text : '';
}

function imagesOf(result) {
  return result.content.filter((c) => c.type === 'image');
}

(async () => {
  const { p, rpc } = start();
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'token-size-test', version: '1' },
  });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  assert.strictEqual(list.result.tools.length, 5, 'bridge still exposes 5 tools');
  const schemaBytes = Buffer.byteLength(JSON.stringify(list.result.tools), 'utf8');
  console.log(`tools=${list.result.tools.length} schema=${(schemaBytes / 1024).toFixed(1)} KB`);

  // 1. Broad query: list mode only.
  let r = await call(rpc, 'artcraft_commands', { app: 'pdfcraft', limit: 20 });
  let data = JSON.parse(textOf(r));
  assert.strictEqual(data.detail, 'list');
  assert.strictEqual(data.commands.length, 20);
  assert(data.commands.every((c) => !('params' in c)), 'list mode has no params');
  const listChars = textOf(r).length;
  assert(listChars < 2500, `pdfcraft list should stay small (got ${listChars} chars)`);
  console.log(`pdfcraft list 20: ${listChars} chars, detail=${data.detail}`);

  // 2. Exact filter: full params, unchanged precision.
  r = await call(rpc, 'artcraft_commands', { app: 'figcraft', filter: 'node.create' });
  data = JSON.parse(textOf(r));
  assert.strictEqual(data.detail, 'full');
  assert.strictEqual(data.matched, 1);
  assert(data.commands[0].params, 'exact match includes params');
  console.log(`figcraft node.create: detail=${data.detail}, params=${data.commands[0].params.length} chars`);

  // 3. Broad filter: list mode + ids hint.
  r = await call(rpc, 'artcraft_commands', { app: 'figcraft', filter: 'node', limit: 5 });
  data = JSON.parse(textOf(r));
  assert.strictEqual(data.detail, 'list');
  assert(data.commands.every((c) => !('params' in c)), 'broad filter has no params');
  assert(/ids/.test(data.hint || ''), 'broad filter hints at ids');
  console.log(`figcraft node: ${data.matched} matches, list hint="${data.hint}"`);

  // 4. Describe mode.
  r = await call(rpc, 'artcraft_commands', { app: 'figcraft', ids: ['node.create'] });
  data = JSON.parse(textOf(r));
  assert.strictEqual(data.detail, 'describe');
  assert.strictEqual(data.matched, 1);
  assert(data.commands[0].params, 'describe includes params');
  console.log(`figcraft ids: detail=${data.detail}, params present`);

  // 5. detail:none forces list mode even for an exact match.
  r = await call(rpc, 'artcraft_commands', { app: 'figcraft', filter: 'node.create', detail: 'none' });
  data = JSON.parse(textOf(r));
  assert.strictEqual(data.detail, 'list');
  assert(!('params' in data.commands[0]), 'detail:none omits params');
  console.log(`figcraft detail:none: detail=${data.detail}, no params`);

  // 6. Explicit full mode.
  r = await call(rpc, 'artcraft_commands', { app: 'figcraft', filter: 'node', detail: 'full', limit: 2 });
  data = JSON.parse(textOf(r));
  assert.strictEqual(data.detail, 'full');
  assert.strictEqual(data.commands.length, 2);
  assert(data.commands.every((c) => c.params), 'detail:full includes params');
  console.log(`figcraft detail:full: ${data.commands.length} commands with params`);

  // 7. run: stdout is omitted when results exist.
  r = await call(rpc, 'artcraft_run', {
    app: 'figcraft',
    steps: [{ id: 'node.create', params: { type: 'frame', name: 'TokenProbe', width: 320, height: 180 } }],
  });
  data = JSON.parse(textOf(r));
  assert(Array.isArray(data.results));
  assert(!('stdout' in data), 'stdout omitted by default');
  assert(!textOf(r).includes('\n  "'), 'MCP text is compact JSON');
  console.log(`run default: results=${data.results.length}, stdout=${'stdout' in data}`);

  // 8. run: include_stdout is opt-in.
  r = await call(rpc, 'artcraft_run', {
    app: 'figcraft',
    steps: [{ id: 'node.create', params: { type: 'frame', name: 'TokenProbe2', width: 320, height: 180 } }],
    include_stdout: true,
  });
  data = JSON.parse(textOf(r));
  assert('stdout' in data, 'include_stdout keeps stdout');
  console.log(`run include_stdout: stdout=${data.stdout.length} chars`);

  // 9. Unit: base64 redaction, truncation and result sanitization.
  const redacted = redactBase64Text(`prefix data:image/png;base64,${B64} suffix`, { maxStringChars: 64 });
  assert(!redacted.includes(B64), 'data URI is redacted');
  assert(redacted.includes('omitted'), 'redaction marker is present');

  const truncated = truncateStream('x'.repeat(200), { app: 'test', kind: 'stdout', maxChars: 10 });
  assert.strictEqual(truncated.truncated, true);
  assert.strictEqual(truncated.text.length, 10);
  assert(fs.existsSync(truncated.file), 'full output is written to a temp file');
  fs.unlinkSync(truncated.file);

  const safe = sanitizeValue({ png: B64, note: 'ok' }, { maxStringChars: 64 });
  assert.strictEqual(safe.png.omitted, true);
  assert.strictEqual(safe.png.type, 'image/png');
  assert.strictEqual(safe.note, 'ok');
  console.log('helpers: redaction, truncation and sanitization OK');

  // 10. Preview: one image block, no base64 in text/structuredContent.
  const pngFile = path.join(os.tmpdir(), `artcraft-token-${process.pid}.png`);
  fs.writeFileSync(pngFile, Buffer.from(PNG_1X1, 'base64'));
  r = await call(rpc, 'artcraft_cli', {
    app: 'pdfcraft', args: ['--version'],
    preview: 'image', preview_file: pngFile,
  });
  const text = textOf(r);
  const imgs = imagesOf(r);
  assert.strictEqual(imgs.length, 1, 'exactly one image block');
  assert.strictEqual(imgs[0].mimeType, 'image/png');
  assert.strictEqual(imgs[0].data, PNG_1X1);
  assert(!text.includes(PNG_1X1), 'text content has no image base64');
  assert(!JSON.stringify(r.structuredContent).includes(PNG_1X1), 'structuredContent has no image base64');
  assert.strictEqual(r.structuredContent.preview.width, 1);
  assert.strictEqual(r.structuredContent.preview.height, 1);
  console.log(`preview: image blocks=${imgs.length}, ${r.structuredContent.preview.width}x${r.structuredContent.preview.height}`);

  // 11. preview:none returns metadata only.
  r = await call(rpc, 'artcraft_cli', {
    app: 'pdfcraft', args: ['--version'],
    preview: 'none', preview_file: pngFile,
  });
  assert.strictEqual(imagesOf(r).length, 0, 'preview:none returns no image');
  console.log('preview:none: no image block');

  // 12. Output path inference helper.
  assert.strictEqual(inferOutputPath(['export', 'in.figcraft', '-o', 'out.png']), 'out.png');
  assert.strictEqual(inferOutputPath(['render', '--out=out.webp']), 'out.webp');

  // 13. previewFromRun finds an explicit image output; base64 validation works.
  const found = previewFromRun({ output: pngFile, results: [] });
  assert(found.image, 'previewFromRun finds the output image');
  assert.strictEqual(found.image.width, 1);
  const decoded = inspectBase64Image(PNG_1X1, 'image/png');
  assert(decoded.image, 'base64 image validates');
  assert.strictEqual(decoded.image.width, 1);
  fs.unlinkSync(pngFile);

  p.kill();
  console.log('\nPASS token-size-test');
})().catch((e) => {
  console.error(`\nFAIL token-size-test: ${e.stack || e.message}`);
  process.exit(1);
});
