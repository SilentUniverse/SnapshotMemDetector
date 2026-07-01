'use strict';

const fs = require('fs');
const path = require('path');
const { getFullHeapFromFile, PluginUtils } = require('@memlab/api');
const { utils } = require('@memlab/core');

const GROWTH_NODE_TYPES = new Set(['object', 'closure', 'regexp', 'native', 'array']);

const F = {
  fmt(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1073741824) return `${(value / 1048576).toFixed(2)} MB`;
    return `${(value / 1073741824).toFixed(2)} GB`;
  },
  pad(value, width) { return String(value).padStart(width); },
  short(value, width = 72) {
    const text = value == null ? '' : String(value);
    return text.length > width ? `${text.slice(0, width)}...` : text;
  },
};

function isHeapFile(file) {
  return /\.(heapsnapshot|heapdump)$/i.test(file);
}

function listHeapFiles(dir) {
  return fs.readdirSync(dir)
    .filter(isHeapFile)
    .sort()
    .map(file => path.join(dir, file));
}

function normalizeInputs(config, argv) {
  const inputs = { ...(config.inputs || {}) };
  const args = argv || [];
  const positional = args.filter(arg => !arg.startsWith('--'));
  const dirIndex = args.indexOf('--dir');
  if (dirIndex >= 0 && args[dirIndex + 1]) inputs.snapshotsDir = args[dirIndex + 1];

  const snapshotArgs = positional.filter(isHeapFile);
  if (snapshotArgs.length) {
    inputs.snapshots = snapshotArgs;
    inputs.snapshot = snapshotArgs[snapshotArgs.length - 1];
  }

  const timelineArg = positional.find(file => /\.heaptimeline$/i.test(file));
  if (timelineArg) inputs.timeline = timelineArg;

  let snapshots = [];
  if (inputs.snapshotsDir) snapshots = listHeapFiles(inputs.snapshotsDir);
  else if (Array.isArray(inputs.snapshots) && inputs.snapshots.length) snapshots = inputs.snapshots;
  else if (inputs.snapshot) snapshots = [inputs.snapshot];

  return {
    ...config,
    inputs: {
      ...inputs,
      snapshots,
      snapshot: snapshots.length ? snapshots[snapshots.length - 1] : inputs.snapshot || null,
    },
  };
}

async function loadHeap(file, onProgress) {
  const start = Date.now();
  if (onProgress) onProgress(`loading snapshot: ${file}`);
  const heap = await getFullHeapFromFile(file);
  if (onProgress) onProgress(`  ${heap.nodes.length.toLocaleString()} nodes, ${Date.now() - start} ms`);
  return heap;
}

function findDetachedDOM(heap, topN = 30) {
  return PluginUtils.filterOutLargestObjects(heap, utils.isDetachedDOMNode, topN);
}

function topHolders(heap, topN = 20) {
  return PluginUtils.filterOutLargestObjects(heap, PluginUtils.isNodeWorthInspecting, topN);
}

