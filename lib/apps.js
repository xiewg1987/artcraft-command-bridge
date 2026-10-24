/**
 * The 13 ArtCraft Crafting Apps and how their `run` argv is built.
 *
 * Every app shares one model: `commands` lists stable command IDs and `run`
 * executes them. The apps disagree on how that translates to argv, which is
 * what the per-app `build()` below reconciles.
 *
 * argv styles
 *   cmd-params     --cmd <id> --params <json>      PhotoCraft, VectorCraft
 *   cmd-inline-eq  --cmd <id>={<json>}              DesignCraft, GridCraft,
 *                                                    SoundCraft, DeckCraft,
 *                                                    WordCraft
 *   cmd-inline-sp  --cmd '<id> <json>'               CADCraft
 *   positional     <id> <json>                      LightCraft, EffectCraft
 *   script-json    run <script.json>                FigCraft  ({command,params})
 *   script-jsonl   run <script.jsonl>               FilmCraft ({id,params})
 *   positional-kv  run <tool> key=value              PdfCraft  (tool name != id)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpScript(prefix, ext, body) {
  const f = path.join(os.tmpdir(), `artcraft-${prefix}-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(f, body, 'utf8');
  return f;
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
    build({ steps, input }) {
      const a = ['run'];
      if (input) a.push('--in', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      return a;
    },
  },
  {
    id: 'gridcraft', label: 'GridCraft', dirName: 'GridCraft', cliName: 'gridcraft-cli',
    kind: 'Spreadsheets — Excel alternative',
    style: 'cmd-inline-eq',
    build({ steps, input }) {
      const a = ['run'];
      if (input) a.push('--in', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
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
      if (output) a.push('--bounce', output);
      return a;
    },
  },
  {
    id: 'deckcraft', label: 'DeckCraft', dirName: 'DeckCraft', cliName: 'deckcraft-cli',
    kind: 'Presentations — PowerPoint alternative',
    style: 'cmd-inline-eq',
    build({ steps, input }) {
      const a = ['run'];
      if (input) a.push('--file', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      return a;
    },
  },
  {
    id: 'wordcraft', label: 'WordCraft', dirName: 'WordCraft', cliName: 'wordcraft-cli',
    kind: 'Documents — Word alternative',
    style: 'cmd-inline-eq',
    build({ steps, input }) {
      const a = ['run'];
      if (input) a.push('--file', input);
      for (const s of steps) a.push('--cmd', `${s.id}=${JSON.stringify(s.params ?? {})}`);
      return a;
    },
  },
  {
    id: 'cadcraft', label: 'CADCraft', dirName: 'CADCraft', cliName: 'cadcraft-cli',
    kind: 'CAD drafting — AutoCAD alternative',
    style: 'cmd-inline-sp',
    build({ steps, input }) {
      const a = ['run'];
      if (input) a.push(input);
      for (const s of steps) a.push('--cmd', `${s.id} ${JSON.stringify(s.params ?? {})}`);
      return a;
    },
  },
  {
    id: 'effectcraft', label: 'EffectCraft', dirName: 'EffectCraft', cliName: 'effectcraft-cli',
    kind: 'Motion graphics — After Effects alternative',
    style: 'positional',
    build({ steps }) {
      const a = ['run'];
      for (const s of steps) a.push(s.id, JSON.stringify(s.params ?? {}));
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
      const a = ['run', f];
      if (input) a.push('--in', input);
      if (output) a.push('--out', output);
      return a;
    },
  },
  {
    id: 'figcraft', label: 'FigCraft', dirName: 'FigCraft', cliName: 'figcraft-cli',
    kind: 'Interface design — Figma alternative',
    style: 'script-json',
    build({ steps, input, output }) {
      // FigCraft's script.json takes [{command, params}] — note: command, not id.
      const f = tmpScript('fig', '.json',
        JSON.stringify(steps.map((s) => ({ command: s.id, params: s.params ?? {} })), null, 2));
      const a = ['run', f];
      if (input) a.push('--in', input);
      if (output) a.push('--out', output);
      return a;
    },
  },
  {
    id: 'pdfcraft', label: 'PdfCraft', dirName: 'PdfCraft', cliName: 'pdfcraft-cli',
    kind: 'PDF reading, editing and export',
    style: 'positional-kv',
    build({ steps, output, params }) {
      const a = ['run'];
      for (const s of steps) {
        a.push(s.id);
        for (const [k, v] of Object.entries(s.params ?? {})) {
          a.push(v === true ? k : `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
        }
      }
      if (params?.root) a.push('--root', params.root);
      if (output) a.push('--out', output);
      return a;
    },
  },
];

const APP_BY_ID = new Map(APPS.map((a) => [a.id, a]));

module.exports = { APPS, APP_BY_ID };
