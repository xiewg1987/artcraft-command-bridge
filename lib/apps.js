/**
 * The 19 ArtCraft Crafting Apps and how their `run` argv is built.
 *
 * Every app shares one model: `commands` lists stable command IDs and `run`
 * executes them. The apps disagree on how that translates to argv, which is
 * what the per-app `build()` below reconciles.
 *
 * argv styles
 *   cmd-params     --cmd <id> --params <json>      PhotoCraft, VectorCraft
 *   cmd-inline-eq  --cmd <id>={<json>}              DesignCraft, GridCraft,
 *                                                    SoundCraft, DeckCraft,
 *                                                    WordCraft, MailCraft
 *   cmd-inline-sp  --cmd '<id> <json>'               CADCraft
 *   positional     <id> <json>                      LightCraft, EffectCraft
 *   script-json    run <script.json>                FigCraft ({command,params}),
 *                                                    SolidCraft ({command,params})
 *   script-json-cmd run <doc> <script.json>         AniCraft ({cmd,params})
 *   script-jsonl   run <script.jsonl>               FilmCraft ({id,params})
 *   batch-json     batch <script.json>              TextureCraft, MaterialCraft
 *                                                    ({open, steps, save})
 *   tool-script    run --script <steps.json>         PdfCraft ({tool,args})
 *   cli-only       <tool> [args]                     Craft Anything (one
 *                                                    subcommand per tool)
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const TEMP_FILES = Symbol('artcraft.tempFiles');
let tempSeq = 0;

function tmpScript(prefix, ext, body) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const f = path.join(
    os.tmpdir(),
    `artcraft-${prefix}-${process.pid}-${Date.now()}-${++tempSeq}-${nonce}${ext}`
  );
  fs.writeFileSync(f, body, 'utf8');
  return f;
}

/** Mark only files created by this process so cleanup can never touch user paths. */
function withTempFiles(argv, ...files) {
  argv[TEMP_FILES] = files;
  return argv;
}

function tempFilesOf(argv) {
  return argv && Array.isArray(argv[TEMP_FILES]) ? argv[TEMP_FILES].slice() : [];
}

function cleanupGeneratedFiles(argv) {
  let removed = 0;
  for (const file of tempFilesOf(argv)) {
    try {
      fs.unlinkSync(file);
      removed++;
    } catch (e) { /* already gone */ }
  }
  return removed;
}

/** TextureCraft / MaterialCraft take one batch document for a whole run. */
function batchScript(prefix, { steps, input, output }) {
  const script = { steps: steps.map((s) => ({ id: s.id, params: s.params ?? {} })) };
  if (input) script.open = input;
  if (output) script.save = output;
  const f = tmpScript(prefix, '.json', JSON.stringify(script));
  return withTempFiles(['batch', f], f);
}

