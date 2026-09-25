'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { comparePhenotypes, normalizePhenotypeText, tokenJaccard } = require('../src/lib/phenotype');

const config = {
  minimum_informative_token_overlap: 2,
  minimum_token_jaccard: 0.6,
  uninformative_tokens: ['abnormal', 'response']
};

test('TLR4 descriptions are not elevated by a manual functional concept', () => {
  const match = comparePhenotypes(
    { phenotype_label: 'decreased response to LPS' },
    { phenotype_label: 'toll-like receptor 4; defective lipopolysaccharide response' },
    config
  );
  assert.equal(match.matched, false);
  assert.equal(match.evidenceTier, '');
});

test('normalization expands LPS but does not imply ontology equivalence', () => {
  assert.equal(normalizePhenotypeText('Reduced LPS responsiveness'), 'reduced lipopolysaccharide response');
  assert.deepEqual(tokenJaccard(['hearing', 'loss'], ['hearing', 'impairment']), {
    intersection: ['hearing'], sharedCount: 1, jaccard: 1 / 3
  });
});

test('generic one-token overlaps are rejected', () => {
  const match = comparePhenotypes(
    { phenotype_label: 'abnormal immune response' },
    { phenotype_label: 'abnormal tactile response' },
    config
  );
  assert.equal(match.matched, false);
});
