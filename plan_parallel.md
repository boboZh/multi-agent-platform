# 并行能力：Fork / Join（Assign 拆为独立阶段）

本文是实现计划，**不含业务代码**。

目标：在现有 Workflow Document（`schemaVersion: 1`）和 LangGraph `StateGraph` 上补齐 **画布级静态并行**。用户可以给任意 Fork 配置 **N 条 lane（N≥2）**，运行时这些 lane **同时执行**，在配对的 Join 上 **全部到齐后再往下走**。一张图里可以有 **多段** 并行区，中间穿插串行 Agent、条件、人审、环。

「竞品分析报告」（多路调研 + 交叉质检 + 人审）只是 **验收样例**，用来证明能力够用。DSL、校验、编译器、画布 **不得** 为某个业务写死 lane 数或 lane 名。

版本基线：`@langchain/langgraph@0.2.74`（本文所有运行时结论均针对该版本的实际实现，见 §2）。

---

## 0. 交付的能力

编辑器里用户能做到：

1. 拖一个 **Fork**，像 Condition 增删分支一样 **增删 lane**（默认 2 条）。
2. 从每个 lane 端口拉线，接到 Agent / Tool，或一条串行链的第一个节点。
3. 各条链最终连到同一个 Join；Join 之后接任意现有节点（Agent、Condition、人审、下一个 Fork、End）。
   - 「Join 之后接下一个 Fork」是 **串联**，不是嵌套：第二个 Fork 落在第一个 Join **之后**，两个区域首尾相接、互不重叠。
   - **嵌套** 指第二个 Fork 落在某条 lane **内部**（夹在 ForkA 与 JoinA 之间），本期禁止，见 §7.2 第 3 条。
   - 判断标准：沿任一 lane 从 Fork 走到它配对的 Join，路上再遇到 Fork 就是嵌套。
4. 运行时：Fork 之后 N 路并行；**Join 在 N 路全部** `node_end` **之前不得执行，且只执行一次**（含各 lane 长度不等的情况）。
5. 并行路各写不同 `vars[outputKey]`；Join 之后用现有 `inputMap` 读任意子集。
6. 旧图（无 fork/join）行为不变。

能力边界：**N 在画布上固定，编译期就知道有几条边。** 不是运行时读 `vars.files.length` 再复制子图（那是 Map/`Send`，见 §11）。

可拼出的模式（都不需要新 kind）：

| 模式                       | 拼法                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| 两路同时检索再汇总         | Fork(2) → 两 Agent → Join → Agent                                |
| N 路专家调研 + 主笔        | Fork(N) → … → Join → Agent                                       |
| 串行中插两段并行           | `Fork(3)…Join → Agent → Fork(2)…Join`（段内 N 路并行，段间串行） |
| 并行后互斥路由             | Join → Condition → 不同后续                                      |
| 并行后打回重做（环在区外） | Join → Condition → 区外某串行节点                                |
| 并行后人审会签             | Join → human_review → Condition → …                              |
| 交叉质检                   | Join 后主笔 → 再 Fork，各 lane 的 `inputMap` 只注入需要的 vars   |

表格里 `Fork(N)…Join` 是**整个并行区的缩写**，把 lane 折叠掉了。「串行中插两段并行」展开后是：

```
Start
  → ForkA ─┬→ Agent 市场 ─┐
           ├→ Agent 产品 ─┼→ JoinA        ← 三路同一 superstep 并行
           └→ Agent 风险 ─┘
  → Agent 主笔                             ← 串行一段
  → ForkB ─┬→ Agent 事实核查 ─┐
           └→ Agent 逻辑审   ─┴→ JoinB     ← 两路并行
  → End
```

对比 **嵌套**（本期禁止）——第二个 Fork 在 ForkA 与 JoinA 之间：

```
ForkA ─┬→ ForkB ─┬→ b1 ─┐
       │         └→ b2 ─┴→ JoinB ─┐
       └→ a2 ────────────────────┴→ JoinA
```

---

## 1. 现状缺口

| 层     | 现状                                                                          | 缺什么                                          |
| ------ | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| 运行时 | `compile.ts` 逐条边 `addEdge`。多条普通出边 = 下游并行。                      | **正确的 fan-in**（见 §2）、恒等 Fork/Join。    |
| 画布   | `connect()` 按 `(source, handle)` 只留一条出边；非 Condition 只有匿名单出口。 | Fork 多个 named 出口；Join 多入边不被清掉。     |
| 端口   | `NODE_PORT_SPEC` 里 `targets: 0 \| 1`、`sources: 0 \| 1 \| "branches"`。      | `sources: "lanes"`、Join 的 `targets: "many"`。 |
| 节点   | Condition = XOR。                                                             | AND 扇出 / 汇合。                               |
| State  | `vars` 浅合并；`lastAgentText` 覆盖；`messages` 追加。                        | 写冲突校验；并行 Agent 的写回策略（见 §8.1）。  |
| 监控   | runner 用**单个** `currentNodeId` 归属 token/tool/error。                     | 按事件 metadata 归属节点（见 §9）。             |

