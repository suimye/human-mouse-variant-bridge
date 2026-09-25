'use strict';

/** Parse RFC4180-style delimited text, including quoted multiline fields. */
function parseDelimited(text, delimiter = '\t') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field);
    if (row.some(value => value !== '')) rows.push(row);
  }
  return rows;
}

/** Decode a percent-encoded VCF value without failing on malformed input. */
function decodeVcfValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse a semicolon-separated VCF INFO field. */
function parseVcfInfo(infoText) {
  const info = {};
  for (const entry of infoText.split(';')) {
    const separator = entry.indexOf('=');
    if (separator === -1) {
      info[entry] = true;
    } else {
      info[entry.slice(0, separator)] = decodeVcfValue(entry.slice(separator + 1));
    }
  }
  return info;
}

/** Normalize disease identifiers used differently by ClinVar and HPO. */
function normalizeDiseaseId(value) {
  const cleaned = value.trim().replace(/^\"|\"$/g, '');
  if (/^MONDO:MONDO:/i.test(cleaned)) return cleaned.replace(/^MONDO:MONDO:/i, 'MONDO:');
  if (/^OMIM:OMIM:/i.test(cleaned)) return cleaned.replace(/^OMIM:OMIM:/i, 'OMIM:');
  if (/^MIM:/i.test(cleaned)) return cleaned.replace(/^MIM:/i, 'OMIM:');
  if (/^OMIM:/i.test(cleaned)) return cleaned.replace(/^OMIM:/i, 'OMIM:');
  if (/^Orphanet:/i.test(cleaned)) return cleaned.replace(/^Orphanet:/i, 'ORPHA:');
  if (/^ORPHA:/i.test(cleaned)) return cleaned.replace(/^ORPHA:/i, 'ORPHA:');
  if (/^MONDO:/i.test(cleaned)) return cleaned.replace(/^MONDO:/i, 'MONDO:');
  if (/^MedGen:/i.test(cleaned)) return cleaned.replace(/^MedGen:/i, 'MEDGEN:');
  return cleaned;
}

/** Determine whether a ClinVar aggregate classification is in the configured analysis scope. */
function isAcceptedClinvarSignificance(value, acceptedValues) {
  const accepted = new Set(acceptedValues || []);
  return String(value || '').split(/[|,]/).some(classification => accepted.has(classification));
}

/** Extract normalized condition identifiers from ClinVar CLNDISDB. */
function parseClinvarDiseaseIds(value) {
  if (!value || value === '.') return [];
  const ids = [];
  const seen = new Set();
  for (const token of value.split(/[|,]/)) {
    const normalized = normalizeDiseaseId(token);
    if (!/^(OMIM|ORPHA|MONDO|MEDGEN):[^\s]+$/.test(normalized)) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      ids.push(normalized);
    }
  }
  return ids;
}

/** Parse ClinVar GENEINFO into gene-symbol and NCBI-gene pairs. */
function parseClinvarGenes(value) {
  if (!value || value === '.') return [];
  return value.split('|').map(token => {
    const separator = token.lastIndexOf(':');
    return {
      symbol: separator === -1 ? token : token.slice(0, separator),
      ncbiGeneId: separator === -1 ? '' : token.slice(separator + 1)
    };
  }).filter(gene => gene.symbol && gene.symbol !== '.');
}

/** Convert ClinVar underscore-separated display values to readable text. */
function displayClinvarValue(value) {
  return decodeVcfValue(value || '').replace(/_/g, ' ').replace(/\|/g, '; ');
}

module.exports = {
  decodeVcfValue,
  displayClinvarValue,
  isAcceptedClinvarSignificance,
  normalizeDiseaseId,
  parseClinvarDiseaseIds,
  parseClinvarGenes,
  parseDelimited,
  parseVcfInfo
};
