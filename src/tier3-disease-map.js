#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { readLines, readTsvObjects, writeTsvRow } = require('./lib/io');
const { loadAlleleMetadata } = require('./prepare-relaxed');
const { loadWorkflowConfig, sourcePath } = require('./lib/config');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const WORKFLOW_CONFIG = loadWorkflowConfig(PROJECT_ROOT);
const RAW_DISEASE = sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mgi_genotype_disease_models');
const RAW_ALLELE = sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mgi_phenotypic_alleles');
const COLUMNS = [
  'tier_id', 'connection_basis', 'human_gene', 'human_ncbi_gene_id', 'rs_id',
  'human_variant_source', 'human_source_record_id', 'human_chromosome',
  'human_position', 'human_condition_label', 'human_condition_identifiers',
  'human_evidence_class', 'human_clinical_significance', 'mouse_gene',
  'mouse_ncbi_gene_id', 'mgi_marker_id', 'mouse_allele', 'mgi_allele_id',
  'mouse_allele_name', 'mouse_allele_attribute', 'allelic_composition',
  'genetic_background', 'mgi_genotype_id', 'shared_disease_id',
  'mouse_doid', 'mouse_omim_ids', 'mouse_mp_ids', 'mouse_pubmed_ids',
  'ortholog_source', 'interpretation'
];

/** Turn a TSV line into an object using an existing header. */
function rowObject(header, line) {
  const values = line.split('\t');
  const row = {};
  header.forEach((name, index) => { row[name] = values[index] || ''; });
  return row;
}

/** Close gzip after the destination has flushed. */
function closePipedStream(transform, destination) {
  return new Promise((resolve, reject) => {
    transform.on('error', reject);
    destination.on('error', reject);
    destination.on('finish', resolve);
    transform.end();
  });
}

/** Convert a pipe-delimited field to a unique, sorted list. */
function identifiers(value, prefix = '') {
  return [...new Set(String(value || '').split('|').map(item => item.trim())
    .filter(item => item && (!prefix || item.startsWith(prefix))))].sort();
}