function dominatorChain(node, maxDepth = 12) {
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

function meaningfulReferrers(node, maxN = 10) {
  const out = [];
  for (const edge of node.referrers || []) {
    const name = edge.name_or_index;
    if (name === '' || typeof name === 'number') continue;
    if (name === 'context' && edge.type === 'internal') continue;
    out.push({ edge: name, type: edge.type, from: edge.fromNode });
    if (out.length >= maxN) break;
  }
  return out;
}

function hasRef(node, name) {
  try { return !!node.getReferenceNode(name); }
  catch { return false; }
}

function readStr(node) {
  if (!node) return null;
  if (node.type === 'string' || node.type === 'concatenated string' || node.type === 'sliced string') {
    return node.name;
  }
  return null;
}

function pickStr(fromNode, fields) {
  if (!fromNode) return null;
  for (const field of fields) {
    try {
      const valueNode = fromNode.getReferenceNode(field);
      const value = readStr(valueNode);
      if (value) return value;
    } catch {}
  }
  return null;
}

const frameworkHelpers = { hasRef, readStr, pickStr };

const defaultFrameworks = {
  vue2: {
    name: 'vue2',
    detect: node => hasRef(node, '_isVue'),
    nameFrom(instance) {
      const options = instance.getReferenceNode('$options');
      if (options) return pickStr(options, ['name', '_componentTag', '__name', '__file']);
      return pickStr(instance, ['_name']);
    },
  },
  vue3: {
    name: 'vue3',
    detect: node => hasRef(node, 'vnode') &&
      (hasRef(node, 'subTree') || hasRef(node, 'setupState') || hasRef(node, 'proxy')),
    nameFrom(instance) {
      const typeNode = instance.getReferenceNode('type');
      if (typeNode) {
        const name = pickStr(typeNode, ['name', '__name', '__file']);
        if (name) return name;
        const scopeId = typeNode.getReferenceNode && typeNode.getReferenceNode('__scopeId');
        const scope = readStr(scopeId);
        if (scope) return `scope:${scope}`;
      }
      return pickStr(instance, ['__name', '_name']);
    },
  },
  react: {
    name: 'react',
    detect: node => hasRef(node, 'memoizedState') &&
      (hasRef(node, 'return') || hasRef(node, 'child') || hasRef(node, 'pendingProps') || hasRef(node, 'stateNode')),
    nameFrom(fiber) {
      const typeNode = fiber.getReferenceNode('type');
      if (typeNode) {
        const tag = readStr(typeNode);
        if (tag) return `tag:${tag}`;
        const displayName = pickStr(typeNode, ['displayName', 'name']);
        if (displayName) return displayName;
      }
      const elementType = fiber.getReferenceNode('elementType');
      if (elementType) return pickStr(elementType, ['displayName', 'name']);
      return null;
    },
  },
};

function normalizeFrameworks(config) {
  const configured = Array.isArray(config.frameworks) ? config.frameworks : ['vue2', 'vue3', 'react'];
  return configured.map(rule => {
    if (typeof rule === 'string') return defaultFrameworks[rule];
    return rule;
  }).filter(Boolean).concat(config.customFrameworks || []);
}

function classifyFramework(node, rules) {
  if (!node) return null;
  for (const rule of rules) {
    try {
      if (rule.detect(node, frameworkHelpers)) {
        let name = null;
        try { name = rule.nameFrom && rule.nameFrom(node, frameworkHelpers); }
        catch {}
        return { kind: rule.name, name: name || '(anonymous)' };
      }
    } catch {}
  }
  return null;
}

function extractClass(nodeName) {
  const match = String(nodeName || '').match(/class="([^"]*)"/);
  return match ? match[1] : '';
}

function classToBusiness(className, config) {
  const business = config.business || {};
  if (!className) return null;
  for (const regexp of business.classKeyExtractors || []) {
    const match = String(className).match(regexp);
    if (match) return { key: match[1], source: 'dom-class-regexp' };
  }
  const tokens = String(className).split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    for (const [prefix, moduleName] of Object.entries(business.classPrefixes || {})) {
      if (token.startsWith(prefix)) {
        const rest = token.slice(prefix.length).split(/[\s_-]/)[0];
        return { key: moduleName + (rest ? `:${rest}` : ''), source: 'dom-class-prefix' };
      }
    }
  }
  return null;
}

function findBusinessSignal(node, config, frameworkRules) {
  const directClass = classToBusiness(extractClass(node.name), config);
  if (directClass) return directClass;

  for (const current of dominatorChain(node, 10)) {
    const byClass = classToBusiness(extractClass(current.name), config);
    if (byClass) return { ...byClass, source: `dominator-${byClass.source}` };
    const framework = classifyFramework(current, frameworkRules);
    if (framework && framework.name !== '(anonymous)') {
      return { key: `${framework.kind}:${framework.name}`, source: 'framework-retainer' };
    }
  }

  for (const referrer of meaningfulReferrers(node, 12)) {
    const semantic = (config.business && config.business.edgeSemantics || {})[referrer.edge];
    if (semantic) return { key: semantic, source: 'retainer-edge-semantic' };
  }

  return null;
}