关于端口表里的 `0`：它是**端口数量**，不是「第 0 号端口」。`start: { targets: 0 }` 表示顶部不渲染输入点，`end: { sources: 0 }` 表示底部不渲染输出点。

**注意一个已有的坑**：`1` 只描述「渲染一个 handle」，**并不限制这个 handle 上能接几条边**。现有校验只处理了 `0` 的情况（`spec.targets === 0 && ins.length > 0`），所以任何 Agent 现在都能接多条入边——环和人审驳回正是靠这个。因此：

- 给 Join 加 `targets: "many"` 主要是表达意图与驱动 UI，真正的行为差别在编译器怎么连边（§8）。
- 「region 内除 Join 外不许扇入」必须**新写校验**（§7.2 第 5 条），改端口表不会自动生效。

---

## 2. 运行时前提：LangGraph 的 fan-in 语义（本计划的核心）

**必须先记住这一节，否则实现出来的 Join 是错的。**

### 2.0 前置模型：LangGraph 不是「沿着边走」

它是 Pregel 模型，**一轮一轮**（superstep）执行：

1. 图里有一批 **channel**：可以理解成带版本号的信箱。
2. 每个节点订阅若干 channel，这个订阅列表叫 **triggers**。
3. 节点执行完会往某些 channel 写值，这个动作叫 **writer**。
4. 每轮结束后引擎扫一遍：**凡是「订阅的 channel 有新版本」的节点，下一轮一起执行**。同一轮里的节点就是并行的。

关键点：**边在运行时并不存在**。`addEdge(a, b)` 只在编译期做两件事——给 a 装一个 writer（跑完往某个 channel 写），并把那个 channel 加进 b 的 triggers。所以「怎么连边」直接决定「什么时候放行」。

### 2.1 两种 `attachEdge`

`CompiledStateGraph.attachEdge`（`node_modules/@langchain/langgraph/dist/graph/state.js`）按 `start` 是字符串还是数组，走完全不同的分支：

| 调用形式                    | 通道                                  | 类型                | 语义                                       |
| --------------------------- | ------------------------------------- | ------------------- | ------------------------------------------ |
| `addEdge("a", "c")`（现状） | `branch:to:c`，**所有上游共写同一个** | `LastValue`         | **OR**：任一上游写入即 bump 版本，c 被触发 |
| `addEdge(["a","b"], "c")`   | `join:a+b:c`                          | `NamedBarrierValue` | **AND**：等 `names` 全部报到才放行         |

`NamedBarrierValue` 内部两个集合：

- **`names`**：要等的节点名单，**编译期固定**（就是数组里那几个）。
- **`seen`**：目前已经报到过的节点，**运行期累积**，并随 checkpoint 持久化（`checkpoint()` 返回 `[...seen]`）。

放行条件就是 `seen` 等于 `names`，否则 `get()` 抛 `EmptyChannelError`。抛错为什么等于「不放行」——因为引擎挑下一轮任务时会读每个 trigger，**读不出来的直接从 trigger 列表里过滤掉**（`dist/pregel/algo.js` 的 `_prepareSingleTask`）：过滤后 `triggers.length === 0` 就不给这个节点建任务。等最后一个上游写进 `seen`，它才被调度**一次**。

比方：屏障是挂在 Join 门口的一张点名表。`names` 是名单，`seen` 是已到的人；人没齐门不开，齐了开一次门。

**一个必须知道的细节**：`triggers.length > 0` 说明 **多个 trigger 之间仍是 OR**，屏障的 AND 只在**同一个 channel 内部**生效。所以只要 Join 还有别的边写进来（比如某个 condition 分支直连 Join），它就会被那条边单独触发，屏障等于白做。这正是 §7.2 第 2 条要拦的东西。

### 2.2 逐条 `addEdge` 做 Join 会错在哪

举例 laneA=[a]、laneB=[b1,b2]：

| superstep | 执行                            |
| --------- | ------------------------------- |
| 1         | fork                            |
| 2         | a、b1                           |
| 3         | **join（只拿到 a 的结果）**、b2 |
| 4         | **join 第二次**                 |

主笔（join 的下游）会先拿着一路结果跑一遍，然后再跑一遍。**等长 lane 碰巧正确，会掩盖问题**——所以 §13.1 必须有不等长 lane 的用例。

### 2.3 由此得出的三条硬约束

