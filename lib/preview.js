/**
 * Image previews for visual ArtCraft tasks.
 *
 * MCP image blocks need base64, but that base64 must never appear in the text
 * result or structuredContent. This module validates a local image (extension,
 * magic bytes, size) and returns an object that can be attached as one image
 * block. Images larger than 4096 px get a warning; resizing is left to the app.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { parseDataUri, looksLikeBase64, imageMimeFromKey } = require('./output');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIM = 4096;
const IMAGE_PATH_KEYS = new Set([
  'path', 'output', 'file', 'filename', 'preview', 'preview_file',
  'image', 'thumbnail', 'out',
]);
const IMAGE_DATA_KEYS = /^(png|jpe?g|gif|webp|image|images|image_?data|thumbnail|preview|base64|data_?base64|data_?uri|dataurl)$/i;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isImagePath(file) {
  return typeof file === 'string' && IMAGE_EXTS.has(path.extname(file).toLowerCase());
}

function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const gif = buf.toString('ascii', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function jpegSize(buf) {
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    if (marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
    if (i + 4 > buf.length) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (i + 9 > buf.length) break;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 12, 16) !== 'VP8X') return null;
  const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
  const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
  return { width, height };
}

function imageDimensions(buf, mimeType) {
  if (mimeType === 'image/png') return pngSize(buf);
  if (mimeType === 'image/gif') return gifSize(buf);
  if (mimeType === 'image/jpeg') return jpegSize(buf);
  if (mimeType === 'image/webp') return webpSize(buf);
  return null;
}

function makeImage(buf, mimeType, file) {
  const dims = imageDimensions(buf, mimeType);
  const warning = dims && Math.max(dims.width, dims.height) > MAX_IMAGE_DIM
    ? `image is ${dims.width}x${dims.height}; keep previews at max ${MAX_IMAGE_DIM}px (use the app's scale/size flag)`
    : undefined;
  return {
    data: buf.toString('base64'),
    mimeType,
    bytes: buf.length,
    width: dims ? dims.width : null,
    height: dims ? dims.height : null,
    ...(file ? { file: path.resolve(file) } : {}),
    ...(warning ? { warning } : {}),
  };
}

/** Validate one local image file and return { image } or { error }. */
function inspectImageFile(file) {
  if (!file || typeof file !== 'string') return { error: 'no image file given' };
  if (!isImagePath(file)) return { error: `not a supported image extension: ${file}` };

  let st;
  try { st = fs.statSync(file); } catch (e) { return { error: `image file not found: ${file}` }; }
  if (!st.isFile()) return { error: `image path is not a file: ${file}` };
  if (st.size > MAX_IMAGE_BYTES) return { error: `image is larger than 20 MB: ${file}` };

  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { error: `could not read image: ${file}` }; }
  const mimeType = sniffMime(buf);
  if (!mimeType) return { error: `file is not a valid PNG/JPEG/GIF/WebP: ${file}` };

  const expected = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (expected && expected !== mimeType) {
    return { error: `file extension ${path.extname(file)} does not match ${mimeType}: ${file}` };
  }
  return { image: makeImage(buf, mimeType, file) };
}

/** Validate base64 image data (with or without a data: URI prefix). */
function inspectBase64Image(value, mimeHint) {
  if (typeof value !== 'string' || !value) return { error: 'no base64 image data' };
  const uri = parseDataUri(value);
  const raw = (uri ? uri.data : value).replace(/\s+/g, '');
  const declared = uri ? uri.mimeType : mimeHint;
  if (!looksLikeBase64(raw, 64)) return { error: 'image field is not valid base64' };
  if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {
    return { error: 'image is larger than 20 MB' };
  }

  let buf;
  try { buf = Buffer.from(raw, 'base64'); } catch (e) { return { error: 'could not decode base64 image' }; }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return { error: 'image is empty or larger than 20 MB' };
  const mimeType = sniffMime(buf);
  if (!mimeType) return { error: 'base64 data is not a valid PNG/JPEG/GIF/WebP image' };
  if (declared && declared.startsWith('image/') && declared !== mimeType) {
    return { error: `declared ${declared} but the image is ${mimeType}` };
  }
  return { image: makeImage(buf, mimeType) };
}

/** Pick -o / --out / --output / --export / --save from a CLI argv. */
function inferOutputPath(args) {
  const flags = new Set(['-o', '--out', '--output', '--export', '--save']);
  for (let i = 0; i < (args || []).length; i++) {
    const a = String(args[i]);
    for (const flag of flags) {
      if (a === flag && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) {
        return String(args[i + 1]);
      }
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
    }
  }
  return null;
}

function findImagePath(value, baseDir, key = '', depth = 0) {
  if (depth > 10) return null;
  if (typeof value === 'string') {
    if (!IMAGE_PATH_KEYS.has(key.toLowerCase()) || !isImagePath(value)) return null;
    const candidates = [path.resolve(value)];
    if (baseDir) candidates.push(path.resolve(baseDir, value));
    for (const p of candidates) {
      try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* try next */ }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImagePath(item, baseDir, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const found = findImagePath(v, baseDir, k, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findBase64Image(value, key = '', depth = 0) {
  if (depth > 10) return null;
  if (typeof value === 'string') {
    const uri = parseDataUri(value);
    if (uri && uri.mimeType.startsWith('image/')) return { data: uri.data, mimeType: uri.mimeType };
    if (IMAGE_DATA_KEYS.test(key) && looksLikeBase64(value, 64)) {
      return { data: value, mimeType: imageMimeFromKey(key) };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBase64Image(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const found = findBase64Image(v, k, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Preview for artcraft_run: an image output file, an image path in the result,
 * or an image payload in the result (decoded before base64 redaction).
 */
function previewFromRun({ output, results } = {}) {
  const baseDir = output ? path.dirname(path.resolve(output)) : process.cwd();
  let warning;

  if (output && isImagePath(output)) {
    const r = inspectImageFile(output);
    if (r.image) return { image: r.image };
    warning = r.error;
  }

  const pathFile = findImagePath(results, baseDir);
  if (pathFile) {
    const r = inspectImageFile(pathFile);
    if (r.image) return { image: r.image };
    warning = warning || r.error;
  }

  const payload = findBase64Image(results);
  if (payload) {
    const r = inspectBase64Image(payload.data, payload.mimeType);
    if (r.image) return { image: r.image };
    warning = warning || r.error;
  }

  return warning ? { warning } : {};
}

/** Preview for artcraft_cli: preview_file, or -o/--out/--export inferred. */
function previewFromCli({ previewFile, args } = {}) {
  const explicit = previewFile || null;
  const inferred = inferOutputPath(args);
  const file = explicit || inferred;
  if (!file) return {};
  // An inferred non-image output (e.g. -o report.pdf) is not a preview.
  if (!explicit && !isImagePath(file)) return {};
  const r = inspectImageFile(file);
  if (r.image) return { image: r.image };
  return { warning: r.error || `could not read preview file: ${file}` };
}

/** Safe metadata for structuredContent (never includes base64). */
function imageMeta(image) {
  return {
    ...(image.file ? { file: image.file } : {}),
    mimeType: image.mimeType,
    bytes: image.bytes,
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
    ...(image.warning ? { warning: image.warning } : {}),
  };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIM,
  isImagePath,
  sniffMime,
  inspectImageFile,
  inspectBase64Image,
  inferOutputPath,
  previewFromRun,
  previewFromCli,
  imageMeta,
};
