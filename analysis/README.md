# V8 Heap/TIMELINE 内存泄露分析器

这是一个基于 **memlab** 的静态分析工具。它面向前端项目的 `.heapsnapshot` / `.heapdump` / `.heaptimeline` 文件，不启动浏览器，不抓取页面，直接从已有文件里生成业务可读的内存泄露报告。

项目现在刻意保持很小：核心代码只在一份文件里。

```text
analysis/
  analyze.js        # CLI 入口，只负责解析参数、运行、写 reports/*.json
  config.js         # 业务配置，通常唯一需要改的文件
  lib/analyzer.js   # 全部分析逻辑：增长检测、关系链、框架/业务识别、timeline 栈解析、报告格式
```

## 安装

Node >= 18。

```powershell
cd analysis
npm install
```

依赖只有 `@memlab/api`。本项目复用 memlab 的静态 heap graph 能力，不使用浏览器自动化。

## 怎么跑

推荐给 2 份以上 snapshot；2 份只能证明“从 A 到 B 变大”，5 份以上更适合判断趋势。

```powershell
# 多份 snapshot 直接传入，最后一份作为 final heap 做关系链分析
node --max-old-space-size=12288 analyze.js before.heapsnapshot after.heapsnapshot run.heaptimeline

# 或者把多份 snapshot/heapdump 放一个目录，文件名排序就是时间顺序
node --max-old-space-size=12288 analyze.js --dir D:\Code\Snapshot D:\Code\Snapshot\Heap-20260702T020808.heaptimeline
```

`--max-old-space-size=12288` 建议保留。memlab 加载大型 snapshot 并计算 dominator tree 时峰值内存会比较高。

## 核心逻辑

1. **输入多份 heap 文件**
   - 支持 `.heapsnapshot` 和 `.heapdump`。
   - 如果使用 `--dir`，按文件名排序作为时间线。
   - 最后一份 heap 是 `finalSnapshot`，用于对象关系、DOM、global、字符串等证据分析。

2. **找持续增长对象**
   - 对每个 snapshot 调用 memlab 的 `getFullHeapFromFile`。
   - 按 V8 node id 追踪 `object` / `closure` / `regexp` / `native` / `array`。
   - 只保留每一份 snapshot 都存在、类型和名字一致、`retainedSize` 单调不下降、最终 delta 大于 `config.unboundGrowth.thresholdBytes` 的对象。
   - 输出按 `delta` 从大到小排序。

3. **用 memlab 做对象关系**
   - 对每个增长对象，在 final heap 上提取：
     - `dominatorNode` 链：谁在主持有这个对象。
     - `referrers`：哪些边在引用它，边名常对应业务变量名。
     - `retainedSize` / `self_size`：对象自身与独占保留大小。
     - `getReferenceNode`：通过稳定属性边识别 Vue/React/自研框架实例。
   - 额外用 memlab 的 `utils.isDetachedDOMNode` 和 `PluginUtils.filterOutLargestObjects` 输出 detached DOM 证据。

4. **去 timeline 里找堆栈结构**
   - 解析 `.heaptimeline` 的 `trace_function_infos` 和递归 `trace_tree`。
   - 输出 allocation 热点函数：`functionName`、`scriptUrl`、`line`、`column`、`allocationSize`、`allocationCount`、`sampleStack`。
   - 如果 heap node 自身带 `trace_node_id`，报告会给对象级精确栈。
   - 如果普通 `.heapsnapshot` 没有 `trace_node_id`，工具不会假装精确；增长对象里会写明原因，并把 `timeline.functions` 作为业务函数候选热点。

## 报告输出

运行后会同时打印控制台摘要，并写入：

```text
analysis/reports/report-<timestamp>.json
```

报告结构：

```js
{
  generatedAt,
  inputs: {
    snapshots,       // 输入 heap 文件列表
    finalSnapshot,   // 用于关系链分析的最后一份 heap
    timeline,
  },
  memlabCapabilities, // 本次复用的 memlab 能力清单
  summary: {
    snapshotCount,
    sustainedGrowthCount,
    finalHeapNodes,
    timelineTraceFunctions,
    timelineTraceTreeNodes,
    exactObjectAllocationStacks,
    notes,
  },
  growth: {
    findings: [
      {
        id,
        type,
        name,
        initialSize,
        finalSize,
        delta,
        history,
        relationship: {
          business,        // DOM class / 框架实例 / retainer edge 推断出的业务归属
          frameworkOwner,  // Vue/React/自研框架实例
          likelyCause,     // observer/event/global property 等泄漏机制提示
          allocation,      // 对象级栈，或说明为什么只能看 timeline 热点
          dominatorChain,
          referrers,
        },
      }
    ]
  },
  timeline: {
    functions, // allocation 热点函数，按 allocationSize 排序
    scripts,
  },
  heapEvidence: {
    detachedDom,
    topHolders,
    globalVariables,
    duplicateStrings,
  }
}
```