**约束 1：Join 的编译必须一次性 `addEdge(predecessors, joinId)`**，`predecessors` = 该 Join 的全部直接前驱节点。

现状是逐条连（`lib/workflow-dsl/compile.ts`）：

```ts
for (const edge of doc.edges) {
  if (edge.data.kind !== "normal") continue;
  builder.addEdge(
    graphSourceId(edge.source, doc.startNodeId),
    graphTargetId(edge.target, ends)
  );
}
```

要改成「目标是 Join 的边先按 Join 攒起来，最后一次性连」。示意实现：

```ts
const joinIds = new Set(
  doc.nodes.filter((n) => n.data.kind === "join").map((n) => n.id)
);

// 目标是 Join 的边不逐条连，先按 Join 收集直接前驱
const predecessorsByJoin = new Map<string, Set<string>>();

for (const edge of doc.edges) {
  if (edge.data.kind === "branch") continue; // 条件边仍走 addConditionalEdges

  const source = graphSourceId(edge.source, doc.startNodeId);
  const target = graphTargetId(edge.target, ends);

  // lane 边与普通边在编译上没区别，都是 addEdge；差别只在校验层
  if (typeof target === "string" && joinIds.has(target)) {
    if (source === START) throw new Error("Start 不能直连 Join"); // 校验层已拦，这里兜底
    const set = predecessorsByJoin.get(target) ?? new Set<string>();
    set.add(source); // Set 顺带去重：同一前驱两条边只算一次
    predecessorsByJoin.set(target, set);
    continue;
  }

  builder.addEdge(source, target);
}

for (const [joinId, predecessors] of predecessorsByJoin) {
  // 必须排序，理由见约束 3
  builder.addEdge([...predecessors].sort(), joinId);
}
```

`GraphBuilder` 那个宽松类型的 `addEdge` 签名要同时接受 `string` 与 `string[]`。

**约束 2：屏障只能挂在 Join 上。** 普通节点的多入边（环、条件回流、人审驳回）**必须**保持 OR，否则该节点永远不会被调度。

以修订环为例，主笔有两条入边——一条来自 JoinA，一条来自条件节点的 `revise` 分支：

```
JoinA ────────────────→ 主笔 → ForkB…JoinB → Condition
                          ↑                      │ revise
                          └──────────────────────┘
```

若把这两条入边编译成一个屏障，`names = {JoinA, Condition}`：

1. 第 1 轮走到 JoinA，写入 → `seen = {JoinA}`
2. `seen ≠ names`（还差 Condition）→ 主笔**不被调度**
3. 而 Condition 在主笔**下游**，主笔不跑它永远不会跑 → 永远写不进 `seen`

引擎发现这一轮没有任何可调度任务，图就**停在这里**。表现不是卡住转圈，而是这次 run 直接变成 `completed`、主笔从未执行、输出为空——比报错更难查。

换成 OR（现状）就正常：JoinA 写一次触发一次主笔；后面 Condition 打回时再写一次，再触发一次。

**结论：并行汇合要 AND，环与分支回流要 OR，两者不能用同一套连边方式。** 这也是「必须有显式 Join 节点」而不能靠「N 路都连到下一个业务节点」的根本原因——那个业务节点身上没法既当屏障又当环的入口。

**约束 3：`predecessors` 数组必须按节点 id 排序。** 通道名是 `join:${start.join("+")}:${end}`，而每次 run / resume / retry 都会重新编译发布快照（`runner.ts` 的 `compilePublished`）。若数组顺序随 `doc.edges` 遍历顺序变化，resume 时算出的通道名与 checkpoint 里存的不一致，屏障状态会变成孤儿，导致卡死或重复触发。排序 + 单测锁死。

### 2.4 屏障用完会自动重置（多轮循环无需额外处理）

疑问：屏障齐过一次之后 `seen` 是满的，第二次进这个并行区会怎样？答案是 LangGraph 自己清了。

节点被调度后，引擎会把它读过的 channel 逐个 `consume()`（`dist/pregel/algo.js`），而 `NamedBarrierValue.consume()` 就是「点名齐了就擦掉签到表」：`seen` 清空、通道版本 bump。

完整生命周期：

1. N 路陆续写入 → `seen` 逐渐填满
2. 齐了 → Join 被调度，执行一次
3. `consume()` 清空 `seen`，屏障回到初始状态
4. 区外的环把流程带回这个 Fork → N 路重新跑、重新写入 → 屏障再次填满 → Join 再执行一次

所以**多轮修订循环天然可用**，我们不用在 Join 节点里写任何重置逻辑。

### 2.5 附带限制

