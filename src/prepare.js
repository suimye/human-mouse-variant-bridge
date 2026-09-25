#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  displayClinvarValue,
  isAcceptedClinvarSignificance,
  normalizeDiseaseId,
  parseClinvarDiseaseIds,
  parseClinvarGenes,
  parseDelimited,
  parseVcfInfo
} = require('./lib/parsers');
const { ensureDirectory, readLines, writeTsvRow } = require('./lib/io');
const { loadWorkflowConfig, sourcePath } = require('./lib/config');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');
const WORKFLOW_CONFIG = loadWorkflowConfig(PROJECT_ROOT);

const RAW = {
  clinvar: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'clinvar_grch38'),
  hpoa: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'hpo_annotations'),
  upheno: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'monarch_upheno'),
  mhmi: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mhmi_mgi'),
  mousePhenotype: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mgi_gene_pheno'),
  ortholog: sourcePath(PROJECT_ROOT, WORKFLOW_CONFIG, 'mgi_orthologs')
};

/** Normalize ontology IRIs and CURIEs to the HP: or MP: form. */
function normalizeOntologyId(value) {
  const cleaned = String(value || '').trim();
  const iriMatch = cleaned.match(/\/obo\/(HP|MP)_([0-9]+)$/);
  if (iriMatch) return `${iriMatch[1]}:${iriMatch[2]}`;
  return cleaned;
}

/** Normalize SKOS predicate IRIs to compact identifiers. */
function normalizePredicate(value) {
  const cleaned = String(value || '').trim();
  const match = cleaned.match(/skos\/core[#/]([A-Za-z]+Match)$/);
  return match ? `skos:${match[1]}` : cleaned;
}

/** Convert one SSSOM file to consistently directed HP-to-MP mapping objects. */
async function parseSssomMappings(filePath, sourceId) {
  const text = await fsp.readFile(filePath, 'utf8');
  const headerMatch = text.match(/^(?:subject_id|object_id)\t.*$/m);
  if (!headerMatch || headerMatch.index === undefined) {
    throw new Error(`SSSOM header not found in ${filePath}`);
  }

  const rows = parseDelimited(text.slice(headerMatch.index), '\t');
  const header = rows.shift().map(value => value.replace(/^\uFEFF/, '').trim());
  return rows.map(values => {
    const row = {};
    header.forEach((name, index) => { row[name] = values[index] || ''; });
    const subject = normalizeOntologyId(row.subject_id);
    const object = normalizeOntologyId(row.object_id);
    const hpFirst = subject.startsWith('HP:') && object.startsWith('MP:');
    const mpFirst = subject.startsWith('MP:') && object.startsWith('HP:');
    if (!hpFirst && !mpFirst) return null;
    return {
      hpo_id: hpFirst ? subject : object,
      hpo_label: hpFirst ? row.subject_label : row.object_label,
      mp_id: hpFirst ? object : subject,
      mp_label: hpFirst ? row.object_label : row.subject_label,
      predicate: normalizePredicate(row.predicate_id),
      confidence: row.confidence || '',
      mapping_justification: row.mapping_justification || '',
      mapping_date: row.mapping_date || '',
      mapping_source: sourceId
    };
  }).filter(Boolean);
}

/** Merge repeated mappings while retaining all contributing sources. */
function mergeMappings(mappingLists) {
  const merged = new Map();
  for (const mapping of mappingLists.flat()) {
    const key = [mapping.hpo_id, mapping.mp_id, mapping.predicate].join('|');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...mapping, sources: new Set([mapping.mapping_source]) });
      continue;
    }
    existing.sources.add(mapping.mapping_source);
    if (!existing.hpo_label && mapping.hpo_label) existing.hpo_label = mapping.hpo_label;
    if (!existing.mp_label && mapping.mp_label) existing.mp_label = mapping.mp_label;
    if ((!existing.confidence || Number(mapping.confidence) > Number(existing.confidence)) && mapping.confidence) {
      existing.confidence = mapping.confidence;
    }
    if (!existing.mapping_date && mapping.mapping_date) existing.mapping_date = mapping.mapping_date;
  }
  return [...merged.values()].map(mapping => ({
    ...mapping,
    mapping_source: [...mapping.sources].sort().join('|')
  })).sort((left, right) => (
    left.hpo_id.localeCompare(right.hpo_id)
    || left.mp_id.localeCompare(right.mp_id)
    || left.predicate.localeCompare(right.predicate)
  ));
}