/** Aggregate duplicate MGI disease-model rows that differ only by MP annotation. */
async function indexDiseaseModels(orthologRows, alleleMetadata) {
  const byMarker = new Map(orthologRows.map(row => [row.mgi_marker_id, row]));
  const aggregated = new Map();
  let scannedRows = 0;
  for await (const line of readLines(RAW_DISEASE)) {
    if (!line.trim()) continue;
    const values = line.split('\t');
    if (values.length < 10 || values[0] === 'Allelic Composition') continue;
    scannedRows += 1;
    const [composition, alleleSymbols, alleleIdsText, background, mpId, pubmedIds,
      markerIdsText, doIdsText, omimIdsText, genotypeId] = values;
    const markerIds = identifiers(markerIdsText);
    if (markerIds.length !== 1) continue;
    const ortholog = byMarker.get(markerIds[0]);
    if (!ortholog) continue;
    const key = [ortholog.human_gene, alleleIdsText, background, genotypeId, doIdsText, omimIdsText].join('|');
    if (!aggregated.has(key)) {
      const alleleRecords = identifiers(alleleIdsText).map(id => alleleMetadata.get(id)).filter(Boolean);
      aggregated.set(key, {
        ortholog,
        mouse_allele: alleleSymbols,
        mgi_allele_id: alleleIdsText,
        mouse_allele_name: alleleRecords.map(row => row.alleleName).filter(Boolean).join('|'),
        mouse_allele_attribute: [...new Set(alleleRecords.flatMap(row => identifiers(row.alleleAttribute)))].join('|'),
        allelic_composition: composition,
        genetic_background: background,
        mgi_genotype_id: genotypeId,
        mouse_doid: doIdsText,
        mouse_omim_ids: omimIdsText,
        mouse_mp_ids: new Set(),
        mouse_pubmed_ids: new Set()
      });
    }
    const model = aggregated.get(key);
    if (mpId) model.mouse_mp_ids.add(mpId);
    for (const publication of identifiers(pubmedIds)) model.mouse_pubmed_ids.add(publication);
  }

  const index = new Map();
  for (const model of aggregated.values()) {
    model.mouse_mp_ids = [...model.mouse_mp_ids].sort().join('|');
    model.mouse_pubmed_ids = [...model.mouse_pubmed_ids].sort().join('|');
    for (const omimId of identifiers(model.mouse_omim_ids, 'OMIM:')) {
      const key = `${model.ortholog.human_gene}|${omimId}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(model);
    }
  }
  return { index, scannedRows, uniqueModels: aggregated.size };
}

/** Join ClinVar disease IDs to independently curated MGI disease models. */
async function executeDiseaseMapping(paths) {
  const [orthologRows, alleleMetadata] = await Promise.all([
    readTsvObjects(paths.ortholog),
    loadAlleleMetadata(RAW_ALLELE)
  ]);
  const models = await indexDiseaseModels(orthologRows, alleleMetadata);
  const compressedFile = fs.createWriteStream(paths.output);
  const output = zlib.createGzip({ level: 6 });
  output.pipe(compressedFile);
  writeTsvRow(output, COLUMNS);
  const stats = {
    generatedAt: new Date().toISOString(),
    diseaseRowsScanned: models.scannedRows,
    uniqueMouseDiseaseModels: models.uniqueModels,
    humanEvidenceRows: 0,
    humanRowsWithSharedDisease: 0,
    finalRows: 0,
    unique: { humanVariants: new Set(), genes: new Set(), mouseGenotypes: new Set(), diseases: new Set() }
  };
  const seen = new Set();
  let header = null;
  for await (const line of readLines(paths.human)) {
    if (!line.trim()) continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    const human = rowObject(header, line);
    stats.humanEvidenceRows += 1;
    if (human.variant_source !== 'ClinVar' || human.evidence_class !== 'clinvar_supported') continue;
    for (const diseaseId of identifiers(human.condition_identifiers, 'OMIM:')) {
      const candidates = models.index.get(`${human.human_gene}|${diseaseId}`) || [];
      if (candidates.length) stats.humanRowsWithSharedDisease += 1;
      for (const model of candidates) {
        const signature = [human.human_gene, human.rs_id, human.source_record_id,
          model.mgi_genotype_id, diseaseId].join('|');
        if (seen.has(signature)) continue;
        seen.add(signature);
        const record = {
          tier_id: 'tier3',
          connection_basis: 'shared_disease_identifier_and_curated_mouse_model',
          human_gene: human.human_gene,
          human_ncbi_gene_id: human.human_ncbi_gene_id,
          rs_id: human.rs_id,
          human_variant_source: human.variant_source,
          human_source_record_id: human.source_record_id,
          human_chromosome: human.chromosome,
          human_position: human.position,
          human_condition_label: human.phenotype_label,
          human_condition_identifiers: human.condition_identifiers,
          human_evidence_class: human.evidence_class,
          human_clinical_significance: human.clinical_significance,
          mouse_gene: model.ortholog.mouse_gene,
          mouse_ncbi_gene_id: model.ortholog.mouse_ncbi_gene_id,
          mgi_marker_id: model.ortholog.mgi_marker_id,
          mouse_allele: model.mouse_allele,
          mgi_allele_id: model.mgi_allele_id,
          mouse_allele_name: model.mouse_allele_name,
          mouse_allele_attribute: model.mouse_allele_attribute,
          allelic_composition: model.allelic_composition,
          genetic_background: model.genetic_background,
          mgi_genotype_id: model.mgi_genotype_id,
          shared_disease_id: diseaseId,
          mouse_doid: model.mouse_doid,
          mouse_omim_ids: model.mouse_omim_ids,
          mouse_mp_ids: model.mouse_mp_ids,
          mouse_pubmed_ids: model.mouse_pubmed_ids,
          ortholog_source: model.ortholog.source,
          interpretation: 'Candidate correspondence supported by an exact ClinVar-MGI OMIM identifier and an MGI-curated mouse disease model; not variant equivalence.'
        };
        writeTsvRow(output, COLUMNS.map(column => record[column]));
        stats.finalRows += 1;
        stats.unique.humanVariants.add(human.rs_id);
        stats.unique.genes.add(human.human_gene);
        stats.unique.mouseGenotypes.add(model.mgi_genotype_id);
        stats.unique.diseases.add(diseaseId);
      }
    }
  }
  await closePipedStream(output, compressedFile);
  stats.unique = Object.fromEntries(Object.entries(stats.unique).map(([key, set]) => [key, set.size]));
  return stats;
}

/** Write the Tier 3 disease-model table and its statistics. */
async function main() {
  const paths = {
    human: path.join(PROCESSED_DIR, 'human_variant_phenotypes.tsv.gz'),
    ortholog: path.join(PROCESSED_DIR, 'ortholog_mapping.tsv'),
    output: path.join(OUTPUT_DIR, 'tier3_disease_model.tsv.gz')
  };
  const stats = await executeDiseaseMapping(paths);
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'tier3_mapping_stats.json'),
    `${JSON.stringify(stats, null, 2)}\n`,
    'utf8'
  );
  console.log(`Disease-model mapping complete: ${stats.finalRows.toLocaleString('en-US')} Tier 3 rows.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { COLUMNS, executeDiseaseMapping, identifiers, indexDiseaseModels };