const APPS = [
  {
    id: 'photocraft', label: 'PhotoCraft', dirName: 'PhotoCraft', cliName: 'photocraft-cli',
    kind: 'Photo editor — Photoshop alternative',
    style: 'cmd-params',
    build({ steps, input, output, params }) {
      const a = ['run'];
      if (input) a.push(input); else a.push('--new', JSON.stringify(params?.document ?? {}));
      for (const s of steps) { a.push('--cmd', s.id); if (s.params) a.push('--params', JSON.stringify(s.params)); }
      if (output) a.push('--out', output);
      return a;
    },
  },
  {
    id: 'lightcraft', label: 'LightCraft', dirName: 'LightCraft', cliName: 'lightcraft-cli',
    kind: 'RAW development — Lightroom alternative',
    style: 'positional',
    build({ steps }) {
      const a = ['run'];
      for (const s of steps) a.push(s.id, JSON.stringify(s.params ?? {}));
      return a;
    },
  },
  {
    id: 'vectorcraft', label: 'VectorCraft', dirName: 'VectorCraft', cliName: 'vectorcraft-cli',
    kind: 'Vector illustration — Illustrator alternative',
    style: 'cmd-params',
    build({ steps, input, output }) {
      const a = ['run'];
      if (input) a.push('--in', input);
      for (const s of steps) { a.push('--cmd', s.id); if (s.params) a.push('--params', JSON.stringify(s.params)); }
      if (output) a.push('--export', output);
      return a;
    },
  },
  {
    id: 'designcraft', label: 'DesignCraft', dirName: 'DesignCraft', cliName: 'designcraft-cli',
    kind: 'Page layout — InDesign alternative',
    style: 'cmd-inline-eq',
    build({ steps, input, output }) {
      const a = ['run'];
      if (input) a.push('--in', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      if (output) a.push('--export', output);
      return a;
    },
  },
  {
    id: 'gridcraft', label: 'GridCraft', dirName: 'GridCraft', cliName: 'gridcraft-cli',
    kind: 'Spreadsheets — Excel alternative',
    style: 'cmd-inline-eq',
    build({ steps, input, output }) {
      const a = ['run'];
      if (input) a.push('--in', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      if (output) a.push('--out', output);
      return a;
    },
  },
  {
    id: 'soundcraft', label: 'SoundCraft', dirName: 'SoundCraft', cliName: 'soundcraft-cli',
    kind: 'Audio editing — Pro Tools alternative',
    style: 'cmd-inline-eq',
    build({ steps, input, output }) {
      const a = ['run'];
      if (input) a.push('--in', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      if (output) {
        const native = path.extname(output).toLowerCase() === '.scraft';
        a.push(native ? '--save' : '--bounce', output);
      }
      return a;
    },
  },
  {
    id: 'deckcraft', label: 'DeckCraft', dirName: 'DeckCraft', cliName: 'deckcraft-cli',
    kind: 'Presentations — PowerPoint alternative',
    style: 'cmd-inline-eq',
    build({ steps, input, output }) {
      const a = ['run'];
      if (input) a.push('--in', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      if (output) a.push('--save', output);
      return a;
    },
  },
  {
    id: 'wordcraft', label: 'WordCraft', dirName: 'WordCraft', cliName: 'wordcraft-cli',
    kind: 'Documents — Word alternative',
    style: 'cmd-inline-eq',
    build({ steps, input, output }) {
      const a = ['run'];
      if (input) a.push('--file', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      if (output) a.push('--save', output);
      return a;
    },
  },
  {
    id: 'cadcraft', label: 'CADCraft', dirName: 'CADCraft', cliName: 'cadcraft-cli',
    kind: 'CAD drafting — AutoCAD alternative',
    style: 'cmd-inline-sp',
    build({ steps, input, output }) {
      const a = ['run'];
      if (input) a.push(input);
      for (const s of steps) a.push('--cmd', `${s.id} ${JSON.stringify(s.params ?? {})}`);
      if (output) a.push('--save', output);
      return a;
    },
  },
  {
    id: 'effectcraft', label: 'EffectCraft', dirName: 'EffectCraft', cliName: 'effectcraft-cli',
    kind: 'Motion graphics — After Effects alternative',
    style: 'positional',
    build({ steps, input, output }) {
      const a = [];
      if (input) a.push('--project', input);
      else a.push('--empty');
      a.push('run');
      for (const s of steps) a.push(s.id, JSON.stringify(s.params ?? {}));
      if (output) a.push('--save-as', output);
      return a;
    },
  },
  {
    id: 'filmcraft', label: 'FilmCraft', dirName: 'FilmCraft', cliName: 'filmcraft-cli',
    kind: 'Video editing — Premiere alternative',
    style: 'script-jsonl',
    build({ steps, input, output }) {
      // FilmCraft's script.jsonl takes one {"id","params"} per line.
      const f = tmpScript('film', '.jsonl',
        steps.map((s) => JSON.stringify({ id: s.id, params: s.params ?? {} })).join('\n'));
      const a = [];
      if (input) a.push('--project', input);
      a.push('run', f);
      if (output) a.push('--save-as', output);
      return withTempFiles(a, f);
    },
  },
  {
    id: 'figcraft', label: 'FigCraft', dirName: 'FigCraft', cliName: 'figcraft-cli',
    kind: 'Interface design — Figma alternative',
    style: 'script-json',
    build({ steps, input, output }) {
      // FigCraft's script.json takes [{command, params}] — note: command, not id.
      const f = tmpScript('fig', '.json',
        JSON.stringify(steps.map((s) => ({ command: s.id, params: s.params ?? {} }))));
      const a = ['run', f];
      if (input) a.push('--in', input);
      if (output) a.push('--out', output);
      return withTempFiles(a, f);
    },
  },
  {
    id: 'texturecraft', label: 'TextureCraft', dirName: 'TextureCraft', cliName: 'texturecraft-cli',
    kind: '3D texture painting — texture sets, smart materials, baking',
    style: 'batch-json',
    build({ steps, input, output }) {
      return batchScript('texture', { steps, input, output });
    },
  },
  {
    id: 'materialcraft', label: 'MaterialCraft', dirName: 'MaterialCraft', cliName: 'materialcraft-cli',
    kind: 'Procedural materials — node graphs, PBR material packages',
    style: 'batch-json',
    build({ steps, input, output }) {
      return batchScript('material', { steps, input, output });
    },
  },
  {
    id: 'pdfcraft', label: 'PdfCraft', dirName: 'PdfCraft', cliName: 'pdfcraft-cli',
    kind: 'PDF reading, editing and export',
    style: 'tool-script',
    build({ steps, output, params }) {
      const script = steps.map((s) => ({ tool: s.id, args: s.params ?? {} }));
      const f = tmpScript('pdf', '.json', JSON.stringify(script));
      const a = ['run', '--script', f];
      if (params?.report !== false) a.push('--report');
      if (params?.root) a.push('--root', params.root);
      if (output) a.push('--out', output);
      return withTempFiles(a, f);
    },
  },
  {
    id: 'anicraft', label: 'AniCraft', dirName: 'AniCraft', dirNames: ['ArtCraft/AniCraft'],
    cliName: 'anicraft-cli',
    kind: '2D vector animation — After Effects alternative',
    style: 'script-json-cmd',
    build({ steps, input, output }) {
      // AniCraft's script.json takes [{cmd, params}] and the document comes
      // first: `run <file|--sample> <script.json>`. Without a document the
      // sample animation is the only built-in starting point.
      const f = tmpScript('ani', '.json',
        JSON.stringify(steps.map((s) => ({ cmd: s.id, params: s.params ?? {} }))));
      const a = ['run', input || '--sample', f];
      if (output) a.push('--save', output);
      return withTempFiles(a, f);
    },
  },
  {
    id: 'craft-anything', label: 'Craft Anything', dirName: 'Craft Anything',
    cliName: 'craft-anything-cli',
    kind: 'Software exploration and reverse engineering — agent front-end',
    style: 'cli-only',
    // Craft Anything's registry calls the tool id `command` and keeps the
    // human title and one-line summary in `title` / `summary`.
    registry: { id: 'command', label: 'title', description: 'summary', toolset: 'toolset' },
    build() {
      throw new Error(
        'Craft Anything has no run/batch form: every tool is its own subcommand. ' +
        'Use artcraft_cli with the tool name, e.g. args:["core-session-show"]. ' +
        'Find the tool names with artcraft_commands.'
      );
    },
  },
  {
    id: 'mailcraft', label: 'MailCraft', dirName: 'MailCraft', cliName: 'mailcraft-cli',
    kind: 'Email, contacts and calendar — Outlook alternative',
    style: 'cmd-inline-eq',
    build({ steps, input, output, params }) {
      const a = ['run'];
      if (input) a.push('--file', input); else a.push('--sample');
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      if (output) a.push('--save', output);
      // Without --print MailCraft writes nothing to stdout.
      if (params?.print !== false) a.push('--print');
      return a;
    },
  },
  {
    id: 'solidcraft', label: 'SolidCraft', dirName: 'SolidCraft', cliName: 'solidcraft-cli',
    kind: '3D CAD modelling — STEP drawings and mesh export',
    style: 'script-json',
    build({ steps, input, output }) {
      // SolidCraft's script.json takes [{command, params}], like FigCraft.
      const f = tmpScript('solid', '.json',
        JSON.stringify(steps.map((s) => ({ command: s.id, params: s.params ?? {} }))));
      const a = ['run', f];
      if (input) a.push('--in', input);
      if (output) {
        // .sc is the native design; every other extension is a mesh export.
        if (path.extname(output).toLowerCase() === '.sc') a.push('--save', output);
        else a.push('--out', output);
      }
      a.push('--results');
      return withTempFiles(a, f);
    },
  },
];

const APP_BY_ID = new Map(APPS.map((a) => [a.id, a]));

module.exports = { APPS, APP_BY_ID, tempFilesOf, cleanupGeneratedFiles };
