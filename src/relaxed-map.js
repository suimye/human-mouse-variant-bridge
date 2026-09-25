#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { comparePhenotypes, informativeTokens, normalizePhenotypeText,
} = require('./lib/phenotype');
const { ensureDirectory, readLines, readTsvObjects, writeTsvRow } = require('./lib/io');
const { loadWorkflowConfig } = require('./lib/config');
const { writeOrthologFirstSvg } = require('./report');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const OUTPUT_COLUMNS = [
  'tier_id', 'connection_basis',
  'human_gene', 'human_ncbi_gene_id', 'rs_id', 'human_variant_source',
  'human_source_record_id', 'human_chromosome', 'human_position',
  'human_phenotype_id', 'human_phenotype_label', 'human_evidence_class',
  'human_evidence_detail', 'human_p_value', 'human_publication_id',
  'human_clinical_significance', 'mouse_gene', 'mouse_ncbi_gene_id',
  'mgi_marker_id', 'mouse_allele', 'mgi_allele_id', 'allele_name', 'allele_type',
  'allelic_composition', 'genetic_background', 'mouse_phenotype_id',
  'mouse_phenotype_label', 'mouse_phenotype_definition', 'mouse_phenotype_source',
  'mouse_evidence_detail', 'mouse_pubmed_ids', 'mgi_genotype_id',
  'ortholog_source', 'within_tier_support', 'match_method', 'matched_concept',
  'shared_informative_tokens', 'token_jaccard', 'interpretation'
];

/** Turn a TSV line into an object with a previously read header. */
function rowObject(header, line) {
  const values = line.split('\t');
  const row = {};
  header.forEach((name, index) => { row[name] = values[index] || ''; });
  return row;
}

/** Close gzip and wait until the compressed file is fully written. */
function closePipedStream(transform, destination) {
  return new Promise((resolve, reject) => {
    transform.on('error', reject);
    destination.on('error', reject);
    destination.on('finish', resolve);
    transform.end();
  });
}

/** Create per-gene concept, label and token indexes for mouse evidence. */
async function indexMouseEvidence(filePath, orthologs, config) {
  const mouseToHuman = new Map(orthologs.map(row => [row.mouse_gene, row]));
  const byHumanGene = new Map();
  let header = null;
  let indexedRows = 0;
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    const row = rowObject(header, line);
    const ortholog = mouseToHuman.get(row.mouse_gene);
    if (!ortholog || !row.phenotype_label) continue;
    if (!byHumanGene.has(ortholog.human_gene)) {
      byHumanGene.set(ortholog.human_gene, {
        ortholog,
        rows: [],
        labels: new Map(),
        tokens: new Map()
      });
    }
    const geneIndex = byHumanGene.get(ortholog.human_gene);
    row._id = geneIndex.rows.length;
    geneIndex.rows.push(row);
    const normalized = normalizePhenotypeText(row.phenotype_label);
    if (!geneIndex.labels.has(normalized)) geneIndex.labels.set(normalized, []);
    geneIndex.labels.get(normalized).push(row._id);
    for (const token of informativeTokens(row.phenotype_label, config.uninformative_tokens)) {
      if (!geneIndex.tokens.has(token)) geneIndex.tokens.set(token, []);
      geneIndex.tokens.get(token).push(row._id);
    }
    indexedRows += 1;
  }
  return { byHumanGene, indexedRows };
}

/** Limit detailed pair comparison to mouse rows sharing a concept, label or token. */
function candidateMouseIds(human, geneIndex, config) {
  const ids = new Set();
  for (const id of geneIndex.labels.get(normalizePhenotypeText(human.phenotype_label)) || []) ids.add(id);
  for (const token of informativeTokens(human.phenotype_label, config.uninformative_tokens)) {
    for (const id of geneIndex.tokens.get(token) || []) ids.add(id);
  }
  return ids;
}

/** Human-readable statement that remains weaker than biological equivalence. */
function interpretationFor(tier) {
  if (tier === 'A') throw new Error('Tier 2 support A was retired with manual human literature phenotype ingestion.');
  if (tier === 'B') return 'Candidate correspondence: 1:1 ortholog plus the same normalized phenotype label; review allele direction and experimental context.';
  return 'Hypothesis-level correspondence: 1:1 ortholog plus controlled lexical phenotype overlap; manual review required.';
}

