'use strict';

const fs = require('fs');
const path = require('path');
const { getFullHeapFromFile, PluginUtils } = require('@memlab/api');
const { utils } = require('@memlab/core');

const DEFAULT_HEAPDUMP_DIR = path.resolve(__dirname, '..', '..', 'heapdump');
const GROWTH_NODE_TYPES = new Set(['object', 'closure', 'regexp', 'native', 'array']);
const DEFAULTS = {
  minSnapshots: 2,
  thresholdBytes: 1024,
  maxGrowthFindings: 80,
  maxObjectGroups: 8,
  maxUngroupedObjects: 8,
  maxDetachedDom: 12,
  maxTopHolders: 12,
};

const F = {
  fmt(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1073741824) return `${(value / 1048576).toFixed(2)} MB`;
    return `${(value / 1073741824).toFixed(2)} GB`;
  },
  short(value, width = 80) {
    const text = value == null || value === '' ? '(anonymous)' : String(value);
    return text.length > width ? `${text.slice(0, width)}...` : text;
  },
};

function isHeapFile(file) {
  return /\.(heapsnapshot|heapdump)$/i.test(file);
}

function isTimelineFile(file) {
  return /\.heaptimeline$/i.test(file);
}

function listFiles(dir, predicate) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(predicate)
    .sort()
    .map(file => path.join(dir, file));
}

function createRuntimeOptions(argv = []) {
  const args = argv.slice();
  const positional = args.filter(arg => !arg.startsWith('--'));
  const dirIndex = args.indexOf('--dir');
  const heapdumpDir = dirIndex >= 0 && args[dirIndex + 1]
    ? path.resolve(args[dirIndex + 1])
    : DEFAULT_HEAPDUMP_DIR;

  const explicitHeapFiles = positional.filter(isHeapFile).map(file => path.resolve(file));
  const explicitTimeline = positional.find(isTimelineFile);
  const snapshots = explicitHeapFiles.length ? explicitHeapFiles : listFiles(heapdumpDir, isHeapFile);
  const timelines = listFiles(heapdumpDir, isTimelineFile);
  const timeline = explicitTimeline ? path.resolve(explicitTimeline) : timelines[timelines.length - 1] || null;

  return {
    heapdumpDir,
    snapshots,
    timeline,
    ...DEFAULTS,
  };
}

async function loadHeap(file, onProgress) {
  const start = Date.now();
  if (onProgress) onProgress(`loading snapshot: ${file}`);
  const heap = await getFullHeapFromFile(file);
  if (onProgress) onProgress(`  ${heap.nodes.length.toLocaleString()} nodes, ${Date.now() - start} ms`);
  return heap;
}

function cleanName(name) {
  return String(name || '(anonymous)').replace(/\s+/g, ' ');
}

function extractClass(nodeName) {
  const match = String(nodeName || '').match(/class="([^"]*)"/);
  return match ? match[1] : null;
}

function normalizeLocation(location) {
  if (!location) return null;
  return {
    scriptId: location.script_id || location.scriptId || null,
    line: location.line || location.lineNumber || 0,
    column: location.column || location.columnNumber || 0,
  };
}

function nodeRecord(node) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    className: extractClass(node.name),
    selfSize: node.self_size || 0,
    retainedSize: node.retainedSize || 0,
    traceNodeId: node.trace_node_id || 0,
    location: normalizeLocation(node.location),
  };
}

function objectLabel(object) {
  return `${object.type}/${F.short(cleanName(object.name), 72)}`;
}

function isUsefulEdgeName(name) {
  return name !== '' && typeof name !== 'number';
}

function strongReferrers(node, maxN = 20) {
  const refs = [];
  for (const edge of node.referrers || []) {
    if (edge.type === 'weak') continue;
    if (!isUsefulEdgeName(edge.name_or_index)) continue;
    refs.push({ edge: String(edge.name_or_index), type: edge.type, from: edge.fromNode });
    if (refs.length >= maxN) break;
  }
  return refs;
}

function dominatorChain(node, maxDepth = 10) {
  const chain = [];
  const seen = new Set();
  let current = node;
  while (current && chain.length < maxDepth && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.dominatorNode;
  }
  return chain;
}

