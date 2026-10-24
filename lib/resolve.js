/**
 * Cross-platform discovery of the ArtCraft CLI binaries.
 *
 * The ArtCraft apps (storytold/*) ship in several layouts, and different
 * packagers use different ones:
 *
 *   - official portable layout   %LOCALAPPDATA%\storytold\apps\<app>\...
 *                                 ~/.local/share/storytold/apps/<app>/...
 *                                 ~/Library/Application Support/storytold/apps/<app>/...
 *   - MSI / system install       C:\Program Files\<App>Craft\<app>-cli.exe
 *   - macOS app bundle           /Applications/<App>Craft.app/Contents/MacOS/<app>-cli
 *   - anywhere on PATH           <app>-cli
 *
 * We probe all of them and let the environment override everything:
 *
 *   ARTCRAFT_<APP>_CLI   full path to one CLI   e.g. ARTCRAFT_PHOTOCRAFT_CLI
 *   ARTCRAFT_HOME        root that holds apps   e.g. D:\tools\storytold\apps
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

function exeName(base) {
  return IS_WINDOWS ? `${base}.exe` : base;
}

/** Every place we are willing to look for one app's CLI, in priority order. */
function candidatePaths(app) {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };

  const exe = exeName(app.cliName);
  const altExe = exeName(app.cliName.replace(/-/g, ''));

  // 1. per-app environment override
  const envKey = `ARTCRAFT_${app.cliName.replace(/-/g, '_').toUpperCase()}_CLI`;
  if (process.env[envKey]) push(process.env[envKey]);

  // 2. ARTCRAFT_HOME and the official per-OS app roots
  const roots = [];
  if (process.env.ARTCRAFT_HOME) roots.push(process.env.ARTCRAFT_HOME);
  if (IS_WINDOWS) {
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'storytold', 'apps'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'storytold', 'apps'));
  } else {
    roots.push(path.join(os.homedir(), '.local', 'share', 'storytold', 'apps'));
  }
  for (const root of roots) {
    push(path.join(root, app.id, exe));
    push(path.join(root, app.id, 'bin', exe));
    push(path.join(root, app.id, app.dirName, exe));
    push(path.join(root, app.id, app.dirName, 'bin', exe));
    push(path.join(root, 'bin', exe));
    push(path.join(root, exe));
  }

  // 3. PATH
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    push(path.join(dir, exe));
    push(path.join(dir, altExe));
  }

  // 4. platform install locations
  if (IS_WINDOWS) {
    for (const p of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
      if (p) push(path.join(p, app.dirName, exe));
    }
  } else if (process.platform === 'darwin') {
    push(path.join('/Applications', `${app.dirName}.app`, 'Contents', 'MacOS', exe));
    push(path.join(os.homedir(), 'Applications', `${app.dirName}.app`, 'Contents', 'MacOS', exe));
  } else {
    push(path.join('/usr', 'local', 'bin', exe));
    push(path.join('/usr', 'bin', exe));
    push(path.join(os.homedir(), '.local', 'bin', exe));
  }

  return out;
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch (e) {
    return false;
  }
}

/**
 * Resolve one app's CLI path.
 * @returns {string|null} absolute path, or null when the app is not installed.
 */
function resolveCli(app) {
  for (const p of candidatePaths(app)) {
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * Resolve every app at once.
 * @returns {Array<{app, cli: string|null}>}
 */
function resolveAll(apps) {
  return apps.map((app) => ({ app, cli: resolveCli(app) }));
}

/** List every candidate path that was probed — useful for diagnosing installs. */
function explain(app) {
  return candidatePaths(app);
}

module.exports = { resolveCli, resolveAll, explain, candidatePaths, IS_WINDOWS };