/** Save the normalized HPO-MP bridge and return lookup sets and labels. */
async function preparePhenotypeMappings(stats) {
  const lists = await Promise.all([
    parseSssomMappings(RAW.upheno, 'monarch_upheno'),
    parseSssomMappings(RAW.mhmi, 'mhmi_mgi')
  ]);
  const mappings = mergeMappings(lists);
  const outputPath = path.join(PROCESSED_DIR, 'hpo_mp_mapping.tsv');
  const output = fs.createWriteStream(outputPath);
  writeTsvRow(output, [
    'hpo_id', 'hpo_label', 'mp_id', 'mp_label', 'predicate', 'confidence',
    'mapping_justification', 'mapping_date', 'mapping_source'
  ]);
  for (const mapping of mappings) {
    writeTsvRow(output, [
      mapping.hpo_id, mapping.hpo_label, mapping.mp_id, mapping.mp_label,
      mapping.predicate, mapping.confidence, mapping.mapping_justification,
      mapping.mapping_date, mapping.mapping_source
    ]);
  }
  await closeStream(output);

  stats.hpoMp = {
    uphenoRows: lists[0].length,
    mhmiRows: lists[1].length,
    uniqueRows: mappings.length,
    uniqueHpoTerms: new Set(mappings.map(mapping => mapping.hpo_id)).size,
    uniqueMpTerms: new Set(mappings.map(mapping => mapping.mp_id)).size
  };
  return {
    mappings,
    mappedHpo: new Set(mappings.map(mapping => mapping.hpo_id)),
    mappedMp: new Set(mappings.map(mapping => mapping.mp_id)),
    hpoLabels: new Map(mappings.filter(mapping => mapping.hpo_label)
      .map(mapping => [mapping.hpo_id, mapping.hpo_label]))
  };
}

/** Load HPO disease annotations that can participate in an HP-MP bridge. */
async function loadHpoDiseaseAnnotations(filePath, mappedHpo, stats) {
  const diseaseToHpo = new Map();
  let totalRows = 0;
  let retainedRows = 0;
  let header = null;
  const fallback = [
    'database_id', 'disease_name', 'qualifier', 'hpo_id', 'reference', 'evidence',
    'onset', 'frequency', 'sex', 'modifier', 'aspect', 'biocuration'
  ];

  for await (const rawLine of readLines(filePath)) {
    if (!rawLine.trim()) continue;
    const commentStripped = rawLine.startsWith('#') ? rawLine.slice(1) : rawLine;
    const values = commentStripped.split('\t');
    if (!header && values.includes('database_id') && values.includes('hpo_id')) {
      header = values.map(value => value.trim().toLowerCase());
      continue;
    }
    if (rawLine.startsWith('#')) continue;
    if (!header) header = fallback;
    totalRows += 1;

    const row = {};
    header.forEach((name, index) => { row[name] = values[index] || ''; });
    const hpoId = normalizeOntologyId(row.hpo_id);
    if (!mappedHpo.has(hpoId) || row.qualifier === 'NOT' || row.aspect !== 'P') continue;
    const diseaseId = normalizeDiseaseId(row.database_id);
    if (!diseaseId) continue;

    if (!diseaseToHpo.has(diseaseId)) diseaseToHpo.set(diseaseId, new Map());
    const byHpo = diseaseToHpo.get(diseaseId);
    if (!byHpo.has(hpoId)) {
      byHpo.set(hpoId, {
        diseaseId,
        diseaseName: row.disease_name,
        hpoId,
        reference: row.reference,
        evidence: row.evidence,
        frequency: row.frequency,
        biocuration: row.biocuration
      });
      retainedRows += 1;
    }
  }

  stats.hpoAnnotations = {
    totalRows,
    retainedRows,
    diseasesWithMappedPhenotypes: diseaseToHpo.size
  };
  return diseaseToHpo;
}

