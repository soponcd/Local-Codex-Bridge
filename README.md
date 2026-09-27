# Local Codex Bridge

*A thin supervisory MCP bridge between external AI supervisors and native Codex.*

Local Codex Bridge 是一个面向 Windows 与 macOS 的轻量 MCP stdio 适配器：

```text
ChatGPT / external AI supervisor
              ↕
        Local Codex Bridge
              ↕
      native Codex app-server
              ↕
   native Codex threads / turns
```

它解决的不是“再造一个 Codex”，而是让擅长对话、规划和持续监督的 AI，可以直接监督本机原生 Codex 完成真实工程任务。

**监督者负责目标、资源、边界、风险、审批与验收；Codex 保留原生的编码与执行自主性。**

Bridge 本身保持薄层：

- 不创建第二套 job / task 系统；
- 不复制 Codex 对话历史；
- 不维护平行线程数据库；
- 不缓存“当前模型”状态；
- 不替代 Codex 自己的 session / thread / turn 语义。

**原生 Codex thread/session 始终是执行事实源。**

## 当前代码范围

[版本历史](CHANGELOG.md)

当前代码提供 12 个工具，包含独立 History、Native Goal、Queue 与 Search，并保留薄 supervisory adapter 的边界：

- 原生持久历史按需分页，成功页无损交付；
- Goal set 显式选择预算意图，Queue 交由 native 在 active turn 后执行；
- 原生 capability / lineage 与搜索 locator 只按需读取；
- compact observation 使用一次固定截止、最多 120 秒的事件驱动等待；
- 所有成功工具调用使用 `structuredContent`，旧客户端需按下文迁移。

Windows 与 macOS 共用同一核心 Bridge，实现差异只保留在平台原生路径、launcher、checkpoint 默认目录、进程启动与终止等系统边界。

------

## 谁负责什么

### External supervisor / ChatGPT

适合负责：

- 理解用户目标；
- 拆解任务；
- 决定工作范围与风险边界；
- 选择何时继续观察、纠正、审批或中断；
- 判断结果是否满足验收条件；
- 在 Codex 无法自行安全决定时提供监督。

### Native Codex

继续负责：

- 原生 thread / turn 生命周期；
- 工作区文件与命令执行；
- Codex 自己的上下文与历史；
- sandbox 与 approval-policy 行为；
- 模型和 reasoning effort 的真实运行状态；
- 持久化的原生执行结果。

### Local Codex Bridge

只负责把两者接起来：

- MCP stdio ↔ Codex app-server JSONL；
- 有界地暴露监督所需状态；
- 转发明确的控制意图；
- 对高风险、歧义或协议边界 fail closed；
- 不把自己升级成第二个 orchestration runtime。

------

## 12 个 MCP 工具

| Tool               | 用途                                                         | 边界                                                         |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `codex_threads`    | 列出、搜索、读取原生 Codex 持久线程元数据      | `cwd` / search 只是筛选条件，不是 ACL                        |
| `codex_history` | 按需读取原生持久历史页 | paginated 按 turn / item 分页；legacy 每页一个完整 turn，无 Bridge 历史库 |
| `codex_search` | 原生跨线程搜索与线程内 occurrence 定位 | 返回 locator；不建索引，不隐式限制 workspace，不完整读取历史 |
| `codex_models`     | 按需读取一页原生 `model/list`                                | 不缓存模型目录，不维护 current-model registry                |
| `codex_goal` | 读取、设置或清除原生 thread goal | 不隐式 resume / turn-start，不自建 goal，不合并 checkpoint；clear 不等于 interrupt |
| `codex_queue` | 管理原生待执行 follow-up 文本 | 原生负责队列和执行；不隐式 resume / start，不建 Bridge scheduler |
| `codex_turn`       | 创建或恢复原生 thread，并启动一个 turn                       | 返回 accepted 不等于任务完成；model / effort 都是可选 override |
| `codex_observe`    | 有界读取实时事件、pending requests、terminal state 与 live cursor | runtime 缺失时只读持久元数据；支持一次 bounded wait          |
| `codex_steer`      | 对同一个 active turn 追加语义纠正或新意图                    | 不是 timer、polling 或 retry 机制                            |
| `codex_respond`    | 回答真实存在且 Bridge 明确支持的 approval / user-input / permission request | 必须保留原始 request id 和准确 scope；不支持 elicitation     |
| `codex_interrupt`  | 中断准确的 active thread / turn                              | 只发送原生 interrupt，不重启 Bridge 或 app-server            |
| `codex_checkpoint` | 保存可选、精简、有界的 supervisory anchor                    | 不是 transcript、job id 或 Codex history 的替代品            |

