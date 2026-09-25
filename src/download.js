#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  downloadFile,
  ensureDirectory,
  formatBytes,
  requestHead,
  sha256File
} = require('./lib/io');
const { loadWorkflowConfig } = require('./lib/config');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'data', 'raw', 'manifest.json');
const VERSION_PATH = path.join(PROJECT_ROOT, 'DATA_VERSIONS.md');

/** Remove transient signed query parameters from provenance URLs. */
function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

/** Read JSON and return a fallback when the file does not exist. */
async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Decide whether a local file is the same release described by the server. */
function canReuse(source, previous, remote, force) {
  if (force || !previous || !fs.existsSync(path.join(PROJECT_ROOT, source.path))) return false;
  if (previous.url !== source.url) return false;
  if (remote.contentDisposition && previous.contentDisposition
      && remote.contentDisposition !== previous.contentDisposition) return false;
  if (remote.contentDisposition && previous.contentDisposition
      && remote.contentDisposition === previous.contentDisposition
      && (!remote.contentLength || remote.contentLength === previous.bytes)) return true;
  if (remote.etag && previous.etag) return remote.etag === previous.etag;
  if (remote.lastModified && previous.lastModified) {
    return remote.lastModified === previous.lastModified
      && (!remote.contentLength || remote.contentLength === previous.bytes);
  }
  return false;
}

/** Download or reuse one source, then calculate its reproducibility metadata. */
async function obtainSource(source, previous, force) {
  const destination = path.join(PROJECT_ROOT, source.path);
  await ensureDirectory(path.dirname(destination));

  let remote = {};
  try {
    remote = await requestHead(source.url);
  } catch (error) {
    console.warn(`  Metadata unavailable: ${error.message}`);
  }

  let downloadedAt = previous?.downloadedAt || '';
  let transfer = remote;
  if (canReuse(source, previous, remote, force)) {
    console.log(`  Reusing current local copy (${formatBytes(previous.bytes)})`);
  } else {
    let lastPercent = -1;
    transfer = await downloadFile(source.url, destination, (received, total) => {
      if (!total) return;
      const percent = Math.floor((received / total) * 10) * 10;
      if (percent !== lastPercent) {
        lastPercent = percent;
        process.stdout.write(`\r  ${percent}% of ${formatBytes(total)}`);
      }
    });
    if (lastPercent >= 0) process.stdout.write('\n');
    downloadedAt = new Date().toISOString();
  }

  const stat = await fsp.stat(destination);
  const sha256 = await sha256File(destination);
  return {
    ...source,
    resolvedUrl: sanitizeUrl(transfer.resolvedUrl || remote.resolvedUrl || source.url),
    bytes: stat.size,
    sha256,
    etag: transfer.etag || remote.etag || '',
    lastModified: transfer.lastModified || remote.lastModified || '',
    contentType: transfer.contentType || remote.contentType || '',
    contentDisposition: transfer.contentDisposition || remote.contentDisposition || '',
    downloadedAt
  };
}

/** Render machine-readable download metadata as a reader-facing Markdown file. */
function renderVersionMarkdown(entries, generatedAt) {
  const rows = entries.map(entry => [
    entry.name,
    entry.lastModified || entry.contentDisposition || 'not reported',
    entry.downloadedAt || 'reused',
    formatBytes(entry.bytes),
    `\`${entry.sha256}\``
  ].join(' | '));

  const details = entries.map(entry => [
    `### ${entry.name}`,
    '',
    `- Source: ${entry.url}`,
    `- Resolved URL: ${entry.resolvedUrl}`,
    `- Local raw file: \`${entry.path}\``,
    `- Scope: ${entry.scope}`,
    `- License/terms: ${entry.license}`,
    `- Server last modified: ${entry.lastModified || 'not reported'}`,
    `- Server release filename: ${entry.contentDisposition || 'not reported'}`,
    `- Downloaded at: ${entry.downloadedAt || 'reused from a verified local copy'}`,
    `- Bytes: ${entry.bytes}`,
    `- SHA-256: \`${entry.sha256}\``,
    ''
  ].join('\n')).join('\n');

  return `# Data versions (2026 implementation)\n\n`
    + `Generated: ${generatedAt}\n\n`
    + `The files below are the exact raw inputs used by this checkout. Re-run \`npm run download\` to compare server validators and refresh changed sources.\n\n`
    + `Dataset | Server release marker | Downloaded at | Size | SHA-256\n`
    + `--- | --- | --- | --- | ---\n`
    + `${rows.join('\n')}\n\n`
    + `${details}`
    + `## Important scope notes\n\n`
    + `- ClinVar VCF is restricted to variants with precise GRCh38 positions; it is not the complete ClinVar XML release.\n`
    + `- ClinVar conditions are joined to HPO disease annotations by shared OMIM, ORPHA, or MONDO identifiers. A variant does not become a causal HPO annotation merely because it is in the same gene.\n`
    + `- GWAS Catalog rows are restricted downstream to P <= 5e-8 and a direct SNP_GENE_IDS Ensembl gene mapped through the current HGNC set; reported or nearest gene names alone are not used.\n`
    + `- HPO annotations can carry source-specific reuse restrictions, especially annotations derived from OMIM. Review the source terms before redistribution.\n`
    + `- MGI_GenePheno excludes conditional mutations. The pipeline also excludes multigenic rows by default so a phenotype is not assigned to the wrong allele.\n`
    + `- Tier 3 requires an exact OMIM identifier shared by a supported ClinVar condition and an MGI-curated mouse disease model; similar disease labels alone do not qualify.\n`;
}

/** Download every configured source and write an auditable manifest. */
async function main() {
  const force = process.argv.includes('--force');
  const sources = loadWorkflowConfig(PROJECT_ROOT).data_sources;
  const previousManifest = await readJson(MANIFEST_PATH, { sources: [] });
  const previousById = new Map(previousManifest.sources.map(entry => [entry.id, entry]));
  const downloaded = [];

  console.log(`Downloading ${sources.length} current data sources${force ? ' (forced)' : ''}...`);
  for (const [index, source] of sources.entries()) {
    console.log(`[${index + 1}/${sources.length}] ${source.name}`);
    downloaded.push(await obtainSource(source, previousById.get(source.id), force));
  }

  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    nodeVersion: process.version,
    sources: downloaded
  };
  await fsp.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.writeFile(VERSION_PATH, renderVersionMarkdown(downloaded, generatedAt), 'utf8');
  console.log(`Wrote ${path.relative(PROJECT_ROOT, MANIFEST_PATH)} and ${path.relative(PROJECT_ROOT, VERSION_PATH)}.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { canReuse, obtainSource, renderVersionMarkdown, sanitizeUrl };
