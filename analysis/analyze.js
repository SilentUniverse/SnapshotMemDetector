#!/usr/bin/env node
'use strict';
/**
 * Static heap analyzer. Reads config.js, scans heap snapshots for sustained
 * growth, enriches each finding with memlab retainer/dominator evidence, then
 * correlates the run with allocation stacks from a .heaptimeline.
 *
 *   node analyze.js before.heapsnapshot after.heapsnapshot run.heaptimeline
 *   node analyze.js --dir <snapshots-dir> run.heaptimeline
 */
const path = require('path');
const config = require('./config');
const { normalizeInputs, runAnalysis, formatConsoleReport, writeReport } = require('./lib/analyzer');

(async () => {
  const runtimeConfig = normalizeInputs(config, process.argv.slice(2));
  const report = await runAnalysis(runtimeConfig, { onProgress: message => console.log(message) });
  formatConsoleReport(report);

  const outFile = writeReport(report, path.join(__dirname, 'reports'));
  console.log(`\n-> ${outFile}`);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
