#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadWorkflowConfig } = require('./lib/config');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function buildSteps(config, options = {}) {
  const steps = [];
  if (!options.skipDownload) {
    steps.push({ id: 'download', label: 'データファイルを取得し、URL・更新日・SHA-256を記録', command: ['node', 'src/download.js', ...(options.forceDownload ? ['--force'] : [])] });
  }
  steps.push(
    { id: 'prepare_tier1', label: 'HPO–MP、1:1 ortholog、ClinVar、MGIを共通列へ変換', command: ['node', 'src/prepare.js'] },
    { id: 'map_tier1', label: 'HPO–MPを使ってTier 1を作成', command: ['node', 'src/map.js'] },
    { id: 'prepare_tier2', label: 'ClinVar/GWASとMGI表現型を遺伝子別に整理', command: ['node', 'src/prepare-relaxed.js'] },
    { id: 'map_tier2', label: '表現型名を比較してTier 2を作成', command: ['node', 'src/relaxed-map.js'] },
    { id: 'map_tier3', label: '同じOMIM疾患IDからTier 3を作成', command: ['node', 'src/tier3-disease-map.js'] },
    { id: 'validate_tiers', label: 'Tier 1–3とpositive/negative controlsを検証', command: ['node', 'src/validate.js'] },
    { id: 'test_node', label: 'Node.js単体テストを実行', command: ['npm', 'test'] }
  );
  const runSemantic = config.execution.run_semantic && !options.skipSemantic;
  if (runSemantic) {
    steps.push(
      { id: 'setup_semantic', label: 'Semantic解析用Python環境を作成またはrequirementsと照合', command: ['node', 'src/setup-semantic-env.js'] },
      { id: 'semantic_model', label: '指定したrevisionのSapBERTを取得し、SHA-256を検証', command: ['.venv-semantic/bin/python', 'src/download-semantic-model.py'] },
      { id: 'test_semantic', label: 'Semantic分類の単体テストを実行', command: ['.venv-semantic/bin/python', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_semantic.py', '-v'] },
      { id: 'map_semantic', label: 'ortholog遺伝子内で表現型文を比較しA–Dを作成', command: ['.venv-semantic/bin/python', 'src/semantic-map.py'] },
      { id: 'verify_semantic', label: 'Semantic SQLite・出力件数・境界値を検証', command: ['.venv-semantic/bin/python', 'src/verify-semantic.py'] },
      { id: 'report_cases', label: 'TLR4、CFTR、ALPLの横断サマリーを更新', command: ['node', 'src/case-study-report.js'] }
    );
  }
  if (config.execution.tier0_input) {
    steps.push({ id: 'validate_tier0', label: '設定されたTier 0ファイルを検証', command: ['node', 'src/validate-tier0.js', config.execution.tier0_input] });
  }
  return steps;
}

function parseArguments(argv) {
  const known = new Set(['--dry-run', '--skip-download', '--force-download', '--skip-semantic', '--help']);
  const unknown = argv.filter(argument => !known.has(argument));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  return {
    dryRun: argv.includes('--dry-run'),
    skipDownload: argv.includes('--skip-download'),
    forceDownload: argv.includes('--force-download'),
    skipSemantic: argv.includes('--skip-semantic'),
    help: argv.includes('--help')
  };
}

function printHelp() {
  console.log(`Usage: ./run.sh [options]\n\nOptions:\n  --dry-run         Show every step without executing it\n  --skip-download    Reuse files already present in data/raw\n  --force-download   Download all configured source files again\n  --skip-semantic    Skip model download and semantic A–D generation\n  --help             Show this message`);
}

function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`Node.js 20 or newer is required; current version is ${process.versions.node}`);
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.skipDownload && options.forceDownload) throw new Error('--skip-download and --force-download cannot be used together');
  const config = loadWorkflowConfig(PROJECT_ROOT);
  const steps = buildSteps(config, options);
  console.log(`Workflow config: config/workflow.json`);
  console.log(`Planned steps: ${steps.length}${options.dryRun ? ' (dry run)' : ''}`);
  steps.forEach((step, index) => {
    const commandText = step.command.join(' ');
    console.log(`\n[${index + 1}/${steps.length}] ${step.label}\n  ${commandText}`);
    if (options.dryRun) return;
    const result = spawnSync(step.command[0], step.command.slice(1), {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Workflow stopped at ${step.id} (exit ${result.status})`);
  });
  if (!options.dryRun) console.log('\nWorkflow completed successfully.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildSteps, parseArguments };