- 数组形式里 **不能出现** `START`（`state.js` 抛 `Need to add a node named "__start__" first`）→ 校验必须禁止 Start 直连 Join。
- 数组形式的 `endKey` 不能是 `END` → Join 本身不能是 end 节点（天然满足）。
- `addEdge` 要求节点已注册。现有 `compile.ts` 先 `addNode` 再连边，顺序已正确。

---

## 3. 设计原则

1. **Fork = AND 扇出，Condition = XOR 路由。** 都是 named handle；Fork 每条 lane 都 `addEdge`，Condition 走 `addConditionalEdges`。
2. **Join 是显式汇合点，且是唯一允许挂屏障的节点。** 「屏障」指 §2.1 那个 `NamedBarrierValue` 通道实例（名字形如 `join:n_a+n_b+n_c:n_join`）；「只挂在 Join 上」= 只有 Join 的入边会被编译成数组形式的 `addEdge`，其余节点的多入边一律逐条连（OR）。
3. **Lane 数是 Fork 的配置，不是平台常量。** schema 只约束 `2 ≤ lanes.length ≤ 16`、key 合法且不重复，不预置业务 key。
4. **一张图可有多个 Fork–Join 对，可前后串联，第一期不嵌套**（区别见 §0 第 3 条）。
5. **并行结果只认** `vars`**。** 同一 superstep 内多个节点对 `lastAgentText` / `messages` 的写入顺序**是确定的**（引擎按任务路径 `[PULL, 节点名]` 排序应用写入，见 `dist/pregel/algo.js` 的 `_applyWrites`），但**取决于节点 id 的字典序**——把 `n_agent_market` 改名成 `n_agent_zzz`，下游输入就变了。这种「确定但任意」比不确定更危险：测试会稳定通过，问题不在开发期暴露。因此 **region 内节点不得写 `lastAgentText` 与 `messages`**，下游只允许通过 `inputMap` 读 `vars`（见 §8.1）。
6. **并行区内禁止 HITL 与 Condition。** 前者因单 interrupt 契约；后者因 XOR 会让屏障永远等不到某条入边。两者都放在 Join 之后。
7. `schemaVersion` **仍为 1**，只追加 kind，旧文档无需迁移。
8. **Join 第一期只有** `wait: "all"`**。**

---

## 4. 新增节点

### 4.1 `fork`

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| `data.kind` | `fork`                                                             |
| 画布 `type` | `forkNode`                                                         |
| 入          | 1 条 `normal`                                                      |
| 出          | 恰好 `lanes.length` 条 `lane` 边（≥2），`sourceHandle === laneKey` |
| 编译        | 恒等 `return {}`；对每条 lane 边 `addEdge(fork, target)`           |

```ts
type ForkLane = { key: string; label: string }; // key 同 BRANCH_KEY_RE，数组内去重

type ForkNodeConfig = {
  lanes: ForkLane[]; // min 2, max 16
  joinId?: string; // 可选断言，见下
};
```

拖入时的默认配置（无业务语义）：

```ts
lanes: [
  { key: "lane_1", label: "通道 1" },
  { key: "lane_2", label: "通道 2" },
];
```

Lane 的增 / 删 / 改名与 Condition 的 branches 同一套交互；删除时至少留 2 条，并级联删掉该 handle 上的边。

上限 16 是画布 Handle 与并发的双重护栏（并发另见 §10），不是业务形状。

`joinId` **是可选断言，不是控制流边。** 编译时本来就要收集「Join 的直接前驱」建屏障，配对关系可从拓扑推断：

- 优先 **推断**：从 Fork 各 lane 向下走，唯一的共同汇合 Join 即配对结果。
- 推断不唯一或为空时 **报错**，错误锚点落在 Fork 上。
- 用户显式填了 `joinId` 时，**校验推断结果与之一致**，不一致则报错。

这样用户加了第 4 条 lane 却忘改配置时不会产生新的不一致状态。绝不能加一条 Fork→Join 的实际边——那会让 Join 提前被触发。

### 4.2 `join`

|             |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| `data.kind` | `join`                                                                         |
| 画布 `type` | `joinNode`                                                                     |
| 入          | ≥2 条 `normal`（lane 内多跳时从各链尾汇入）                                    |
| 出          | 恰好 1 条 `normal`                                                             |
| 编译        | 恒等 `return {}`；`addEdge(sortedPredecessors, joinId)` 建 `NamedBarrierValue` |

```ts
type JoinNodeConfig = { wait: "all" };
```

Join **不做**深合并。各并行节点写不同 `vars` key，现有 reducer `(left, right) => ({ ...left, ...right })` 足够，N=2 与 N=16 同理。

---

## 5. 边

`EDGE_KINDS` 追加 `"lane"`：

```ts
{
  kind: "lane";
  laneKey: string;
}
```

