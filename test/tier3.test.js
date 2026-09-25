'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identifiers } = require('../src/tier3-disease-map');

test('disease identifiers are deduplicated and can be restricted to OMIM', () => {
  assert.deepEqual(
    identifiers('DOID:1485|OMIM:219700|OMIM:219700', 'OMIM:'),
    ['OMIM:219700']
  );
});