function isPathStopNode(node) {
  if (!node) return true;
  if (node.type === 'closure' || node.type === 'code' || node.type === 'synthetic') return true;
  if (/Window|HTMLDocument|Document|Detached|JSGlobalObject/.test(node.name || '')) return true;
  return false;
}

function retainingPaths(node, maxDepth = 5, maxPaths = 5) {
  const paths = [];
  const queue = [{ node, path: [] }];
  const seen = new Set([node.id]);

  while (queue.length && paths.length < maxPaths) {
    const current = queue.shift();
    const refs = strongReferrers(current.node, 10);
    for (const ref of refs) {
      const step = { edge: ref.edge, type: ref.type, from: nodeRecord(ref.from) };
      const nextPath = current.path.concat(step);
      const stop = nextPath.length >= maxDepth || isPathStopNode(ref.from);
      if (stop) paths.push(nextPath);
      if (!stop && !seen.has(ref.from.id)) {
        seen.add(ref.from.id);
        queue.push({ node: ref.from, path: nextPath });
      }
      if (paths.length >= maxPaths) break;
    }
  }
  return paths;
}

async function scanGrowth(snapshotFiles, options, onProgress) {
  if (snapshotFiles.length < options.minSnapshots) {
    return {
      files: snapshotFiles,
      error: `need >= ${options.minSnapshots} heap snapshots, got ${snapshotFiles.length}`,
      records: [],
      finalHeap: null,
    };
  }

  const records = new Map();
  let finalHeap = null;
  for (let index = 0; index < snapshotFiles.length; index++) {
    if (global.gc) global.gc();
    const heap = await loadHeap(snapshotFiles[index], onProgress);
    const isFinal = index === snapshotFiles.length - 1;
    if (isFinal) finalHeap = heap;

    heap.nodes.forEach(node => {
      if (!GROWTH_NODE_TYPES.has(node.type)) return;
      const retainedSize = node.retainedSize || 0;
      if (index === 0) {
        records.set(node.id, {
          id: node.id,
          type: node.type,
          name: node.name,
          history: [retainedSize],
          finalNode: isFinal ? node : null,
        });
        return;
      }
      const record = records.get(node.id);
      if (!record) return;
      if (record.type !== node.type || record.name !== node.name) {
        records.set(node.id, null);
        return;
      }
      record.history.push(retainedSize);
      if (isFinal) record.finalNode = node;
    });
  }

  const growing = [];
  for (const record of records.values()) {
    if (!record || !record.finalNode || record.history.length !== snapshotFiles.length) continue;
    let monotonic = false;
    for (let index = 1; index < record.history.length; index++) {
      if (record.history[index] < record.history[index - 1]) {
        monotonic = false;
        break;
      }
      if (record.history[index] > record.history[index - 1]) monotonic = true;
    }
    if (!monotonic) continue;
    const initialSize = record.history[0];
    const finalSize = record.history[record.history.length - 1];
    const delta = finalSize - initialSize;
    if (delta < options.thresholdBytes) continue;
    growing.push({ ...record, initialSize, finalSize, delta });
  }

  growing.sort((left, right) => right.delta - left.delta || right.finalSize - left.finalSize);
  return {
    files: snapshotFiles,
    error: null,
    totalGrowingCount: growing.length,
    records: growing.slice(0, options.maxGrowthFindings),
    finalHeap,
  };
}

function readTimelineString(strings, index, fallback = '') {
  return strings && strings[index] ? strings[index] : fallback;
}

function parseFunctionInfos(snapshot) {
  const fields = snapshot.snapshot.meta.trace_function_info_fields || [];
  const raw = snapshot.trace_function_infos || [];
  const strings = snapshot.strings || [];
  const indexes = Object.fromEntries(fields.map((field, index) => [field, index]));
  const frames = [];
  for (let offset = 0; offset < raw.length; offset += fields.length || 1) {
    frames.push({
      functionId: raw[offset + indexes.function_id],
      functionName: readTimelineString(strings, raw[offset + indexes.name], '(anonymous)'),
      scriptUrl: readTimelineString(strings, raw[offset + indexes.script_name], '(unknown)'),
      line: raw[offset + indexes.line] || 0,
      column: raw[offset + indexes.column] || 0,
    });
  }
  return frames;
}