/** Load one-to-one protein-coding orthologs and write a normalized table. */
async function prepareOrthologs(filePath, stats) {
  const outputPath = path.join(PROCESSED_DIR, 'ortholog_mapping.tsv');
  const output = fs.createWriteStream(outputPath);
  const byMouseMgiId = new Map();
  const byHumanSymbol = new Map();
  let totalRows = 0;
  writeTsvRow(output, [
    'human_gene', 'human_ncbi_gene_id', 'hgnc_id', 'mouse_gene',
    'mouse_ncbi_gene_id', 'mgi_marker_id', 'source'
  ]);

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    const values = line.split('\t');
    if (values.length < 6 || values[0] === 'MGI Marker Accession ID') continue;
    const [mgiId, mouseSymbol, mouseNcbi, hgncId, humanSymbol, humanNcbi] = values;
    if (!mgiId.startsWith('MGI:') || !mouseSymbol || !humanSymbol) continue;
    const record = {
      human_gene: humanSymbol,
      human_ncbi_gene_id: humanNcbi,
      hgnc_id: hgncId,
      mouse_gene: mouseSymbol,
      mouse_ncbi_gene_id: mouseNcbi,
      mgi_marker_id: mgiId,
      source: 'MGI_HOM_ProteinCoding'
    };
    totalRows += 1;
    byMouseMgiId.set(mgiId, record);
    if (!byHumanSymbol.has(humanSymbol)) byHumanSymbol.set(humanSymbol, []);
    byHumanSymbol.get(humanSymbol).push(record);
    writeTsvRow(output, Object.values(record));
  }
  await closeStream(output);
  stats.orthologs = { oneToOnePairs: totalRows };
  return { byMouseMgiId, byHumanSymbol };
}

/** Convert MGI gene-genotype annotations to allele-level MP records. */
async function prepareMousePhenotypes(filePath, mappedMp, orthologs, stats) {
  const output = fs.createWriteStream(path.join(PROCESSED_DIR, 'mouse_allele_mp.tsv'));
  const controls = fs.createWriteStream(path.join(PROCESSED_DIR, 'control_mouse_variants.tsv'));
  const header = [
    'mouse_gene', 'mouse_ncbi_gene_id', 'mgi_marker_id', 'allelic_composition',
    'mouse_allele', 'mgi_allele_id', 'genetic_background', 'mp_id',
    'pubmed_ids', 'mgi_genotype_id'
  ];
  writeTsvRow(output, header);
  writeTsvRow(controls, header);
  let totalRows = 0;
  let singleGeneRows = 0;
  let retainedRows = 0;
  let controlRows = 0;

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    const values = line.split('\t');
    if (values.length < 8 || values[0] === 'Allelic Composition') continue;
    totalRows += 1;
    const [composition, alleleSymbols, alleleIds, background, mpId, pubmedIds, markerIdsText, genotypeId] = values;
    const markerIds = markerIdsText.split('|').filter(Boolean);
    if (markerIds.length !== 1) continue;
    singleGeneRows += 1;
    const ortholog = orthologs.byMouseMgiId.get(markerIds[0]);
    if (!ortholog) continue;
    const record = [
      ortholog.mouse_gene, ortholog.mouse_ncbi_gene_id, markerIds[0], composition,
      alleleSymbols, alleleIds, background, mpId, pubmedIds, genotypeId
    ];
    if (ortholog.mouse_gene === 'Tlr4' && /Lps-d/i.test(alleleSymbols)
        && /C3H\/HeJ/i.test(background)) {
      writeTsvRow(controls, record);
      controlRows += 1;
    }
    if (!mappedMp.has(mpId)) continue;
    writeTsvRow(output, record);
    retainedRows += 1;
  }
  await Promise.all([closeStream(output), closeStream(controls)]);
  stats.mousePhenotypes = { totalRows, singleGeneRows, retainedRows, tlr4ControlRows: controlRows };
}

