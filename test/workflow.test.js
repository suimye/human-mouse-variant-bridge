'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWorkflowConfig, sourcePath } = require('../src/lib/config');
const { buildSteps, parseArguments } = require('../src/run-workflow');

const projectRoot = path.resolve(__dirname, '..');

test('one workflow config contains unique sources and all mapping sections', () => {
  const config = loadWorkflowConfig(projectRoot);
  assert.equal(new Set(config.data_sources.map(source => source.id)).size, config.data_sources.length);
  assert.ok(config.strict_mapping.accepted_predicates.length);
  assert.equal(config.semantic_mapping.class_c_min, 0.5);
  assert.equal(config.tier_definitions.length, 3);
});

test('configured source paths are used instead of hard-coded raw paths', () => {
  const config = loadWorkflowConfig(projectRoot);
  assert.equal(
    sourcePath(projectRoot, config, 'clinvar_grch38'),
    path.join(projectRoot, 'data/raw/clinvar/clinvar.vcf.gz')
  );
});

test('workflow lists every construction and validation stage in order', () => {
  const config = loadWorkflowConfig(projectRoot);
  const ids = buildSteps(config).map(step => step.id);
  assert.deepEqual(ids, [
    'download', 'prepare_tier1', 'map_tier1', 'prepare_tier2', 'map_tier2',
    'map_tier3', 'validate_tiers', 'test_node', 'setup_semantic', 'semantic_model', 'test_semantic',
    'map_semantic', 'verify_semantic', 'report_cases', 'validate_tier0'
  ]);
  assert.ok(!buildSteps(config, { skipDownload: true, skipSemantic: true })
    .some(step => step.id === 'download' || step.id === 'map_semantic'));
});

test('workflow command-line options are explicit', () => {
  assert.deepEqual(parseArguments(['--dry-run', '--skip-download']), {
    dryRun: true, skipDownload: true, forceDownload: false, skipSemantic: false, help: false
  });
  assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
});
