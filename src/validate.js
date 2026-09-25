#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readLines, readTsvObjects, writeTsvRow } = require('./lib/io');
const { loadWorkflowConfig } = require('./lib/config');
const { writeOrthologFirstSvg, writeSummarySvg, writeTierSummarySvg } = require('./report');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

/** Count automatic TLR4 matches and detect a deliberately invalid gene pair. */
async function inspectMappingResults(filePath) {
  let header = null;
  let automaticTlr4Rows = 0;
  let invalidOrthologRows = 0;
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    const values = line.split('\t');
    const row = {};
    header.forEach((name, index) => { row[name] = values[index] || ''; });
    if (row.human_gene === 'TLR4' && row.rs_id === 'rs4986790' && row.mouse_gene === 'Tlr4') {
      automaticTlr4Rows += 1;
    }
    if (row.human_gene === 'TLR4' && row.rs_id === 'rs4986790' && row.mouse_gene === 'Trp53') {
      invalidOrthologRows += 1;
    }
  }
  return { automaticTlr4Rows, invalidOrthologRows };
}

/** Count each declared positive control in one DB-ready tier table. */
async function inspectTierResults(filePath, tierId, controls) {
  const counts = new Map(controls.map(control => [control.control_id, 0]));
  const support = new Map(controls.map(control => [control.control_id, new Set()]));
  let invalidOrthologRows = 0;
  let header = null;
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    const values = line.split('\t');
    const row = {};
    header.forEach((name, index) => { row[name] = values[index] || ''; });
    if (row.human_gene === 'TLR4' && row.rs_id === 'rs4986790' && row.mouse_gene === 'Trp53') {
      invalidOrthologRows += 1;
    }
    for (const control of controls) {
      if (row.human_gene !== control.human_gene || row.rs_id !== control.human_variant
          || row.mouse_gene !== control.mouse_gene) continue;
      const alleleIds = String(row.mgi_allele_id || '').split('|');
      if (control.mouse_allele_id && !alleleIds.includes(control.mouse_allele_id)) continue;
      counts.set(control.control_id, counts.get(control.control_id) + 1);
      if (row.within_tier_support) support.get(control.control_id).add(row.within_tier_support);
    }
  }
  return {
    tierId,
    counts,
    support,
    invalidOrthologRows
  };
}

/** Compare observed positive controls with their independently declared expected tiers. */
function buildTierValidation(controls, inspections) {
  const rows = [];
  for (const control of controls) {
    const expected = new Set(String(control.expected_tiers || '').split('|').filter(Boolean));
    for (const inspection of inspections) {
      const foundRows = inspection.counts.get(control.control_id) || 0;
      const shouldBeFound = expected.has(inspection.tierId);
      rows.push({
        control_id: control.control_id,
        tier_id: inspection.tierId,
        expected: shouldBeFound ? 'found' : 'not_required',
        found_rows: foundRows,
        within_tier_support: [...inspection.support.get(control.control_id)].sort().join('|'),
        status: shouldBeFound && foundRows === 0 ? 'FAIL' : 'PASS',
        interpretation: shouldBeFound
          ? (foundRows ? 'Expected positive control recovered.' : 'Expected positive control was not recovered.')
          : (foundRows ? 'Additional cross-tier recovery; retained for review.' : 'No recovery expected for this basis.')
      });
    }
  }
  return rows;
}

/** Validate TLR4 identities and orthology without using a hand-curated human phenotype. */
function validatePositiveControl(control, humanRows, mouseRows, orthologRows, resultInspection) {
  const humanFound = humanRows.some(row => row.human_gene === control.human_gene
    && row.rs_id === control.human_variant);
  const orthologFound = orthologRows.some(row => row.human_gene === control.human_gene
    && row.mouse_gene === control.mouse_gene);
  const mouseFound = mouseRows.some(row => row.mouse_gene === control.mouse_gene
    && row.mgi_allele_id.split('|').includes(control.mouse_allele_id)
    && row.mouse_allele.includes('Lps-d') && row.genetic_background.includes('C3H/HeJ'));
  const distinctSubstitutions = control.human_protein_change !== control.mouse_protein_change;
  const status = humanFound && orthologFound && mouseFound
    && distinctSubstitutions ? 'PASS' : 'FAIL';
  return {
    status,
    humanFound,
    orthologFound,
    mouseFound,
    distinctSubstitutions,
    manualHumanPhenotypeUsed: false,
    automaticHpoMpRows: resultInspection.automaticTlr4Rows
  };
}