| 源        | 边 kind  | handle                                          |
| --------- | -------- | ----------------------------------------------- |
| fork      | `lane`   | `sourceHandle === lanes[].key === data.laneKey` |
| condition | `branch` | 与现在一致                                      |
| 其余      | `normal` | 无 handle                                       |

不要复用 `branch`：校验与编译都按 XOR 处理它。

---

## 6. 端口与画布

```ts
targets: 0 | 1 | "many";
sources: 0 | 1 | "branches" | "lanes";
```

| kind | targets  | sources   |
| ---- | -------- | --------- |
| fork | 1        | `"lanes"` |
| join | `"many"` | 1         |

节点卡：Fork 底边按 **当前** `lanes.length` 均分 Handle（与 Condition 按 branches 动态渲染同一套写法）。Join 顶边一个 target，允许多条入边。

`document.ts`：

- `connect()` 源为 fork 时 **按 handle 替换**——只改这一条 lane 的第一跳，**不同 handle 的边并存**。这是 N 路能画出来的前提；若沿用「清掉该源全部出边」的写法，连第二条 lane 会删掉第一条。
- 普通单出口节点：同 handle 仍只留一条（现状不变）。
- Join 作 target 时 **不得**清掉其它入边。
- `canConnect`：fork 必须从某个 lane handle 拉出；禁止 fork→fork；禁止连到 start。
- `addForkLane` / `removeForkLane` / `renameForkLane`：抄 Condition 三件套；改名同步 `sourceHandle` 与 `laneKey`。

Palette：`fork`（并行扇出，可增删通道）、`join`（等待全部完成）。

Inspector：Fork 编辑 lane 列表 + 只读展示推断出的配对 Join（可选覆盖）；Join 只读 `wait` 与配对 Fork。

---

## 7. 校验

`refinePortsAndControlFlow` + 新增 `refineForkJoinRegions`。规则对任意 N、任意多对 Fork–Join 成立。

### 7.1 端口

- Fork：每个 `lanes[].key` 有且仅有一条出边；`kind==="lane"` 且三键一致；`2 ≤ lanes.length ≤ 16`。
- Join：`wait === "all"`；compile 档出边恰好 1；入边 ≥2。
- 非 Fork 不得发出 `lane` 边。

### 7.2 区域（一对 Fork–Join）

从 Fork 每条 lane 后继 DFS，**不穿过配对 Join**：

1. **每条 lane 都能到达该 Join**（与 N 无关）。
2. **Join 的直接前驱集合必须恰好覆盖所有 lane**，一条 lane 一个链尾。屏障名单就是这个集合，校验与编译必须用同一份计算结果，否则会出现「校验过了但屏障少等一路」。
3. 路径上禁止：`human_review`、`condition`、另一个 Fork、`end`。Lane 内只允许 `agent` / `tool`（Assign 落地后加入）。
4. **lane 之间节点互斥**：两条 lane 不得共享任何中间节点。共享节点会被 OR 触发跑两次，且 Join 的前驱集合缩小，屏障失效。
5. **region 内除 Join 外禁止 fan-in**：region 内任何非 Join 节点入边必须为 1。注意现有校验 **不限制**入边数量（只检查 `spec.targets === 0`），这条要新写。
6. **禁止 Start 直连 Join**（§2.5，LangGraph 会直接抛）。
7. **每条 lane 至少一个节点**：`fork` 的 lane 边不得直接连到 Join。技术上能跑（fork 自己进屏障名单），但语义无意义且让错误信息难解释。
8. 一个 Join 只配对一个 Fork。
9. 区域内 DAG：禁止 Join 出边直接回到自己的 Fork。区域 **外** 的环合法。

多对区域各自校验；允许 `JoinA → … → ForkB`。

### 7.3 写冲突

同一 region 内 `agent`/`tool` 的 `outputKey` 不得重复。仍使用默认 `outputKey=lastAgentText` 的 Agent 放进 region → compile 失败。

region 内节点的 `inputMap` 引用 `state.lastAgentText` → compile 失败（该字段在并行区里不再被写入，见 §8.1）。

不同 region 可复用 key（后写覆盖），属用户责任，抽屉给提示。

### 7.4 并行入口

禁止 Agent 匿名多出边。并行只能从 Fork 的 lane handle 出去。

---

## 8. 编译器

`start`/`end` 仍不 `addNode`。Fork / Join 要注册为恒等节点。

```
addNode(forkId, async () => ({}))
addNode(joinId,  async () => ({}))
```

边的处理分三类：

- `lane` → `addEdge(fork, target)`，N 条就 N 次（**不是** conditional）。
- `branch` → `addConditionalEdges`（不变）。
- `normal` → `addEdge`，**但 target 为 join 的除外**：这些边不逐条连，改为按 Join 聚合后一次性 `addEdge(sortedPredecessors, joinId)`。

