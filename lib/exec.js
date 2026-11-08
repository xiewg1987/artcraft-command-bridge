/**
 * Spawn a CLI, spool oversized output to disk, and enforce a timeout.
 *
 * Only a bounded prefix is retained in memory for the tool response. The full
 * stream is written to a temp file once it crosses captureMaxChars, so a noisy
 * renderer cannot consume unbounded bridge memory.
 */

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const { tempStreamFile } = require('./output');

const DEFAULT_CAPTURE_CHARS = 256 * 1024;

function createCapture(file, kind, maxChars) {
  const decoder = new StringDecoder('utf8');
  let parts = [];
  let prefix = null;
  let chars = 0;
  let fd = null;
  let outputFile = null;
  let writeError = null;

  function stopSpool(error) {
    writeError = error.message;
    try { if (fd !== null) fs.closeSync(fd); } catch (e) { /* ignore */ }
    fd = null;
    if (outputFile) {
      try { fs.unlinkSync(outputFile); } catch (e) { /* ignore */ }
    }
    outputFile = null;
    parts = [];
  }

  function emit(text) {
    if (!text) return;
    chars += text.length;

    if (fd !== null) {
      try { fs.writeSync(fd, text, null, 'utf8'); } catch (e) { stopSpool(e); }
      return;
    }

    parts.push(text);
    if (chars <= maxChars) return;

    const all = parts.join('');
    prefix = all.slice(0, maxChars);
    parts = [];
    try {
      outputFile = tempStreamFile(path.basename(file), kind);
      fd = fs.openSync(outputFile, 'w');
      fs.writeSync(fd, all, null, 'utf8');
    } catch (e) {
      stopSpool(e);
    }
  }

  return {
    write(buf) { emit(decoder.write(buf)); },
    end() {
      emit(decoder.end());
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (e) { stopSpool(e); }
        fd = null;
      }
      return {
        text: prefix !== null ? prefix : parts.join(''),
        chars,
        file: outputFile,
        truncated: chars > maxChars,
        ...(writeError ? { writeError } : {}),
      };
    },
  };
}

function execFile(file, args, {
  timeoutMs = 120000,
  captureMaxChars = DEFAULT_CAPTURE_CHARS,
} = {}) {
  return new Promise((resolve) => {
    let p;
    const argv = [path.basename(file), ...args];
    try {
      p = spawn(file, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: `spawn failed: ${e.message}`, argv });
    }

    const limit = Math.max(4096, Math.trunc(Number(captureMaxChars) || DEFAULT_CAPTURE_CHARS));
    const stdout = createCapture(file, 'stdout', limit);
    const stderr = createCapture(file, 'stderr', limit);
    let done = false;
    let timedOut = false;
    let timeoutTimer = null;
    let forceTimer = null;

    function finish(code) {
      if (done) return;
      done = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      const out = stdout.end();
      const err = stderr.end();
      resolve({
        code: timedOut ? -2 : code,
        stdout: out.text,
        stderr: err.text,
        stdoutFile: out.file,
        stderrFile: err.file,
        stdoutChars: out.chars,
        stderrChars: err.chars,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        ...(out.writeError ? { stdoutWriteError: out.writeError } : {}),
        ...(err.writeError ? { stderrWriteError: err.writeError } : {}),
        timedOut,
        argv,
      });
    }

    timeoutTimer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      stderr.write(Buffer.from(`\n[bridge] timed out after ${timeoutMs}ms\n`, 'utf8'));
      try { p.kill(); } catch (e) { /* ignore */ }
      forceTimer = setTimeout(() => finish(-2), 1000);
    }, timeoutMs);

    p.stdout.on('data', (d) => stdout.write(d));
    p.stderr.on('data', (d) => stderr.write(d));
    p.on('error', (e) => {
      stderr.write(Buffer.from(`spawn error: ${e.message}\n`, 'utf8'));
      finish(-1);
    });
    p.on('close', (code) => finish(code));
  });
}

module.exports = { execFile, DEFAULT_CAPTURE_CHARS };
