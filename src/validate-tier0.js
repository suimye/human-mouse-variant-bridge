'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readLines, readTsvObjects } = require('./lib/io');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'data/external/tier0_exact_variant.template.tsv');
const ORTHOLOG_PATH = path.join(PROJECT_ROOT, 'data/processed/ortholog_mapping_enriched.tsv');

const MATCH_LEVELS = new Set(['genomic_reciprocal_exact', 'coding_exact', 'protein_exact']);
const ORIENTATIONS = new Set(['forward', 'reverse_complement']);
const QC_STATUSES = new Set(['pending', 'passed', 'rejected']);
const REQUIRED = [
  'tier_id', 'connection_basis', 'match_level', 'exact_match_definition',
  'human_gene', 'human_variant_id', 'human_assembly',
  'mouse_gene', 'mouse_variant_id', 'mouse_assembly',
  'ortholog_source', 'cross_species_alignment_source', 'alignment_version',
  'allele_orientation', 'reciprocal_mapping', 'qc_status',
  'source_dataset', 'source_version', 'source_record_id', 'source_sha256'
];

function validateTier0Row(row, orthologKeys = null) {
  const errors = [];
  for (const name of REQUIRED) {
    if (!String(row[name] || '').trim()) errors.push(`missing ${name}`);
  }
  if (row.tier_id !== 'tier0') errors.push('tier_id must be tier0');
  if (row.connection_basis !== 'exact_variant_correspondence') {
    errors.push('connection_basis must be exact_variant_correspondence');
  }
  if (!MATCH_LEVELS.has(row.match_level)) errors.push('invalid match_level');
  if (!ORIENTATIONS.has(row.allele_orientation)) errors.push('invalid allele_orientation');
  if (!['0', '1'].includes(String(row.reciprocal_mapping))) errors.push('reciprocal_mapping must be 0 or 1');
  if (!QC_STATUSES.has(row.qc_status)) errors.push('invalid qc_status');
  if (!/^[A-Fa-f0-9]{64}$/.test(row.source_sha256 || '')) errors.push('source_sha256 must be 64 hexadecimal characters');

  if (row.match_level === 'genomic_reciprocal_exact') {
    for (const name of [
      'human_chromosome', 'human_position', 'human_reference_allele', 'human_alternate_allele',
      'mouse_chromosome', 'mouse_position', 'mouse_reference_allele', 'mouse_alternate_allele'
    ]) {
      if (!String(row[name] || '').trim()) errors.push(`genomic_reciprocal_exact requires ${name}`);
    }
    if (String(row.reciprocal_mapping) !== '1') {
      errors.push('genomic_reciprocal_exact requires reciprocal_mapping=1');
    }
  }
  if (row.match_level === 'coding_exact') {
    for (const name of ['human_transcript', 'human_hgvs_c', 'mouse_transcript', 'mouse_hgvs_c']) {
      if (!String(row[name] || '').trim()) errors.push(`coding_exact requires ${name}`);
    }
  }
  if (row.match_level === 'protein_exact') {
    for (const name of ['human_transcript', 'human_hgvs_p', 'mouse_transcript', 'mouse_hgvs_p']) {
      if (!String(row[name] || '').trim()) errors.push(`protein_exact requires ${name}`);
    }
  }

  if (orthologKeys) {
    const idKey = row.human_ncbi_gene_id && row.mouse_ncbi_gene_id
      ? `id:${row.human_ncbi_gene_id}\t${row.mouse_ncbi_gene_id}` : '';
    const symbolKey = `symbol:${row.human_gene}\t${row.mouse_gene}`;
    if ((!idKey || !orthologKeys.has(idKey)) && !orthologKeys.has(symbolKey)) {
      errors.push('human and mouse genes are not an accepted 1:1 ortholog pair');
    }
  }
  return [...new Set(errors)];
}

async function loadOrthologKeys(filePath = ORTHOLOG_PATH) {
  if (!fs.existsSync(filePath)) return null;
  const keys = new Set();
  for (const row of await readTsvObjects(filePath)) {
    keys.add(`symbol:${row.human_gene}\t${row.mouse_gene}`);
    if (row.human_ncbi_gene_id && row.mouse_ncbi_gene_id) {
      keys.add(`id:${row.human_ncbi_gene_id}\t${row.mouse_ncbi_gene_id}`);
    }
  }
  return keys;
}

async function validateTier0File(filePath, options = {}) {
  const expectedHeader = fs.readFileSync(options.templatePath || TEMPLATE_PATH, 'utf8').trim().split('\t');
  const orthologKeys = options.orthologKeys === undefined ? await loadOrthologKeys() : options.orthologKeys;
  let header = null;
  let rowNumber = 0;
  const issues = [];
  const recordKeys = new Set();
  const counts = { rows: 0, pending: 0, passed: 0, rejected: 0 };

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    const values = line.split('\t');
    if (!header) {
      header = values;
      if (header.join('\t') !== expectedHeader.join('\t')) {
        issues.push({ row: 1, errors: ['header does not exactly match the Tier 0 template'] });
      }
      continue;
    }
    rowNumber += 1;
    const row = {};
    expectedHeader.forEach((name, index) => { row[name] = values[index] || ''; });
    const errors = [];
    if (values.length !== expectedHeader.length) {
      errors.push(`expected ${expectedHeader.length} columns; found ${values.length}`);
    }
    errors.push(...validateTier0Row(row, orthologKeys));
    const recordKey = `${row.source_dataset}\t${row.source_version}\t${row.source_record_id}`;
    if (recordKeys.has(recordKey)) errors.push('duplicate source_dataset/source_version/source_record_id');
    recordKeys.add(recordKey);
    counts.rows += 1;
    if (Object.hasOwn(counts, row.qc_status)) counts[row.qc_status] += 1;
    if (errors.length) issues.push({ row: rowNumber + 1, source_record_id: row.source_record_id, errors: [...new Set(errors)] });
  }
  if (!header) issues.push({ row: 1, errors: ['file has no header'] });
  return { status: issues.length ? 'FAIL' : 'PASS', file: path.resolve(filePath), counts, issues };
}

async function main() {
  const filePath = path.resolve(process.argv[2] || TEMPLATE_PATH);
  const result = await validateTier0File(filePath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { validateTier0File, validateTier0Row };
