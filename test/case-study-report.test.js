'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCaseStudyRows,
  caseStudyHtmlDocument,
  matchesControl,
  primaryRoutes,
  tierHtmlDocument
} = require('../src/case-study-report');

const controls = [
  {
    control_id: 'TLR4_LPS_001', human_gene: 'TLR4', human_variant: 'rs4986790',
    human_protein_change: 'p.Asp299Gly', mouse_gene: 'Tlr4',
    mouse_allele_id: 'MGI:1857718', mouse_allele: 'Tlr4<Lps-d>',
    mouse_protein_change: 'p.Pro712His', expected_tiers: '', expected_semantic_class: 'C'
  },
  {
    control_id: 'CFTR_F508DEL_001', human_gene: 'CFTR', human_variant: 'rs113993960',
    human_protein_change: 'p.Phe508del', mouse_gene: 'Cftr',
    mouse_allele_id: 'MGI:1856709', mouse_allele: 'Cftr<tm1Unc>',
    mouse_protein_change: 'null allele', expected_tiers: 'tier1|tier3',
    expected_semantic_class: ''
  },
  {
    control_id: 'ALPL_HPP_001', human_gene: 'ALPL', human_variant: 'rs1558543066',
    human_protein_change: 'frameshift deletion', mouse_gene: 'Alpl',
    mouse_allele_id: 'MGI:3051587', mouse_allele: 'Alpl<Hpp>',
    mouse_protein_change: 'hypomorphic allele', expected_tiers: 'tier2|tier3',
    expected_semantic_class: ''
  }
];

test('control matching requires both variant and mouse allele identity', () => {
  assert.equal(matchesControl({
    human_gene: 'TLR4', rs_id: 'rs4986790', mouse_gene: 'Tlr4',
    mgi_allele_id: 'MGI:1857718|MGI:other'
  }, controls[0]), true);
  assert.equal(matchesControl({
    human_gene: 'TLR4', rs_id: 'rs4986790', mouse_gene: 'Tlr4',
    mgi_allele_id: 'MGI:wrong'
  }, controls[0]), false);
});

test('declared routes combine tier and semantic expectations', () => {
  assert.deepEqual(primaryRoutes(controls[0]), ['semantic_C']);
  assert.deepEqual(primaryRoutes(controls[1]), ['tier1', 'tier3']);
});

test('three case studies require recovery by their declared primary routes', () => {
  const tierValidation = [
    ['TLR4_LPS_001', 'tier1', 0], ['TLR4_LPS_001', 'tier2', 0], ['TLR4_LPS_001', 'tier3', 0],
    ['CFTR_F508DEL_001', 'tier1', 6], ['CFTR_F508DEL_001', 'tier2', 0], ['CFTR_F508DEL_001', 'tier3', 2],
    ['ALPL_HPP_001', 'tier1', 0], ['ALPL_HPP_001', 'tier2', 20], ['ALPL_HPP_001', 'tier3', 2]
  ].map(([control_id, tier_id, found_rows]) => ({ control_id, tier_id, found_rows }));
  const semantic = [
    { control_id: 'TLR4_LPS_001', class_A_rows: 0, class_B_rows: 0, class_C_rows: 1, class_D_archive_rows: 78, best_active_cosine: '.548' },
    { control_id: 'CFTR_F508DEL_001', class_A_rows: 1, class_B_rows: 1, class_C_rows: 61, class_D_archive_rows: 434, best_active_cosine: '.833' },
    { control_id: 'ALPL_HPP_001', class_A_rows: 22, class_B_rows: 2, class_C_rows: 24, class_D_archive_rows: 0, best_active_cosine: '1' }
  ];
  const representatives = {
    tier1: new Map([['CFTR_F508DEL_001', { hpo_label: 'Failure to thrive', mp_label: 'postnatal growth retardation' }]]),
    tier2: new Map([['ALPL_HPP_001', { human_phenotype_label: 'Hypophosphatasia', mouse_phenotype_label: 'hypophosphatasia' }]]),
    tier3: new Map(),
    semantic_A: new Map(),
    semantic_B: new Map(),
    semantic_C: new Map([['TLR4_LPS_001', { human_phenotype_label: 'inflammatory diseases', mouse_phenotype_label: 'induced arthritis', cosine_similarity: '.548' }]])
  };
  const rows = buildCaseStudyRows(controls, tierValidation, semantic, representatives);
  assert.deepEqual(rows.map(row => row.case_study_status), ['FOUND', 'FOUND', 'FOUND']);
  assert.equal(rows[0].representative_route, 'semantic_C');
  assert.equal(rows[1].tier1_evidence_rows, 6);
  assert.equal(rows[2].tier2_evidence_rows, 20);
});

test('tier explanation and case studies are generated as separate documents', () => {
  const tierHtml = tierHtmlDocument([
    { tier_id: 'tier1', row_count: '10' },
    { tier_id: 'tier2', row_count: '20' },
    { tier_id: 'tier3', row_count: '30' }
  ]);
  assert.match(tierHtml, /human-mouse variant correspondenceを作る3つのTier/);
  assert.match(tierHtml, /Tier 1: HPO ↔ MP/);
  assert.doesNotMatch(tierHtml, /TLR4 rs4986790/);

  const caseRows = controls.map((control, index) => ({
    ...control,
    case_study_status: 'FOUND',
    primary_connection_routes: index === 0 ? 'semantic_C' : index === 1 ? 'tier1|tier3' : 'tier2|tier3',
    tier1_evidence_rows: index === 1 ? 6 : 0,
    tier2_evidence_rows: index === 2 ? 20 : 0,
    tier3_evidence_rows: index ? 2 : 0,
    semantic_class_A_evidence_rows: index === 1 ? 1 : index === 2 ? 22 : 0,
    semantic_class_B_evidence_rows: index === 1 ? 1 : index === 2 ? 2 : 0,
    semantic_class_C_evidence_rows: index === 0 ? 1 : index === 1 ? 61 : 24,
    representative_route: index === 0 ? 'semantic_C' : index === 1 ? 'tier1' : 'tier2',
    representative_human_phenotype: 'human phenotype',
    representative_mouse_phenotype: 'mouse phenotype',
    interpretation: 'interpretation', limitation: 'limitation'
  }));
  const caseHtml = caseStudyHtmlDocument(caseRows);
  assert.match(caseHtml, /TLR4 rs4986790/);
  assert.match(caseHtml, /3\/3/);
});