排序与去重（同一前驱两条边）都要做，代码示意与理由见 §2.3。

不用 `Send` 实现静态 N 路：画布拓扑应等于运行时拓扑。

### 8.1 Agent 的 `messagesMode` 与并行区写回约束

`executeAgentNode` 现在**无条件**写三个字段：

```ts
return {
  messages: newMessages,
  lastAgentText: text,
  vars: { [config.outputKey]: text },
};
```

N 路并行同时 append，`messages` 会变成按节点名序拼接的多路交错对话，`lastAgentText` 则是节点 id 字典序最大那一路的输出（§3 第 5 条）。两者都稳定但都没有业务含义。

两种模式（规范含义，不是给用户勾的选项）：

- `"inherit"`：喂 `state.messages`，写回 `newMessages` 与 `lastAgentText`，并写 `vars[outputKey]`。旧串行图走这条。
- `"isolated"`：不读共享对话；只吃 `inputMap` 展开后的 HumanMessage + system；**不写回** `messages`，**也不写** `lastAgentText`，只写 `vars[outputKey]`（若确实需要留痕，就只写一条压缩后的摘要 AIMessage，实现时二选一并在注释里说明理由）。

**第一期不把 `messagesMode` 做成 DSL 字段，也不做 Inspector 选项。** 编译期用区域分析结果决定，用户不能覆盖：

| 位置                     | 模式            | 理由                                                    |
| ------------------------ | --------------- | ------------------------------------------------------- |
| Fork–Join **区域内**     | 强制 `isolated` | N 路工人只拿任务包（`inputMap` / `vars`），不挂共享线程 |
| **区外**（含 Join 之后） | 强制 `inherit`  | 与旧图一致；用 `inputMap` 读并行产物                    |

区外默认要历史，如果以后有这个需求：「某个串行 Agent 不要历史」，再加用户选项；第一期不做。区内也不提供改回 `inherit` 的口子——那会重新引入交错 `messages` 和字典序 `lastAgentText`。

**不采用**「让 Join 按 lane 顺序拼出一个确定的 `lastAgentText`」这条路：Join 一旦有业务逻辑，就得回答分隔符、标题、超长截断等一串问题，这些应该由用户在 Join 后面放一个 Agent 或模板节点决定，而不是编译器替他定。

Inspector 里对 region 内的 Agent 隐藏（或警示）与 `lastAgentText` 相关的提示，避免用户在 `inputMap` 里写 `state.lastAgentText`。不出现 `messagesMode` 下拉框。

---

## 9. 运行监控

SSE 协议（`WorkflowSseEvent`）不变，但 **runner 必须改**，不只是前端聚合。

### 9.1 runner：节点归属

现在 `currentNodeId` 是单个可变量，token / tool_start / tool_end / error 都挂在它上面。并行时 lane B 的 `on_chain_start` 会覆盖它，lane A 的 token 就被标成 B，失败时 `error.nodeId` 也会指错。

改为从事件 metadata 取 `langgraph_node`（`dist/pregel/algo.js` 派发任务时写入 `langgraph_step` / `langgraph_node` / `langgraph_triggers`），只把命中 DSL 节点 id 的值作为归属；取不到时留空而不是回退到全局游标。

### 9.2 前端聚合

- `event-reducer`：把 `currentNodeId` 扩成 `currentNodeIds`（已有 `openNodes` 可直接暴露），N 路同跑就是集合大小 N。`run_status.currentNodeId` 保留兼容。
- `highlight` / `RunHighlightContext`：用 Set，id 命中即脉冲。
- `appendTimelineEvent`：现在只合并**相邻同节点** token。三路交错后几乎每个 token 一个条目，长输出会拖垮前端。改为按 `nodeId` 分桶累积，而不是只看 `events.at(-1)`。

第一期不做 Join 上的「k/N 已到达」进度条。

---

## 10. 并发与资源

| 项               | 说明                                                                                                                                      | 处置                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 并发无上限       | N 路并行 = N 个 LLM 同时调用，易撞供应商限流与成本尖峰；LangGraph 不替你节流。                                                            | 给 `streamEvents` 的 config 设 `maxConcurrency`；可选做成 Fork 配置。 |
| `recursionLimit` | 默认 25 个 superstep。并行区抬高 superstep 数，叠加环容易撞上限。                                                                         | 显式设置；校验里可估算最坏 superstep 数并提示。                       |
| 单 lane 失败     | 任一 lane 抛错 → 整个 superstep 失败 → run 变 `failed`，其余 lane 结果留在 pending writes。                                               | 这是预期行为，写进文档；UI 用 `error.nodeId` 指出是哪一路。           |
| retry 成本       | `findRetryCheckpointId` 用 `snap.next.includes(nodeId)` 定位；并行时 `next` 有多个节点，从某一路重试会把同 superstep 其他 lane 一起重跑。 | 第一期接受，文档写明；UI 提示「将重跑该并行批次」。                   |