/** Validate negative controls that guard against two common overclaims. */
function validateNegativeControls(controls, positive, resultInspection) {
  return controls.map(control => {
    let rejected = false;
    let observedReason = '';
    if (control.expected_rejection_reason === 'non_orthologous_gene') {
      rejected = resultInspection.invalidOrthologRows === 0;
      observedReason = rejected ? 'No result bypassed the 1:1 ortholog constraint.' : 'Invalid gene pair leaked into output.';
    } else if (control.expected_rejection_reason === 'different_residue_and_substitution') {
      rejected = positive.human_protein_change !== positive.mouse_protein_change;
      observedReason = rejected
        ? `${positive.human_protein_change} is not ${positive.mouse_protein_change}; the control is functional, not residue-equivalent.`
        : 'Substitutions unexpectedly matched.';
    }
    return { ...control, status: rejected ? 'PASS' : 'FAIL', observed_reason: observedReason };
  });
}

/** Write the positive-control audit as a one-row TSV. */
async function writePositiveResult(filePath, control, validation) {
  const output = fs.createWriteStream(filePath);
  const columns = [
    'control_id', 'status', 'human_gene', 'human_variant', 'human_protein_change',
    'human_effect', 'mouse_gene', 'mouse_allele_id', 'mouse_allele',
    'mouse_protein_change', 'mouse_background', 'mouse_effect', 'bridge_type',
    'human_identity_in_clinvar', 'ortholog_in_mgi', 'mouse_identity_in_mgi',
    'automatic_hpo_mp_rows', 'tier2_candidate_rows', 'tier2_support', 'manual_human_phenotype_used',
    'interpretation', 'human_reference', 'mouse_reference'
  ];
  writeTsvRow(output, columns);
  writeTsvRow(output, [
    control.control_id, validation.status, control.human_gene, control.human_variant,
    control.human_protein_change, control.human_effect, control.mouse_gene,
    control.mouse_allele_id, control.mouse_allele, control.mouse_protein_change,
    control.mouse_background, control.mouse_effect, control.bridge_type,
    validation.humanFound, validation.orthologFound, validation.mouseFound,
    validation.automaticHpoMpRows, validation.tier2CandidateRows || 0,
    validation.tier2Support || '', validation.manualHumanPhenotypeUsed,
    'Identity and orthology audit only. No manual human literature phenotype is injected; semantic class C is validated separately.',
    control.human_reference, control.mouse_reference
  ]);
  await closeStream(output);
}

/** Write a positive-control by tier matrix suitable for database import. */
async function writeTierValidation(filePath, rows) {
  const output = fs.createWriteStream(filePath);
  const columns = [
    'control_id', 'tier_id', 'expected', 'found_rows', 'within_tier_support',
    'status', 'interpretation'
  ];
  writeTsvRow(output, columns);
  for (const row of rows) writeTsvRow(output, columns.map(column => row[column]));
  await closeStream(output);
}

/** Write tier metadata and exact row counts for downstream database loading. */
async function writeTierCatalog(filePath, definitions, rowCounts) {
  const output = fs.createWriteStream(filePath);
  const columns = [
    'tier_id', 'name', 'connection_basis', 'output_file', 'row_count', 'interpretation'
  ];
  writeTsvRow(output, columns);
  for (const definition of definitions) {
    writeTsvRow(output, [
      definition.tier_id,
      definition.name,
      definition.connection_basis,
      definition.output,
      rowCounts[definition.tier_id] || 0,
      definition.interpretation
    ]);
  }
  await closeStream(output);
}

/** Write negative-control outcomes for transparent failure-mode testing. */
async function writeNegativeResults(filePath, results) {
  const output = fs.createWriteStream(filePath);
  const columns = [
    'control_id', 'status', 'human_gene', 'human_variant', 'mouse_gene',
    'mouse_allele', 'claim', 'expected_rejection_reason', 'observed_reason'
  ];
  writeTsvRow(output, columns);
  for (const result of results) writeTsvRow(output, columns.map(column => result[column]));
  await closeStream(output);
}

/** Close a writable stream after its final row is flushed. */
function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });
}

