'use strict';

const fsp = require('node:fs/promises');

/** Escape text before inserting it into SVG markup. */
function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[character]));
}

/** Format integer counts with locale-independent separators. */
function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

/** Generate an editable SVG summary of pipeline retention and controls. */
async function writeSummarySvg(filePath, preparation, mapping, validation = null) {
  const bars = [
    ['ClinVar records', preparation.humanVariants.totalVariants],
    ['ClinVar with rsID', preparation.humanVariants.variantsWithRsid],
    ['Accepted-significance variants', preparation.humanVariants.variantsWithAcceptedSignificance],
    ['Variant-disease-HPO rows', preparation.humanVariants.retainedRows],
    ['HPO-MP candidate joins', mapping.hpoMpCandidateRows],
    ['Final ortholog + phenotype rows', mapping.finalRows]
  ];
  const maxLog = Math.max(...bars.map(([, value]) => Math.log10(Number(value) + 1)), 1);
  const barElements = bars.map(([label, value], index) => {
    const y = 180 + index * 72;
    const width = Math.max(2, (Math.log10(Number(value) + 1) / maxLog) * 710);
    const color = index === bars.length - 1 ? '#12A594' : '#2C6E9B';
    return `
      <text x="48" y="${y - 9}" class="label">${escapeXml(label)}</text>
      <rect x="48" y="${y}" width="710" height="24" rx="5" fill="#E8EFF4"/>
      <rect x="48" y="${y}" width="${width.toFixed(1)}" height="24" rx="5" fill="${color}"/>
      <text x="772" y="${y + 18}" class="count">${formatCount(value)}</text>`;
  }).join('');
  const controlStatus = validation?.positiveControl?.status || 'run npm run validate';
  const controlColor = controlStatus === 'PASS' ? '#11845B' : '#A65E00';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720" viewBox="0 0 1100 720" role="img" aria-labelledby="title description">
  <title id="title">2026 cross-phenotype mapping summary</title>
  <desc id="description">Record counts across ClinVar, HPO, MP, MGI allele and ortholog mapping stages. Bar lengths use a logarithmic scale.</desc>
  <style>
    .title { font: 700 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #17324D; }
    .subtitle { font: 400 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #526779; }
    .label { font: 600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #243746; }
    .count { font: 700 16px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #17324D; }
    .small { font: 400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #526779; }
    .control { font: 700 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect width="1100" height="720" fill="#FFFFFF"/>
  <text x="48" y="58" class="title">Human-Mouse phenotype bridge - 2026 rebuild</text>
  <text x="48" y="88" class="subtitle">ClinVar → disease → HPO → MP → MGI allele, constrained by 1:1 orthology</text>
  <text x="48" y="124" class="small">Bar length: log10(count + 1); values at right are exact row counts.</text>
  ${barElements}
  <rect x="48" y="626" width="1004" height="58" rx="10" fill="#F1F8F5" stroke="#C3E2D5"/>
  <text x="70" y="661" class="control" fill="${controlColor}">TLR4 rs4986790 ↔ Tlr4&lt;Lps-d&gt; / C3H/HeJ: ${escapeXml(controlStatus)}</text>
  <text x="660" y="661" class="small">Identity/orthology audit; no manual human phenotype input</text>
</svg>\n`;
  await fsp.writeFile(filePath, svg, 'utf8');
}

/** Generate an editable SVG for the ortholog-first evidence expansion. */
async function writeOrthologFirstSvg(filePath, preparation, mapping, validation = null) {
  const values = [
    ['Current 1:1 ortholog pairs', preparation.orthologPairs, '#315C83'],
    ['Human ClinVar phenotype rows', preparation.clinvar.rows, '#477FA8'],
    ['Human significant GWAS rows', preparation.gwas.rows, '#477FA8'],
    ['Mouse MP evidence rows', preparation.mouse.mpRows, '#A26A24'],
    ['Mouse allele-name evidence rows', preparation.mouse.alleleNameRows, '#A26A24'],
    ['Candidate variant-allele rows', mapping.finalRows, '#168273']
  ];
  const maxLog = Math.max(...values.map(([, value]) => Math.log10(Number(value) + 1)), 1);
  const bars = values.map(([label, value, color], index) => {
    const y = 176 + index * 64;
    const width = Math.max(2, (Math.log10(Number(value) + 1) / maxLog) * 650);
    return `<text x="48" y="${y - 8}" class="label">${escapeXml(label)}</text>
      <rect x="48" y="${y}" width="650" height="21" rx="5" fill="#E8EFF4"/>
      <rect x="48" y="${y}" width="${width.toFixed(1)}" height="21" rx="5" fill="${color}"/>
      <text x="716" y="${y + 16}" class="count">${formatCount(value)}</text>`;
  }).join('\n');
  const status = 'MANUAL LITERATURE INPUT DISABLED';
  const statusColor = '#526779';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720" viewBox="0 0 1100 720" role="img" aria-labelledby="title description">
  <title id="title">Ortholog-first human-mouse candidate correspondence</title>
  <desc id="description">Current orthologs constrain separately collected human variant and mouse allele phenotype evidence. Counts use logarithmic bars.</desc>
  <style>
    .title { font: 700 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #17324D; }
    .subtitle { font: 400 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #526779; }
    .label { font: 600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #243746; }
    .count { font: 700 16px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #17324D; }
    .small { font: 400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #526779; }
    .control { font: 700 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect width="1100" height="720" fill="#FFFFFF"/>
  <text x="48" y="56" class="title">Ortholog-first phenotype evidence expansion</text>
  <text x="48" y="86" class="subtitle">1:1 gene pair → human variants / mouse alleles → phenotype evidence → tiered candidate correspondence</text>
  <text x="48" y="120" class="small">Strict HPO–MP output remains separate. Support A is retired; B = exact label; C = lexical hypothesis.</text>
  ${bars}
  <rect x="48" y="586" width="1004" height="86" rx="10" fill="#F1F8F5" stroke="#C3E2D5"/>
  <text x="70" y="621" class="control" fill="${statusColor}">TLR4 rs4986790 ↔ Tlr4&lt;Lps-d&gt;: ${escapeXml(status)}</text>
  <text x="70" y="649" class="small">TLR4 is assessed in the separate semantic class C output; no hand-curated human phenotype is injected here.</text>
  <text x="1025" y="621" text-anchor="end" class="count">support A ${formatCount(mapping.supportGrades.A)} / B ${formatCount(mapping.supportGrades.B)} / C ${formatCount(mapping.supportGrades.C)}</text>
</svg>\n`;
  await fsp.writeFile(filePath, svg, 'utf8');
}

/** Generate an editable comparison figure for tier counts and control recovery. */
async function writeTierSummarySvg(filePath, tierCounts, validationRows) {
  const tiers = [
    ['tier1', 'Monarch phenotype bridge', tierCounts.tier1, '#315C83'],
    ['tier2', 'Ortholog-first phenotype evidence', tierCounts.tier2, '#168273'],
    ['tier3', 'Curated disease model', tierCounts.tier3, '#A26A24']
  ];
  const maxLog = Math.max(...tiers.map(([, , count]) => Math.log10(Number(count) + 1)), 1);
  const bars = tiers.map(([tierId, label, count, color], index) => {
    const y = 155 + index * 78;
    const width = Math.max(2, (Math.log10(Number(count) + 1) / maxLog) * 700);
    return `<text x="54" y="${y - 10}" class="label">${escapeXml(`${tierId}: ${label}`)}</text>
      <rect x="54" y="${y}" width="700" height="25" rx="5" fill="#E8EFF4"/>
      <rect x="54" y="${y}" width="${width.toFixed(1)}" height="25" rx="5" fill="${color}"/>
      <text x="774" y="${y + 19}" class="count">${formatCount(count)}</text>`;
  }).join('\n');
  const controls = [...new Set(validationRows.map(row => row.control_id))];
  const matrixHeader = tiers.map(([tierId], index) => (
    `<text x="${620 + index * 150}" y="442" class="matrixHead">${tierId}</text>`
  )).join('\n');
  const matrixRows = controls.map((controlId, rowIndex) => {
    const y = 480 + rowIndex * 52;
    const cells = tiers.map(([tierId], columnIndex) => {
      const row = validationRows.find(item => item.control_id === controlId && item.tier_id === tierId);
      const expected = row?.expected === 'found';
      const found = Number(row?.found_rows || 0);
      const fill = expected && found ? '#D8F0E6' : expected ? '#F9D8D8' : found ? '#FFF0C7' : '#EFF3F6';
      const textFill = expected && found ? '#116B4D' : expected ? '#A12A2A' : '#526779';
      const label = found ? `${found} row${found === 1 ? '' : 's'}` : '-';
      const x = 570 + columnIndex * 150;
      return `<rect x="${x}" y="${y - 28}" width="118" height="36" rx="7" fill="${fill}"/>
        <text x="${x + 59}" y="${y - 5}" text-anchor="middle" class="cell" fill="${textFill}">${label}</text>`;
    }).join('\n');
    return `<text x="54" y="${y - 5}" class="label">${escapeXml(controlId)}</text>${cells}`;
  }).join('\n');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="680" viewBox="0 0 1100 680" role="img" aria-labelledby="title description">
  <title id="title">Tiered human-mouse variant correspondence</title>
  <desc id="description">Independent evidence tier row counts and positive-control recovery matrix.</desc>
  <style>
    .title { font: 700 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #17324D; }
    .subtitle { font: 400 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #526779; }
    .label { font: 600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #243746; }
    .count { font: 700 17px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #17324D; }
    .matrixHead { font: 700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #17324D; text-anchor: middle; }
    .cell { font: 700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .small { font: 400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #526779; }
  </style>
  <rect width="1100" height="680" fill="#FFFFFF"/>
  <text x="54" y="56" class="title">Tiered human-mouse variant correspondence</text>
  <text x="54" y="87" class="subtitle">Independent connection bases, separate DB tables; bars use log10(row count + 1)</text>
  ${bars}
  <line x1="54" y1="408" x2="1046" y2="408" stroke="#D7E0E7"/>
  <text x="54" y="442" class="label">Positive-control recovery</text>
  ${matrixHeader}
  ${matrixRows}
  <text x="54" y="650" class="small">Green = expected and recovered; gray = not required for that evidence basis. Non-required recoveries are retained for review.</text>
</svg>\n`;
  await fsp.writeFile(filePath, svg, 'utf8');
}

module.exports = { writeOrthologFirstSvg, writeSummarySvg, writeTierSummarySvg };
