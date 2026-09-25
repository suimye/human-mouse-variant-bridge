#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const {
  decodeVcfValue,
  displayClinvarValue,
  isAcceptedClinvarSignificance,
  parseClinvarDiseaseIds,
  parseClinvarGenes,
  parseVcfInfo
} = require('./lib/parsers');
const { ensureDirectory, readLines, readTsvObjects, writeTsvRow } = require('./lib/io');
const { loadWorkflowConfig, sourcePath } = require('./lib/config');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');
const WORKFLOW_CONFIG = loadWorkflowConfig(PROJECT_ROOT);
const RAW = {
  clinvar: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'clinvar_grch38'),
  gwas: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'gwas_catalog_associations'),
  genePhenotype: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mgi_gene_pheno'),
  phenotypicAllele: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mgi_phenotypic_alleles'),
  mpVocabulary: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mgi_mp_vocabulary'),
  hgnc: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'hgnc_complete_set')
};

const HUMAN_COLUMNS = [
  'human_gene', 'human_ncbi_gene_id', 'rs_id', 'chromosome', 'position',
  'reference_allele', 'alternate_allele', 'variant_source', 'source_record_id',
  'phenotype_id', 'phenotype_label', 'evidence_class', 'evidence_detail',
  'p_value', 'publication_id', 'clinical_significance', 'condition_identifiers',
  'reported_genes', 'mapped_genes'
];
const MOUSE_COLUMNS = [
  'mouse_gene', 'mouse_ncbi_gene_id', 'mgi_marker_id', 'mouse_allele',
  'mgi_allele_id', 'allele_name', 'allele_type', 'allelic_composition',
  'genetic_background', 'phenotype_id', 'phenotype_label', 'phenotype_definition',
  'phenotype_source', 'evidence_detail', 'pubmed_ids', 'mgi_genotype_id'
];

/** Finish a gzip pipeline only after the destination has flushed. */
function closePipedStream(transform, destination) {
  return new Promise((resolve, reject) => {
    transform.on('error', reject);
    destination.on('error', reject);
    destination.on('finish', resolve);
    transform.end();
  });
}

/** Read one-to-one ortholog records into human and mouse lookup maps. */
async function loadOrthologs(filePath, hgncPath = RAW.hgnc) {
  const rows = await readTsvObjects(filePath);
  const hgncRows = await readTsvObjects(hgncPath);
  const hgncById = new Map(hgncRows.map(row => [row.hgnc_id, row]));
  const enrichedRows = rows.map(row => ({
    ...row,
    human_ensembl_gene_id: hgncById.get(row.hgnc_id)?.ensembl_gene_id || ''
  }));
  return {
    rows: enrichedRows,
    byHumanSymbol: new Map(enrichedRows.map(row => [row.human_gene, row])),
    byHumanNcbi: new Map(enrichedRows.map(row => [row.human_ncbi_gene_id, row])),
    byHumanEnsembl: new Map(enrichedRows.filter(row => row.human_ensembl_gene_id)
      .map(row => [row.human_ensembl_gene_id, row])),
    byMouseMgi: new Map(enrichedRows.map(row => [row.mgi_marker_id, row]))
  };
}

/** Split ClinVar condition labels without losing their record-level grouping. */
function clinvarConditionLabels(value) {
  if (!value || value === '.') return [];
  return value.split('|').map(item => decodeVcfValue(item).replace(/_/g, ' ').trim()).filter(Boolean);
}

