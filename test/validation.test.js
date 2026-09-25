'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTierValidation, validateNegativeControls, validatePositiveControl } = require('../src/validate');

const positive = {
  human_gene: 'TLR4', human_variant: 'rs4986790', human_protein_change: 'p.Asp299Gly',
  human_effect: 'reduced LPS responsiveness', mouse_gene: 'Tlr4',
  mouse_allele_id: 'MGI:1857718', mouse_allele: 'Tlr4<Lps-d>',
  mouse_protein_change: 'p.Pro712His', mouse_background: 'C3H/HeJ',
  mouse_effect: 'defective lipopolysaccharide response', bridge_type: 'ortholog_identity_semantic_candidate'
};

test('TLR4 control checks identities and orthology without a manual human phenotype', () => {
  const result = validatePositiveControl(
    positive,
    [{ human_gene: 'TLR4', rs_id: 'rs4986790' }],
    [{ mouse_gene: 'Tlr4', mgi_allele_id: 'MGI:1857718', mouse_allele: 'Tlr4<Lps-d>', genetic_background: 'C3H/HeJ-Tlr4<Lps-d>' }],
    [{ human_gene: 'TLR4', mouse_gene: 'Tlr4' }],
    { automaticTlr4Rows: 0 }
  );
  assert.equal(result.status, 'PASS');
  assert.equal(result.distinctSubstitutions, true);
  assert.equal(result.manualHumanPhenotypeUsed, false);
});

test('negative controls reject wrong ortholog and same-residue overclaim', () => {
  const results = validateNegativeControls([
    { control_id: 'a', expected_rejection_reason: 'non_orthologous_gene' },
    { control_id: 'b', expected_rejection_reason: 'different_residue_and_substitution' }
  ], positive, { invalidOrthologRows: 0 });
  assert.deepEqual(results.map(result => result.status), ['PASS', 'PASS']);
});

test('tier validation requires only independently declared expected recoveries', () => {
  const controls = [{ control_id: 'x', expected_tiers: 'tier2|tier3' }];
  const inspections = [
    { tierId: 'tier1', counts: new Map([['x', 0]]), support: new Map([['x', new Set()]]) },
    { tierId: 'tier2', counts: new Map([['x', 2]]), support: new Map([['x', new Set(['A'])]]) },
    { tierId: 'tier3', counts: new Map([['x', 0]]), support: new Map([['x', new Set()]]) }
  ];
  const rows = buildTierValidation(controls, inspections);
  assert.deepEqual(rows.map(row => row.status), ['PASS', 'PASS', 'FAIL']);
  assert.equal(rows[1].within_tier_support, 'A');
});
