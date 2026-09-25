#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readLines, readTsvObjects, writeTsvRow } = require('./lib/io');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const SEMANTIC_DIR = path.join(OUTPUT_DIR, 'semantic');

const ROUTE_LABELS = {
  tier1: 'HPO-MP ontology bridge',
  tier2: 'exact phenotype label',
  tier3: 'shared OMIM disease model',
  semantic_A: 'semantic phenotype class A',
  semantic_B: 'semantic phenotype class B',
  semantic_C: 'semantic phenotype class C'
};

const CASE_NARRATIVES = {
  TLR4_LPS_001: {
    representativeRoute: 'semantic_C',
    interpretation: 'The ortholog-constrained semantic search retrieves the specified human variant and mouse allele as a review candidate after all three structured routes miss the pair.',
    limitation: 'The class C evidence links inflammatory disease and induced-arthritis phenotypes. It does not demonstrate equivalent LPS-response mechanisms or variant equivalence.'
  },
  CFTR_F508DEL_001: {
    representativeRoute: 'tier1',
    interpretation: 'The target pair is supported independently by an HPO-MP phenotype bridge and the same OMIM disease model, providing structured and traceable evidence.',
    limitation: 'The highest semantic match concerns different sperm phenotypes and is not used as the main cystic-fibrosis evidence. Row counts are evidence records, not independent experiments.'
  },
  ALPL_HPP_001: {
    representativeRoute: 'tier2',
    interpretation: 'The target pair is recovered by the exact normalized phenotype label hypophosphatasia and independently by the same OMIM disease model.',
    limitation: 'A shared phenotype or disease model does not imply the same nucleotide change, protein residue, allelic direction, or experimental context.'
  }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function splitPipe(value) {
  return String(value || '').split('|').filter(Boolean);
}

function matchesControl(row, control) {
  return row.human_gene === control.human_gene
    && row.rs_id === control.human_variant
    && row.mouse_gene === control.mouse_gene
    && splitPipe(row.mgi_allele_id).includes(control.mouse_allele_id);
}

async function firstMatchingRows(filePath, controls) {
  const remaining = new Map(controls.map(control => [control.control_id, control]));
  const matches = new Map();
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
    for (const [controlId, control] of remaining) {
      if (!matchesControl(row, control)) continue;
      matches.set(controlId, row);
      remaining.delete(controlId);
      break;
    }
    if (!remaining.size) break;
  }
  return matches;
}

function primaryRoutes(control) {
  const routes = splitPipe(control.expected_tiers);
  if (control.expected_semantic_class) routes.push(`semantic_${control.expected_semantic_class}`);
  return routes;
}

function representativeEvidence(controlId, routeId, representatives) {
  const row = representatives[routeId]?.get(controlId) || {};
  if (routeId === 'tier1') {
    return {
      human: row.hpo_label || '',
      mouse: row.mp_label || '',
      detail: [row.hpo_id, row.predicate, row.mp_id].filter(Boolean).join(' / ')
    };
  }
  if (routeId === 'tier2') {
    return {
      human: row.human_phenotype_label || '',
      mouse: row.mouse_phenotype_label || row.allele_name || '',
      detail: [row.match_method, row.within_tier_support].filter(Boolean).join(' / ')
    };
  }
  if (routeId === 'tier3') {
    return {
      human: row.human_condition_label || '',
      mouse: row.mouse_allele_name || '',
      detail: row.shared_disease_id || ''
    };
  }
  return {
    human: row.human_phenotype_label || '',
    mouse: row.mouse_phenotype_label || '',
    detail: row.cosine_similarity ? `cosine ${Number(row.cosine_similarity).toFixed(3)}` : ''
  };
}

