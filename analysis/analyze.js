#!/usr/bin/env node
'use strict';
/**
 * Static heap analyzer. Scans heapdump/ for sustained object growth, enriches
 * each raw V8 object with retainer/dominator evidence, then correlates the run
 * with allocation stacks from a .heaptimeline.
 *
 *   node analyze.js
 *   node analyze.js --dir <heapdump-dir>
 */
const path = require('path');
const { createRuntimeOptions, runAnalysis, formatConsoleReport, writeReports } = require('./lib/raw-analyzer');

(async () => {
  const options = createRuntimeOptions(process.argv.slice(2));
  const report = await runAnalysis(options, { onProgress: message => console.log(message) });
  formatConsoleReport(report);

  const files = writeReports(report, path.join(__dirname, 'reports'));
  console.log(`\nAI report: ${files.aiFile}`);
  console.log(`Human report: ${files.humanFile}`);
  console.log(`AI prompt: ${path.join(__dirname, 'AI_PROMPT.md')}`);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