function diagnoseLeak(referrers, config) {
  const hints = [];
  const fromNames = referrers.map(referrer => referrer.from && referrer.from.name || '');
  for (const rule of config.leakMechanisms || []) {
    if (fromNames.some(name => rule.match.test(name))) hints.push(rule.hint);
  }
  const edgeSemantics = config.business && config.business.edgeSemantics || {};
  const edges = [...new Set(referrers.map(referrer => String(referrer.edge)).filter(edge => edge && !/^\d+$/.test(edge)))];
  if (edges.length) {
    hints.push(`stored as property: ${edges.slice(0, 4).map(edge => edgeSemantics[edge] || edge).join(', ')}`);
  }
  return hints;
}

function nodeSummary(node, frameworkRules) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    retainedSize: node.retainedSize,
    selfSize: node.self_size,
    framework: classifyFramework(node, frameworkRules),
  };
}

function relationshipForNode(node, config, frameworkRules, timelineAttribution) {
  const referrers = meaningfulReferrers(node, 10);
  const chain = dominatorChain(node, 12);
  const allocation = allocationForNode(node, timelineAttribution);
  const frameworkOwner = chain.map(current => classifyFramework(current, frameworkRules)).find(Boolean) || null;

  return {
    business: findBusinessSignal(node, config, frameworkRules),
    frameworkOwner,
    likelyCause: diagnoseLeak(referrers, config),
    allocation,
    dominatorChain: chain.map(current => nodeSummary(current, frameworkRules)),
    referrers: referrers.slice(0, 8).map(referrer => ({
      edge: referrer.edge,
      type: referrer.type,
      from: nodeSummary(referrer.from, frameworkRules),
    })),
  };
}

function isMonotonicGrowth(history) {
  let grew = false;
  for (let index = 1; index < history.length; index++) {
    if (history[index] < history[index - 1]) return false;
    if (history[index] > history[index - 1]) grew = true;
  }
  return grew;
}

