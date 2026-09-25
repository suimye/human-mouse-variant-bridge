'use strict';

const WORD_ALIASES = new Map([
  ['lps', 'lipopolysaccharide'],
  ['endotoxin', 'lipopolysaccharide'],
  ['hyporesponsiveness', 'hyporesponsive'],
  ['responsiveness', 'response'],
  ['responsive', 'response']
]);

/** Normalize phenotype text without inventing an ontology assertion. */
function normalizePhenotypeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => WORD_ALIASES.get(token) || token)
    .join(' ');
}

/** Return normalized tokens after excluding generic phenotype words. */
function informativeTokens(value, uninformative = []) {
  const excluded = new Set(uninformative.map(normalizePhenotypeText));
  return [...new Set(normalizePhenotypeText(value).split(' ')
    .filter(token => token && !excluded.has(token)))];
}

/** Calculate Jaccard overlap for two unique token lists. */
function tokenJaccard(leftTokens, rightTokens) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  const intersection = [...left].filter(token => right.has(token));
  const union = new Set([...left, ...right]);
  return {
    intersection,
    sharedCount: intersection.length,
    jaccard: union.size ? intersection.length / union.size : 0
  };
}

/** Compare two phenotype descriptors and assign an evidence tier. */
function comparePhenotypes(human, mouse, config) {
  const humanNormalized = normalizePhenotypeText(human.phenotype_label);
  const mouseNormalized = normalizePhenotypeText(mouse.phenotype_label);
  if (humanNormalized && humanNormalized === mouseNormalized) {
    return {
      matched: true,
      evidenceTier: 'B',
      method: 'exact_normalized_label',
      matchedConcept: '',
      sharedTokens: humanNormalized,
      tokenJaccard: 1
    };
  }

  const humanTokens = informativeTokens(human.phenotype_label, config.uninformative_tokens);
  const mouseTokens = informativeTokens(mouse.phenotype_label, config.uninformative_tokens);
  const overlap = tokenJaccard(humanTokens, mouseTokens);
  const matched = overlap.sharedCount >= config.minimum_informative_token_overlap
    && overlap.jaccard >= config.minimum_token_jaccard;
  return {
    matched,
    evidenceTier: matched ? 'C' : '',
    method: matched ? 'controlled_lexical_overlap' : '',
    matchedConcept: '',
    sharedTokens: overlap.intersection.join('|'),
    tokenJaccard: overlap.jaccard
  };
}

module.exports = {
  comparePhenotypes,
  informativeTokens,
  normalizePhenotypeText,
  tokenJaccard
};