function summarizeTraceTree(snapshot, frames) {
  const fields = snapshot.snapshot.meta.trace_node_fields || [];
  const root = snapshot.trace_tree || [];
  const nodeByTraceId = new Map();
  const byFunction = new Map();
  const byScript = new Map();
  if (!fields.length || !root.length) {
    return { traceTreeNodes: 0, functions: [], scripts: [], nodeByTraceId };
  }

  const indexes = Object.fromEntries(fields.map((field, index) => [field, index]));
  const stride = fields.length;
  let traceTreeNodes = 0;

  function addSample(bucket, frame) {
    const sample = `${frame.functionName}:${frame.line}`;
    if (!bucket.sample.includes(sample) && bucket.sample.length < 5) bucket.sample.push(sample);
  }

  function addStack(bucket, stack) {
    if (!bucket.sampleStack && stack.length) {
      bucket.sampleStack = stack.slice(-10).map(frame => ({
        functionName: frame.functionName,
        scriptUrl: frame.scriptUrl,
        line: frame.line,
        column: frame.column,
      }));
    }
  }

  function visit(list, offset, stack) {
    const id = list[offset + indexes.id];
    const functionInfoIndex = list[offset + indexes.function_info_index];
    const allocationCount = list[offset + indexes.count] || 0;
    const allocationSize = list[offset + indexes.size] || 0;
    const children = list[offset + indexes.children] || [];
    const frame = frames[functionInfoIndex] || {
      functionName: '(unknown)',
      scriptUrl: '(unknown)',
      line: 0,
      column: 0,
    };
    const nextStack = frame.functionName === '(root)' ? stack : stack.concat(frame);
    traceTreeNodes++;
    nodeByTraceId.set(id, { id, allocationCount, allocationSize, frame, stack: nextStack.slice(-16) });

    if (frame.functionName !== '(root)') {
      const functionKey = `${frame.scriptUrl}:${frame.line}:${frame.column}:${frame.functionName}`;
      let func = byFunction.get(functionKey);
      if (!func) {
        func = {
          functionName: frame.functionName,
          scriptUrl: frame.scriptUrl,
          line: frame.line,
          column: frame.column,
          traceNodeCount: 0,
          allocationCount: 0,
          allocationSize: 0,
          sampleStack: null,
        };
        byFunction.set(functionKey, func);
      }
      func.traceNodeCount++;
      func.allocationCount += allocationCount;
      func.allocationSize += allocationSize;
      addStack(func, nextStack);

      let script = byScript.get(frame.scriptUrl);
      if (!script) {
        script = { url: frame.scriptUrl, functionCount: 0, allocationCount: 0, allocationSize: 0, sample: [] };
        byScript.set(frame.scriptUrl, script);
      }
      script.functionCount++;
      script.allocationCount += allocationCount;
      script.allocationSize += allocationSize;
      addSample(script, frame);
    }

    for (let childOffset = 0; childOffset < children.length; childOffset += stride) visit(children, childOffset, nextStack);
  }

  visit(root, 0, []);
  const sortBySize = (left, right) => right.allocationSize - left.allocationSize || right.allocationCount - left.allocationCount;
  return {
    traceTreeNodes,
    functions: [...byFunction.values()].sort(sortBySize),
    scripts: [...byScript.values()].sort(sortBySize),
    nodeByTraceId,
  };
}

function loadTimelineAttribution(file, onProgress) {
  if (!file) return null;
  if (onProgress) onProgress(`loading timeline: ${file}`);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const frames = parseFunctionInfos(snapshot);
  const tree = summarizeTraceTree(snapshot, frames);
  return {
    file,
    traceFunctionCount: frames.length,
    traceTreeNodes: tree.traceTreeNodes,
    functions: tree.functions,
    scripts: tree.scripts,
    getTraceNode: id => tree.nodeByTraceId.get(id),
  };
}

function isNoisyScript(url) {
  return !url || url === '(unknown)' || /^chrome-extension:|^devtools:|^extensions::/.test(url);
}

function candidateStacks(timeline, maxN = 8) {
  if (!timeline) return [];
  return timeline.functions
    .filter(func => !isNoisyScript(func.scriptUrl))
    .slice(0, maxN)
    .map(func => ({
      confidence: '候选调用栈',
      reason: 'snapshot 没有对象级 trace_node_id；这是同次 timeline 中分配最多的连续栈。',
      allocationSize: func.allocationSize,
      allocationCount: func.allocationCount,
      frames: func.sampleStack && func.sampleStack.length
        ? func.sampleStack
        : [{ functionName: func.functionName, scriptUrl: func.scriptUrl, line: func.line, column: func.column }],
    }));
}

