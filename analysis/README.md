# SnapshotMemDetector

SnapshotMemDetector 是一个基于 **memlab** 的 V8 heap snapshot / heaptimeline 静态分析器。

它的目标不是猜业务模块，而是把浏览器堆里的原始证据整理成可排查的问题：哪些对象持续增长、谁还在持有它们、它们被哪条对象链保留下来，以及哪些代码栈值得回到源码继续查。

最终报告围绕四类信息展开：

- 真实 V8 对象：`object`、`closure`、`native`、`array` 等；
- 持有关系：`referrers`、retaining path、dominator path；
- 增长趋势：多份 snapshot 中的 `retainedSize` 变化；
- 代码位置：对象级 `trace_node_id` 精确栈，或同次 timeline 的高分配候选栈。

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

默认读取 `../heapdump/`：

- `.heapsnapshot` / `.heapdump`：按文件名排序，作为多份 heap 样本；
- `.heaptimeline`：默认取目录中最后一份 timeline。

也可以显式指定目录：

```powershell
node --max-old-space-size=12288 analyze.js --dir D:\Code\Snapshot\heapdump
```

`--max-old-space-size=12288` 不是算法必须参数，只是给 Node.js 更高内存上限。大型 heap 在加载对象图和计算 dominator tree 时很容易 OOM，所以默认脚本保留这个参数。小文件可以直接运行：

```powershell
node analyze.js
```

## 输入建议

至少准备两份 snapshot：

```text
heapdump/
  01-before.heapsnapshot
  02-after.heapsnapshot
```

更推荐覆盖一次完整操作：

```text
heapdump/
  01-before.heapsnapshot
  02-open-page.heapsnapshot
  03-run-action.heapsnapshot
  04-close-page.heapsnapshot
  05-after-gc.heapsnapshot
  allocation.heaptimeline
```

只有两份 snapshot 时，报告只能证明 before 到 after 的增长；样本越多，持续增长判断越可信。

## 输出

每次运行会在 `analysis/reports/` 生成两份文件：

```text
report-<timestamp>-human.md   # 给人看的原始对象报告
report-<timestamp>-ai.json    # 完整结构化证据
```

如果要把 AI JSON 丢给 AI 继续诊断，使用固定提示词：

```text
analysis/AI_PROMPT.md
```

这个提示词是项目文件，不会在每次运行时重新生成。

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

## 怎么读报告

优先看 `report-<timestamp>-human.md` 里的“需要优先排查的真实对象”。这里展示的是对象簇，不是孤立对象。

一个泄漏通常不是单个对象，而是一串互相持有的对象。例如：

```text
Context --dn--> closure/e --buf--> Map --table--> Array
```

这表示闭包上下文持有 `closure/e`，闭包通过 `buf` 字段持有 `Map`，`Map` 又持有底层 `Array`。如果这条链持续增长，真正要查的通常是 `buf`、`Map` 或相关生命周期清理逻辑。

排查顺序建议：

1. 先看增长大小最大的对象簇。
2. 再看对象链里的容器或生命周期对象，如 `Map`、`Set`、`Array`、`Context`、DOM/native 对象。
3. 用持有路径确认谁还在引用它。
4. 用代码栈中的 `scriptUrl:line:column` 回源码或 sourcemap。

## 整体原理

```text
heap snapshots
  -> memlab heap graph
  -> sustained growth scan
  -> retainer / dominator evidence
  -> related-object clustering
  -> timeline stack attribution
  -> human report + AI JSON
```

这个流程里有两个不同的关系图：

- 对象引用图：来自 `.heapsnapshot`，回答“对象为什么还活着”；
- 函数分配栈：来自 `.heaptimeline`，回答“应该从哪段代码开始查”。

最终结果主要由对象引用图决定。函数分配栈只负责提供源码定位线索，不能单独证明对象为什么没有被 GC。

## 1. memlab 解析出了什么

核心入口是：

```js
getFullHeapFromFile(file)
```

memlab 会把 V8 heap snapshot 的扁平数组解析成可遍历的 `IHeapSnapshot`。本项目主要使用这些字段：

| memlab 产物 | 含义 | 本项目用途 |
|---|---|---|
| `heap.nodes` | V8 heap 全部节点 | 遍历对象，做增长追踪 |
| `node.id` | V8 节点 id | 在同一组 snapshot 中追踪同一个对象 |
| `node.type` | 节点类型，如 `object`、`closure`、`native` | 过滤需要关注的对象类型 |
| `node.name` | 构造器名、函数名、DOM 描述、V8 内部名 | 展示真实对象身份 |
| `node.self_size` | 节点自身大小 | 辅助判断，不作为主要排序依据 |
| `node.retainedSize` | 对象独占保留大小 | 判断增长和影响范围的核心指标 |
| `node.references` | 当前节点指向哪些节点 | 表示对象向外引用了什么 |
| `node.referrers` | 哪些节点指向当前节点 | 找直接持有者和属性边 |
| `node.dominatorNode` | dominator tree 父节点 | 找主持有路径 |
| `node.trace_node_id` | timeline 分配栈 id | 有值时映射到对象级精确栈 |
| `node.location` | 节点可能携带的源码位置 | 普通 snapshot 中经常为空，只作补充 |

项目还使用了 memlab 的辅助能力：