/** Join precise ClinVar variants to HPO through shared disease identifiers. */
async function prepareHumanVariants(filePath, diseaseToHpo, orthologs, hpoLabels, config, stats) {
  const compressedFile = fs.createWriteStream(path.join(PROCESSED_DIR, 'human_variant_hpo.tsv.gz'));
  const output = zlib.createGzip({ level: 6 });
  output.pipe(compressedFile);
  const controls = fs.createWriteStream(path.join(PROCESSED_DIR, 'control_human_variants.tsv'));
  const header = [
    'human_gene', 'human_ncbi_gene_id', 'rs_id', 'clinvar_variation_id',
    'chromosome', 'position', 'reference_allele', 'alternate_allele', 'clinical_significance',
    'review_status', 'disease_id', 'disease_name', 'hpo_id', 'hpo_label',
    'hpo_annotation_evidence', 'hpo_annotation_reference', 'hpo_frequency', 'hpo_biocuration'
  ];
  writeTsvRow(output, header);
  writeTsvRow(controls, [
    'human_gene', 'human_ncbi_gene_id', 'rs_id', 'clinvar_variation_id',
    'chromosome', 'position', 'reference_allele', 'alternate_allele',
    'clinical_significance', 'review_status', 'condition_identifiers', 'condition_names',
    'clinical_hgvs'
  ]);

  let totalVariants = 0;
  let variantsWithRsid = 0;
  let variantsWithOrtholog = 0;
  let variantsWithAcceptedSignificance = 0;
  let variantsWithHpoBridge = 0;
  let retainedRows = 0;
  let controlRows = 0;

  for await (const line of readLines(filePath)) {
    if (!line || line.startsWith('#')) continue;
    totalVariants += 1;
    const fields = line.split('\t');
    if (fields.length < 8) continue;
    const [chromosome, position, variationId, reference, alternate, , , infoText] = fields;
    const info = parseVcfInfo(infoText);
    const rsNumbers = String(info.RS || '').split(',').filter(value => /^\d+$/.test(value));
    if (!rsNumbers.length) continue;
    variantsWithRsid += 1;
    const genes = parseClinvarGenes(info.GENEINFO).filter(gene => orthologs.byHumanSymbol.has(gene.symbol));
    if (!genes.length) continue;
    variantsWithOrtholog += 1;
    const diseaseIds = parseClinvarDiseaseIds(info.CLNDISDB);
    const conditionNames = displayClinvarValue(info.CLNDN);
    const clinicalSignificance = displayClinvarValue(info.CLNSIG);
    const reviewStatus = displayClinvarValue(info.CLNREVSTAT);
    const clinicalHgvs = displayClinvarValue(info.CLNHGVS);

    for (const gene of genes) {
      for (const rsNumber of rsNumbers) {
        if (gene.symbol === 'TLR4' && rsNumber === '4986790') {
          writeTsvRow(controls, [
            gene.symbol, gene.ncbiGeneId, `rs${rsNumber}`, variationId,
            chromosome, position, reference, alternate, clinicalSignificance,
            reviewStatus, diseaseIds.join('|'), conditionNames, clinicalHgvs
          ]);
          controlRows += 1;
        }
      }
    }

    if (!isAcceptedClinvarSignificance(info.CLNSIG, config.accepted_clinvar_significance)) continue;
    variantsWithAcceptedSignificance += 1;

    let variantWritten = false;
    const perVariant = new Set();
    for (const diseaseId of diseaseIds) {
      const annotations = diseaseToHpo.get(diseaseId);
      if (!annotations) continue;
      for (const annotation of annotations.values()) {
        for (const gene of genes) {
          for (const rsNumber of rsNumbers) {
            const signature = [gene.symbol, rsNumber, variationId, diseaseId, annotation.hpoId].join('|');
            if (perVariant.has(signature)) continue;
            perVariant.add(signature);
            writeTsvRow(output, [
              gene.symbol, gene.ncbiGeneId, `rs${rsNumber}`, variationId,
              chromosome, position, reference, alternate, clinicalSignificance,
              reviewStatus, diseaseId, annotation.diseaseName || conditionNames,
              annotation.hpoId, hpoLabels.get(annotation.hpoId) || '',
              annotation.evidence, annotation.reference, annotation.frequency,
              annotation.biocuration
            ]);
            retainedRows += 1;
            variantWritten = true;
          }
        }
      }
    }
    if (variantWritten) variantsWithHpoBridge += 1;
  }
  await Promise.all([closePipedStream(output, compressedFile), closeStream(controls)]);
  stats.humanVariants = {
    totalVariants,
    variantsWithRsid,
    variantsWithOrtholog,
    variantsWithAcceptedSignificance,
    variantsWithHpoBridge,
    retainedRows,
    tlr4ControlRows: controlRows
  };
}