完整 schema 与运行时限制以 [`src/tools.ts`](src/tools.ts) 为准。

**响应格式：** 所有成功 `tools/call` 的完整结果都位于 `result.structuredContent`；`result.content` 只保留 tiny text 标记，不再包含可解析的结果 JSON。旧客户端须改为读取 `structuredContent`。错误仍走显式 `isError` / text error 路径，不附带成功结果。

`codex_threads(thread_id)` 只读元数据。旧参数 `include_turns:false` 保持该行为；`include_turns:true` 明确返回指向独立 `codex_history` 的迁移错误。旧 caller 需要迁移。

`codex_history` 每次先读取原生 historyMode：paginated 线程用 `kind:"turns"` 取不含 items 的 turn 索引（默认 20、最多 50），再用 `kind:"items", turn_id` 读取指定 turn 的 items（默认 10、最多 20）；legacy 线程仅支持 `kind:"turns"`，每页一个包含完整 items 的原生 turn，默认且最大 limit 为 1。legacy item 请求返回 `history_legacy_item_paging_unsupported:`。成功页明确标识 history mode、分页粒度与 turn items view；Bridge 不造 item/chunk cursor。

只有原生 `nextCursor:null` 表示当前方向结束；空页本身不表示结束。反向 `backwardsCursor` 配合相反的 `sort_direction`，turn anchor 会再次包含，Bridge 不去重。续页保持同一 thread、history mode、kind、turn scope 与排序方向；history cursor、thread/list cursor、live observe 数字 cursor 互不通用。

历史页以原样 `structuredContent` 加 tiny text 返回，实际 MCP JSON 帧受 256 KiB 预算约束（预检另留 1 KiB framing / request-id 余量）。已接收的超预算页返回 `history_page_too_large:`；脱敏或 sanitizer 裁剪会改变内容时返回 `history_page_not_lossless:`；原生页结构错误返回 `history_upstream_invalid:`。错误没有部分 data/cursor。即使 limit=1，一个 legacy turn 或 paginated item 仍可能无法无损交付；不自动 full-history read 或分块。超过 10 MiB 的 App Server 单行入站仍是连接级 fatal protocol failure，不能保证转成普通分页错误；下游裁剪、cursor 有效期与快照一致性不由 Bridge 保证。

------

## Native Search

`codex_search` 返回原生搜索 locator。`kind:"threads"` 映射 `thread/search`，区别于 `codex_threads` 的标题筛选；它没有 cwd / parent / ancestor 筛选，只接受原生 source / archived 范围，不能当作 workspace 或 ACL 隔离。`kind:"occurrences"` 映射 `thread/searchOccurrences`，要求指定一个 paginated thread；原生按时间顺序查找可见 user 与 final assistant 消息中的不区分大小写字面子串，不覆盖每个 tool / reasoning item。

每次只取一页，续页保持 query 与筛选条件，只有 `nextCursor:null` 表示结束。Occurrence 的 `turnCursor` 是同一 thread 的 `codex_history(kind:"turns")` 原生 inclusive anchor，不是搜索续页 cursor；`snippetMatchRange` 使用 UTF-16 code units，end 不包含在范围内。

可交付的页面保持原样；脱敏、裁剪、非法字段或 256 KiB 返回体上限会导致 `search_result_not_deliverable:`，不返回部分 data/cursor。Bridge 不建索引、不做 relevance 判断、不隐式 resume，也不以完整历史读取兜底。Legacy 支持与其他 native 错误由原生决定；搜索结果不保证完整审计或快照一致性。