---

## 11. 本计划不做

对任意 N 的静态并行都成立的边界：

| 延后                                 | 原因                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| 运行时 Map / `Send`                  | 节点 id 运行期才出现，与画布 / 校验 / 高亮契约不一致。                               |
| Join `wait: "any"`、超时取消兄弟任务 | 需要取消 inflight LLM 并丢弃后到的 `vars` 补丁，调度模型不同。                       |
| 并行区内 HITL                        | 产品层单 `interrupt_payload`、单 resume。                                            |
| 并行区内 Condition                   | XOR 会使屏障某个 name 永远不写入。将来可放宽为「所有分支必须在本 lane 内重新汇合」。 |
| 嵌套 Fork                            | 区域从「一对」变成栈；前后串联已够用。                                               |
| 子图、Cron、`human_review` 双出口    | 与并行正交，原 PLAN 已延后。                                                         |
| 改 `schemaVersion` / checkpointer 表 | 追加 kind 即可。                                                                     |
| 用户可选的 `messagesMode`            | 第一期按拓扑强制：区内 `isolated`、区外 `inherit`。区外「不要历史」以后再加选项。    |

---

## 12. 实现顺序

### Phase A — DSL + 校验（不依赖 UI）

- `kinds.ts`：`fork` / `join`、`lane` 边、端口表、中文 label。
- `schema.ts`：config、`refineForkJoinRegions`（N 参数化）、`createNodeData` / `defaultConfigForKind`。
- 抽出 **共享的区域分析纯函数**（Fork→lanes→Join 前驱集合），校验与编译器共用同一份实现，避免 §7.2 第 2 条两头算不一样。
- 单测：合法 N=2 / N=3；缺 lane 边；region 内 `outputKey` 冲突（含都用默认值）；region 内 `inputMap` 引用 `state.lastAgentText`；region 内出现 HITL / Condition；lane 共享节点；region 内非 Join fan-in；Start 直连 Join；空 lane；lanes 为 1 条或 17 条；`joinId` 与推断结果冲突。

### Phase B — 编译器

- 恒等 Fork/Join；`lane` → `addEdge`；**Join 走数组** `addEdge` **且前驱排序**。
- 按 region 强制 `messagesMode`：区内 `isolated`、区外 `inherit`。不写入 DSL、不做 Inspector。
- 单测（重点）：
  - **lane 长度不等**（一条 lane 一个节点，另一条两个节点）：断言 Join **只执行一次**且在两路都完成之后。这条直接挡住 §2 的回归。
  - N=2 调用序；N=4 四个 key 都进 `vars`。
  - 两段并行串联互不抢 Join。
  - 前驱数组排序稳定（同一 DSL 两次编译得到同名通道）。
  - **region 内 Agent 不写 `lastAgentText` / `messages`**：并行跑完后这两个字段与并行前一致，只有 `vars` 增加。
  - **环上多入边仍是 OR**：Join 之后打回主笔的图能跑第二轮（屏障 `consume` 后重置），主笔在第一轮就执行而不是等到 Condition 写入。
  - 旧串行图回归。

### Phase C — 画布

- Palette、动态 Handle、lane CRUD、Drawer、`connect` 按 handle 并存。
- Drawer **不**提供 `messagesMode`；区内 Agent 隐藏 / 警示 `lastAgentText` 相关提示。
- 单测：两个 handle 并存；`addForkLane` 后第 3 条可连；同 handle 替换；Join 多入边保留；无 handle 拉线被拒；删到 1 条 lane 被拒；改名同步 `laneKey`。

### Phase D — 监控

- runner 按 `langgraph_node` 归属事件。
- `event-reducer` / `highlight` 多当前节点；时间线 token 按节点分桶。
- 并发与 recursionLimit 配置落地。

### Phase E — Assign（独立阶段，与并行正交）

并行本身不需要它，但环、maxRound、标志位需要稳定赋值。单独一个小 PR，避免把 expr-eval 写值语义的决策塞进 Phase A。

```ts
type AssignNodeConfig = { sets: Array<{ key: string; expression: string }> };
```

- 出入各 1 条 `normal`；可位于串行段或某条 lane 链上（落地后加入 §7.2 第 3 条白名单，其 `sets[].key` 计入 §7.3 写冲突检查）。
- 求值沙箱与 condition expression 相同（只读 `state.vars` / `state.lastAgentText`）。
- 任一表达式失败：**整节点 throw**，不要静默跳过某个 key（否则 round 停在 0 会死循环）。
- 空 `sets`：graph 档可存，compile 档拒绝。

