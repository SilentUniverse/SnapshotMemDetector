# SnapshotMemDetector

SnapshotMemDetector 是一个基于 **memlab** 的 V8 heap snapshot / heaptimeline 静态分析器。

- 哪些真实 V8 对象持续增长；
- 这些对象之间如何互相持有；
- 对象为什么还活着，也就是 retainer / dominator 证据；
- 能回到代码的连续调用栈，优先用对象级 `trace_node_id`，没有时用同次 timeline 的高分配候选栈。

## 目录结构

```text
heapdump/
  before.heapsnapshot
  after.heapsnapshot
  run.heaptimeline

analysis/
  analyze.js
  AI_PROMPT.md
  lib/raw-analyzer.js
  reports/
```

所有待分析文件都放在仓库根目录的 `heapdump/` 下。`heapdump/` 已在 `.gitignore` 中，不会提交大文件。

## 运行

```powershell
cd analysis
npm install
npm run analyze
```

默认会读取 `../heapdump/`：

- `.heapsnapshot` / `.heapdump`：按文件名排序，作为多份 heap 样本。
- `.heaptimeline`：默认取目录中最后一份 timeline。

也可以显式指定目录：

```powershell
node --max-old-space-size=12288 analyze.js --dir D:\Code\Snapshot\heapdump
```

建议保留 `--max-old-space-size=12288`。大型 heap 加载和 dominator tree 计算会占用较多内存。

## 输出

每次运行会在 `analysis/reports/` 生成两份文件：

```text
report-<timestamp>-human.md   # 给人看的原始对象报告
report-<timestamp>-ai.json    # 完整结构化证据
```

把 AI JSON 丢给 AI 继续诊断时，直接使用固定提示词：`analysis/AI_PROMPT.md`。这个文件不会在每次运行时重新生成。

命令行也会打印摘要，格式类似：

```text
========== 原始对象内存报告 ==========
持续增长对象: 588（报告展示 80）
对象簇: 8

-- 需要优先排查的真实对象 --

排查: 优先检查这条持有链里的 Map/Set/Array 缓冲，确认业务结束后 delete/clear。
对象链: Context --dn--> closure/e --buf--> Map --table--> Array
大小: +321.3 KB，最大保留 207.1 KB，对象 id: ...
持有路径: previous <- Context <- context <- closure
代码栈: 候选调用栈，4.82 MB / 239116 次分配
```

## 整体原理

```text
heapdump files
  -> memlab heap graph
  -> sustained growth scan
  -> raw retainer/dominator evidence
  -> related-object clustering
  -> timeline stack attribution
  -> human report + AI JSON
```

### 1. memlab 解析 heap

核心入口是：

```js
getFullHeapFromFile(file)
```

memlab 返回 `IHeapSnapshot`，里面已经包含：

| memlab 产物 | 含义 | 本项目用途 |
|---|---|---|
| `heap.nodes` | V8 heap 全部节点 | 遍历对象，做增长追踪 |
| `node.id` | V8 节点 id | 多份 snapshot 之间追踪同一个对象 |
| `node.type` | 节点类型，如 `object`、`closure`、`native` | 过滤可能持有业务状态的节点 |
| `node.name` | 构造器名、函数名、DOM 描述、V8 内部名 | 展示真实对象身份 |
| `node.self_size` | 节点自身大小 | 辅助信息 |
| `node.retainedSize` | 对象独占保留大小 | 判断增长和排序的核心指标 |
| `node.dominatorNode` | dominator tree 父节点 | 构造主持有链 |
| `node.references` | 当前节点指向哪些节点 | 后续扩展用 |
| `node.referrers` | 哪些节点指向当前节点 | 找直接持有者和属性边 |
| `node.trace_node_id` | timeline 分配栈 id | 有值时可映射到对象级精确栈 |
| `utils.isDetachedDOMNode` | memlab detached DOM 判定 | 输出 DOM 泄漏辅助证据 |
| `PluginUtils.filterOutLargestObjects` | 按 retainedSize 取 Top N | 找最大 detached DOM / holder |

最重要的是 `retainedSize`。它表示“如果释放这个对象，它独占控制的对象图大约能释放多少”，比 `self_size` 更适合判断泄漏影响。

### 2. 找持续增长对象

工具按 V8 node id 追踪对象，只保留：

- 在每份 snapshot 中都存在；
- `type` 和 `name` 没变；
- `retainedSize` 单调不下降；
- 增长量超过阈值，默认 `1024 B`。

被追踪的类型：

