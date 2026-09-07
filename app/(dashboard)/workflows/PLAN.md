# Agent Workflow：技术方案与分步实施 Plan

本文档是 `app/(dashboard)/workflows/` 的实现蓝图，**不包含可运行业务代码**。目标：前端 ReactFlow 可视化编排 → 标准 Workflow JSON 落库（Supabase `flows`）→ 后端编译为 LangGraph `StateGraph`，支持条件分支与人工审核 interrupt / resume。

当前基线：

- 画布：`page.tsx` 已有 ReactFlow Demo（含多 Handle 路由节点），尚未 CRUD、尚未 Drawer。
- 运行时：单 Agent 使用 `createReactAgent` + Redis `RedisSaver`（`lib/agent-runtime`、`app/api/chat`）。
- 已有表 `public.flows(id, name, flow_data, created_at)`，字段不足以支撑多用户、版本、运行态，需演进而不是推倒重来。

---

## 0. 架构总览

```
┌──────────────────────────────┐     Workflow Document JSON
│  Editor (ReactFlow + Drawer) │ ──────────────────────────► Supabase flows.dsl
└──────────────┬───────────────┘
               │ POST /api/workflows/:id/validate|run
               ▼
┌──────────────────────────────┐
│  Compiler                    │  DSL 校验 → IR → StateGraph.compile({ checkpointer })
│  lib/workflow-runtime        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  Runner                      │  stream / interrupt / Command({ resume })
│  RedisSaver thread_id        │  运行记录写入 flow_runs
└──────────────────────────────┘
```

**两条契约必须分开：**


| 层                     | 谁拥有            | 内容                                               |
| --------------------- | -------------- | ------------------------------------------------ |
| **Document（持久化 DSL）** | 前端提交、后端校验后原样入库 | ReactFlow `nodes`/`edges` + 语义配置 `data.config`   |
| **IR / Graph（运行时）**   | 仅后端内存（可选缓存哈希）  | LangGraph 节点函数、`addConditionalEdges`、`interrupt` |


不要把编译后的 JS 函数或 LangGraph 对象塞进 `flow_data`。Document 必须可 round-trip 回画布。

**节点语义 vs 画布外观：** ReactFlow 的 `type` 只负责自定义组件（`agentNode`、`conditionNode`…）。可执行语义放在 `data.kind`（稳定枚举）。编译器只读 `kind` + `config` + 边的 `sourceHandle`。

---



## 1. 数据库表设计（Supabase）



### 1.1 演进现有 `flows`（定义 / 元数据）

建议在现表上 **ALTER**，保留 `flow_data` 作为过渡列，新代码读写 `dsl`。

```sql
alter table public.flows
  add column if not exists user_id uuid references auth.users (id),
  add column if not exists description text,
  add column if not exists status text not null default 'draft',
    -- draft | published | archived
  add column if not exists version int not null default 1,
  add column if not exists dsl jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

-- 迁移：flow_data → dsl（一次性）
-- update public.flows set dsl = flow_data where dsl = '{}'::jsonb;
```


| 字段                          | 说明                                        |
| --------------------------- | ----------------------------------------- |
| `id`                        | 工作流定义 ID                                  |
| `user_id`                   | 与 `agents.user_id` 对齐；列表/编辑按用户隔离          |
| `name` / `description`      | 列表展示，避免只打开 JSON 才知道含义                     |
| `status`                    | draft 可随便改；published 才允许正式 run（Phase 2/3） |
| `version`                   | 每次「发布」+1；编辑中可只更新 `dsl` 不升版本               |
| `dsl`                       | **唯一真相**：下文 Workflow Document             |
| `flow_data`                 | 兼容旧 Demo；稳定后可废弃                           |
| `created_at` / `updated_at` | `updated_at` 用 trigger 维护                 |


可选：`entry_node_id text` 冗余，便于列表校验「是否有 Start」。仍以 `dsl` 内 `startNodeId` 为准。

**不要**在 `flows` 上存 `compiled_graph`。编译便宜且必须与当前 Agent/Tool 绑定一致；用 `dsl` + `version` 即可复现。

### 1.2 `flow_versions`（发布快照，Phase 2）

发布时写入不可变快照，运行绑定 `flow_version` 而不是「正在编辑的草稿」。

```sql
create table public.flow_versions (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete cascade,
  version int not null,
  dsl jsonb not null,
  published_at timestamptz not null default now(),
  unique (flow_id, version)
);
```



### 1.3 `flow_runs`（一次执行 / 一次 thread，Phase 3）

