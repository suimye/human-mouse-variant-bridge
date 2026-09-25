'use strict';

const fs = require('node:fs');
const path = require('node:path');

function configPath(projectRoot) {
  return path.join(projectRoot, 'config', 'workflow.json');
}

function validateWorkflowConfig(config) {
  if (!config || config.schema_version !== 1) throw new Error('config/workflow.json schema_version must be 1');
  if (!Array.isArray(config.data_sources) || !config.data_sources.length) {
    throw new Error('config/workflow.json data_sources must be a non-empty array');
  }
  const ids = new Set();
  for (const source of config.data_sources) {
    for (const field of ['id', 'name', 'url', 'path']) {
      if (!source[field]) throw new Error(`Data source is missing ${field}`);
    }
    if (ids.has(source.id)) throw new Error(`Duplicate data source id: ${source.id}`);
    ids.add(source.id);
  }
  for (const section of ['strict_mapping', 'ortholog_first_mapping', 'semantic_mapping', 'tier_definitions', 'execution']) {
    if (config[section] === undefined) throw new Error(`config/workflow.json is missing ${section}`);
  }
  return config;
}

function loadWorkflowConfig(projectRoot) {
  return validateWorkflowConfig(JSON.parse(fs.readFileSync(configPath(projectRoot), 'utf8')));
}

function sourceById(config, sourceId) {
  const source = config.data_sources.find(item => item.id === sourceId);
  if (!source) throw new Error(`Unknown data source id in config/workflow.json: ${sourceId}`);
  return source;
}

function sourcePath(projectRoot, config, sourceId) {
  return path.resolve(projectRoot, sourceById(config, sourceId).path);
}

module.exports = { configPath, loadWorkflowConfig, sourceById, sourcePath, validateWorkflowConfig };