/** Write ClinVar phenotypes and return variant identities used to verify curated rows. */
async function prepareClinvar(out, orthologs, config, stats) {
  const identities = new Set();
  const seen = new Set();
  for await (const line of readLines(RAW.clinvar)) {
    if (!line || line.startsWith('#')) continue;
    stats.clinvar.scanned += 1;
    const fields = line.split('\t');
    if (fields.length < 8) continue;
    const [chromosome, position, variationId, reference, alternate, , , infoText] = fields;
    const info = parseVcfInfo(infoText);
    const rsIds = String(info.RS || '').split(',').filter(value => /^\d+$/.test(value)).map(value => `rs${value}`);
    if (!rsIds.length) continue;
    const genes = parseClinvarGenes(info.GENEINFO)
      .map(gene => orthologs.byHumanSymbol.get(gene.symbol))
      .filter(Boolean);
    if (!genes.length) continue;
    for (const gene of genes) for (const rsId of rsIds) identities.add(`${gene.human_gene}|${rsId}`);

    const accepted = isAcceptedClinvarSignificance(info.CLNSIG, config.accepted_clinvar_significance);
    if (!accepted) continue;
    const labels = clinvarConditionLabels(info.CLNDN);
    const idGroups = String(info.CLNDISDB || '').split(',');
    const clinicalSignificance = displayClinvarValue(info.CLNSIG);
    const evidenceDetail = `ClinVar aggregate classification; review status: ${displayClinvarValue(info.CLNREVSTAT) || 'not reported'}`;
    for (let conditionIndex = 0; conditionIndex < Math.max(labels.length, idGroups.length); conditionIndex += 1) {
      const phenotypeLabel = labels[conditionIndex] || labels[0] || '';
      if (!phenotypeLabel || /^not provided$/i.test(phenotypeLabel)) continue;
      const identifiers = parseClinvarDiseaseIds(idGroups[conditionIndex] || '').join('|');
      for (const gene of genes) {
        for (const rsId of rsIds) {
          const key = [gene.human_gene, rsId, variationId, identifiers, phenotypeLabel].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const record = {
            human_gene: gene.human_gene,
            human_ncbi_gene_id: gene.human_ncbi_gene_id,
            rs_id: rsId,
            chromosome,
            position,
            reference_allele: reference,
            alternate_allele: alternate,
            variant_source: 'ClinVar',
            source_record_id: variationId,
            phenotype_id: identifiers,
            phenotype_label: phenotypeLabel,
            evidence_class: 'clinvar_supported',
            evidence_detail: evidenceDetail,
            p_value: '',
            publication_id: '',
            clinical_significance: clinicalSignificance,
            condition_identifiers: identifiers,
            reported_genes: '',
            mapped_genes: ''
          };
          writeTsvRow(out, HUMAN_COLUMNS.map(column => record[column]));
          stats.clinvar.rows += 1;
          stats.humanVariants.add(rsId);
        }
      }
    }
  }
  stats.clinvar.identities = identities.size;
  return identities;
}