/** Write all evidence-bearing ortholog-first human-mouse candidate pairs. */
async function executeRelaxedMapping(paths, config) {
  const orthologRows = await readTsvObjects(paths.ortholog);
  const mouse = await indexMouseEvidence(paths.mouse, orthologRows, config);
  const included = new Set(config.included_human_evidence_classes);
  const compressedFile = fs.createWriteStream(paths.output);
  const output = zlib.createGzip({ level: 6 });
  output.pipe(compressedFile);
  writeTsvRow(output, OUTPUT_COLUMNS);

  const stats = {
    generatedAt: new Date().toISOString(),
    orthologPairs: orthologRows.length,
    indexedMouseEvidenceRows: mouse.indexedRows,
    humanEvidenceRows: 0,
    humanRowsWithOrtholog: 0,
    candidateComparisons: 0,
    finalRows: 0,
    supportGrades: { A: 0, B: 0, C: 0 },
    methods: {},
    unique: {
      humanVariants: new Set(), humanGenes: new Set(), mouseAlleles: new Set(), mouseGenes: new Set()
    }
  };
  let header = null;
  for await (const line of readLines(paths.human)) {
    if (!line.trim()) continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    const human = rowObject(header, line);
    stats.humanEvidenceRows += 1;
    if (!included.has(human.evidence_class) || !human.phenotype_label) continue;
    const geneIndex = mouse.byHumanGene.get(human.human_gene);
    if (!geneIndex) continue;
    stats.humanRowsWithOrtholog += 1;
    for (const id of candidateMouseIds(human, geneIndex, config)) {
      stats.candidateComparisons += 1;
      const mouseRow = geneIndex.rows[id];
      const match = comparePhenotypes(human, mouseRow, config);
      if (!match.matched) continue;
      const record = {
        tier_id: 'tier2',
        connection_basis: 'ortholog_constrained_phenotype_evidence',
        human_gene: human.human_gene,
        human_ncbi_gene_id: human.human_ncbi_gene_id,
        rs_id: human.rs_id,
        human_variant_source: human.variant_source,
        human_source_record_id: human.source_record_id,
        human_chromosome: human.chromosome,
        human_position: human.position,
        human_phenotype_id: human.phenotype_id,
        human_phenotype_label: human.phenotype_label,
        human_evidence_class: human.evidence_class,
        human_evidence_detail: human.evidence_detail,
        human_p_value: human.p_value,
        human_publication_id: human.publication_id,
        human_clinical_significance: human.clinical_significance,
        mouse_gene: mouseRow.mouse_gene,
        mouse_ncbi_gene_id: mouseRow.mouse_ncbi_gene_id,
        mgi_marker_id: mouseRow.mgi_marker_id,
        mouse_allele: mouseRow.mouse_allele,
        mgi_allele_id: mouseRow.mgi_allele_id,
        allele_name: mouseRow.allele_name,
        allele_type: mouseRow.allele_type,
        allelic_composition: mouseRow.allelic_composition,
        genetic_background: mouseRow.genetic_background,
        mouse_phenotype_id: mouseRow.phenotype_id,
        mouse_phenotype_label: mouseRow.phenotype_label,
        mouse_phenotype_definition: mouseRow.phenotype_definition,
        mouse_phenotype_source: mouseRow.phenotype_source,
        mouse_evidence_detail: mouseRow.evidence_detail,
        mouse_pubmed_ids: mouseRow.pubmed_ids,
        mgi_genotype_id: mouseRow.mgi_genotype_id,
        ortholog_source: geneIndex.ortholog.source,
        within_tier_support: match.evidenceTier,
        match_method: match.method,
        matched_concept: match.matchedConcept,
        shared_informative_tokens: match.sharedTokens,
        token_jaccard: match.tokenJaccard.toFixed(3),
        interpretation: interpretationFor(match.evidenceTier)
      };
      writeTsvRow(output, OUTPUT_COLUMNS.map(column => record[column]));
      stats.finalRows += 1;
      stats.supportGrades[match.evidenceTier] += 1;
      stats.methods[match.method] = (stats.methods[match.method] || 0) + 1;
      stats.unique.humanVariants.add(human.rs_id);
      stats.unique.humanGenes.add(human.human_gene);
      stats.unique.mouseAlleles.add(mouseRow.mgi_allele_id);
      stats.unique.mouseGenes.add(mouseRow.mouse_gene);
    }
  }
  await closePipedStream(output, compressedFile);
  stats.unique = Object.fromEntries(Object.entries(stats.unique).map(([key, set]) => [key, set.size]));
  return stats;
}

/** Run the candidate mapper and write statistics and an editable summary figure. */
async function main() {
  await ensureDirectory(OUTPUT_DIR);
  const config = loadWorkflowConfig(PROJECT_ROOT).ortholog_first_mapping;
  const paths = {
    human: path.join(PROCESSED_DIR, 'human_variant_phenotypes.tsv.gz'),
    mouse: path.join(PROCESSED_DIR, 'mouse_variant_phenotypes.tsv.gz'),
    ortholog: path.join(PROCESSED_DIR, 'ortholog_mapping.tsv'),
    output: path.join(OUTPUT_DIR, 'tier2_ortholog_phenotype.tsv.gz')
  };
  const stats = await executeRelaxedMapping(paths, config);
  const preparation = JSON.parse(await fsp.readFile(path.join(PROCESSED_DIR, 'relaxed_preparation_stats.json'), 'utf8'));
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'relaxed_mapping_stats.json'),
    `${JSON.stringify(stats, null, 2)}\n`,
    'utf8'
  );
  await fsp.copyFile(
    paths.output,
    path.join(OUTPUT_DIR, 'relaxed_variant_correspondence.tsv.gz')
  );
  await writeOrthologFirstSvg(path.join(OUTPUT_DIR, 'ortholog_first_summary.svg'), preparation, stats);
  console.log(`Ortholog-first mapping complete: ${stats.finalRows.toLocaleString('en-US')} candidate rows (support A ${stats.supportGrades.A.toLocaleString('en-US')}, B ${stats.supportGrades.B.toLocaleString('en-US')}, C ${stats.supportGrades.C.toLocaleString('en-US')}).`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  OUTPUT_COLUMNS,
  candidateMouseIds,
  executeRelaxedMapping,
  indexMouseEvidence,
  interpretationFor,
  rowObject
};
