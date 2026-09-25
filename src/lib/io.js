'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');

/** Create a directory and all missing parents. */
async function ensureDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true });
}

/** Resolve a project-relative path from any script location. */
function fromProjectRoot(projectRoot, relativePath) {
  return path.resolve(projectRoot, relativePath);
}

/** Request HTTP metadata while following redirects. */
function requestHead(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }

    const client = url.startsWith('https:') ? https : http;
    const request = client.request(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mog-TogoVar-2026/2.0' },
      timeout: 30_000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const redirected = new URL(response.headers.location, url).toString();
        response.resume();
        requestHead(redirected, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HEAD ${url} returned HTTP ${response.statusCode}`));
        return;
      }

      response.resume();
      resolve({
        resolvedUrl: url,
        contentLength: Number(response.headers['content-length'] || 0),
        contentType: response.headers['content-type'] || '',
        contentDisposition: response.headers['content-disposition'] || '',
        etag: response.headers.etag || '',
        lastModified: response.headers['last-modified'] || ''
      });
    });

    request.on('timeout', () => request.destroy(new Error(`HEAD timeout for ${url}`)));
    request.on('error', reject);
    request.end();
  });
}

/** Download a URL atomically while following redirects. */
function downloadFile(url, destination, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }

    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      headers: { 'User-Agent': 'Mog-TogoVar-2026/2.0' },
      timeout: 120_000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const redirected = new URL(response.headers.location, url).toString();
        response.resume();
        downloadFile(redirected, destination, onProgress, redirectCount + 1)
          .then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`GET ${url} returned HTTP ${response.statusCode}`));
        return;
      }

      const temporary = `${destination}.part`;
      const output = fs.createWriteStream(temporary);
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;

      response.on('data', chunk => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', async () => {
        try {
          await fsp.rename(temporary, destination);
          resolve({
            resolvedUrl: url,
            contentLength: received,
            contentType: response.headers['content-type'] || '',
            contentDisposition: response.headers['content-disposition'] || '',
            etag: response.headers.etag || '',
            lastModified: response.headers['last-modified'] || ''
          });
        } catch (error) {
          reject(error);
        }
      });
      response.pipe(output);
    });

    request.on('timeout', () => request.destroy(new Error(`GET timeout for ${url}`)));
    request.on('error', reject);
  });
}

/** Calculate a SHA-256 digest without loading the file into memory. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Return a line iterator for plain-text or gzip-compressed input. */
function readLines(filePath) {
  const input = fs.createReadStream(filePath);
  const stream = filePath.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

/** Protect tabs and newlines before writing a TSV field. */
function cleanTsvValue(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

/** Write one TSV record to a writable stream. */
function writeTsvRow(stream, values) {
  stream.write(`${values.map(cleanTsvValue).join('\t')}\n`);
}

/** Read a small TSV file into objects using its first row as the header. */
async function readTsvObjects(filePath) {
  const rows = [];
  let header = null;
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    const values = line.split('\t');
    if (!header) {
      header = values;
      continue;
    }
    const row = {};
    header.forEach((name, index) => { row[name] = values[index] || ''; });
    rows.push(row);
  }
  return rows;
}

/** Convert bytes to a concise human-readable string. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

module.exports = {
  cleanTsvValue,
  downloadFile,
  ensureDirectory,
  formatBytes,
  fromProjectRoot,
  readLines,
  readTsvObjects,
  requestHead,
  sha256File,
  writeTsvRow
};