async function scanGrowth(snapshotFiles, config, onProgress) {
  const minSnapshots = config.unboundGrowth && config.unboundGrowth.minSnapshots || 2;
  const thresholdBytes = config.unboundGrowth && config.unboundGrowth.thresholdBytes || 1024;
  const maxResults = config.unboundGrowth && config.unboundGrowth.maxResults || 50;

  if (snapshotFiles.length < minSnapshots) {
    return {
      files: snapshotFiles,
      error: `need >= ${minSnapshots} heap snapshots, got ${snapshotFiles.length}`,
      growing: [],
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
    if (!record || record.history.length !== snapshotFiles.length || !record.finalNode) continue;
    if (!isMonotonicGrowth(record.history)) continue;
    const initialSize = record.history[0];
    const finalSize = record.history[record.history.length - 1];
    const delta = finalSize - initialSize;
    if (delta < thresholdBytes) continue;
    growing.push({
      id: record.id,
      type: record.type,
      name: record.name,
      initialSize,
      finalSize,
      delta,
      history: record.history,
      finalNode: record.finalNode,
    });
  }

  growing.sort((left, right) => right.delta - left.delta || right.finalSize - left.finalSize);
  return { files: snapshotFiles, count: growing.length, growing: growing.slice(0, maxResults), finalHeap };
}

function readTimelineString(strings, index, fallback = '') {
  return strings && strings[index] ? strings[index] : fallback;
}

function parseFunctionInfos(snapshot) {
  const fields = snapshot.snapshot.meta.trace_function_info_fields || [];
  const raw = snapshot.trace_function_infos || [];
  const strings = snapshot.strings || [];
  const stride = fields.length || 1;
  const indexes = Object.fromEntries(fields.map((field, index) => [field, index]));
  const frames = [];

  for (let offset = 0; offset < raw.length; offset += stride) {
    frames.push({
      functionId: raw[offset + indexes.function_id],
      functionName: readTimelineString(strings, raw[offset + indexes.name], '(anon)'),
      scriptUrl: readTimelineString(strings, raw[offset + indexes.script_name], '(unknown)'),
      line: raw[offset + indexes.line] || 0,
      column: raw[offset + indexes.column] || 0,
    });
  }
  return frames;
}

function addScriptSample(bucket, frame) {
  const sample = `${frame.functionName}:${frame.line}`;
  if (!bucket.sample.includes(sample) && bucket.sample.length < 5) bucket.sample.push(sample);
}

function addFunctionSample(bucket, stack) {
  if (bucket.sampleStack || !stack.length) return;
  bucket.sampleStack = stack.slice(-8).map(frame => ({
    functionName: frame.functionName,
    scriptUrl: frame.scriptUrl,
    line: frame.line,
    column: frame.column,
  }));
}

function summarizeTraceTree(snapshot, frames) {
  const fields = snapshot.snapshot.meta.trace_node_fields || [];
  const root = snapshot.trace_tree || [];
  if (!fields.length || !root.length) {
    return { traceTreeNodes: 0, scripts: null, functions: [], nodeByTraceId: new Map() };
  }

  const indexes = Object.fromEntries(fields.map((field, index) => [field, index]));
  const stride = fields.length;
  const byScript = new Map();
  const byFunction = new Map();
  const nodeByTraceId = new Map();
  let traceTreeNodes = 0;

  function visitTraceNode(list, offset, stack) {
    const id = list[offset + indexes.id];
    const functionInfoIndex = list[offset + indexes.function_info_index];
    const allocationCount = list[offset + indexes.count] || 0;
    const allocationSize = list[offset + indexes.size] || 0;
    const children = list[offset + indexes.children] || [];
    const frame = frames[functionInfoIndex] || {
      functionId: functionInfoIndex,
      functionName: '(unknown)',
      scriptUrl: '(unknown)',
      line: 0,
      column: 0,
    };
    const nextStack = frame.functionName === '(root)' ? stack : stack.concat(frame);
    traceTreeNodes++;

    nodeByTraceId.set(id, {
      id,
      allocationCount,
      allocationSize,
      frame,
      stack: nextStack.slice(-16),
    });

    if (frame.functionName !== '(root)') {
      let script = byScript.get(frame.scriptUrl);
      if (!script) {
        script = { url: frame.scriptUrl, functionCount: 0, allocationCount: 0, allocationSize: 0, sample: [] };
        byScript.set(frame.scriptUrl, script);
      }
      script.allocationCount += allocationCount;
      script.allocationSize += allocationSize;
      addScriptSample(script, frame);

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
        script.functionCount++;
      }
      func.traceNodeCount++;
      func.allocationCount += allocationCount;
      func.allocationSize += allocationSize;
      addFunctionSample(func, nextStack);
    }

    for (let childOffset = 0; childOffset < children.length; childOffset += stride) {
      visitTraceNode(children, childOffset, nextStack);
    }
  }

  visitTraceNode(root, 0, []);

  return {
    traceTreeNodes,
    nodeByTraceId,
    scripts: [...byScript.values()]
      .sort((left, right) => right.allocationSize - left.allocationSize || right.allocationCount - left.allocationCount)
      .slice(0, 40),
    functions: [...byFunction.values()]
      .sort((left, right) => right.allocationSize - left.allocationSize || right.allocationCount - left.allocationCount)
      .slice(0, 100),
  };
}

function summarizeFunctionInfoScripts(frames) {
  const byScript = new Map();
  for (const frame of frames) {
    let script = byScript.get(frame.scriptUrl);
    if (!script) {
      script = { url: frame.scriptUrl, functionCount: 0, sample: [] };
      byScript.set(frame.scriptUrl, script);
    }
    script.functionCount++;
    addScriptSample(script, frame);
  }
  return [...byScript.values()].sort((left, right) => right.functionCount - left.functionCount).slice(0, 40);
}