function buildCaseStudyRows(controls, tierValidation, semanticSummaries, representatives) {
  const tierByControl = new Map();
  for (const row of tierValidation) {
    if (!tierByControl.has(row.control_id)) tierByControl.set(row.control_id, new Map());
    tierByControl.get(row.control_id).set(row.tier_id, row);
  }
  const semanticByControl = new Map(semanticSummaries.map(row => [row.control_id, row]));

  return controls.map(control => {
    const routes = primaryRoutes(control);
    const narrative = CASE_NARRATIVES[control.control_id];
    if (!narrative) throw new Error(`Missing case-study narrative for ${control.control_id}`);
    const semantic = semanticByControl.get(control.control_id) || {};
    const tierRows = tierByControl.get(control.control_id) || new Map();
    const evidence = representativeEvidence(
      control.control_id, narrative.representativeRoute, representatives
    );
    const found = routes.every(route => {
      if (route.startsWith('tier')) return Number(tierRows.get(route)?.found_rows || 0) > 0;
      const cosineClass = route.replace('semantic_', '');
      return Number(semantic[`class_${cosineClass}_rows`] || 0) > 0;
    });
    return {
      control_id: control.control_id,
      human_gene: control.human_gene,
      human_variant: control.human_variant,
      human_protein_change: control.human_protein_change,
      mouse_gene: control.mouse_gene,
      mouse_allele_id: control.mouse_allele_id,
      mouse_allele: control.mouse_allele,
      mouse_protein_change: control.mouse_protein_change,
      case_study_status: found ? 'FOUND' : 'NOT_FOUND',
      primary_connection_routes: routes.join('|'),
      tier1_evidence_rows: Number(tierRows.get('tier1')?.found_rows || 0),
      tier2_evidence_rows: Number(tierRows.get('tier2')?.found_rows || 0),
      tier3_evidence_rows: Number(tierRows.get('tier3')?.found_rows || 0),
      semantic_class_A_evidence_rows: Number(semantic.class_A_rows || 0),
      semantic_class_B_evidence_rows: Number(semantic.class_B_rows || 0),
      semantic_class_C_evidence_rows: Number(semantic.class_C_rows || 0),
      semantic_class_D_archive_rows: Number(semantic.class_D_archive_rows || 0),
      best_active_cosine: semantic.best_active_cosine || '',
      representative_route: narrative.representativeRoute,
      representative_human_phenotype: evidence.human,
      representative_mouse_phenotype: evidence.mouse,
      representative_evidence_detail: evidence.detail,
      interpretation: narrative.interpretation,
      limitation: narrative.limitation
    };
  });
}

async function writeCaseStudyTsv(filePath, rows) {
  const columns = [
    'control_id', 'human_gene', 'human_variant', 'human_protein_change',
    'mouse_gene', 'mouse_allele_id', 'mouse_allele', 'mouse_protein_change',
    'case_study_status', 'primary_connection_routes', 'tier1_evidence_rows',
    'tier2_evidence_rows', 'tier3_evidence_rows', 'semantic_class_A_evidence_rows',
    'semantic_class_B_evidence_rows', 'semantic_class_C_evidence_rows',
    'semantic_class_D_archive_rows', 'best_active_cosine', 'representative_route',
    'representative_human_phenotype', 'representative_mouse_phenotype',
    'representative_evidence_detail', 'interpretation', 'limitation'
  ];
  const output = fs.createWriteStream(filePath);
  writeTsvRow(output, columns);
  for (const row of rows) writeTsvRow(output, columns.map(column => row[column]));
  await new Promise((resolve, reject) => {
    output.on('error', reject);
    output.end(resolve);
  });
}

function countCell(value, extra = '') {
  if (!Number(value)) return '<span class="route-empty">-</span>';
  return `<strong>${Number(value).toLocaleString('en-US')}</strong>${extra}`;
}

function routeBadges(row) {
  return row.primary_connection_routes.split('|').map(route => (
    `<span class="route-badge route-${escapeHtml(route)}">${escapeHtml(ROUTE_LABELS[route])}</span>`
  )).join('');
}

function caseCard(row) {
  const evidence = `${escapeHtml(row.representative_human_phenotype)} <span aria-hidden="true">↔</span> ${escapeHtml(row.representative_mouse_phenotype)}`;
  return `<article class="case-card case-${escapeHtml(row.human_gene.toLowerCase())}">
    <header>
      <div><span class="case-gene">${escapeHtml(row.human_gene)}</span><span class="case-status">target pair found</span></div>
      <p>${escapeHtml(row.human_variant)} ${escapeHtml(row.human_protein_change)} <span aria-hidden="true">↔</span> ${escapeHtml(row.mouse_allele)} ${escapeHtml(row.mouse_protein_change)}</p>
    </header>
    <div class="pair-track" role="img" aria-label="${escapeHtml(row.human_gene)} human variant to mouse allele correspondence">
      <div class="species-node"><span>Human</span><strong>${escapeHtml(row.human_variant)}</strong></div>
      <div class="route-line"><span>${escapeHtml(ROUTE_LABELS[row.representative_route])}</span></div>
      <div class="species-node"><span>Mouse</span><strong>${escapeHtml(row.mouse_allele)}</strong></div>
    </div>
    <div class="route-badges">${routeBadges(row)}</div>
    <p class="evidence"><span>Representative evidence</span>${evidence}</p>
    <p>${escapeHtml(row.interpretation)}</p>
    <p class="limit"><strong>Limit:</strong> ${escapeHtml(row.limitation)}</p>
  </article>`;
}

