/**
 * Context-size guards for tool results.
 *
 * The bridge must never put base64 image data into the text content or
 * structuredContent it returns to the MCP client. It also keeps large
 * stdout/stderr blobs out of the conversation by truncating them and writing
 * the full text to a temp file.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const DEFAULT_MAX_STRING_CHARS = 4096;

const DATA_URI_RE = /^data:([^;,]+);base64,([\s\S]*)$/i;
const IMAGE_KEY_RE = /(png|jpe?g|gif|webp|image|thumbnail|preview|base64|data_?uri|dataurl)/i;
const BASE64_CHARS_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseDataUri(value) {
  if (typeof value !== 'string') return null;
  const m = DATA_URI_RE.exec(value.trim());
  return m ? { mimeType: m[1].toLowerCase(), data: m[2] } : null;
}

/** True for a long string that is (almost certainly) base64 data. */
function looksLikeBase64(value, minChars = DEFAULT_MAX_STRING_CHARS) {
  if (typeof value !== 'string') return false;
  if (value.length < minChars) return false;
  const compact = value.replace(/\s+/g, '');
  if (compact.length < minChars || compact.length % 4 !== 0) return false;
  return BASE64_CHARS_RE.test(compact) && /[A-Za-z]/.test(compact) && /[0-9+/=]/.test(compact);
}

function imageMimeFromKey(key = '') {
  if (/png/i.test(key)) return 'image/png';
  if (/jpe?g/i.test(key)) return 'image/jpeg';
  if (/gif/i.test(key)) return 'image/gif';
  if (/webp/i.test(key)) return 'image/webp';
  return 'application/octet-stream';
}

/** Replace long base64 payloads in a text stream with a compact marker. */
function redactBase64Text(text, { maxStringChars = DEFAULT_MAX_STRING_CHARS } = {}) {
  if (typeof text !== 'string' || !text) return '';
  if (text.length < maxStringChars) return text;

  let out = text.replace(
    /data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]+/gi,
    (match, mime) => `[omitted ${mime} data: ${match.length} chars]`
  );

  const min = Math.max(64, maxStringChars);
  const longBase64 = new RegExp(`[A-Za-z0-9+/]{${min},}={0,2}`, 'g');
  out = out.replace(longBase64, (match) => `[omitted base64: ${match.length} chars]`);
  return out;
}

/**
 * Recursively replace long base64/image strings with a small descriptor.
 * Short image paths stay untouched; they are useful and cheap.
 */
function sanitizeValue(value, { maxStringChars = DEFAULT_MAX_STRING_CHARS } = {}, key = '', depth = 0) {
  if (typeof value === 'string') {
    if (value.length <= maxStringChars) return value;

    const uri = parseDataUri(value);
    if (uri) return { omitted: true, chars: value.length, type: uri.mimeType };

    if (IMAGE_KEY_RE.test(key) || looksLikeBase64(value, maxStringChars)) {
      return { omitted: true, chars: value.length, type: imageMimeFromKey(key) };
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, { maxStringChars }, key, depth + 1));
  }

  if (value && typeof value === 'object') {
    if (depth > 20) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeValue(v, { maxStringChars }, k, depth + 1);
    }
    return out;
  }

  return value;
}

let streamSeq = 0;

function tempStreamFile(app, kind) {
  const suffix = `${process.pid}-${Date.now()}-${++streamSeq}`;
  return path.join(os.tmpdir(), `artcraft-${app}-${kind}-${suffix}.log`);
}

/**
 * Truncate a stream to maxChars and write the whole (already redacted) text to
 * a temp file when it does not fit.
 */
function truncateStream(text, { app = 'app', kind = 'stdout', maxChars = DEFAULT_MAX_OUTPUT_CHARS } = {}) {
  const s = typeof text === 'string' ? text : '';
  const chars = s.length;
  if (chars <= maxChars) return { text: s, truncated: false, chars };

  const file = tempStreamFile(app, kind);
  fs.writeFileSync(file, s, 'utf8');
  return { text: s.slice(0, maxChars), truncated: true, chars, file };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_STRING_CHARS,
  clampInt,
  parseDataUri,
  looksLikeBase64,
  imageMimeFromKey,
  redactBase64Text,
  sanitizeValue,
  truncateStream,
};