function exactStackForNode(node, timeline) {
  if (!timeline || !node.trace_node_id) return null;
  const traceNode = timeline.getTraceNode(node.trace_node_id);
  if (!traceNode || !traceNode.stack.length || traceNode.frame.functionName === '(root)') return null;
  return {
    confidence: '精确对象栈',
    reason: `heap node trace_node_id=${node.trace_node_id} can be resolved in timeline trace_tree.`,
    allocationSize: traceNode.allocationSize,
    allocationCount: traceNode.allocationCount,
    frames: traceNode.stack.map(frame => ({
      functionName: frame.functionName,
      scriptUrl: frame.scriptUrl,
      line: frame.line,
      column: frame.column,
    })),
  };
}

function relationshipForNode(node, timeline) {
  return {
    rawObject: nodeRecord(node),
    dominatorPath: dominatorChain(node, 10).map(nodeRecord),
    referrers: strongReferrers(node, 30).map(ref => ({ edge: ref.edge, type: ref.type, from: nodeRecord(ref.from) })),
    retainingPaths: retainingPaths(node, 5, 5),
    exactStack: exactStackForNode(node, timeline),
  };
}

function buildGrowthFindings(records, timeline) {
  return records.map(record => ({
    id: record.id,
    type: record.type,
    name: record.name,
    initialSize: record.initialSize,
    finalSize: record.finalSize,
    delta: record.delta,
    history: record.history,
    relationship: relationshipForNode(record.finalNode, timeline),
  }));
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map(id => [id, id]));
  }
  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }
  union(left, right) {
    if (!this.parent.has(left) || !this.parent.has(right)) return;
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function buildClusterChain(group) {
  const ids = new Set(group.findings.map(finding => finding.id));
  const labels = new Map(group.findings.map(finding => [finding.id, objectLabel(finding.relationship.rawObject)]));
  const adjacency = new Map();
  const held = new Set();

  for (const finding of group.findings) {
    for (const ref of finding.relationship.referrers) {
      if (!ids.has(ref.from.id)) continue;
      if (!adjacency.has(ref.from.id)) adjacency.set(ref.from.id, []);
      adjacency.get(ref.from.id).push({ to: finding.id, edge: ref.edge });
      held.add(finding.id);
    }
  }

  const roots = [...ids].filter(id => !held.has(id));
  const startIds = roots.length ? roots : [...ids];
  let best = [];

  function walk(id, path, seen) {
    const next = adjacency.get(id) || [];
    if (!next.length && path.length > best.length) best = path;
    for (const edge of next) {
      if (seen.has(edge.to)) continue;
      walk(edge.to, path.concat({ id: edge.to, via: edge.edge }), new Set([...seen, edge.to]));
    }
  }

  for (const id of startIds) walk(id, [{ id, via: null }], new Set([id]));
  if (!best.length) best = [{ id: group.findings[0].id, via: null }];

  return best.map((step, index) => ({
    id: step.id,
    edge: index === 0 ? null : step.via,
    label: labels.get(step.id) || String(step.id),
  }));
}

function formatClusterChain(chain) {
  return chain.map((step, index) => index === 0 ? step.label : `--${step.edge}--> ${step.label}`).join(' ');
}

function recommendInvestigation(group) {
  const text = group.findings.map(finding => [
    finding.name,
    finding.type,
    ...finding.relationship.referrers.map(ref => ref.edge),
    ...finding.relationship.referrers.map(ref => ref.from.name),
  ].join(' ')).join(' ').toLowerCase();

  if (/intersectionobserv|resizeobserv|mutationobserv|performanceobserv/.test(text)) {
    return '优先检查 Observer、回调和 DOM 引用，确认销毁时 disconnect 并清空引用。';
  }
  if (/eventtargetdata|registeredeventlistener|eventlistener|listener/.test(text)) {
    return '优先检查事件监听或订阅，确认销毁时 remove/off，参数保持一致。';
  }
  if (/\bmap\b|\bset\b|cache|records|table|buf/.test(text)) {
    return '优先检查这条持有链里的 Map/Set/Array 缓冲，确认业务结束后 delete/clear。';
  }
  if (/context|closure|previous/.test(text)) {
    return '优先检查闭包上下文里的回调、Promise、定时器或异步任务，确认结束时取消并释放引用。';
  }
  if (/cssstylesheet|stylesheet/.test(text)) {
    return '优先检查动态样式表或样式注入逻辑，确认页面切换后移除 style/link 引用。';
  }
  return '沿持有链定位保存对象的字段，在生命周期结束时断开引用。';
}

function buildObjectClusters(findings, stacks, options) {
  const ids = findings.map(finding => finding.id);
  const idSet = new Set(ids);
  const uf = new UnionFind(ids);

  for (const finding of findings) {
    for (const ref of finding.relationship.referrers) if (idSet.has(ref.from.id)) uf.union(finding.id, ref.from.id);
    for (const pathSteps of finding.relationship.retainingPaths) {
      for (const step of pathSteps) if (idSet.has(step.from.id)) uf.union(finding.id, step.from.id);
    }
    for (const node of finding.relationship.dominatorPath) if (idSet.has(node.id)) uf.union(finding.id, node.id);
  }

  const groups = new Map();
  for (const finding of findings) {
    const root = uf.find(finding.id);
    if (!groups.has(root)) groups.set(root, { findings: [] });
    groups.get(root).findings.push(finding);
  }

  return [...groups.values()].map((group, index) => {
    group.findings.sort((left, right) => right.delta - left.delta || right.finalSize - left.finalSize);
    const chain = buildClusterChain(group);
    const exactStack = group.findings.map(finding => finding.relationship.exactStack).find(Boolean);
    const stack = exactStack || stacks[index] || null;
    return {
      title: formatClusterChain(chain),
      chain,
      objectIds: group.findings.map(finding => finding.id),
      totalDelta: group.findings.reduce((sum, finding) => sum + finding.delta, 0),
      maxFinalSize: Math.max(...group.findings.map(finding => finding.finalSize)),
      objects: group.findings.map(finding => ({
        id: finding.id,
        object: objectLabel(finding.relationship.rawObject),
        delta: finding.delta,
        finalSize: finding.finalSize,
        referrerEdges: [...new Set(finding.relationship.referrers.map(ref => ref.edge))].slice(0, 8),
      })),
      retainingPaths: group.findings[0].relationship.retainingPaths,
      recommendation: recommendInvestigation(group),
      stack,
    };
  }).sort((left, right) => right.totalDelta - left.totalDelta || right.maxFinalSize - left.maxFinalSize)
    .slice(0, options.maxObjectGroups);
}

function findDetachedDOM(heap, maxN) {
  return PluginUtils.filterOutLargestObjects(heap, utils.isDetachedDOMNode, maxN).map(node => ({
    node: nodeRecord(node),
    referrers: strongReferrers(node, 8).map(ref => ({ edge: ref.edge, type: ref.type, from: nodeRecord(ref.from) })),
    retainingPaths: retainingPaths(node, 4, 3),
  }));
}

function findTopHolders(heap, maxN) {
  return PluginUtils.filterOutLargestObjects(heap, PluginUtils.isNodeWorthInspecting, maxN).map(node => ({
    node: nodeRecord(node),
    referrers: strongReferrers(node, 6).map(ref => ({ edge: ref.edge, type: ref.type, from: nodeRecord(ref.from) })),
  }));
}

function formatFrame(frame) {
  return `${frame.functionName || '(anonymous)'} (${frame.scriptUrl || '(unknown)'}:${frame.line || 0}:${frame.column || 0})`;
}

function formatStack(stack, maxFrames = 8) {
  if (!stack || !stack.frames || !stack.frames.length) return ['无可用调用栈'];
  const knownFrames = stack.frames.filter(frame => !isNoisyScript(frame.scriptUrl));
  const frames = knownFrames.length >= 2 ? knownFrames : stack.frames;
  return frames.slice(-maxFrames).map((frame, index) => `${'  '.repeat(index)}${index ? '-> ' : ''}${formatFrame(frame)}`);
}

function formatPath(pathSteps) {
  if (!pathSteps || !pathSteps.length) return '无可读持有路径';
  return pathSteps.map((step, index) => `${index ? ' <- ' : ''}${step.edge} <- ${objectLabel(step.from)}`).join('');
}

async function runAnalysis(options, hooks = {}) {
  const onProgress = hooks.onProgress;
  const growth = await scanGrowth(options.snapshots, options, onProgress);
  const finalHeap = growth.finalHeap || (options.snapshots.length ? await loadHeap(options.snapshots[options.snapshots.length - 1], onProgress) : null);
  const timeline = loadTimelineAttribution(options.timeline, onProgress);
  const stacks = candidateStacks(timeline, 10);
  const findings = buildGrowthFindings(growth.records, timeline);
  const clusters = buildObjectClusters(findings, stacks, options);

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      heapdumpDir: options.heapdumpDir,
      snapshots: options.snapshots,
      finalSnapshot: options.snapshots[options.snapshots.length - 1] || null,
      timeline: options.timeline,
    },
    summary: {
      snapshotCount: options.snapshots.length,
      sustainedGrowthCount: growth.totalGrowingCount || findings.length,
      reportedGrowthCount: findings.length,
      objectClusterCount: clusters.length,
      finalHeapNodes: finalHeap ? finalHeap.nodes.length : 0,
      timelineTraceFunctions: timeline ? timeline.traceFunctionCount : 0,
      timelineTraceTreeNodes: timeline ? timeline.traceTreeNodes : 0,
      exactObjectStacks: findings.filter(finding => finding.relationship.exactStack).length,
      notes: options.snapshots.length === 2
        ? ['当前只有 2 份 snapshot，只能证明 before 到 after 增长；建议使用 4 份以上覆盖完整操作来提高趋势置信度。']
        : [],
    },
    objectClusters: clusters,
    growthFindings: findings.map(finding => ({ ...finding, relationship: finding.relationship })),
    timeline: timeline ? {
      file: timeline.file,
      traceFunctionCount: timeline.traceFunctionCount,
      traceTreeNodes: timeline.traceTreeNodes,
      topStacks: stacks,
      topFunctions: timeline.functions.slice(0, 50),
      topScripts: timeline.scripts.slice(0, 30),
    } : null,
    heapEvidence: finalHeap ? {
      detachedDom: findDetachedDOM(finalHeap, options.maxDetachedDom),
      topHolders: findTopHolders(finalHeap, options.maxTopHolders),
    } : null,
  };
}

