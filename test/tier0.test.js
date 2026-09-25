'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTier0Row } = require('../src/validate-tier0');

function baseRow() {
  return {
    tier_id: 'tier0', connection_basis: 'exact_variant_correspondence',
    match_level: 'protein_exact', exact_match_definition: 'same aligned reference residue and alternate amino acid',
    human_gene: 'GENEA', human_ncbi_gene_id: '1', human_variant_id: 'h1', human_assembly: 'GRCh38',
    human_transcript: 'NM_000001.1', human_hgvs_p: 'p.Gly10Asp',
    mouse_gene: 'Genea', mouse_ncbi_gene_id: '2', mouse_variant_id: 'm1', mouse_assembly: 'GRCm39',
    mouse_transcript: 'NM_000002.1', mouse_hgvs_p: 'p.Gly10Asp',
    ortholog_source: 'test', cross_species_alignment_source: 'test alignment', alignment_version: 'v1',
    allele_orientation: 'forward', reciprocal_mapping: '0', qc_status: 'passed',
    source_dataset: 'collaborator', source_version: 'v1', source_record_id: 'r1',
    source_sha256: 'a'.repeat(64)
  };
}

test('Tier 0 protein exact row requires complete provenance and aligned protein HGVS', () => {
  const row = baseRow();
  const orthologs = new Set(['id:1\t2']);
  assert.deepEqual(validateTier0Row(row, orthologs), []);
  delete row.mouse_hgvs_p;
  assert.ok(validateTier0Row(row, orthologs).includes('protein_exact requires mouse_hgvs_p'));
});

test('Tier 0 genomic exact row requires reciprocal mapping and both normalized alleles', () => {
  const row = baseRow();
  row.match_level = 'genomic_reciprocal_exact';
  row.reciprocal_mapping = '0';
  const errors = validateTier0Row(row, new Set(['symbol:GENEA\tGenea']));
  assert.ok(errors.includes('genomic_reciprocal_exact requires reciprocal_mapping=1'));
  assert.ok(errors.includes('genomic_reciprocal_exact requires human_reference_allele'));
  assert.ok(errors.includes('genomic_reciprocal_exact requires mouse_alternate_allele'));
});

test('Tier 0 rejects non-orthologous gene pairs', () => {
  const errors = validateTier0Row(baseRow(), new Set(['id:1\t999']));
  assert.ok(errors.includes('human and mouse genes are not an accepted 1:1 ortholog pair'));
});