function caseStudyHtmlDocument(rows) {
  const rowByGene = new Map(rows.map(row => [row.human_gene, row]));
  const tlr4 = rowByGene.get('TLR4');
  const cftr = rowByGene.get('CFTR');
  const alpl = rowByGene.get('ALPL');
  const found = rows.filter(row => row.case_study_status === 'FOUND').length;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Human-mouse variant pair discovery by complementary evidence routes</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f8fb;--panel:#fff;--ink:#152235;--muted:#59687a;--line:#c8d1dc;--blue:#2563a6;--green:#188260;--orange:#b86d19;--purple:#7b4bb7;--soft-blue:#eaf2fb;--soft-green:#e7f5ef;--soft-orange:#fff2df;--soft-purple:#f3ecfb;--shadow:0 12px 34px rgba(20,34,53,.08)}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.65} main{max-width:1180px;margin:0 auto;padding:48px 24px 72px} h1,h2,h3,p{margin-top:0} h1{font-size:clamp(30px,5vw,50px);line-height:1.18;letter-spacing:-.02em;margin-bottom:16px} h2{font-size:clamp(24px,3vw,32px);margin:56px 0 20px} .lead{font-size:18px;max-width:900px;color:var(--muted)} .headline{display:inline-block;padding:5px 11px;border-radius:999px;background:var(--soft-green);color:var(--green);font-weight:700;margin-bottom:18px}.summary{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:28px;align-items:start}.summary-count{background:var(--panel);border-radius:18px;padding:20px;box-shadow:var(--shadow);text-align:center}.summary-count strong{display:block;font-size:42px;line-height:1.15}.summary-count span{color:var(--muted)}
  .schema{background:var(--panel);border-radius:22px;padding:20px;box-shadow:var(--shadow);overflow:hidden}.schema svg{display:block;width:100%;height:auto;min-height:320px}.genome{stroke:var(--line);stroke-width:4;stroke-linecap:round}.gene{stroke:var(--ink);stroke-width:20;stroke-linecap:round}.variant{fill:var(--panel);stroke:var(--blue);stroke-width:7}.allele{fill:var(--panel);stroke:var(--orange);stroke-width:7}.route{fill:none;stroke-width:4;stroke-linecap:round}.route1{stroke:var(--blue)}.route2{stroke:var(--green)}.route3{stroke:var(--orange)}.route4{stroke:var(--purple)}.svg-title{font-size:18px;font-weight:700;fill:var(--ink)}.svg-label{font-size:15px;font-weight:600;fill:var(--ink)}.svg-muted{font-size:13px;fill:var(--muted)}.label-box{fill:var(--panel);opacity:.96}
  .case-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.case-card{background:var(--panel);border-radius:18px;padding:22px;box-shadow:var(--shadow);border-top:6px solid var(--blue)}.case-alpl{border-top-color:var(--green)}.case-tlr4{border-top-color:var(--purple)}.case-card header p{color:var(--muted);font-size:14px;margin:5px 0 18px}.case-gene{font-size:26px;font-weight:800;margin-right:10px}.case-status{font-size:12px;font-weight:700;color:var(--green);background:var(--soft-green);border-radius:999px;padding:4px 8px;white-space:nowrap}.pair-track{display:grid;grid-template-columns:minmax(74px,1fr) minmax(92px,1.2fr) minmax(74px,1fr);align-items:center;gap:8px;margin:4px 0 14px}.species-node{padding:10px 7px;border-radius:12px;background:var(--soft-blue);text-align:center;min-width:0}.species-node:last-child{background:var(--soft-orange)}.species-node span{display:block;color:var(--muted);font-size:11px}.species-node strong{display:block;font-size:12px;overflow-wrap:anywhere}.route-line{position:relative;text-align:center;color:var(--muted);font-size:10px;line-height:1.25}.route-line:before{content:"";position:absolute;left:0;right:0;top:50%;height:3px;background:currentColor;z-index:0}.route-line span{position:relative;z-index:1;background:var(--panel);padding:3px 5px}.route-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}.route-badge{font-size:11px;font-weight:700;padding:4px 7px;border-radius:999px;background:var(--soft-blue);color:var(--blue)}.route-tier2{background:var(--soft-green);color:var(--green)}.route-tier3{background:var(--soft-orange);color:var(--orange)}.route-semantic_C{background:var(--soft-purple);color:var(--purple)}.evidence{padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-weight:650}.evidence span:first-child{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}.limit{color:var(--muted);font-size:13px;margin-bottom:0}
  .matrix-wrap{overflow-x:auto;background:var(--panel);border-radius:18px;padding:10px 20px;box-shadow:var(--shadow)}table{border-collapse:collapse;width:100%;min-width:850px}th,td{text-align:left;padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted)}td:first-child{font-weight:800}.route-empty{color:var(--line)}.cell-note{display:block;color:var(--muted);font-size:11px;margin-top:2px}.db-model{display:grid;grid-template-columns:1fr 72px 1.25fr;align-items:center;gap:12px}.db-table{background:var(--panel);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}.db-table h3{font-size:16px;margin:0;padding:13px 16px;background:var(--soft-blue)}.db-table ul{list-style:none;padding:10px 16px 14px;margin:0}.db-table li{padding:5px 0;border-bottom:1px solid var(--line);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.db-table li:last-child{border:0}.db-arrow{text-align:center;font-size:32px;color:var(--muted)}.note{color:var(--muted);font-size:13px;margin-top:14px}.conclusion{margin-top:48px;padding:22px 24px;border-left:6px solid var(--green);background:var(--soft-green);border-radius:0 16px 16px 0;font-size:18px;font-weight:650}
  @media(max-width:900px){.summary{grid-template-columns:1fr}.summary-count{max-width:260px}.case-grid{grid-template-columns:1fr}.db-model{grid-template-columns:1fr}.db-arrow{transform:rotate(90deg)}.schema{padding:8px}.schema svg{min-width:760px}.schema{overflow-x:auto}}
  @media(prefers-color-scheme:dark){:root{--bg:#10151d;--panel:#19212d;--ink:#f4f7fb;--muted:#b2becc;--line:#3b4757;--soft-blue:#182f49;--soft-green:#16382e;--soft-orange:#432e18;--soft-purple:#302343;--shadow:none}}
</style>
</head>
<body>
<main>
  <section class="summary">
    <div>
      <span class="headline">Complementary evidence routes</span>
      <h1>表現型連携で、実用的なhuman-mouse variant pairを見つける</h1>
      <p class="lead">1:1 orthologを共通の足場にし、ontology、表現型名、疾患ID、semantic similarityを別々の証拠経路として保存します。単一の方法に揃えるのではなく、対象ペアと接続根拠を一緒に検索できるDBを目指します。</p>
    </div>
    <div class="summary-count"><strong>${found}/${rows.length}</strong><span>case-study target pairs recovered by the union of routes</span></div>
  </section>

  <h2>同じgene pairでも、variant pairへの接続点は異なる</h2>
  <div class="schema">
    <svg viewBox="0 0 1120 410" role="img" aria-labelledby="schema-title schema-desc">
      <title id="schema-title">Human-mouse variant matching through several phenotype evidence routes</title>
      <desc id="schema-desc">Human and mouse orthologous genes are drawn as thick genome segments. A human variant and mouse allele are joined by four evidence routes and stored as a pair with route-specific evidence.</desc>
      <text x="52" y="38" class="svg-title">HUMAN genomic region</text>
      <line x1="52" y1="92" x2="1068" y2="92" class="genome"/>
      <line x1="272" y1="92" x2="724" y2="92" class="gene"/>
      <rect x="420" y="42" width="228" height="30" rx="8" class="label-box"/>
      <text x="534" y="63" text-anchor="middle" class="svg-label">Gene A (human ortholog)</text>
      <circle cx="474" cy="92" r="13" class="variant"/>
      <line x1="384" y1="122" x2="458" y2="99" class="genome" style="stroke-width:2"/>
      <text x="376" y="128" text-anchor="end" class="svg-label">human variant</text>

      <path d="M462 101 C408 160 432 252 486 307" class="route route1"/>
      <path d="M470 105 C454 165 478 252 494 305" class="route route2"/>
      <path d="M478 105 C510 165 470 252 502 305" class="route route3"/>
      <path d="M486 101 C561 160 435 252 510 307" class="route route4"/>
      <rect x="654" y="145" width="390" height="128" rx="14" class="label-box"/>
      <line x1="676" y1="173" x2="714" y2="173" class="route route1"/><text x="728" y="178" class="svg-label">HPO-MP ontology bridge</text>
      <line x1="676" y1="202" x2="714" y2="202" class="route route2"/><text x="728" y="207" class="svg-label">exact phenotype label</text>
      <line x1="676" y1="231" x2="714" y2="231" class="route route3"/><text x="728" y="236" class="svg-label">shared disease identifier</text>
      <line x1="676" y1="260" x2="714" y2="260" class="route route4"/><text x="728" y="265" class="svg-label">semantic phenotype candidate</text>

      <text x="52" y="390" class="svg-title">MOUSE genomic region</text>
      <line x1="52" y1="318" x2="1068" y2="318" class="genome"/>
      <line x1="272" y1="318" x2="724" y2="318" class="gene"/>
      <circle cx="498" cy="318" r="13" class="allele"/>
      <rect x="412" y="264" width="244" height="30" rx="8" class="label-box"/>
      <text x="534" y="285" text-anchor="middle" class="svg-label">Gene A (mouse ortholog)</text>
      <line x1="404" y1="348" x2="482" y2="323" class="genome" style="stroke-width:2"/>
      <text x="396" y="354" text-anchor="end" class="svg-label">mouse allele</text>
    </svg>
  </div>

  <h2>3つの例が示す接続方法の相補性</h2>
  <section class="case-grid">${rows.map(caseCard).join('\n')}</section>

  <h2>対象ペアをどの経路が回収したか</h2>
  <div class="matrix-wrap">
    <table>
      <thead><tr><th>Case-study pair</th><th>HPO-MP</th><th>Exact phenotype label</th><th>Shared OMIM disease model</th><th>Semantic phenotype evidence</th></tr></thead>
      <tbody>
        <tr><td>TLR4 rs4986790 ↔ Tlr4&lt;Lps-d&gt;</td><td>${countCell(tlr4.tier1_evidence_rows)}</td><td>${countCell(tlr4.tier2_evidence_rows)}</td><td>${countCell(tlr4.tier3_evidence_rows)}</td><td>${countCell(tlr4.semantic_class_C_evidence_rows, '<span class="cell-note">class C, cosine 0.548</span>')}</td></tr>
        <tr><td>CFTR rs113993960 ↔ Cftr&lt;tm1Unc&gt;</td><td>${countCell(cftr.tier1_evidence_rows, '<span class="cell-note">failure to thrive ↔ postnatal growth retardation</span>')}</td><td>${countCell(cftr.tier2_evidence_rows)}</td><td>${countCell(cftr.tier3_evidence_rows, '<span class="cell-note">OMIM:219700</span>')}</td><td>A ${cftr.semantic_class_A_evidence_rows} / B ${cftr.semantic_class_B_evidence_rows} / C ${cftr.semantic_class_C_evidence_rows}<span class="cell-note">semantic A is not used as the main CF evidence</span></td></tr>
        <tr><td>ALPL rs1558543066 ↔ Alpl&lt;Hpp&gt;</td><td>${countCell(alpl.tier1_evidence_rows)}</td><td>${countCell(alpl.tier2_evidence_rows, '<span class="cell-note">hypophosphatasia ↔ hypophosphatasia</span>')}</td><td>${countCell(alpl.tier3_evidence_rows, '<span class="cell-note">OMIM:146300</span>')}</td><td>A ${alpl.semantic_class_A_evidence_rows} / B ${alpl.semantic_class_B_evidence_rows} / C ${alpl.semantic_class_C_evidence_rows}<span class="cell-note">exact semantic label is concordant</span></td></tr>
      </tbody>
    </table>
  </div>
  <p class="note">Counts are evidence rows produced by source records, genotypes, backgrounds, and phenotype annotations. They are not counts of independent experiments. Class D is archived and excluded from ordinary use.</p>

  <h2>DBではpairとevidence routeを分けて保存する</h2>
  <div class="db-model">
    <section class="db-table"><h3>variant_pair</h3><ul><li>pair_id</li><li>human_gene + rs_id</li><li>mouse_gene + mgi_allele_id</li><li>ortholog_pair_id</li></ul></section>
    <div class="db-arrow" aria-hidden="true">1 → n</div>
    <section class="db-table"><h3>connection_evidence</h3><ul><li>pair_id + route_id</li><li>human phenotype/source</li><li>mouse phenotype/source</li><li>ontology predicate / disease ID / cosine class</li><li>score, review flag, provenance</li></ul></section>
  </div>
  <p class="note">同じpairに複数のevidence rowを持たせることで、経路を統合して検索しながら、根拠の違いと限界を失いません。</p>

  <p class="conclusion">実用上の意義は、単一の正解経路を決めることではなく、構造化された強い接続と、取りこぼしを拾う緩い接続を同じpair単位で追跡できることです。</p>
</main>
</body>
</html>
`;
}

function tierHtmlDocument(tierCatalog) {
  const catalog = new Map(tierCatalog.map(row => [row.tier_id, row]));
  const count = tier => Number(catalog.get(tier)?.row_count || 0).toLocaleString('en-US');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Three evidence tiers for human-mouse variant correspondence</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f8fb;--panel:#fff;--ink:#152235;--muted:#5a697b;--line:#c8d1dc;--blue:#2563a6;--green:#188260;--orange:#b86d19;--soft-blue:#eaf2fb;--soft-green:#e7f5ef;--soft-orange:#fff2df;--shadow:0 12px 34px rgba(20,34,53,.08)}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.65}main{max-width:1160px;margin:0 auto;padding:48px 24px 72px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(30px,5vw,48px);line-height:1.18;letter-spacing:-.02em;margin-bottom:16px}h2{font-size:clamp(24px,3vw,31px);margin:54px 0 20px}.lead{font-size:18px;max-width:900px;color:var(--muted)}.diagram{background:var(--panel);border-radius:22px;padding:18px;box-shadow:var(--shadow);overflow-x:auto}.diagram svg{display:block;width:100%;height:auto;min-width:820px}.genome{stroke:var(--line);stroke-width:4;stroke-linecap:round}.gene{stroke:var(--ink);stroke-width:20;stroke-linecap:round}.point-human{fill:var(--panel);stroke:var(--blue);stroke-width:7}.point-mouse{fill:var(--panel);stroke:var(--orange);stroke-width:7}.leader{stroke:var(--line);stroke-width:2}.route{fill:none;stroke-width:5;stroke-linecap:round}.tier1{stroke:var(--blue)}.tier2{stroke:var(--green)}.tier3{stroke:var(--orange)}.svg-title{font-size:18px;font-weight:700;fill:var(--ink)}.svg-label{font-size:15px;font-weight:650;fill:var(--ink)}.svg-small{font-size:13px;fill:var(--muted)}.label-bg{fill:var(--panel);opacity:.97}.tier-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.tier-card{background:var(--panel);border-radius:18px;padding:22px;box-shadow:var(--shadow);border-top:6px solid var(--blue)}.tier-card:nth-child(2){border-top-color:var(--green)}.tier-card:nth-child(3){border-top-color:var(--orange)}.tier-card h3{font-size:24px;margin-bottom:4px}.tier-card .count{font-size:30px;font-weight:800;margin:10px 0}.tier-card .basis{font-weight:700}.tier-card ul{padding-left:20px;margin-bottom:0}.flow{display:grid;grid-template-columns:1fr 60px 1fr;align-items:center;gap:12px}.db-table{background:var(--panel);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}.db-table h3{font-size:16px;margin:0;padding:13px 16px;background:var(--soft-blue)}.db-table:last-child h3{background:var(--soft-green)}.db-table ul{list-style:none;padding:10px 16px 14px;margin:0}.db-table li{padding:5px 0;border-bottom:1px solid var(--line);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.db-table li:last-child{border:0}.arrow{text-align:center;font-size:30px;color:var(--muted)}.note{color:var(--muted);font-size:13px}.conclusion{margin-top:44px;padding:22px 24px;border-left:6px solid var(--green);background:var(--soft-green);border-radius:0 16px 16px 0;font-size:18px;font-weight:650}
  @media(max-width:840px){.tier-grid{grid-template-columns:1fr}.flow{grid-template-columns:1fr}.arrow{transform:rotate(90deg)}}
  @media(prefers-color-scheme:dark){:root{--bg:#10151d;--panel:#19212d;--ink:#f4f7fb;--muted:#b2becc;--line:#3b4757;--soft-blue:#182f49;--soft-green:#16382e;--soft-orange:#432e18;--shadow:none}}
</style>
</head>
<body>
<main>
  <h1>human-mouse variant correspondenceを作る3つのTier</h1>
  <p class="lead">3つのTierは信頼度の順位ではなく、異なる証拠の結び方です。共通するのは、human Gene Aとmouse Gene Aの1:1 orthologを先に確定し、その遺伝子内のvariant、allele、phenotype evidenceを接続することです。</p>

  <h2>ゲノム上のmatching pointから、根拠別のリストを作る</h2>
  <div class="diagram">
    <svg viewBox="0 0 1120 540" role="img" aria-labelledby="tier-title tier-desc">
      <title id="tier-title">Tier 1, Tier 2 and Tier 3 matching within an orthologous gene pair</title>
      <desc id="tier-desc">Thick lines show orthologous Gene A regions in human and mouse genomes. A human variant and mouse allele are connected through three evidence routes and saved in separate tier tables.</desc>
      <text x="54" y="38" class="svg-title">HUMAN genomic region</text>
      <line x1="54" y1="92" x2="1066" y2="92" class="genome"/>
      <line x1="246" y1="92" x2="758" y2="92" class="gene"/>
      <rect x="384" y="42" width="244" height="30" rx="8" class="label-bg"/>
      <text x="506" y="63" text-anchor="middle" class="svg-label">Gene A (human ortholog)</text>
      <circle cx="468" cy="92" r="13" class="point-human"/>
      <line x1="372" y1="124" x2="452" y2="99" class="leader"/>
      <text x="364" y="130" text-anchor="end" class="svg-label">human variant</text>

      <path d="M458 103 C330 178 342 290 470 363" class="route tier1"/>
      <path d="M468 105 C468 188 480 278 480 361" class="route tier2"/>
      <path d="M478 103 C614 178 626 290 490 363" class="route tier3"/>

      <rect x="735" y="154" width="330" height="166" rx="14" class="label-bg"/>
      <line x1="758" y1="185" x2="800" y2="185" class="route tier1"/><text x="814" y="190" class="svg-label">Tier 1: HPO ↔ MP</text>
      <text x="814" y="211" class="svg-small">ontology predicate + mapping confidence</text>
      <line x1="758" y1="238" x2="800" y2="238" class="route tier2"/><text x="814" y="243" class="svg-label">Tier 2: ortholog + phenotype</text>
      <text x="814" y="264" class="svg-small">B exact label / C lexical candidate</text>
      <line x1="758" y1="291" x2="800" y2="291" class="route tier3"/><text x="814" y="296" class="svg-label">Tier 3: shared OMIM</text>
      <text x="814" y="317" class="svg-small">ClinVar condition + curated mouse model</text>

      <text x="54" y="444" class="svg-title">MOUSE genomic region</text>
      <line x1="54" y1="374" x2="1066" y2="374" class="genome"/>
      <line x1="246" y1="374" x2="758" y2="374" class="gene"/>
      <rect x="384" y="322" width="244" height="30" rx="8" class="label-bg"/>
      <text x="506" y="343" text-anchor="middle" class="svg-label">Gene A (mouse ortholog)</text>
      <circle cx="480" cy="374" r="13" class="point-mouse"/>
      <line x1="384" y1="410" x2="464" y2="382" class="leader"/>
      <text x="376" y="416" text-anchor="end" class="svg-label">mouse allele / genotype</text>

      <line x1="300" y1="472" x2="820" y2="472" class="leader"/>
      <text x="560" y="500" text-anchor="middle" class="svg-label">matching lineごとにvariant pair + evidence sourceを1行として保存</text>
      <text x="560" y="524" text-anchor="middle" class="svg-small">同じpairが複数Tierに存在してよい。根拠を統合して潰さない。</text>
    </svg>
  </div>

  <h2>各Tierが保存するもの</h2>
  <section class="tier-grid">
    <article class="tier-card"><h3>Tier 1</h3><p class="count">${count('tier1')} rows</p><p class="basis">Ontology phenotype bridge</p><ul><li>ClinVar condition → HPO</li><li>HPO-MP mapping</li><li>MGI allele/genotype</li><li>predicate、confidence、sourceを保持</li></ul></article>
    <article class="tier-card"><h3>Tier 2</h3><p class="count">${count('tier2')} rows</p><p class="basis">Ortholog-first phenotype evidence</p><ul><li>ClinVar/GWAS phenotype</li><li>MGI MP/allele name</li><li>B: exact normalized label</li><li>C: lexical hypothesis、要レビュー</li></ul></article>
    <article class="tier-card"><h3>Tier 3</h3><p class="count">${count('tier3')} rows</p><p class="basis">Curated disease model</p><ul><li>ClinVar condition identifier</li><li>MGI curated disease model</li><li>shared OMIM ID</li><li>variant equivalenceは主張しない</li></ul></article>
  </section>

  <h2>DBではpairと接続根拠を分離する</h2>
  <div class="flow">
    <section class="db-table"><h3>variant_pair</h3><ul><li>human gene + rsID</li><li>mouse gene + MGI allele/genotype</li><li>ortholog pair ID</li></ul></section>
    <div class="arrow" aria-hidden="true">1 → n</div>
    <section class="db-table"><h3>tier_evidence</h3><ul><li>pair ID + tier ID</li><li>human/mouse phenotype</li><li>ontology predicate / shared OMIM / match method</li><li>source record + review status</li></ul></section>
  </div>
  <p class="note">Tier番号をconfidence scoreとして比較しません。各Tierの元データ、適用範囲、review条件を保ったまま検索します。Semantic class A/B/C/DはTier 2のB/Cとは別分類です。</p>
  <p class="conclusion">Tier説明図はデータ構造と接続根拠を示します。TLR4・CFTR・ALPLのケーススタディは、別HTMLでこの設計が実際の対象ペア回収にどう効くかを示します。</p>
</main>
</body>
</html>
`;
}

async function main() {
  const [controls, tierValidation, semanticSummaries, tierCatalog] = await Promise.all([
    readTsvObjects(path.join(PROJECT_ROOT, 'data', 'controls', 'positive_controls.tsv')),
    readTsvObjects(path.join(OUTPUT_DIR, 'tier_validation_results.tsv')),
    readTsvObjects(path.join(SEMANTIC_DIR, 'controls_summary.tsv')),
    readTsvObjects(path.join(OUTPUT_DIR, 'tier_catalog.tsv'))
  ]);
  if (!controls.length) throw new Error('No positive controls found.');

  const [tier1, tier2, tier3, semantic] = await Promise.all([
    firstMatchingRows(path.join(OUTPUT_DIR, 'tier1_monarch_phenotype.tsv.gz'), controls),
    firstMatchingRows(path.join(OUTPUT_DIR, 'tier2_ortholog_phenotype.tsv.gz'), controls),
    firstMatchingRows(path.join(OUTPUT_DIR, 'tier3_disease_model.tsv.gz'), controls),
    firstMatchingRows(path.join(SEMANTIC_DIR, 'control_variant_pairs.tsv.gz'), controls)
  ]);
  const representatives = {
    tier1,
    tier2,
    tier3,
    semantic_A: semantic,
    semantic_B: semantic,
    semantic_C: semantic
  };
  const rows = buildCaseStudyRows(controls, tierValidation, semanticSummaries, representatives);
  await writeCaseStudyTsv(path.join(SEMANTIC_DIR, 'case_study_summary.tsv'), rows);
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'case_study_evidence_explainer.html'),
    caseStudyHtmlDocument(rows),
    'utf8'
  );
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'tier_evidence_explainer.html'),
    tierHtmlDocument(tierCatalog),
    'utf8'
  );
  const found = rows.filter(row => row.case_study_status === 'FOUND').length;
  console.log(`Case-study target pairs: ${found}/${rows.length} FOUND`);
  if (found !== rows.length) {
    throw new Error(`${rows.length - found} case-study target pair(s) were not recovered.`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCaseStudyRows,
  caseStudyHtmlDocument,
  escapeHtml,
  matchesControl,
  primaryRoutes,
  representativeEvidence,
  tierHtmlDocument
};