function loadTimelineAttribution(file, onProgress) {
  if (onProgress) onProgress(`loading timeline: ${file}`);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const frames = parseFunctionInfos(snapshot);
  const tree = summarizeTraceTree(snapshot, frames);
  const scripts = tree.scripts || summarizeFunctionInfoScripts(frames);

  return {
    file,
    traceFunctionCount: frames.length,
    traceTreeNodes: tree.traceTreeNodes,
    traceTreeComplete: tree.traceTreeNodes > 1,
    scripts,
    functions: tree.functions,
    getTraceNode(traceNodeId) {
      return tree.nodeByTraceId.get(traceNodeId);
    },
  };
}

function allocationForNode(node, timelineAttribution) {
  if (!timelineAttribution) return null;
  const traceNodeId = Number(node.trace_node_id || 0);
  if (!traceNodeId) {
    return {
      confidence: 'none',
      reason: 'heap node has no trace_node_id; use timeline hot functions as allocation candidates',
    };
  }

  const traceNode = timelineAttribution.getTraceNode(traceNodeId);
  if (!traceNode) {
    return { confidence: 'none', reason: `trace_node_id ${traceNodeId} not found in timeline trace_tree` };
  }
  if (!traceNode.stack.length || traceNode.frame.functionName === '(root)') {
    return { confidence: 'none', reason: 'trace_node_id resolves to timeline root, not a business allocation frame' };
  }
  const frame = traceNode.stack[traceNode.stack.length - 1] || traceNode.frame;
  return {
    confidence: 'trace_node_id',
    traceNodeId,
    allocationCount: traceNode.allocationCount,
    allocationSize: traceNode.allocationSize,
    topFrame: frame,
    stack: traceNode.stack.map(stackFrame => ({
      functionName: stackFrame.functionName,
      scriptUrl: stackFrame.scriptUrl,
      line: stackFrame.line,
      column: stackFrame.column,
    })),
  };
}

function buildGrowthFindings(growthScan, config, frameworkRules, timelineAttribution) {
  return growthScan.growing.map(record => ({
    id: record.id,
    type: record.type,
    name: record.name,
    initialSize: record.initialSize,
    finalSize: record.finalSize,
    delta: record.delta,
    history: record.history,
    relationship: relationshipForNode(record.finalNode, config, frameworkRules, timelineAttribution),
  }));
}

function findDuplicateStrings(heap, maxResults = 20) {
  const map = new Map();
  heap.nodes.forEach(node => {
    if (node.type !== 'string' && node.type !== 'concatenated string') return;
    let entry = map.get(node.name);
    if (!entry) {
      entry = { name: node.name, count: 0, totalSize: 0 };
      map.set(node.name, entry);
    }
    entry.count++;
    entry.totalSize += node.self_size || 0;
  });
  return [...map.values()]
    .filter(entry => entry.count > 1)
    .sort((left, right) => right.totalSize - left.totalSize)
    .slice(0, maxResults);
}