不新增「循环节点」：环继续用现有边 + Condition。

---

## 13. 验收

### 13.1 通用能力（与业务无关，必须全绿）

1. N=2 并行，Join 后第三节点能读到两个 `outputKey`，且在两路都开始之后才执行。
2. **N=2 但 lane 长度不等**：Join 只跑一次、且在长 lane 结束之后。
3. N=4：四条 lane 全部 `addEdge`，缺一条出边 compile 失败。
4. 两段并行串联，互不抢 Join。
5. 改 lane 数：删到 1 条被拒；改名后边随之更新。
6. 同一 DSL 反复编译，屏障通道名稳定（resume 可用）。
7. 并行区跑完后 `lastAgentText` / `messages` 未被 region 内节点改写。
8. 带环的图（Join → Condition → 回到区外串行节点）能跑满两轮，屏障自动重置。
9. 旧串行图回归。

### 13.2 样例 fixture：竞品分析报告

用两个 Fork–Join 对拼装，lane 名由用户配置：

```
Start(topic, scope)
  → Fork(lanes: market, product, risk) → 三 Agent（各自 outputKey）→ Join
  → Agent 主笔 → vars.draft
  → Fork(lanes: facts, logic) → 两质检 Agent（inputMap 只注入 draft 等，不注入对方 review_*）
  → Join
  → Condition（pass / revise / escalate）
        revise   → [Assign(round+=1) 待 Phase E] → 主笔
        pass | escalate → human_review → Condition(decision)
              approve → End
              reject  → 主笔
```

Phase E 之前，`round` 上限用 LLM condition 的 prompt 约束；Phase E 之后换成 Assign 计数。

人工验收：调研三卡同时高亮；Join 前无主笔；人审 interrupt / resume 正常。

建议放两份 fixture：`fixtures/parallel-uneven-lanes.dsl.json`（能力回归，含不等长 lane）与 `fixtures/competitive-analysis.dsl.json`（复杂拼装）。

---

## 14. 单测要求（对齐 AGENTS.md）

只测纯函数与图变换，不引入 React / DOM。每个新模块至少 3 个极端边界，`it` 描述用中文说明测试意图。

优先文件：`lib/workflow-dsl/schema.test.ts`、`lib/workflow-dsl/compile.test.ts`、`app/(dashboard)/workflows/lib/document.test.ts`、`app/(dashboard)/runs/lib/highlight.test.ts`、`event-reducer.test.ts`；区域分析纯函数配套自己的测试文件。

**不要**把「必须出现 market / product / risk」写进通用 schema 测试；业务名只出现在竞品 fixture。

---

## 15. 风险与默认决策

| 风险                               | 决策                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| fan-in 语义误用                    | §2 写死：Join 用数组 `addEdge`，屏障只挂 Join，前驱排序。Phase B 的不等长 lane 用例作为回归闸门         |
| 校验与编译对「屏障名单」算法不一致 | 抽共享纯函数，两边调用同一实现                                                                          |
| 并行 messages 交错                 | 区内强制 `isolated`（不读不写共享对话），区外 `inherit`；不做 Inspector / DSL 选项。下游只读 `vars`     |
| `lastAgentText` 「确定但任意」     | 顺序按节点 id 字典序，改名即改语义。靠 §7.3 的校验硬拦，而不是靠文档提醒                                |
| Join 恒等显得多余                  | 必需。屏障只能挂在它上面，普通节点多入边必须保持 OR                                                     |
| lane 过多 Handle 重叠 / 并发爆炸   | 上限 16 + `maxConcurrency`                                                                              |
| `joinId` 与连线状态不同步          | 改为推断优先、显式仅作断言                                                                              |
| 穷尽 switch 漏改                   | TS 在 `defaultConfigForKind`、`createNodeData`、`KIND_ICONS`、Inspector、`compile` 处报错，作为检查清单 |

---

## 16. 与 PLAN.md 的关系

节点表追加两行（Assign 随 Phase E 再加）：

| `data.kind` | 画布 `type` | 编译行为                                                                         |
| ----------- | ----------- | -------------------------------------------------------------------------------- |
| `fork`      | `forkNode`  | 恒等；对配置中的全部 `lane` 边 `addEdge`（AND 扇出，N 可变）                     |
| `join`      | `joinNode`  | 恒等；`addEdge(sortedPredecessors, joinId)` → `NamedBarrierValue`（`wait: all`） |

完成后可划掉「静态并行 fan-out」；动态 map、子图、Cron 仍延后。