LangGraph `thread_id` 与 Redis checkpoint 对齐；人工审核挂起也落在这一行。

```sql
create table public.flow_runs (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete restrict,
  flow_version int not null,
  user_id uuid not null references auth.users (id),
  thread_id text not null unique,          -- LangGraph configurable.thread_id
  status text not null default 'pending',
    -- pending | running | interrupted | completed | failed | cancelled
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  interrupt_payload jsonb,                 -- 当前挂起原因、待审字段、nodeId
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`interrupt_payload` 示例：`{ "nodeId": "n_review", "kind": "human_review", "form": { ... }, "resumeSchema": "approve_reject" }`。

### 1.4 索引与 RLS

- 索引：`flows(user_id, updated_at desc)`；`flow_runs(flow_id, created_at desc)`；`flow_runs(user_id, status)`。
- `public` schema 表 **开启 RLS**。策略与 `agents` 一致：`authenticated` 仅 `user_id = auth.uid()` 的 SELECT/INSERT/UPDATE/DELETE。
- `flow_versions` 通过 `flow_id → flows.user_id` 间接授权（policy 里 `exists` 子查询），避免版本表漏出他人 DSL。
- 服务端 run/compile 走 `lib/supabase-admin.ts`（service role），**禁止**把 service role 暴露给浏览器。
- `dsl` 只存 Agent/Tool 的 **UUID 引用**，不存 API Key。授权字段用 `app_metadata`，不用可被用户改的 `user_metadata`。

CRUD 建议：列表/保存可继续用浏览器 `lib/supabase.ts`（与 Agents 页相同）；**validate / run / resume** 必须走 Next.js Route Handler，以便编译器与 checkpointer 不进客户端。

---



## 2. 前后端通信 DSL



### 2.1 设计原则

1. **ReactFlow 原生存储**：`id`、`position`、`source`/`target`/`sourceHandle` 直接可喂给 `useNodesState` / `useEdgesState`。
2. **语义进** `data`：`kind`、`config`、`ui` 分层；不要把 prompt 写在 `style` 里。ReactFlow允许每个节点塞一个`data`对象来存放自定义数据，`data`中的数据做好“抽屉分类”：`kind`决定后端编译逻辑（Agent还是条件判断等等）、`config`存放后端执行参数（如大模型的temperature等）、`ui`存放纯前端视觉配置（如节点颜色等）
3. **边表达控制流**：条件出口 = 节点上的 named Handle `id`，边用 `sourceHandle` 对齐 `config.branches[].key`。编译器 **禁止**使用边的 `label` 字符串做分支。
4. **版本字段**：根上 `schemaVersion`，编译器按版本解析，避免静默破坏。



### 2.2 Document JSON Schema 示例

```json
{
  "$schema": "https://example.local/workflow-document.schema.json",
  "schemaVersion": 1,
  "id": "flow-uuid",
  "name": "客服升级工作流",
  "startNodeId": "n_start",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [
    {
      "id": "n_start",
      "type": "startNode",
      "position": { "x": 80, "y": 40 },
      "data": {
        "kind": "start",
        "label": "开始",
        "config": {}
      }
    },
    {
      "id": "n_agent",
      "type": "agentNode",
      "position": { "x": 80, "y": 160 },
      "data": {
        "kind": "agent",
        "label": "一线客服",
        "config": {
          "agentId": "uuid-of-agents-row",
          "inputMap": { "messages": "state.messages" },
          "outputKey": "lastAgentText"
        }
      }
    },
    {
      "id": "n_if",
      "type": "conditionNode",
      "position": { "x": 80, "y": 300 },
      "data": {
        "kind": "condition",
        "label": "是否升级",
        "config": {
          "mode": "expression",
          "expression": "state.vars.need_human === true",
          "branches": [
            { "key": "yes", "label": "是" },
            { "key": "no", "label": "否" }
          ],
          "defaultBranch": "no"
        }
      }
    },
    {
      "id": "n_llm_router",
      "type": "conditionNode",
      "position": { "x": 400, "y": 300 },
      "data": {
        "kind": "condition",
        "label": "意图路由",
        "config": {
          "mode": "llm",
          "modelName": "deepseek-chat",
          "prompt": "根据对话判断走 refund / faq / human。只输出分支 key。",
          "branches": [
            { "key": "refund", "label": "退款" },
            { "key": "faq", "label": "FAQ" },
            { "key": "human", "label": "人工" }
          ],
          "defaultBranch": "faq"
        }
      }
    },
    {
      "id": "n_review",
      "type": "interruptNode",
      "position": { "x": 80, "y": 460 },
      "data": {
        "kind": "human_review",
        "label": "人工审核",
        "config": {
          "title": "是否批准升级",
          "formFields": [
            { "name": "decision", "type": "enum", "options": ["approve", "reject"] },
            { "name": "comment", "type": "text" }
          ]
        }
      }
    },
    {
      "id": "n_end",
      "type": "endNode",
      "position": { "x": 80, "y": 600 },
      "data": {
        "kind": "end",
        "label": "结束",
        "config": {}
      }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "n_start",
      "target": "n_agent",
      "data": { "kind": "normal" }
    },
    {
      "id": "e2",
      "source": "n_agent",
      "target": "n_if",
      "data": { "kind": "normal" }
    },
    {
      "id": "e_yes",
      "source": "n_if",
      "sourceHandle": "yes",
      "target": "n_review",
      "data": { "kind": "branch", "branchKey": "yes" }
    },
    {
      "id": "e_no",
      "source": "n_if",
      "sourceHandle": "no",
      "target": "n_end",
      "data": { "kind": "branch", "branchKey": "no" }
    }
  ]
}
```

约束（校验器必须强制）：

- 每个 `kind: start` 至多一个；`startNodeId` 必须指向它。
- `condition` 的每个 `branches[].key` 必须有且仅有一条出边，`sourceHandle === key === data.branchKey`。
- `human_review` 默认单出口；resume 后走该边（驳回逻辑可在节点函数内写 `state` 再跟一条条件边，Phase 3 再做「双出口审核」）。
- 禁止悬空边；允许环（Agent ↔ Tool），编译器按 LangGraph 正常成环。
- 节点 `id` 建议 `[a-zA-Z_][a-zA-Z0-9_]*`，可直接当 LangGraph 节点名。



### 2.3 `kind` 一览（Phase 1–3）


| `data.kind`    | 画布 `type`       | 编译行为                                               |
| -------------- | --------------- | -------------------------------------------------- |
| `start`        | `startNode`     | 入口，写入 `input` → `state`                            |
| `end`          | `endNode`       | 接到 `END`                                           |
| `agent`        | `agentNode`     | 加载 `agents` + tools，调用与 chat 相同的模型绑定               |
| `tool`         | `toolNode`      | 单次结构化 tool 调用（可选，Phase 2）                          |
| `condition`    | `conditionNode` | `addConditionalEdges`；`expression` 或 `llm`         |
| `human_review` | `interruptNode` | 节点内 `interrupt(payload)`，resume 合并表单到 `state.vars` |


表达式求值：**白名单**（`state.vars` / `state.lastAgentText` 上的比较、布尔），不要 `eval` 任意 JS，杜绝注入隐患。LLM 判定：输出必须是 `branches` 中的 key，否则走 `defaultBranch`。

### 2.4 共享 State（编译器固定 Annotation）

所有工作流共用一块图状态，避免每张图一套 TypeScript：

```ts
// 示意，非最终实现
{
  messages: BaseMessage[];      // 对话 / Agent 输入输出
  vars: Record<string, unknown>; // 条件、审核表单、业务字段
  lastAgentText: string;
  _route?: string;              // 条件节点写入的下一跳 key
}
```

节点 `config.outputKey` 把模型输出写入 `vars` 或顶层字段，供下游 expression 使用。

### 2.5 API 契约（建议）


| 方法     | 路径                                                 | 作用                                   |
| ------ | -------------------------------------------------- | ------------------------------------ |
| CRUD   | Supabase `flows` 或 `GET/POST/PATCH /api/workflows` | 列表、创建、保存 `dsl`                       |
| `POST` | `/api/workflows/:id/validate`                      | Zod 校验 + 编译 dry-run（不 invoke LLM）    |
| `POST` | `/api/workflows/:id/run`                           | 发布版本上 `stream` / `invoke`            |
| `POST` | `/api/workflows/runs/:runId/resume`                | `Command({ resume })`                |
| `GET`  | `/api/workflows/runs/:runId`                       | 状态、`interrupt_payload`、checkpoint 摘要 |


保存接口只收 Document；validate/run 返回 `{ ok, errors[], graphSummary? }`，错误带 `nodeId` 方便画布高亮。

---



## 3. 前端模块拆解

建议目录（落地时再拆文件，此处只定边界）：

```
app/(dashboard)/workflows/
  page.tsx                 # 列表 + 新建
  [id]/page.tsx            # 编辑器壳
  _components/
    workflow-canvas.tsx    # ReactFlow 本体
    node-palette.tsx       # 拖拽新增
    inspector-drawer.tsx   # 右侧配置
    nodes/*                # 自定义节点
  _state/workflow-editor-store.ts
  _lib/document.ts         # 空图、增删节点、handle 同步
lib/workflow-dsl/
  schema.ts                # Zod：前后端共用
  kinds.ts
```



### 3.1 画布（Canvas）

- 继续用现有 `reactflow@11`（不必此时升级 `@xyflow/react`）。
- 职责：渲染、`onNodesChange` / `onEdgesChange` / `onConnect`、框选删除、`fitView`。
- **不要**在 Canvas 里写 Agent prompt 表单。
- 连接规则：`isValidConnection` — 条件节点出边必须带 `sourceHandle`；Start 无入边；End 无出边。
- 从 Palette **拖入**时生成稳定 `id`，并按 `kind` 注入默认 `config` 与 Handles。

现状 Demo 的 `RouterNode` 可收敛为通用 `conditionNode`：Handles 由 `config.branches` **动态生成**，增删分支时同步删掉对应边。

### 3.2 自定义节点

每个节点组件只展示：`label`、`kind` 图标、校验错误点、Handles。选中态用 ReactFlow `selected` + 左边框。


| 组件                    | Handles                                 |
| --------------------- | --------------------------------------- |
| Start                 | source ×1                               |
| End                   | target ×1                               |
| Agent / Tool / Review | target ×1，source ×1                     |
| Condition             | target ×1，source × N（`id = branch.key`） |




### 3.3 右侧 Drawer 与状态

复用 Agents 页 `thread-config-drawer` 的「右侧滑入 + Esc + 遮罩」交互，但编辑器里建议：

- **遮罩不要全屏吞掉画布**：抽屉打开时仍可平移画布；仅抽屉内表单抢焦点。可用无遮罩的 `absolute right-0` 面板（宽 ~380px，与现有 Drawer 一致）。
- 选中节点 → `selection = { type: 'node', id }`；选中边 → `{ type: 'edge', id }`；点空白 → 关闭或显示「工作流级设置」（名称、描述）。

状态建议（单一 store / Context，避免 props 钻三层）：

```
document: WorkflowDocument          # nodes/edges 的权威来源
selection: Selection | null
drawerOpen: boolean                 # 可由 selection 派生
dirty / saving
validationErrors: { nodeId, message }[]
```

更新配置：**只改** `node.data.config`**（不可变更新）**，Canvas 从同一 `document.nodes` 来。条件分支增删必须同时改 `config.branches` 与 `edges`。

Drawer 按 `kind` 切换表单：Agent 选择器（拉 `agents` 表）、condition 的 mode/expression/branches、review 的 formFields。边 Drawer：只读 source/target，可编辑 `label`（展示用），`branchKey` 与 Handle 锁定同步。

### 3.4 列表页 vs 编辑页

- `/workflows`：卡片/表格，对齐 `/agents` 的加载与删除交互。
- `/workflows/[id]`：全高编辑器（layout 已是 `h-screen`）。顶栏：返回、名称、保存、校验、（Phase 3）试运行。

---



## 4. 后端 DSL → LangGraph 编译器

落地位置建议：`lib/workflow-runtime/`（与 `lib/agent-runtime/` 并列），API 放 `app/api/workflows/`。

### 4.1 流水线

```
Document
  → Zod parse（schemaVersion）
  → Graph 拓扑校验（连通、Handle、单 Start）
  → 解析引用（agentId ∈ 当前用户 agents）
  → 注册 node 函数
  → 连边：普通 addEdge；condition → addConditionalEdges
  → compile({ checkpointer: RedisSaver })
```

校验失败返回结构化错误，不 compile。

### 4.2 节点绑定思路

- **start**：`return { ...input }`（messages / vars）。
- **agent**：复用 `createChatModel`、`buildLangChainTools`、必要时 `createReactAgent` 或一次 `model.invoke`。工作流里的 Agent 节点默认「一步」：读 `state.messages`，写回 messages + `lastAgentText`。内部 ReAct 循环留在该节点内，不必在画布上展开 Tools 环（与当前 chat 路由一致）。若产品要可视化 Tool 环，再用 `tool` 节点 + 回边（Phase 2 可选）。
- **condition (expression)**：纯函数，`_route = evalExpr(state)`。
- **condition (llm)**：调用模型，约束输出为 branch key。
- **human_review**：

```ts
const decision = interrupt({ nodeId, form: config.formFields, snapshot: state.vars });
return { vars: { ...state.vars, ...decision } };
```

Resume：`graph.stream(new Command({ resume: { decision, comment } }), { configurable: { thread_id } })`。checkpointer 必须与 chat 相同的 RedisSaver，**thread_id = flow_runs.thread_id**。

- **end**：接到 `END`；可把 `state` 摘要写入 `flow_runs.output`。



### 4.3 边

- 无 `sourceHandle`：`addEdge(source, target)`。
- 条件节点：`addConditionalEdges(source, (s) => s._route ?? defaultBranch, { yes: 'n_review', no: 'n_end' })`。map 的 key 来自 `branches`，value 来自对应边的 `target`。



### 4.4 单步调试（为 Phase 3 预留）

- `streamMode: ['updates', 'checkpoints']`（以实际 LangGraph 0.2 API 为准）。
- API 可提供 `stopAfter: nodeId`：编译时给目标节点包一层，执行完 `interrupt({ debug: true })`，前端高亮当前节点。
- 不要为调试另存一套 DSL。



### 4.5 与现有 Chat 的关系


|     | 单 Agent Chat           | Workflow                    |
| --- | ---------------------- | --------------------------- |
| 图   | `createReactAgent` 预置  | 用户 DSL 编译                   |
| 记忆  | Redis thread per agent | Redis thread per `flow_run` |
| 配置  | Agent 行 + 可选覆盖         | 节点上 `agentId` 指向 Agent 行    |


共享 `llm.ts` / `tools.ts` / `getRedisCheckpointer()`，不要分叉模型工厂。

---



## 5. 分阶段落地



### Phase 1 — 可编辑、可保存（CRUD + 画布 + Drawer）

**目标：** 当「画布编辑器」，定义能 round-trip 进 `flows.dsl`。

- 表：`user_id`、`description`、`status`、`version`、`dsl`、`updated_at` + RLS。
- `lib/workflow-dsl/schema.ts`（Zod）前后端共用。
- 列表页 CRUD（模式对齐 `agents/page.tsx`）。
- 编辑器：Palette、自定义节点、连接/删除、选中打开 Drawer、保存/加载。
- 条件节点：可增删 Handle；暂不运行。
- `POST validate`：只做 schema + 拓扑，不 compile LangGraph。

**完成标准：** 刷新页面图不丢；选中 Agent 节点可绑定已有 `agents.id`。

### Phase 2 — 编译器 + 条件控制流

**目标：** Document 能变成可 `invoke` 的 `StateGraph`（无 HITL）。

- `compileWorkflow(dsl)`；Start → Agent → Condition(expression) → End 跑通。
- LLM 条件路由。
- `flow_versions`：发布后 run 钉死版本。
- validate 升级为 dry-run compile。
- 画布展示 validate 错误锚点。

**完成标准：** 固定 DSL fixture 单测：边 map 与 Handle 一致；expression / defaultBranch 行为符合预期。

### Phase 3 — 运行、人工审核、单步调试

**目标：** 编排真正跑起来。

- `flow_runs`；`POST run` SSE 或轮询（可复用 `lib/agent-runtime/sse.ts` 思路）。
- `human_review` + `interrupt` / `resume`；Drawer 或独立「待办」填表。
- 运行中高亮当前节点；失败写 `error`。
- 可选：`stopAfter` 单步。

**完成标准：** 审核节点挂起后进程可退出；用同一 `thread_id` resume 从断点继续，Redis checkpoint 不丢。

### 刻意延后

- 子图 / 嵌套 workflow、并行 fan-out、定时 Cron、可视化 Tool 内循环、协作多人编辑。
- 把 `flow_data` 当第二套 schema。

---



## 6. 与当前代码的衔接


| 现有                              | 用法                         |
| ------------------------------- | -------------------------- |
| `workflows/page.tsx` Demo       | 拆成列表；画布迁到 `[id]`           |
| `agents` CRUD / Drawer          | 列表与 Inspector 交互参考         |
| `createReactAgent` + RedisSaver | Agent 节点与 run 的 checkpoint |
| `flows.flow_data`               | 一次性迁到 `dsl`                |


实施顺序：**先 schema + 表演进 → 再编辑器持久化 → 再编译器 → 最后 run/resume**。每阶段都要有可演示的 UI 或 API，避免只堆 DSL 类型。