------

## Native capability 与 lineage

`codex_threads` 的 list / read 结果沿既有有界脱敏路径保留原生线程事实；runtime 缺失时，`codex_observe.stored_thread` 也来自只读 metadata。原生 `canAcceptDirectInput` 表示 App Server 当时是否接受该 loaded thread 的直接 turn 输入：`null` 表示能力未知或不可用，不能当成 false；旧响应缺字段时仍保持缺失。它不证明跨客户端 writer ownership，也不作为 Bridge 的写权限判定或自动 resume 条件。

Lineage 直接读取原生 `sessionId`、`forkedFromId`、`parentThreadId` 与 source 信息。Session tree、fork 来源和 spawned parent 各有含义，Bridge 不互相推导，也不递归读取或保存关系图。Metadata 仍受既有 transport 脱敏与截断限制，不具有 History 的整页无损交付保证。

列举子线程时可用 `parent_thread_id` 查直接 spawned children，或用 `ancestor_thread_id` 查任意深度的 spawned descendants（不包含祖先本身）；二者不能同时给非 null 值。这两个筛选不用于枚举 forks。来源由 `source_kinds` 明确选择，例如：

```json
{"parent_thread_id":"<native-thread-id>","source_kinds":["subAgentThreadSpawn"],"limit":20}
```

省略 `source_kinds`、传 null 或空数组都保持 native 的 interactive-source 默认值，不隐式扩大到 subagents。筛选字段仅用于 list，不能与 `thread_id` 混用；null、省略、数组顺序及重复值原样转发。每次只读取一个有界 native page，续页沿用相同筛选与 native cursor；不做 Bridge tree walk、补查或全量扫描。这些筛选不增加独立工具。

------

## Native Goal

`codex_goal` 用 `action:"get" / "set" / "clear"` 管理指定 `thread_id` 的原生持久目标，每次只映射一个原生方法。Goal 服务 executor 的持续目标，`codex_checkpoint` 仍只保护 supervisor cognition；Bridge 不保存或重建 goal，也不隐式 resume、启动 turn 或恢复被清除的目标。

set 必须显式携带 `budget_mode`，没有默认 mode 或默认额度：

| budget_mode | Native tokenBudget | 公共参数要求 |
| --- | --- | --- |
| `preserve` | 省略，保留既有预算 | 不得携带 `token_budget` |
| `unlimited` | `null`，移除预算上限 | 不得携带 `token_budget` |
| `fixed` | 指定额度 | 必填正的 JavaScript safe integer `token_budget` |

旧式 set 缺少 mode、或直接传 `token_budget:null` 会在 native mutation 前拒绝。预算是可选资源上限；需要硬上限时选择 fixed，修改已有目标且不改预算时选择 preserve。此 gate 不影响普通 Turn、Queue 或 Steer。

set 还可携带 `objective`、`status`；其省略与 null 原样交给 native，不补默认值。目标的非空、4,000 字符限制及状态转换由 native 判定，Bridge 不截断或改写目标。safe-integer 上限仅保护预算的无损传输。

成功返回原生 goal / null 或 cleared 布尔值，保留原生字段。返回体经过既有脱敏与有界无损检查，最大 256 KiB；无法原样交付时返回 `goal_result_not_deliverable:`。对 set / clear，这表示 **native 已返回成功、mutation 已获确认，但响应无法交付**；不等同于确认超时的 UNKNOWN，也不应直接重试。没有自动补偿或第二套 goal 状态。

Goal updated / cleared 通知沿现有 compact/raw 通道可见。Active goal 的续跑由 native 决定；clear 不能作为中断正在执行的 turn 的替代品，需要中断时使用精确的 `codex_interrupt`。

------

## Native Queue

