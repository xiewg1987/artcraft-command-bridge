#!/usr/bin/env node
/** Verify every app's argv mapping and generated-file cleanup contract. */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  APP_BY_ID,
  tempFilesOf,
  cleanupGeneratedFiles,
} = require('../lib/apps');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artcraft-adapter-test-'));
const input = path.join(root, 'input.native');
const output = path.join(root, 'output.native');
const steps = [{ id: 'probe.command', params: { value: 1 } }];

function build(app, extra = {}) {
  return APP_BY_ID.get(app).build({ steps, input, output, ...extra });
}

function hasPair(argv, flag, value) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] === value;
}

(async () => {
  const design = build('designcraft');
  assert(hasPair(design, '--in', input));
  assert(hasPair(design, '--export', output));

  const grid = build('gridcraft');
  assert(hasPair(grid, '--in', input));
  assert(hasPair(grid, '--out', output));

  const soundFile = path.join(root, 'session.scraft');
  const soundNative = APP_BY_ID.get('soundcraft').build({ steps, input, output: soundFile });
  assert(hasPair(soundNative, '--in', input));
  assert(hasPair(soundNative, '--save', soundFile));
  const soundBounce = APP_BY_ID.get('soundcraft').build({
    steps, input, output: path.join(root, 'mix.wav'),
  });
  assert(hasPair(soundBounce, '--bounce', path.join(root, 'mix.wav')));

  const deck = build('deckcraft');
  assert(hasPair(deck, '--in', input));
  assert(hasPair(deck, '--save', output));

  const word = build('wordcraft');
  assert(hasPair(word, '--file', input));
  assert(hasPair(word, '--save', output));

  const cad = build('cadcraft');
  assert(cad.includes(input));
  assert(hasPair(cad, '--save', output));

  const effect = build('effectcraft');
  assert.deepStrictEqual(effect.slice(0, 3), ['--project', input, 'run']);
  assert(hasPair(effect, '--save-as', output));

  const film = build('filmcraft');
  assert.deepStrictEqual(film.slice(0, 3), ['--project', input, 'run']);
  assert(hasPair(film, '--save-as', output));

  const fig = build('figcraft');
  assert(hasPair(fig, '--in', input));
  assert(hasPair(fig, '--out', output));

  const texture = build('texturecraft');
  assert.strictEqual(texture[0], 'batch');

  const material = build('materialcraft');
  assert.strictEqual(material[0], 'batch');

  const pdf = build('pdfcraft');
  assert.deepStrictEqual(pdf.slice(0, 2), ['run', '--script']);
  assert(pdf.includes('--report'));
  const pdfScript = tempFilesOf(pdf)[0];
  assert(pdfScript, 'PdfCraft script is marked as generated');
  const pdfSteps = JSON.parse(fs.readFileSync(pdfScript, 'utf8'));
  assert.deepStrictEqual(pdfSteps, [{ tool: 'probe.command', args: { value: 1 } }]);

  const generated = [design, grid, soundNative, soundBounce, deck, word, cad,
    effect, film, fig, texture, material, pdf].flatMap(tempFilesOf);
  assert(generated.length >= 5, 'script-style apps expose their generated files');

  const userFile = path.join(root, 'do-not-delete.json');
  fs.writeFileSync(userFile, '{"user":true}');
  const figWithUserOutput = APP_BY_ID.get('figcraft').build({ steps, input, output: userFile });
  cleanupGeneratedFiles(figWithUserOutput);
  assert(fs.existsSync(userFile), 'cleanup must not delete arbitrary JSON files');

  for (const argv of [design, grid, soundNative, soundBounce, deck, word, cad,
    effect, film, fig, texture, material, pdf]) cleanupGeneratedFiles(argv);
  assert(generated.every((file) => !fs.existsSync(file)), 'generated scripts are removed');
  assert(fs.existsSync(userFile), 'user-owned file survives cleanup');

  console.log('PASS adapter-contract-test');
})().catch((error) => {
  console.error(`FAIL adapter-contract-test: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