| 能力 | 用途 |
|---|---|
| `utils.isDetachedDOMNode` | 判断 detached DOM 相关对象 |
| `PluginUtils.filterOutLargestObjects` | 从 heap 中按 retained size 找大对象 |
| `PluginUtils.isNodeWorthInspecting` | 找值得人工检查的大 holder |

最重要的是 `retainedSize`。它表示“如果释放这个对象，它独占控制的对象图大约能释放多少”。泄漏对象本身可能很小，但它可能通过引用链保留一个很大的对象子图。

## 2. 怎么通过对象关系找到结果

项目不是先看函数调用，而是先找持续增长的对象。

它按 `node.id` 在多份 snapshot 中追踪对象，只保留：

- 在每份 snapshot 中都存在；
- `type` 和 `name` 没变；
- `retainedSize` 单调不下降；
- 增长量超过阈值，默认 `1024 B`。

当前追踪的类型是：

```text
object, closure, regexp, native, array
```

找到增长对象后，项目会在最后一份 snapshot 中提取三类持有证据：

| 证据 | 回答的问题 |
|---|---|
| `referrers` | 谁直接引用了这个对象？引用边叫什么？ |
| `retainingPaths` | 从这个对象向外走，能看到哪些可读持有路径？ |
| `dominatorPath` | 哪些对象在 dominator tree 上主导保留它？ |

然后项目用 Union-Find 合并相关对象。只要两个增长对象之间存在直接 referrer 边、出现在同一条 retaining path、或出现在同一条 dominator path 中，就把它们合成一个对象簇。

这样做的原因是：真实泄漏通常是一串对象链，而不是单点对象。人类报告优先展示对象簇，可以减少重复信息，让排查目标更接近“该清理哪条引用链”。

## 3. memlab 本身怎么寻找

memlab 本身并不直接判断业务泄漏。它做的是底层 heap graph 建模。

V8 heap snapshot 原始数据接近这种结构：

```text
nodes array
edges array
strings table
snapshot metadata
trace metadata
```

memlab 会把这些扁平数组还原成对象图：

```text
raw snapshot arrays
  -> IHeapNode
  -> node.references
  -> node.referrers
  -> dominator tree
  -> retainedSize
```

引用图回答的是：

- A 是否直接引用 B；
- A 通过哪个属性或边引用 B；
- 谁还在引用 B。

Dominator tree 回答的是：

- 如果释放 A，哪些对象只能跟着 A 一起释放；
- A 是否主导保留某批对象；
- A 的 `retainedSize` 大概有多大。

可以把 dominator 理解成“所有通往某对象的路径都必须经过的节点”。例如：

```text
GC Root
  -> Window
    -> App
      -> Cache
        -> BigArray
```

如果从 GC Root 到 `BigArray` 的所有路径都必须经过 `Cache`，那么 `Cache` dominate `BigArray`。释放 `Cache` 时，`BigArray` 也会变得可释放，所以 `Cache.retainedSize` 会体现这部分影响。

因此 memlab 提供的是对象图、反向引用、dominator 和 retained size。本项目再基于这些底层证据做跨 snapshot 增长判断和对象簇归并。

## 4. 函数关系的具体原理

函数关系来自 `.heaptimeline`，不是 `.heapsnapshot`。

`.heaptimeline` 里有两块关键数据：

| 数据 | 含义 |
|---|---|
| `trace_function_infos` | 函数表，包含函数名、脚本 URL、行、列 |
| `trace_tree` | 分配调用树，包含 trace node id、函数索引、分配次数、分配大小和子节点 |

项目会先把 `trace_function_infos` 解析成函数帧：

```js
{
  functionName,
  scriptUrl,
  line,
  column,
}
```

然后递归遍历 `trace_tree`。每走到一个节点，就把当前函数帧追加到调用栈里，形成连续的 allocation stack：

```text
run (...index.js:13:1473)
  -> (anonymous) (...index.js:13:9357)
    -> $g (...index.js:30:117947)
      -> t (...index.js:30:115492)
        -> value (...index.js:30:110855)
```

同时项目会统计：

- 每个函数下累计分配了多少字节；
- 每个函数下发生了多少次分配；
- 每个脚本文件的累计分配量；
- 每个 trace node 对应的连续调用栈。

报告里的栈有两种置信度：

| 栈类型 | 含义 | 可信度 |
|---|---|---|
| 精确对象栈 | heap node 有 `trace_node_id`，且能在 `trace_tree` 中找到 | 高 |
| 候选调用栈 | snapshot 没有对象级 `trace_node_id`，展示同次 timeline 中分配最多的连续栈 | 中 |

关键区别是：对象引用图证明“为什么活着”，函数分配栈说明“可能从哪里创建”。如果只有候选调用栈，它只能提示优先排查位置，不能单独证明某个对象一定由这条栈创建。

如果生产代码被压缩或去符号，函数名可能只是 `t`、`e`、`value`。此时最可靠的定位锚点是：

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

## 已知限制

- 普通 `.heapsnapshot` 往往没有 `trace_node_id`，多数对象只能给候选调用栈，不能给精确创建栈。
- 只有两份 snapshot 时，只能证明 before 到 after 增长；建议使用 4 份以上覆盖一次完整操作。
- 生产代码压缩后，函数名可能不可读，需要 sourcemap 才能从 `scriptUrl:line:column` 回到源码。
- V8 node id 在同一组 snapshot 中通常可用于追踪，但跨不同录制批次不应混用。