`codex_queue` 管理原生待执行 follow-up，提供 list / add / update / delete / reorder 五个操作。适用流程是 A 正在执行时排入 B、C，A 结束后由原生 Codex 自动依次执行。入队成功不代表执行完成；继续用 `codex_observe` 监督各轮，用 `codex_history` 恢复持久结果。`codex_steer` 仍用于纠正当前 active turn。

每次调用只映射一个 native queue 方法，不隐式 resume、启动 turn 或 queue，不创建 Bridge 队列、调度器或重试循环。add 必须携带调用方提供的 `client_user_message_id`；修改、删除和重排使用原生 `queuedSubmission.id`。该 client ID 没有经过本项目验证的幂等保证，不能作为自动重试依据。队列项可能在读取或修改期间被原生消费，成员关系、重排有效性及冲突由 native 判定。

add / update 仅接受文本；update 会把该条目的**整个 input 数组替换成一个 text item**，不会合并其他输入。list 原样保留可交付的 native input 类型，每次默认请求 20 条、最多 100 条，只返回一个 native page；只有 `nextCursor:null` 表示结束。重排最多传 100 个原生 ID，这是传输边界，不代表原生队列容量；Bridge 不补查、拼接或去重。

成功结果保留原生字段，并接受既有脱敏与有界无损检查，返回体上限 256 KiB。需要脱敏、裁剪或结构不合法时返回 `queue_result_not_deliverable:`；对变更操作，这明确表示 **native 已返回成功、mutation 已获确认，但结果无法交付**。已经发送但确认超时则是 UNKNOWN / possibly accepted。两种情况都不自动重试或补偿，应先读取 queue 与执行状态。

Queue changed 通知沿现有 compact/raw 通道可见。delete 删除待执行项，不中断已经开始的 turn。当前资格验证覆盖 active A→B→C；空闲／冷线程的启动、跨进程保留和多客户端并发写入不在本轮验证范围。此接口依赖当前原生 experimental queue API，升级时需重新核验。

------

## Model 与 reasoning effort

Bridge 不接管 Codex 的模型状态。

### 普通 continuation

如果 `codex_turn` 没有显式传入 `model` 或 `effort`：

- Bridge 不调用 `model/list`；
- 不推断当前模型；
- 不发送新的 model / effort override；
- 原生 Codex thread 自己继续保持已有状态。

### 显式 model override

如果 supervisor 明确指定 `model`：

Bridge 会临时读取一份新的、包含 hidden models 的原生 `model/list` catalog 来验证该模型是否存在。

这个 catalog：

- 只用于当前请求；
- 有分页和循环保护；
- 不持久化；
- 不形成模型 registry 或 cache。

### `model + effort`

如果同时指定模型和 reasoning effort：

Bridge 只在原生 catalog **明确证明不兼容**时本地拒绝。

如果 upstream 没有提供足够的 compatibility metadata，Bridge 不自行猜测，而把最终决定留给 native Codex。

### effort-only

如果只提供 `effort`：

Bridge 不尝试推断当前 thread 正在使用哪个模型。

它只会拒绝一个在当前 catalog 所有已公布 reasoning-effort token 中都不存在的值；这个 effort 对当前真实模型是否可用，仍由 app-server 决定。

`thread/read` 也不会被 Bridge 当作 current-model registry 的来源。

------

## 监督一个 turn

`codex_turn` 的成功返回只表示 native `turn/start` 已被接受。

长任务通常应继续通过 `codex_observe` 监督，而不是把“请求已接受”误认为“任务已经完成”。

可选的 `wait_ms` 上限为 `120000` 毫秒（120 秒），截止时间从本次调用开始固定；省略或设为 `0` 时立即读取。completed agent message、待处理请求、明确失败／警告、终态和无法识别的 native 事件会提前唤醒；已识别的 delta、成功命令等活动累计到下次唤醒或本次截止时间。Bridge 不进行 polling 或 stall detection。

