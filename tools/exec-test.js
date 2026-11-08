#!/usr/bin/env node
/** Verify bounded output capture, UTF-8 decoding and full-output spooling. */

'use strict';

const assert = require('assert');
const fs = require('fs');

const { execFile } = require('../lib/exec');

(async () => {
  const code = [
    'process.stdout.write("中".repeat(9000));',
    'process.stderr.write("x".repeat(9000));',
  ].join('\n');
  const r = await execFile(process.execPath, ['-e', code], {
    timeoutMs: 10000,
    captureMaxChars: 4096,
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '中'.repeat(4096));
  assert.strictEqual(r.stderr, 'x'.repeat(4096));
  assert.strictEqual(r.stdoutTruncated, true);
  assert.strictEqual(r.stderrTruncated, true);
  assert.strictEqual(r.stdoutChars, 9000);
  assert.strictEqual(r.stderrChars, 9000);
  assert.strictEqual(fs.readFileSync(r.stdoutFile, 'utf8'), '中'.repeat(9000));
  assert.strictEqual(fs.readFileSync(r.stderrFile, 'utf8'), 'x'.repeat(9000));
  fs.unlinkSync(r.stdoutFile);
  fs.unlinkSync(r.stderrFile);
  console.log('PASS exec-test');
})().catch((error) => {
  console.error(`FAIL exec-test: ${error.stack || error.message}`);
  process.exitCode = 1;
});
