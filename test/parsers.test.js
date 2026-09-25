'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAcceptedClinvarSignificance,
  normalizeDiseaseId,
  parseClinvarDiseaseIds,
  parseClinvarGenes,
  parseDelimited,
  parseVcfInfo
} = require('../src/lib/parsers');
const { mergeMappings, normalizeOntologyId, normalizePredicate } = require('../src/prepare');

test('quoted TSV parser preserves tabs and newlines inside quoted fields', () => {
  const rows = parseDelimited('a\tb\n1\t"two\nlines"\n', '\t');
  assert.deepEqual(rows, [['a', 'b'], ['1', 'two\nlines']]);
});

test('ClinVar helpers normalize disease and gene identifiers', () => {
  assert.equal(normalizeDiseaseId('MIM:123456'), 'OMIM:123456');
  assert.equal(normalizeDiseaseId('Orphanet:42'), 'ORPHA:42');
  assert.equal(normalizeDiseaseId('MONDO:MONDO:0011751'), 'MONDO:0011751');
  assert.deepEqual(
    parseClinvarDiseaseIds('MedGen:C1|OMIM:123456,Orphanet:42'),
    ['MEDGEN:C1', 'OMIM:123456', 'ORPHA:42']
  );
  assert.deepEqual(parseClinvarGenes('TLR4:7099|ABO:28'), [
    { symbol: 'TLR4', ncbiGeneId: '7099' },
    { symbol: 'ABO', ncbiGeneId: '28' }
  ]);
});

test('ClinVar significance filter accepts relevant assertions but not benign aggregates', () => {
  const accepted = ['Pathogenic', 'Likely_pathogenic', 'risk_factor'];
  assert.equal(isAcceptedClinvarSignificance('Pathogenic|risk_factor', accepted), true);
  assert.equal(isAcceptedClinvarSignificance('Benign', accepted), false);
});

test('VCF INFO parser retains flags and decodes percent encoding', () => {
  assert.deepEqual(parseVcfInfo('RS=4986790;CLNDN=Endotoxin%20hyporesponsiveness;FLAG'), {
    RS: '4986790',
    CLNDN: 'Endotoxin hyporesponsiveness',
    FLAG: true
  });
});

test('ontology and predicate normalization handles full IRIs', () => {
  assert.equal(normalizeOntologyId('http://purl.obolibrary.org/obo/HP_0012647'), 'HP:0012647');
  assert.equal(normalizePredicate('http://www.w3.org/2004/02/skos/core#exactMatch'), 'skos:exactMatch');
});

test('mapping merge deduplicates sources and retains strongest confidence', () => {
  const base = {
    hpo_id: 'HP:1', hpo_label: 'Human', mp_id: 'MP:1', mp_label: 'Mouse',
    predicate: 'skos:exactMatch', mapping_justification: 'manual', mapping_date: ''
  };
  const merged = mergeMappings([
    [{ ...base, confidence: '0.8', mapping_source: 'a' }],
    [{ ...base, confidence: '1', mapping_source: 'b' }]
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, '1');
  assert.equal(merged[0].mapping_source, 'a|b');
});
