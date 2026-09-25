#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { ensureDirectory, readLines, readTsvObjects, writeTsvRow } = require('./lib/io');
const { loadWorkflowConfig } = require('./lib/config');
const { writeSummarySvg } = require('./report');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

/** Index accepted HP-MP mappings by HPO identifier. */
async function indexPhenotypeMappings(filePath, config) {
  const rows = await readTsvObjects(filePath);
  const accepted = new Set(config.accepted_predicates);
  const index = new Map();
  for (const row of rows) {
    const confidence = row.confidence === '' ? 1 : Number(row.confidence);
    if (!accepted.has(row.predicate) || !Number.isFinite(confidence)
        || confidence < config.minimum_mapping_confidence) continue;
    if (!index.has(row.hpo_id)) index.set(row.hpo_id, []);
    index.get(row.hpo_id).push(row);
  }
  return { index, acceptedRows: [...index.values()].reduce((sum, list) => sum + list.length, 0) };
}

/** Index mouse alleles by orthologous gene and MP term before phenotype joining. */
async function indexMousePhenotypes(filePath) {
  const rows = await readTsvObjects(filePath);
  const index = new Map();
  for (const row of rows) {
    const key = `${row.mouse_gene}|${row.mp_id}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  return { index, rows: rows.length };
}

/** Index one-to-one mouse ortholog symbols by human gene. */
async function indexOrthologs(filePath) {
  const rows = await readTsvObjects(filePath);
  const index = new Map();
  for (const row of rows) {
    if (!index.has(row.human_gene)) index.set(row.human_gene, []);
    index.get(row.human_gene).push(row);
  }
  return { index, rows: rows.length };
}

/** Turn a TSV data line into an object using an existing header. */
function rowObject(header, line) {
  const values = line.split('\t');
  const row = {};
  header.forEach((name, index) => { row[name] = values[index] || ''; });
  return row;
}

/** Execute the ortholog-constrained phenotype bridge without global cross-products. */
async function executeMapping(paths, config) {
  const phenotype = await indexPhenotypeMappings(paths.hpoMp, config);
  const mouse = await indexMousePhenotypes(paths.mouse);
  const ortholog = await indexOrthologs(paths.ortholog);
  const compressedFile = fs.createWriteStream(paths.output);
  const output = zlib.createGzip({ level: 6 });
  output.pipe(compressedFile);
  const outputColumns = [
    'tier_id', 'connection_basis',
    'human_gene', 'human_ncbi_gene_id', 'rs_id', 'clinvar_variation_id',
    'chromosome', 'position', 'reference_allele', 'alternate_allele',
    'clinical_significance', 'review_status', 'disease_id', 'disease_name',
    'hpo_id', 'hpo_label', 'hpo_annotation_evidence', 'hpo_annotation_reference',
    'hpo_frequency', 'hpo_biocuration', 'predicate', 'mapping_confidence',
    'mapping_justification', 'mapping_date', 'mapping_source', 'mp_id', 'mp_label',
    'mouse_gene', 'mouse_ncbi_gene_id', 'mgi_marker_id', 'allelic_composition',
    'mouse_allele', 'mgi_allele_id', 'genetic_background', 'mouse_pubmed_ids',
    'mgi_genotype_id', 'ortholog_source'
  ];
  writeTsvRow(output, outputColumns);

  let header = null;
  const stats = {
    generatedAt: new Date().toISOString(),
    acceptedHpoMpRows: phenotype.acceptedRows,
    indexedMouseRows: mouse.rows,
    indexedOrthologRows: ortholog.rows,
    humanVariantHpoRows: 0,
    hpoMpCandidateRows: 0,
    orthologGeneCandidateRows: 0,
    mousePhenotypeCandidateRows: 0,
    finalRows: 0
  };
  const unique = {
    humanVariants: new Set(),
    humanGenes: new Set(),
    mouseGenes: new Set(),
    hpoTerms: new Set(),
    mpTerms: new Set()
  };

  for await (const line of readLines(paths.human)) {
    if (!line.trim()) continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    stats.humanVariantHpoRows += 1;
    const human = rowObject(header, line);
    const bridges = phenotype.index.get(human.hpo_id) || [];
    stats.hpoMpCandidateRows += bridges.length;
    const mouseOrthologs = ortholog.index.get(human.human_gene) || [];
    stats.orthologGeneCandidateRows += mouseOrthologs.length;

    for (const pair of mouseOrthologs) {
      for (const bridge of bridges) {
        const alleles = mouse.index.get(`${pair.mouse_gene}|${bridge.mp_id}`) || [];
        stats.mousePhenotypeCandidateRows += alleles.length;
        for (const allele of alleles) {
          const record = {
            tier_id: 'tier1',
            connection_basis: 'monarch_hpo_mp_phenotype',
            ...human,
            predicate: bridge.predicate,
            mapping_confidence: bridge.confidence,
            mapping_justification: bridge.mapping_justification,
            mapping_date: bridge.mapping_date,
            mapping_source: bridge.mapping_source,
            mp_id: bridge.mp_id,
            mp_label: bridge.mp_label,
            mouse_gene: allele.mouse_gene,
            mouse_ncbi_gene_id: allele.mouse_ncbi_gene_id,
            mgi_marker_id: allele.mgi_marker_id,
            allelic_composition: allele.allelic_composition,
            mouse_allele: allele.mouse_allele,
            mgi_allele_id: allele.mgi_allele_id,
            genetic_background: allele.genetic_background,
            mouse_pubmed_ids: allele.pubmed_ids,
            mgi_genotype_id: allele.mgi_genotype_id,
            ortholog_source: pair.source
          };
          writeTsvRow(output, outputColumns.map(column => record[column]));
          stats.finalRows += 1;
          unique.humanVariants.add(human.rs_id);
          unique.humanGenes.add(human.human_gene);
          unique.mouseGenes.add(allele.mouse_gene);
          unique.hpoTerms.add(human.hpo_id);
          unique.mpTerms.add(bridge.mp_id);
        }
      }
    }
  }
  await closePipedStream(output, compressedFile);
  stats.unique = Object.fromEntries(Object.entries(unique).map(([key, set]) => [key, set.size]));
  return stats;
}

/** Close a writable stream after flushing all output. */
function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });
}

/** Finish a compression stream and wait for the output file to close. */
function closePipedStream(transform, destination) {
  return new Promise((resolve, reject) => {
    transform.on('error', reject);
    destination.on('error', reject);
    destination.on('finish', resolve);
    transform.end();
  });
}

/** Load configuration, run the mapping and create its first summary figure. */
async function main() {
  await ensureDirectory(OUTPUT_DIR);
  const config = loadWorkflowConfig(PROJECT_ROOT).strict_mapping;
  const paths = {
    hpoMp: path.join(PROCESSED_DIR, 'hpo_mp_mapping.tsv'),
    mouse: path.join(PROCESSED_DIR, 'mouse_allele_mp.tsv'),
    ortholog: path.join(PROCESSED_DIR, 'ortholog_mapping.tsv'),
    human: path.join(PROCESSED_DIR, 'human_variant_hpo.tsv.gz'),
    output: path.join(OUTPUT_DIR, 'cross_phenotype_mapping_results.tsv.gz')
  };

  console.log('Indexing phenotype, mouse allele and ortholog data...');
  const stats = await executeMapping(paths, config);
  const preparation = JSON.parse(await fsp.readFile(path.join(PROCESSED_DIR, 'preparation_stats.json'), 'utf8'));
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'mapping_stats.json'),
    `${JSON.stringify(stats, null, 2)}\n`,
    'utf8'
  );
  await fsp.copyFile(
    paths.output,
    path.join(OUTPUT_DIR, 'tier1_monarch_phenotype.tsv.gz')
  );
  await writeSummarySvg(path.join(OUTPUT_DIR, 'summary.svg'), preparation, stats);
  console.log(`Mapping complete: ${stats.finalRows.toLocaleString('en-US')} result rows.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  executeMapping,
  indexMousePhenotypes,
  indexOrthologs,
  indexPhenotypeMappings,
  rowObject
};
