# Local Codex Bridge

本地正式维护项目的唯一源码源位于本仓库；安装目录仅承载经过批准的发布版本。
本次 **V2.1.3-local.1** 是 candidate，未执行生产部署。完整上游说明保留在下文。

```text
本仓库源码 → 隔离测试/构建 → sealed release + 包外 trust verifier
  → 生产基线核对 → 备份 → manifest 文件替换 + dist 原子交换
  → 定向 kickstart → 实际模块加载证明 → MCP initialize / 8 tools
  → native app-server → codex_apps → local_codex_bridge.codex_models(limit=1)
```

开发要求 Node.js 24+：`npm ci --ignore-scripts`、`npm run typecheck`、`npm test`。
隔离验证：`node scripts/validate-fix.mjs --isolated --output .validation`。
发布：验证通过并提交源码后执行 `npm run package:local`；新目录不可覆盖。
`releases/<version>/package` 是封存包，`releases/trust/<version>/verify-package.mjs` 是包外冻结信任锚点。
信任锚点必须由可信渠道单独保存/复核，不能从待安装包提取或重新计算来接受篡改。
发布包含源码和 dist，不含 node_modules；干净解包后可 `npm ci --ignore-scripts && npm test`。
安装/回滚的显式配置、授权边界和异常恢复详见 [运维手册](ops/runbooks/operations.md)。
外层 healthz/readyz=200 只能证明 Tunnel 层；完整健康还需要控制面轮询、MCP、真实远程只读调用和实际加载证明。
事故机制和未知触发 RPC 详见 [事故报告](incidents/2026-09-28-jsonl-overflow/README.md)。

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

## 当前测试候选版本

**V2.1.3-local.1** · [CHANGELOG](CHANGELOG.md)

V2.1.3 继续收紧 Bridge 作为 supervisory adapter 的边界，并补充：

- 原生 `model/list` 的按需发现；
- `codex_turn` 的可选 model / reasoning-effort override；
- stable permission approval response；
- mutating acknowledgement timeout 的 UNKNOWN 语义；
- 公开工具描述与运行时约束的一致性；
- 统一版本锚点与升级假设检查。

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

## 8 个 MCP 工具

| Tool               | 用途                                                         | 边界                                                         |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `codex_threads`    | 列出、搜索、读取原生 Codex 持久线程                          | `cwd` / search 只是筛选条件，不是 ACL                        |
| `codex_models`     | 按需读取一页原生 `model/list`                                | 不缓存模型目录，不维护 current-model registry                |
| `codex_turn`       | 创建或恢复原生 thread，并启动一个 turn                       | 返回 accepted 不等于任务完成；model / effort 都是可选 override |
| `codex_observe`    | 有界读取实时事件、持久历史、pending requests、terminal state 与 cursor | 支持一次 bounded wait；安静不等于卡死                        |
| `codex_steer`      | 对同一个 active turn 追加语义纠正或新意图                    | 不是 timer、polling 或 retry 机制                            |
| `codex_respond`    | 回答真实存在且 Bridge 明确支持的 approval / user-input / permission request | 必须保留原始 request id 和准确 scope；不支持 elicitation     |
| `codex_interrupt`  | 中断准确的 active thread / turn                              | 只发送原生 interrupt，不重启 Bridge 或 app-server            |
| `codex_checkpoint` | 保存可选、精简、有界的 supervisory anchor                    | 不是 transcript、job id 或 Codex history 的替代品            |

完整 schema 与运行时限制以 [`src/tools.ts`](src/tools.ts) 为准。

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
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

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
- native execution results。

Bridge 的：

- live event ring；
- active-turn runtime state；
- pending requests

主要存在于内存中。

Bridge 重启后，`codex_observe` 可以从 native persisted history 回退恢复有限观察信息，但不会伪造已经丢失的 live state。

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
- `thread/turns/list`
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
- `src/tools.ts` — 8 tools、schema 与 supervisory semantics
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
