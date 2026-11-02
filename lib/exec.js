/**
 * Spawn a CLI, capture stdout/stderr, and enforce a timeout.
 *
 * Never rejects for a non-zero exit: callers inspect { code, stdout, stderr }.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

function execFile(file, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(file, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: `spawn failed: ${e.message}`, argv: [path.basename(file), ...args] });
    }
    let stdout = '', stderr = '', done = false;
    const argv = [path.basename(file), ...args];
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill(); } catch (e) {}
      resolve({ code: -2, stdout, stderr: stderr + `\n[bridge] timed out after ${timeoutMs}ms`, timedOut: true, argv });
    }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    p.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    p.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `spawn error: ${e.message}`, argv });
    });
    p.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, stdout, stderr, argv });
    });
  });
}

module.exports = { execFile };