默认 `view: "compact"` 跨 native chunks 排掉 silent events，仅交付有界的 typed supervision facts 与活动计数；`limit` 约束投影后的 facts。正常结果用 `next_cursor` 续读，只有 ring 缺口才附 `cursor_lost` / `cursor_floor`；命中内部排水上限会明确返回 `continuation: "drainage_yield"`。`view: "raw"` 保留原有 native 事件分页和等待行为，可用指定 native cursor 与 `wait_ms: 0` 下钻。真的没有 native 变化、待处理请求或终态时，截止返回仅含 `runtime_available`、`runtime_status`、`active_turn_id`、`next_cursor`、`no_change: true` 五字段。发生过活动不会标成 `no_change`；它也不表示 stalled。

一个典型流程是：

```text
codex_turn
    ↓
codex_observe
    ↓
 ┌───────────────┬────────────────┬─────────────────┐
 │ continue      │ steer          │ respond         │
 │ observing     │ same turn      │ real pending    │
 │               │                │ request         │
 └───────────────┴────────────────┴─────────────────┘
    ↓
terminal state / acceptance
```

几个重要原则：

- 长时间没有新命令输出，不足以证明 Codex 卡住；
- steer 应代表新的语义信息或纠正，而不是定时催促；
- respond 只能回答真实存在的 pending request；
- interrupt 只在确实需要停止当前 turn 时使用；
- `thread_id` 是 native Codex thread identity，不是 Bridge 发明的永久 task ID。

------

## UNKNOWN：不要直接重试 mutating request

以下原生请求如果已经成功写入 app-server，但等待 acknowledgement 超时：

- `thread/start`
- `thread/resume`（`excludeTurns:true`，恢复执行不灌入持久 turns）
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/goal/set` / `thread/goal/clear`
- `thread/queue/add` / `update` / `delete` / `reorder`

Bridge 会把结果视为：

**UNKNOWN / possibly accepted**

这不等于失败。

请求可能已经被 native Codex 接受，只是 acknowledgement 没有及时返回。

因此 supervisor 应：

1. 先 `codex_observe` 或读取 native state；
2. 判断原操作是否已经发生；
3. 再决定是否需要后续动作。

**不要因为 timeout 直接重发 mutating request。**

Bridge 不自动替 supervisor 做这种 retry。

------

## Elicitation 目前不受支持

`mcpServer/elicitation/request` 当前没有进入 Bridge 的 supported response surface。

如果 native Codex 发出这类 request：

- Bridge 会保留并暴露它；
- 不会静默吞掉；
- 不会猜测 response schema；
- 不会通过 `codex_respond` 随便构造答案。

只有未来存在明确、稳定并经过验证的上游 contract 时，才值得考虑支持。

------

## 快速开始

### 环境要求

- Windows 或 macOS
- Node.js 24+
- 官方 Codex executable
  - 可以直接通过 `codex` 找到；
  - 或使用 `CODEX_EXE` 显式指定。

本项目不捆绑、也不依赖 `@openai/codex` npm package。

### Clone、构建与测试

```powershell
git clone https://github.com/zoeynine/Local-Codex-Bridge.git
cd Local-Codex-Bridge
npm ci
npm run typecheck
npm run build
npm test
```

直接启动：

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe' # codex 已在 PATH 时可省略
npm start
```

### 配置 MCP client

严格的 MCP stdio client 应直接启动构建后的 Node entry：

```text
command: node
args:    C:\absolute\path\to\Local-Codex-Bridge\dist\src\index.js
env:     CODEX_EXE=C:\path\to\codex.exe   # optional
```

macOS 使用同一个构建入口，只需把 `args` 换成 `dist/src/index.js` 的绝对 POSIX path。

不同 MCP client 的配置格式可能不同，但最终应直接运行：

```text
node <repository>/dist/src/index.js
```

不要在 Secure MCP Tunnel 或其他严格 JSON-RPC stdio transport 后使用 `npm start`，因为 npm lifecycle output 可能污染 stdout 协议流。

当 Bridge 的 MCP tool set 发生变化后，已经连接的 MCP client 通常需要重新连接或重启，才能刷新自己的 tool catalog。

------

## 可选：Secure MCP Tunnel