/** Run positive and negative controls, update the figure and fail on regressions. */
async function main() {
  const [positiveControls, negativeControls, humanRows, mouseRows, orthologRows] = await Promise.all([
    readTsvObjects(path.join(PROJECT_ROOT, 'data/controls/positive_controls.tsv')),
    readTsvObjects(path.join(PROJECT_ROOT, 'data/controls/negative_controls.tsv')),
    readTsvObjects(path.join(PROCESSED_DIR, 'control_human_variants.tsv')),
    readTsvObjects(path.join(PROCESSED_DIR, 'control_mouse_variants.tsv')),
    readTsvObjects(path.join(PROCESSED_DIR, 'ortholog_mapping.tsv'))
  ]);
  if (!positiveControls.length) throw new Error('At least one positive control is required.');
  const tlr4Control = positiveControls.find(control => control.control_id === 'TLR4_LPS_001');
  if (!tlr4Control) throw new Error('The primary TLR4 control is required.');

  const inspection = await inspectMappingResults(path.join(OUTPUT_DIR, 'cross_phenotype_mapping_results.tsv.gz'));
  const tierInspections = await Promise.all([
    inspectTierResults(path.join(OUTPUT_DIR, 'tier1_monarch_phenotype.tsv.gz'), 'tier1', positiveControls),
    inspectTierResults(path.join(OUTPUT_DIR, 'tier2_ortholog_phenotype.tsv.gz'), 'tier2', positiveControls),
    inspectTierResults(path.join(OUTPUT_DIR, 'tier3_disease_model.tsv.gz'), 'tier3', positiveControls)
  ]);
  const tierValidation = buildTierValidation(positiveControls, tierInspections);
  const positive = validatePositiveControl(
    tlr4Control, humanRows, mouseRows, orthologRows, inspection
  );
  const tier2Inspection = tierInspections.find(item => item.tierId === 'tier2');
  positive.tier2CandidateRows = tier2Inspection.counts.get(tlr4Control.control_id) || 0;
  positive.tier2Support = [...tier2Inspection.support.get(tlr4Control.control_id)].sort().join('|');
  const combinedInspection = {
    invalidOrthologRows: tierInspections.reduce((sum, item) => sum + item.invalidOrthologRows, 0)
  };
  const negatives = validateNegativeControls(negativeControls, tlr4Control, combinedInspection);
  await writePositiveResult(
    path.join(OUTPUT_DIR, 'positive_control_tlr4.tsv'), tlr4Control, positive
  );
  await writeTierValidation(path.join(OUTPUT_DIR, 'tier_validation_results.tsv'), tierValidation);
  await writeNegativeResults(path.join(OUTPUT_DIR, 'negative_control_results.tsv'), negatives);

  const validation = {
    generatedAt: new Date().toISOString(),
    positiveControl: positive,
    tierValidation,
    negativeControls: negatives.map(control => ({ controlId: control.control_id, status: control.status }))
  };
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'validation_stats.json'),
    `${JSON.stringify(validation, null, 2)}\n`,
    'utf8'
  );
  const preparation = JSON.parse(await fsp.readFile(path.join(PROCESSED_DIR, 'preparation_stats.json'), 'utf8'));
  const mapping = JSON.parse(await fsp.readFile(path.join(OUTPUT_DIR, 'mapping_stats.json'), 'utf8'));
  await writeSummarySvg(path.join(OUTPUT_DIR, 'summary.svg'), preparation, mapping, validation);
  const relaxedPreparation = JSON.parse(await fsp.readFile(path.join(PROCESSED_DIR, 'relaxed_preparation_stats.json'), 'utf8'));
  const relaxedMapping = JSON.parse(await fsp.readFile(path.join(OUTPUT_DIR, 'relaxed_mapping_stats.json'), 'utf8'));
  const tier3Mapping = JSON.parse(await fsp.readFile(path.join(OUTPUT_DIR, 'tier3_mapping_stats.json'), 'utf8'));
  const tierDefinitions = loadWorkflowConfig(PROJECT_ROOT).tier_definitions;
  await writeTierCatalog(path.join(OUTPUT_DIR, 'tier_catalog.tsv'), tierDefinitions, {
    tier1: mapping.finalRows,
    tier2: relaxedMapping.finalRows,
    tier3: tier3Mapping.finalRows
  });
  await writeTierSummarySvg(path.join(OUTPUT_DIR, 'tier_summary.svg'), {
    tier1: mapping.finalRows,
    tier2: relaxedMapping.finalRows,
    tier3: tier3Mapping.finalRows
  }, tierValidation);
  await writeOrthologFirstSvg(
    path.join(OUTPUT_DIR, 'ortholog_first_summary.svg'), relaxedPreparation, relaxedMapping, validation
  );

  const failures = [positive.status, ...negatives.map(control => control.status),
    ...tierValidation.map(row => row.status)]
    .filter(status => status !== 'PASS');
  console.log(`TLR4 positive control: ${positive.status}; Tier 1 rows: ${positive.automaticHpoMpRows}; Tier 2 rows: ${positive.tier2CandidateRows}`);
  console.log(`Tier expectations: ${tierValidation.filter(row => row.status === 'PASS').length}/${tierValidation.length} PASS`);
  console.log(`Negative controls: ${negatives.filter(control => control.status === 'PASS').length}/${negatives.length} PASS`);
  if (failures.length) throw new Error(`${failures.length} validation control(s) failed.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildTierValidation,
  inspectMappingResults,
  inspectTierResults,
  validateNegativeControls,
  validatePositiveControl
};