function formatConsoleReport(report) {
  console.log('\n========== 原始对象内存报告 ==========' );
  console.log(`Snapshot 数量: ${report.summary.snapshotCount}`);
  console.log(`持续增长对象: ${report.summary.sustainedGrowthCount}（报告展示 ${report.summary.reportedGrowthCount}）`);
  console.log(`对象簇: ${report.summary.objectClusterCount}`);
  if (report.inputs.timeline) console.log(`Timeline: ${report.inputs.timeline}`);
  for (const note of report.summary.notes) console.log(`注意: ${note}`);

  console.log('\n-- 需要优先排查的真实对象 --');
  if (!report.objectClusters.length) console.log('  未发现超过阈值的持续增长对象。');
  for (const cluster of report.objectClusters.slice(0, 5)) {
    console.log(`\n  排查: ${cluster.recommendation}`);
    console.log(`  对象链: ${cluster.title}`);
    console.log(`  大小: +${F.fmt(cluster.totalDelta)}，最大保留 ${F.fmt(cluster.maxFinalSize)}，对象 id: ${cluster.objectIds.join(', ')}`);
    if (cluster.retainingPaths.length) console.log(`  持有路径: ${formatPath(cluster.retainingPaths[0])}`);
    if (cluster.stack) {
      console.log(`  代码栈: ${cluster.stack.confidence}，${F.fmt(cluster.stack.allocationSize)} / ${cluster.stack.allocationCount || 0} 次分配`);
      for (const line of formatStack(cluster.stack, 5)) console.log(`       ${line}`);
    }
  }

  console.log('\n完整 JSON 和 Markdown 已写入 analysis/reports/。');
  console.log('AI 提示词使用项目里的固定文件 analysis/AI_PROMPT.md。');
}