远程 MCP 场景可以在 Bridge 前面使用 Secure MCP Tunnel：

```text
remote MCP client
        ↕
Secure MCP Tunnel
        ↕
node <repository>/dist/src/index.js
        ↕
native Codex
```

Tunnel 的认证、profile、port、ready endpoint 和进程生命周期属于外部配置。

本仓库：

- 不创建 Tunnel profile；
- 不保存生产凭据；
- 不内置生产端口；
- 不把 Tunnel control plane 变成 Bridge 自己的 HTTP API。

------

## Windows

### Optional Tray

`windows/` 中的 Tray 是已安装 Tunnel client 的轻量启动与状态层，不是 Bridge 核心运行时的必需组件。

Canonical launcher 名为 `LocalCodexBridgeTray.*`。

调试启动示例：

```powershell
.\windows\LocalCodexBridgeTray.Debug.cmd `
  -ReadyUrl 'http://127.0.0.1:<port>/readyz' `
  -ProfileName 'your-profile' `
  -TunnelExecutable 'C:\path\to\tunnel-client.exe'
```

Local settings 模板：

[`windows/local-settings.example.json`](windows/local-settings.example.json)

实际的：

```text
windows/local-settings.json
```

保持 ignored，不进入 Git。

配置优先级：

1. 显式命令行参数；
2. `LOCAL_CODEX_BRIDGE_*` 环境变量；
3. legacy `LUMEN_CODEX_V2_*` 环境变量；
4. ignored local settings。

旧的 `LumenCodexControlV2Tray.*` launcher 和 legacy env names 目前只作为兼容入口保留，不代表第二套产品。

Tray 不自动重启 Tunnel，并且只会在 process identity、profile、PID 等信息重新核验一致后，停止由当前 Tray 实例启动的进程。

------

## macOS

`Start Mac Codex Bridge.app`、`launcher/` 与 `bin/start-production-tunnel` 提供 macOS Finder / Tunnel 平台集成。

它们只是平台外层；真正的 Bridge 仍然运行同一个：

```text
dist/src/index.js
```

修改 launcher 或 Finder bundle 后，应在 macOS 12+ 上重新构建并验证：

```bash
launcher/build-launcher.sh
npm run test:macos
```

Windows 与 macOS 是同一 Bridge 的两个平台入口，而不是两套独立实现。

------

## 安全与信任边界

Local Codex Bridge **不会创建新的操作系统 sandbox**。

真正的文件、命令、网络与进程能力仍由 native Codex 的配置，以及每个 turn 的：

- `sandbox`
- `approval_policy`

决定。

例如：

- `danger-full-access` 会扩大 sandbox 允许的文件、命令和进程访问范围；
- `approval_policy=never` 不会自行扩大 OS sandbox，但会移除交互式审批这一确认层。

两者是不同的风险维度。

还需要注意：

- `codex_turn` / `codex_steer` 的自然语言指令可能促使 Codex 使用它已有的文件和命令能力；
- “Bridge 没有暴露一个 generic shell MCP tool”并不意味着 native Codex 不会执行命令；
- `codex_threads` 可以看到同一 OS user / Codex runtime 可见的持久线程，筛选条件不能充当访问隔离；
- Bridge 启动 app-server 时会继承自己的环境，但会移除 Tunnel 使用的 `CONTROL_PLANE_API_KEY`；
- 其他环境变量仍属于可信启动边界，不应放入不必要的 secrets；
- 实时事件和 pending request 会受到数量与内容 sanitization 限制，但 Bridge 不是 hostile multi-tenant gateway；
- checkpoint 应保持短小，不保存完整 prompt、transcript、原始事件、命令输出或最终回答。

远程使用时，应由经过认证并正确配置的 Tunnel 提供连接边界。

------

## 持久化

原生 Codex 负责持久化：

- threads；
- turns；
- conversation history；
- native execution results；
- thread goals 与 queued follow-ups。

Bridge 的：

- live event ring；
- active-turn runtime state；
- pending requests

主要存在于内存中。

Bridge 重启且缺失 live runtime 时，`codex_observe` 只读 `thread/read(includeTurns:false)` 元数据；`terminal:null` 和 `active_turn_id:null` 表示未知。返回的零值 live cursor、空 events / pending requests 只是 unavailable placeholders，不能重建 live state。需要持久历史时按需调用 `codex_history`。runtime 仍存在但 ring 已淘汰事件时，`cursor_lost` / `cursor_floor` 继续表示真实的 live 缺口。

### Checkpoint

`codex_checkpoint` 是唯一刻意保存的 Bridge-side supervisory state，而且保持有界。

Windows 新安装默认：

```text
%LOCALAPPDATA%\LocalCodexBridge\checkpoints\<sha256(thread_id)>.json
```

macOS 默认：

```text
~/Library/Application Support/LocalCodexBridge/checkpoints/<sha256(thread_id)>.json
```

可以通过：

```text
LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR
```

覆盖。

legacy：

```text
LUMEN_CODEX_V2_CHECKPOINT_DIR
```

目前仍保留显式兼容。

Bridge 不自动迁移旧 checkpoint。

------

## Deliberate non-goals

Local Codex Bridge 当前刻意不做：

- browser UI；
- HTTP control plane / HTTP MCP server；
- 第二套 task queue 或 job database；
- transcript duplication；
- model cache；
- current-model registry；
- queued-message facade；
- automatic mutating-request retry；
- automatic app-server restart；
- generic shell / `command/exec` MCP surface。

以下 upstream 能力也没有因为“存在”就自动加入 Bridge：

- `command/exec`
- `sourceKinds`
- elicitation response
- provider / `serviceTier` capability abstraction

它们只是未来可以重新评估的候选，不是 roadmap promise。

Bridge 的目标不是把所有 Codex app-server API 都搬进 MCP，而是只暴露监督真正需要的最小 surface。

------

## Upgrading Codex

Bridge 必然依赖少量 native app-server protocol assumptions。

这些依赖、当前验证状态、对应代码位置，以及 upstream 改变后需要重新检查的内容，都集中记录在：

[`PROTOCOL-ASSUMPTIONS.md`](PROTOCOL-ASSUMPTIONS.md)

升级 Codex runtime、修改 protocol-facing behavior，或者相关 regression test 开始失败时，应优先重新核对这份 checklist，而不是凭旧实现经验直接修改 Bridge。

------

## 开发与测试

常用检查：

```powershell
npm run typecheck
npm run build
npm test
```

`npm test` 会运行共享 runtime / app-server / MCP / checkpoint / platform / shutdown / UX projection 测试，并继续执行当前平台对应的集成测试。

真实 Codex smoke 与普通测试刻意分开：

```powershell
npm run smoke:live
```

它会实际调用 native Codex，并可能留下持久测试 thread；只有明确接受这些副作用时才运行。

主要实现位置：

- `src/mcp.ts` — MCP stdio / JSON-RPC boundary
- `src/app-server.ts` — native Codex app-server process / protocol adapter
- `src/tools.ts` — 12 tools、schema 与 supervisory semantics
- `src/runtime.ts` — bounded live runtime state / events / pending requests
- `src/checkpoint.ts` — optional supervisory checkpoint
- `src/platform.ts` — Windows / macOS platform boundary
- `src/version.ts` — canonical Bridge version
- `src/ux-projection.ts` — optional UX projection / compatibility
- `windows/` — optional Windows Tray
- `launcher/`, `bin/`, `Start Mac Codex Bridge.app` — optional macOS integration

------

## License

MIT License — see [`LICENSE`](LICENSE).

## 协作贡献者与致谢

协作贡献者：**小年（ChatGPT）**、**Codex**。

谢谢一起把“让外部 AI 真正监督 native Codex”从一个小想法，一点点压成了一层足够薄、边界足够清楚、也愿意公开给别人继续折腾的 Bridge。`(*╹▽╹*)`

以及谢谢**予安**，没有你我也不会试着去做些什么ღ( ´･ᴗ･` )