最终你主要看两块：

- `growth.findings`：真正跨 snapshot 持续增长的对象，以及它们的持有链、业务归属、可能泄漏机制。
- `timeline.functions`：本次录制期间分配最多的业务函数/脚本。若增长对象没有 `trace_node_id`，这里是定位业务处理函数的候选入口。

## 配置

只改 `config.js`。

```js
module.exports = {
  inputs: {
    snapshots: [],
    snapshotsDir: null,
    timeline: null,
  },

  business: {
    classPrefixes: { 'bpx-': 'player', 'bili-': 'bilibili' },
    classKeyExtractors: [/(bili-[\w-]+)/i, /(bpx-[\w-]+)/i],
    edgeSemantics: {
      // mainThumbWrap: '播放器进度条 thumb 容器'
    },
  },

  frameworks: ['vue2', 'vue3', 'react'],
  customFrameworks: [],

  leakMechanisms: [
    { match: /IntersectionObserv|ResizeObserv|MutationObserv|PerformanceObserv/, hint: 'observer not disconnected' },
    { match: /EventTargetData|RegisteredEventListener|EventListenerMap/, hint: 'event listener not removed' },
  ],

  unboundGrowth: { minSnapshots: 2, thresholdBytes: 1024, maxResults: 50 },
};
```

## 通用框架支持

内置 Vue 2、Vue 3、React 的识别规则，都是通过 heap 里的稳定属性边识别，不依赖源码变量名：

- Vue 2：`_isVue`、`$options.name`、`__file` 等。
- Vue 3：`vnode`、`subTree`、`setupState`、`type.__name` 等。
- React：Fiber 上的 `memoizedState`、`return`、`child`、`type.displayName` 等。

自研框架不要再新建文件，直接在 `config.js` 里写 inline rule：

```js
customFrameworks: [{
  name: 'myfw',
  detect: (node, H) => H.hasRef(node, '_myFrameworkTag'),
  nameFrom: (node, H) => H.pickStr(node.getReferenceNode('$options'), ['name', '__file']),
}],
```

`H` 提供 `hasRef` / `readStr` / `pickStr`，避免你在配置里直接依赖 memlab 内部对象。

## 用到了 memlab 哪些能力

| memlab 能力 | 本项目用途 |
|---|---|
| `getFullHeapFromFile(file)` | 加载 snapshot，构建 heap graph、dominator tree、retainedSize、referrer index |
| `PluginUtils.filterOutLargestObjects` | 按 retainedSize 取 detached DOM / top holders |
| `PluginUtils.isNodeWorthInspecting` | 过滤 root、内部节点，减少噪声 |
| `utils.isDetachedDOMNode` | 判断 detached DOM |
| `IHeapNode.retainedSize` | 判断跨 snapshot 的保留大小增长 |
| `IHeapNode.dominatorNode` | 输出主持有链 |
| `IHeapNode.referrers` / `references` | 输出 retainer 边、全局变量、泄漏机制提示 |
| `IHeapNode.getReferenceNode(name)` | 通过属性边识别 Vue/React/自研框架 |

## 录制建议

- snapshot：复现前 GC 一次，抓 baseline；重复操作 N 次，GC，再抓 after。趋势分析建议 5+ 份。
- timeline：DevTools Memory 里选择 **Allocation instrumentation on timeline**，操作时保持录制，这样 `trace_tree` 才能恢复函数级分配栈。
- SourceMap：如果生产 JS 被压缩，报告只能显示压缩后的函数名、脚本 URL、行列。要回到源码函数，需要后续接入 SourceMap 映射。

## 已知限制

- 普通 `.heapsnapshot` 往往没有 `trace_node_id`，无法把“某个 retained object”百分百映射到 timeline 的某个业务函数。此时报告会给对象关系链 + timeline 热点函数候选。
- 只有两份 snapshot 时，`growth.findings` 是两点差异，不是强趋势。建议用 5 份以上覆盖一次完整业务操作。
- 生产环境 minify 后，构造器名常是 `t` / `e` / `Object`。业务归属主要靠 DOM class、retainer 边名、框架实例属性和 timeline 脚本位置叠加判断。