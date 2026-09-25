#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_DIR = path.join(PROJECT_ROOT, '.venv-semantic');
const PYTHON = path.join(ENV_DIR, 'bin', 'python');
const REQUIREMENTS = path.join(PROJECT_ROOT, 'requirements-semantic.txt');
const STAMP = path.join(ENV_DIR, '.requirements.sha256');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
}

function requirementsHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(REQUIREMENTS)).digest('hex');
}

function main() {
  if (!fs.existsSync(PYTHON)) {
    console.log('Creating .venv-semantic with python3...');
    run('python3', ['-m', 'venv', ENV_DIR]);
  }
  const expected = requirementsHash();
  const installed = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim() : '';
  if (installed !== expected) {
    console.log('Installing semantic-analysis packages from requirements-semantic.txt...');
    run(PYTHON, ['-m', 'pip', 'install', '-r', REQUIREMENTS]);
    fs.writeFileSync(STAMP, `${expected}\n`, 'utf8');
  } else {
    console.log('Semantic environment already matches requirements-semantic.txt.');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { requirementsHash };