function findGlobalVariables(heap, config, frameworkRules) {
  const out = [];
  const seen = new Set();
  heap.nodes.forEach(node => {
    if (!String(node.name || '').startsWith('Window ')) return;
    for (const edge of node.references || []) {
      const target = edge.toNode;
      if (!target) continue;
      if (target.type === 'hidden' || target.type === 'array' || target.type === 'number') continue;
      if (edge.name_or_index === '<symbol>') continue;
      const key = `${edge.name_or_index}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const referrers = meaningfulReferrers(target, 6);
      out.push({
        edge: edge.name_or_index,
        node: nodeSummary(target, frameworkRules),
        business: findBusinessSignal(target, config, frameworkRules),
        hints: diagnoseLeak(referrers, config),
      });
    }
  });
  return out.sort((left, right) => right.node.retainedSize - left.node.retainedSize).slice(0, 30);
}

function analyzeFinalHeap(heap, config, frameworkRules, timelineAttribution) {
  if (!heap) return null;
  return {
    detachedDom: findDetachedDOM(heap, config.report && config.report.maxDetachedDom || 20).map(node => ({
      node: nodeSummary(node, frameworkRules),
      className: extractClass(node.name),
      relationship: relationshipForNode(node, config, frameworkRules, timelineAttribution),
    })),
    topHolders: topHolders(heap, config.report && config.report.maxTopHolders || 20).map(node => ({
      node: nodeSummary(node, frameworkRules),
      relationship: relationshipForNode(node, config, frameworkRules, timelineAttribution),
    })),
    globalVariables: findGlobalVariables(heap, config, frameworkRules),
    duplicateStrings: findDuplicateStrings(heap, config.report && config.report.maxDuplicateStrings || 20),
  };
}

function memlabCapabilities() {
  return [
    { name: 'getFullHeapFromFile', usedFor: 'load heap snapshots, build node graph, dominator tree, retainedSize, referrer index' },
    { name: 'PluginUtils.filterOutLargestObjects', usedFor: 'rank detached DOM nodes and top retained holders' },
    { name: 'PluginUtils.isNodeWorthInspecting', usedFor: 'filter roots and internal nodes from top-holder evidence' },
    { name: 'utils.isDetachedDOMNode', usedFor: 'detect detached DOM nodes with memlab core predicate' },
    { name: 'IHeapNode.retainedSize', usedFor: 'compute monotonic retained-size growth across snapshots' },
    { name: 'IHeapNode.dominatorNode', usedFor: 'show the main owner chain from leaking object to GC roots' },
    { name: 'IHeapNode.referrers/references', usedFor: 'show retainer edges, global variables, and leak mechanism hints' },
    { name: 'IHeapNode.getReferenceNode', usedFor: 'detect Vue/React/custom framework objects through stable property edges' },
    { name: 'timeline trace_tree', usedFor: 'recover allocation stack/function hotspots from .heaptimeline' },
  ];
}

async function runAnalysis(config, options = {}) {
  const onProgress = options.onProgress;
  const frameworkRules = normalizeFrameworks(config);
  const snapshotFiles = config.inputs.snapshots || [];
  let growthScan = { files: snapshotFiles, count: 0, growing: [], finalHeap: null };
  let finalHeap = null;

  if (snapshotFiles.length >= 2) {
    growthScan = await scanGrowth(snapshotFiles, config, onProgress);
    finalHeap = growthScan.finalHeap;
  }

  if (!finalHeap && snapshotFiles.length) {
    finalHeap = await loadHeap(snapshotFiles[snapshotFiles.length - 1], onProgress);
  }

  const timelineAttribution = config.inputs.timeline
    ? loadTimelineAttribution(config.inputs.timeline, onProgress)
    : null;

  const growthFindings = buildGrowthFindings(growthScan, config, frameworkRules, timelineAttribution);
  const heapEvidence = analyzeFinalHeap(finalHeap, config, frameworkRules, timelineAttribution);

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      snapshots: snapshotFiles,
      finalSnapshot: snapshotFiles.length ? snapshotFiles[snapshotFiles.length - 1] : null,
      timeline: config.inputs.timeline || null,
    },
    memlabCapabilities: memlabCapabilities(),
    summary: {
      snapshotCount: snapshotFiles.length,
      sustainedGrowthCount: growthFindings.length,
      finalHeapNodes: finalHeap ? finalHeap.nodes.length : 0,
      timelineTraceFunctions: timelineAttribution ? timelineAttribution.traceFunctionCount : 0,
      timelineTraceTreeNodes: timelineAttribution ? timelineAttribution.traceTreeNodes : 0,
      exactObjectAllocationStacks: growthFindings.filter(finding => finding.relationship.allocation && finding.relationship.allocation.confidence !== 'none').length,
      notes: snapshotFiles.length === 2
        ? ['Only two snapshots were supplied; growth is monotonic but trend confidence is limited. Use 5+ snapshots for stronger evidence.']
        : [],
    },
    growth: {
      files: growthScan.files,
      error: growthScan.error || null,
      findings: growthFindings,
    },
    timeline: timelineAttribution ? {
      traceFunctionCount: timelineAttribution.traceFunctionCount,
      traceTreeNodes: timelineAttribution.traceTreeNodes,
      traceTreeComplete: timelineAttribution.traceTreeComplete,
      functions: timelineAttribution.functions,
      scripts: timelineAttribution.scripts,
    } : null,
    heapEvidence,
  };
}

function formatAllocation(allocation) {
  if (!allocation) return 'no timeline';
  if (allocation.confidence === 'none') return allocation.reason;
  const frame = allocation.topFrame || {};
  return `${frame.functionName || '(unknown)'} ${F.short(frame.scriptUrl || '(unknown)', 48)}:${frame.line || 0}`;
}

function formatConsoleReport(report) {
  console.log('\n========== memory leak report ==========');
  console.log(`snapshots: ${report.summary.snapshotCount}`);
  if (report.inputs.finalSnapshot) console.log(`final snapshot: ${report.inputs.finalSnapshot}`);
  if (report.inputs.timeline) console.log(`timeline: ${report.inputs.timeline}`);
  for (const note of report.summary.notes) console.log(`note: ${note}`);

  console.log('\n-- sustained growth objects --');
  if (report.growth.error) console.log(report.growth.error);
  if (!report.growth.findings.length && !report.growth.error) console.log('no monotonic retained-size growth above threshold');
  for (const finding of report.growth.findings.slice(0, 20)) {
    const business = finding.relationship.business ? finding.relationship.business.key : '(unknown business)';
    console.log(`  @${finding.id} ${F.pad(F.fmt(finding.delta), 10)} growth -> ${F.pad(F.fmt(finding.finalSize), 10)} final  ${finding.type}/${F.short(finding.name, 42)}`);
    console.log(`     business: ${business}`);
    if (finding.relationship.likelyCause.length) console.log(`     cause: ${finding.relationship.likelyCause.join(' | ')}`);
    console.log(`     allocation: ${formatAllocation(finding.relationship.allocation)}`);
  }

  if (report.timeline) {
    console.log('\n-- timeline allocation functions --');
    console.log(`trace functions: ${report.timeline.traceFunctionCount.toLocaleString()} | trace tree nodes: ${report.timeline.traceTreeNodes.toLocaleString()}`);
    for (const func of report.timeline.functions.slice(0, 12)) {
      console.log(`  ${F.pad(F.fmt(func.allocationSize), 10)}  ${F.pad(func.allocationCount, 8)} allocs  ${F.short(func.functionName, 28)}  ${F.short(func.scriptUrl, 58)}:${func.line}`);
    }
    if (!report.timeline.functions.length) {
      for (const script of report.timeline.scripts.slice(0, 12)) {
        console.log(`  ${F.pad(script.functionCount, 6)} fns  ${F.short(script.url, 78)}`);
      }
    }
  }

  if (report.heapEvidence && report.heapEvidence.detachedDom.length) {
    console.log('\n-- detached DOM evidence --');
    for (const item of report.heapEvidence.detachedDom.slice(0, 10)) {
      const business = item.relationship.business ? item.relationship.business.key : '(unknown business)';
      console.log(`  @${item.node.id} ${F.pad(F.fmt(item.node.retainedSize), 10)}  ${business}  ${F.short(item.node.name, 72)}`);
    }
  }

  console.log('\n-- memlab capabilities used --');
  for (const capability of report.memlabCapabilities) console.log(`  ${capability.name}: ${capability.usedFor}`);
}

function writeReport(report, reportsDir) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const outFile = path.join(reportsDir, `report-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  return outFile;
}

module.exports = {
  normalizeInputs,
  runAnalysis,
  formatConsoleReport,
  writeReport,
  loadTimelineAttribution,
  F,
};