/** Stream the single uncompressed association table contained in the GWAS ZIP. */
async function withGwasLines(zipPath, onLine) {
  const unzip = spawn('unzip', ['-p', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  unzip.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exitPromise = new Promise((resolve, reject) => {
    unzip.on('error', reject);
    unzip.on('close', resolve);
  });
  const reader = readline.createInterface({ input: unzip.stdout, crlfDelay: Infinity });
  for await (const line of reader) await onLine(line);
  const exitCode = await exitPromise;
  if (exitCode !== 0) throw new Error(`Unable to extract GWAS Catalog ZIP: ${stderr.trim()}`);
}

/** Write genome-wide significant GWAS traits linked by direct SNP_GENE_IDS. */
async function prepareGwas(out, orthologs, config, stats) {
  let header = null;
  const seen = new Set();
  await withGwasLines(RAW.gwas, async line => {
    if (!line.trim()) return;
    const values = line.split('\t');
    if (!header || values.includes('SNP_GENE_IDS')) {
      header = values.map(value => value.replace(/^\uFEFF/, ''));
      return;
    }
    stats.gwas.scanned += 1;
    const row = {};
    header.forEach((name, index) => { row[name] = values[index] || ''; });
    const pValue = Number(row['P-VALUE']);
    if (!Number.isFinite(pValue) || pValue > config.maximum_gwas_p_value) return;
    const directGenes = [...new Set(String(row.SNP_GENE_IDS || '').match(/ENSG\d+/g) || [])]
      .map(id => orthologs.byHumanEnsembl.get(id)).filter(Boolean);
    if (!directGenes.length) return;
    const rsIds = [...new Set(`${row.SNPS || ''};${row['STRONGEST SNP-RISK ALLELE'] || ''}`
      .match(/rs\d+/gi) || [])].map(value => value.toLowerCase());
    if (!rsIds.length) return;
    const phenotypeLabel = row.MAPPED_TRAIT || row['DISEASE/TRAIT'];
    if (!phenotypeLabel) return;
    for (const gene of directGenes) {
      for (const rsId of rsIds) {
        const key = [row['STUDY ACCESSION'], gene.human_gene, rsId, phenotypeLabel, pValue].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const record = {
          human_gene: gene.human_gene,
          human_ncbi_gene_id: gene.human_ncbi_gene_id,
          rs_id: rsId,
          chromosome: row.CHR_ID,
          position: row.CHR_POS,
          reference_allele: '',
          alternate_allele: '',
          variant_source: 'GWAS_Catalog',
          source_record_id: row['STUDY ACCESSION'],
          phenotype_id: row.MAPPED_TRAIT_URI,
          phenotype_label: phenotypeLabel,
          evidence_class: 'gwas_significant',
          evidence_detail: row['DISEASE/TRAIT'],
          p_value: row['P-VALUE'],
          publication_id: row.PUBMEDID ? `PMID:${row.PUBMEDID}` : '',
          clinical_significance: '',
          condition_identifiers: row.MAPPED_TRAIT_URI,
          reported_genes: row['REPORTED GENE(S)'],
          mapped_genes: row.MAPPED_GENE
        };
        writeTsvRow(out, HUMAN_COLUMNS.map(column => record[column]));
        stats.gwas.rows += 1;
        stats.humanVariants.add(rsId);
      }
    }
  });
}

/** Read current MGI allele names and marker relationships. */
async function loadAlleleMetadata(filePath) {
  const metadata = new Map();
  for await (const line of readLines(filePath)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const values = line.split('\t');
    if (!values[0]?.startsWith('MGI:') || values.length < 8) continue;
    const [alleleId, alleleSymbol, alleleName, alleleType, alleleAttribute,
      originalReference, markerId, markerSymbol] = values;
    metadata.set(alleleId, {
      alleleId, alleleSymbol, alleleName, alleleType, alleleAttribute,
      originalReference, markerId, markerSymbol
    });
  }
  return metadata;
}

/** Read MP labels and definitions by identifier. */
async function loadMpVocabulary(filePath) {
  const vocabulary = new Map();
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    const [id, label, definition] = line.split('\t');
    if (id?.startsWith('MP:')) vocabulary.set(id, { label, definition });
  }
  return vocabulary;
}

/** Write specific MP annotations and allele-name functional descriptors. */
async function prepareMouse(out, orthologs, alleleMetadata, mpVocabulary, stats) {
  const alleleDescriptorSeen = new Set();
  const mpSeen = new Set();
  for await (const line of readLines(RAW.genePhenotype)) {
    if (!line.trim()) continue;
    const values = line.split('\t');
    if (values.length < 8 || values[0] === 'Allelic Composition') continue;
    stats.mouse.scanned += 1;
    const [composition, alleleSymbols, alleleIdsText, background, mpId, pubmedIds,
      markerIdsText, genotypeId] = values;
    const markerIds = markerIdsText.split('|').filter(Boolean);
    if (markerIds.length !== 1) continue;
    const ortholog = orthologs.byMouseMgi.get(markerIds[0]);
    if (!ortholog) continue;
    const alleleIds = alleleIdsText.split('|').filter(Boolean);
    const alleleRecords = alleleIds.map(id => alleleMetadata.get(id)).filter(Boolean);
    const primaryAllele = alleleRecords.find(allele => allele.markerId === markerIds[0]) || alleleRecords[0] || {};
    const mp = mpVocabulary.get(mpId) || {};
    if (mp.label) {
      const signature = [ortholog.mouse_gene, alleleIdsText, background, mpId, genotypeId].join('|');
      if (!mpSeen.has(signature)) {
        mpSeen.add(signature);
        const record = {
          mouse_gene: ortholog.mouse_gene,
          mouse_ncbi_gene_id: ortholog.mouse_ncbi_gene_id,
          mgi_marker_id: markerIds[0],
          mouse_allele: alleleSymbols,
          mgi_allele_id: alleleIdsText,
          allele_name: primaryAllele.alleleName || '',
          allele_type: primaryAllele.alleleType || '',
          allelic_composition: composition,
          genetic_background: background,
          phenotype_id: mpId,
          phenotype_label: mp.label,
          phenotype_definition: mp.definition || '',
          phenotype_source: 'MGI_MP',
          evidence_detail: 'Specific MP annotation from MGI_GenePheno',
          pubmed_ids: pubmedIds,
          mgi_genotype_id: genotypeId
        };
        writeTsvRow(out, MOUSE_COLUMNS.map(column => record[column]));
        stats.mouse.mpRows += 1;
      }
    }
    for (const allele of alleleRecords.filter(item => item.alleleName)) {
      const signature = [ortholog.mouse_gene, allele.alleleId, background, genotypeId].join('|');
      if (alleleDescriptorSeen.has(signature)) continue;
      alleleDescriptorSeen.add(signature);
      const record = {
        mouse_gene: ortholog.mouse_gene,
        mouse_ncbi_gene_id: ortholog.mouse_ncbi_gene_id,
        mgi_marker_id: markerIds[0],
        mouse_allele: allele.alleleSymbol || alleleSymbols,
        mgi_allele_id: allele.alleleId,
        allele_name: allele.alleleName,
        allele_type: allele.alleleType,
        allelic_composition: composition,
        genetic_background: background,
        phenotype_id: '',
        phenotype_label: allele.alleleName,
        phenotype_definition: '',
        phenotype_source: 'MGI_allele_name',
        evidence_detail: `MGI phenotypic allele name; original reference ${allele.originalReference || 'not reported'}`,
        pubmed_ids: pubmedIds,
        mgi_genotype_id: genotypeId
      };
      writeTsvRow(out, MOUSE_COLUMNS.map(column => record[column]));
      stats.mouse.alleleNameRows += 1;
    }
  }
}

/** Build evidence catalogs for the ortholog-first candidate mapper. */
async function main() {
  await ensureDirectory(PROCESSED_DIR);
  const [orthologs, alleleMetadata, mpVocabulary] = await Promise.all([
    loadOrthologs(path.join(PROCESSED_DIR, 'ortholog_mapping.tsv')),
    loadAlleleMetadata(RAW.phenotypicAllele),
    loadMpVocabulary(RAW.mpVocabulary)
  ]);
  const config = { ...WORKFLOW_CONFIG.strict_mapping, ...WORKFLOW_CONFIG.ortholog_first_mapping };
  const stats = {
    generatedAt: new Date().toISOString(),
    clinvar: { scanned: 0, identities: 0, rows: 0 },
    gwas: { scanned: 0, rows: 0 },
    mouse: { scanned: 0, mpRows: 0, alleleNameRows: 0 },
    humanVariants: new Set(),
    orthologPairs: orthologs.rows.length,
    alleleMetadata: alleleMetadata.size,
    mpVocabulary: mpVocabulary.size
  };

  const enrichedOrtholog = fs.createWriteStream(path.join(PROCESSED_DIR, 'ortholog_mapping_enriched.tsv'));
  const enrichedColumns = [
    'human_gene', 'human_ncbi_gene_id', 'human_ensembl_gene_id', 'hgnc_id',
    'mouse_gene', 'mouse_ncbi_gene_id', 'mgi_marker_id', 'source'
  ];
  writeTsvRow(enrichedOrtholog, enrichedColumns);
  for (const row of orthologs.rows) writeTsvRow(enrichedOrtholog, enrichedColumns.map(column => row[column]));
  await new Promise((resolve, reject) => {
    enrichedOrtholog.on('error', reject);
    enrichedOrtholog.end(resolve);
  });

  const humanFile = fs.createWriteStream(path.join(PROCESSED_DIR, 'human_variant_phenotypes.tsv.gz'));
  const human = zlib.createGzip({ level: 6 });
  human.pipe(humanFile);
  writeTsvRow(human, HUMAN_COLUMNS);
  await prepareClinvar(human, orthologs, config, stats);
  await prepareGwas(human, orthologs, config, stats);
  await closePipedStream(human, humanFile);

  const mouseFile = fs.createWriteStream(path.join(PROCESSED_DIR, 'mouse_variant_phenotypes.tsv.gz'));
  const mouse = zlib.createGzip({ level: 6 });
  mouse.pipe(mouseFile);
  writeTsvRow(mouse, MOUSE_COLUMNS);
  await prepareMouse(mouse, orthologs, alleleMetadata, mpVocabulary, stats);
  await closePipedStream(mouse, mouseFile);

  stats.uniqueHumanVariants = stats.humanVariants.size;
  delete stats.humanVariants;
  await fsp.writeFile(
    path.join(PROCESSED_DIR, 'relaxed_preparation_stats.json'),
    `${JSON.stringify(stats, null, 2)}\n`,
    'utf8'
  );
  console.log(`Prepared relaxed evidence: ${stats.clinvar.rows.toLocaleString('en-US')} ClinVar and ${stats.gwas.rows.toLocaleString('en-US')} GWAS rows; ${stats.mouse.mpRows.toLocaleString('en-US')} MP and ${stats.mouse.alleleNameRows.toLocaleString('en-US')} mouse allele-name rows. Manual human literature phenotypes are not ingested.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  HUMAN_COLUMNS,
  MOUSE_COLUMNS,
  clinvarConditionLabels,
  loadAlleleMetadata,
  loadMpVocabulary,
  loadOrthologs,
  withGwasLines
};