/** Close a writable stream and resolve only after all data reaches disk. */
function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });
}

/** Finish a transform and wait for its downstream file to close. */
function closePipedStream(transform, destination) {
  return new Promise((resolve, reject) => {
    transform.on('error', reject);
    destination.on('error', reject);
    destination.on('finish', resolve);
    transform.end();
  });
}

/** Verify raw inputs exist before starting an expensive preparation run. */
async function assertRawInputs() {
  const missing = [];
  for (const filePath of Object.values(RAW)) {
    if (!fs.existsSync(filePath)) missing.push(path.relative(PROJECT_ROOT, filePath));
  }
  if (missing.length) {
    throw new Error(`Missing raw inputs; run npm run download first:\n${missing.join('\n')}`);
  }
}

/** Run each preparation stage in dependency order and record counts. */
async function main() {
  await assertRawInputs();
  await ensureDirectory(PROCESSED_DIR);
  const config = WORKFLOW_CONFIG.strict_mapping;
  const stats = { generatedAt: new Date().toISOString(), config };

  console.log('[1/5] Normalizing HPO-MP mappings...');
  const phenotype = await preparePhenotypeMappings(stats);
  console.log(`[2/5] Loading HPO disease annotations for ${phenotype.mappedHpo.size} bridge terms...`);
  const diseaseToHpo = await loadHpoDiseaseAnnotations(RAW.hpoa, phenotype.mappedHpo, stats);
  console.log('[3/5] Normalizing one-to-one human-mouse orthologs...');
  const orthologs = await prepareOrthologs(RAW.ortholog, stats);
  console.log('[4/5] Filtering MGI allele-phenotype annotations...');
  await prepareMousePhenotypes(RAW.mousePhenotype, phenotype.mappedMp, orthologs, stats);
  console.log('[5/5] Joining ClinVar conditions to HPO annotations...');
  await prepareHumanVariants(
    RAW.clinvar, diseaseToHpo, orthologs, phenotype.hpoLabels, config, stats
  );

  await fsp.writeFile(
    path.join(PROCESSED_DIR, 'preparation_stats.json'),
    `${JSON.stringify(stats, null, 2)}\n`,
    'utf8'
  );
  console.log('Preparation complete. Counts are in data/processed/preparation_stats.json.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  loadHpoDiseaseAnnotations,
  mergeMappings,
  normalizeOntologyId,
  normalizePredicate,
  parseSssomMappings
};