```js
object, closure, regexp, native, array
```

这些类型最容易代表 JS 状态、闭包上下文、DOM/native 对象和容器结构。

### 3. 合并相关对象

单个泄漏通常不是一个对象，而是一串对象链。例如：

```text
system / Context / scope @1750315 --dn--> closure/e --buf--> Map --table--> Array
```

这说明：

- 一个闭包上下文保留了 `closure/e`；
- `closure/e` 通过 `buf` 属性持有 `Map`；
- `Map` 通过 `table` 持有底层数组；
- 这几个对象一起增长，应该作为一个排查点看。

工具会用增长对象之间的直接 referrer 边、retaining path、dominator path 做 union，把互相持有或相邻的增长对象合并成“对象簇”。人类报告优先展示对象簇，而不是展示一堆重复对象。

### 4. 提取持有证据

每个增长对象会记录：

- `dominatorPath`：主持有路径，回答“谁主导保留它”；
- `referrers`：直接引用它的对象和属性边；
- `retainingPaths`：从对象向外走 referrer 得到的可读持有路径；
- `exactStack`：如果对象有 `trace_node_id`，映射到 timeline 中的精确对象栈。

报告里的“持有路径”来自 `referrers`，例如：

```text
previous <- object/system / Context / scope @1785313 <- context <- closure/(anonymous)
```

这比业务翻译更底层，也更通用：即使代码去符号，属性边和 V8 对象关系仍然可用。

### 5. 映射到代码栈

`.heaptimeline` 里有两类关键数据：

- `trace_function_infos`：函数名、脚本 URL、行、列；
- `trace_tree`：递归 allocation 调用树，每个节点有 `count` 和 `size`。

工具会把 `trace_tree` 展成连续调用栈：

```text
run (...index.js:13:1473)
  -> (anonymous) (...index.js:13:9357)
    -> $g (...index.js:30:117947)
      -> t (...index.js:30:115492)
        -> value (...index.js:30:110855)
```

栈分两种置信度：

- **精确对象栈**：heap node 有 `trace_node_id`，并且能在 timeline 的 `trace_tree` 里找到；
- **候选调用栈**：普通 snapshot 没有对象级 `trace_node_id`，只能展示同次 timeline 中分配最多的连续栈，作为回源码的候选位置。

如果代码被压缩或去符号，函数名可能只是 `t`、`e`、`value`。此时最可靠的定位锚点是：

```text
scriptUrl:line:column
```

后续需要配合 sourcemap 回到源码。

## AI JSON 结构

`report-*-ai.json` 保留完整原始证据：

```js
{
  inputs: {
    heapdumpDir,
    snapshots,
    finalSnapshot,
    timeline,
  },
  summary: {
    snapshotCount,
    sustainedGrowthCount,
    reportedGrowthCount,
    objectClusterCount,
    timelineTraceTreeNodes,
    exactObjectStacks,
  },
  objectClusters: [{
    title,
    chain,
    objectIds,
    totalDelta,
    maxFinalSize,
    objects,
    retainingPaths,
    recommendation,
    stack,
  }],
  growthFindings: [{
    id,
    type,
    name,
    initialSize,
    finalSize,
    delta,
    history,
    relationship: {
      rawObject,
      dominatorPath,
      referrers,
      retainingPaths,
      exactStack,
    }
  }],
  timeline: {
    topStacks,
    topFunctions,
    topScripts,
  },
  heapEvidence: {
    detachedDom,
    topHolders,
  }
}
```

最常看的字段：

- `objectClusters`：人类报告的核心，已经把相关增长对象合并；
- `growthFindings`：单个对象的完整证据；
- `relationship.referrers`：谁直接持有这个对象；
- `relationship.retainingPaths`：对象为什么还活着；
- `stack.frames`：连续调用栈和代码位置。


这样对任何前端框架都通用, React、Vue、自研框架、普通 JS 对象都会以同一种形式出现在报告里：真实对象 + 持有链 + 可回源码的栈。

## 已知限制

- 普通 `.heapsnapshot` 往往没有 `trace_node_id`，多数对象只能给候选调用栈，不能给精确创建栈。
- 只有两份 snapshot 时，只能证明 before 到 after 增长；建议使用 4 份以上覆盖一次完整业务操作。
- 生产代码压缩后，函数名可能不可读，需要 sourcemap 才能从 `scriptUrl:line:column` 回到源码。
- V8 node id 在同一组 snapshot 中通常可用于追踪，但跨不同录制批次不应混用。