function markdownTableRow(values) {
  return `| ${values.map(value => String(value == null ? '' : value).replace(/\|/g, '\\|')).join(' | ')} |`;
}

function buildHumanMarkdown(report) {
  const lines = [];
  lines.push('# 原始对象内存分析报告');
  lines.push('');
  lines.push('## 一眼结论');
  lines.push('');
  lines.push(`- Snapshot 数量：${report.summary.snapshotCount}`);
  lines.push(`- 持续增长对象：${report.summary.sustainedGrowthCount}（报告展示 ${report.summary.reportedGrowthCount} 个最大对象）`);
  lines.push(`- 合并后的对象簇：${report.summary.objectClusterCount}`);
  lines.push(`- Timeline 函数栈节点：${report.summary.timelineTraceTreeNodes}`);
  lines.push(`- 对象级精确栈：${report.summary.exactObjectStacks}`);
  for (const note of report.summary.notes) lines.push(`- 注意：${note}`);
  lines.push('');
  lines.push('报告不做业务翻译，只展示真实 V8 对象、持有链和可回源码的调用栈。');
  lines.push('');

  lines.push('## 需要优先排查的真实对象');
  lines.push('');
  if (!report.objectClusters.length) lines.push('未发现超过阈值的持续增长对象。');
  report.objectClusters.forEach((cluster, index) => {
    lines.push(`### ${index + 1}. ${cluster.title}`);
    lines.push('');
    lines.push(`- **先查什么**：${cluster.recommendation}`);
    lines.push(`- **对象 id**：${cluster.objectIds.join(', ')}`);
    lines.push(`- **增长大小**：+${F.fmt(cluster.totalDelta)}，最大最终保留 ${F.fmt(cluster.maxFinalSize)}`);
    if (cluster.retainingPaths.length) lines.push(`- **持有路径**：${formatPath(cluster.retainingPaths[0])}`);
    if (cluster.stack) {
      lines.push(`- **代码栈**：${cluster.stack.confidence}，${F.fmt(cluster.stack.allocationSize)} / ${cluster.stack.allocationCount || 0} 次分配`);
      lines.push('');
      lines.push('```text');
      for (const line of formatStack(cluster.stack, 8)) lines.push(line);
      lines.push('```');
      lines.push('');
    }
    lines.push(markdownTableRow(['对象 id', '真实对象', '增长', '最终保留', '关键边']));
    lines.push(markdownTableRow(['---', '---', '---:', '---:', '---']));
    for (const object of cluster.objects) {
      lines.push(markdownTableRow([
        object.id,
        object.object,
        F.fmt(object.delta),
        F.fmt(object.finalSize),
        object.referrerEdges.join(', '),
      ]));
    }
    lines.push('');
  });

  if (report.heapEvidence && report.heapEvidence.detachedDom.length) {
    lines.push('## Detached DOM 原始证据');
    lines.push('');
    lines.push(markdownTableRow(['#', '保留大小', 'DOM', '直接持有边']));
    lines.push(markdownTableRow(['---', '---:', '---', '---']));
    report.heapEvidence.detachedDom.slice(0, 8).forEach((item, index) => {
      lines.push(markdownTableRow([
        index + 1,
        F.fmt(item.node.retainedSize),
        objectLabel(item.node),
        item.referrers.map(ref => `${ref.edge} <- ${objectLabel(ref.from)}`).join('; '),
      ]));
    });
    lines.push('');
  }

  lines.push('## 这份报告怎么看');
  lines.push('');
  lines.push('- “真实对象”来自 V8 heap：id、type、name、retainedSize，不做业务翻译。');
  lines.push('- “对象链”是增长对象之间的直接持有关系，例如 `Context --dn--> closure --buf--> Map`。');
  lines.push('- “持有路径”来自 referrers，用来说明对象为什么还活着。');
  lines.push('- “代码栈”优先使用对象级 trace_node_id；没有时展示同次 timeline 的高分配候选栈。');
  lines.push('- 如果代码经过压缩或去符号，函数名可能是 `t`、`e`、`value`；此时主要看 script URL、line、column，再配合 sourcemap 回源码。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeReports(report, reportsDir) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = Date.now();
  const aiFile = path.join(reportsDir, `report-${timestamp}-ai.json`);
  const humanFile = path.join(reportsDir, `report-${timestamp}-human.md`);
  fs.writeFileSync(aiFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(humanFile, buildHumanMarkdown(report));
  return { aiFile, humanFile };
}

module.exports = {
  createRuntimeOptions,
  runAnalysis,
  formatConsoleReport,
  writeReports,
  F,
};