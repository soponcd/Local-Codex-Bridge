# Find-wheel Phase 1

直接可用方案为既有上游 https://github.com/zoeynine/Local-Codex-Bridge 和已部署 safety 实现。
适用性：直接满足本机 native Codex → MCP 适配器，保留8工具与protocol；复用现有源码、测试和fail-closed部署，避免另建任务/history系统。
没有以stars选择大型平台；本任务是单用户维护fork，不需要商业MCP网关或新增云服务。
假设：保持冻结2.1.3协议，不隐式升级网页现有2.3.0；发布仅candidate，生产收敛属独立授权阶段。

| 阶段 | 成本判断 |
|---|---|
| 开发期 | 复用已确认上游与部署补丁，主要成本为provenance、参数化、隔离测试和运维文档 |
| 上线日 | 本地Node和外部Tunnel现有依赖，未新增付费服务；部署需独立复核与窗口 |
| 增长期 | 单用户维护fork需跟踪upstream差异，Native协议变更需独立兼容评估，无新供应商锁定 |

Phase1已找到直接匹配方案，停止，不进入学术Phase2。成本实际用量unknown，不声称已节省固定比例。

## Daemon attestation (LCB-DAEMON-13)

复用既有 `runtime-load-proof.mjs` 的捕获策略，抽出同步 `captureRuntimeLoads`。官方现成接口为 [Node registerHooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions) 的 `nextLoad` 实际 source，以及 [Node net](https://nodejs.org/api/net.html) 的 Unix domain socket、超时与显式销毁。macOS 自带 ps/launchctl/lsof 提供独立进程关系与 socket 归属证据；没有增加第三方依赖、云服务或公共 MCP 工具。直接适合本机单用户环境；不将同一 UID 的恶意进程隔离作为该方案能力。开发期成本为固定小协议、进程绑定、隔离攻击测试；上线日无新增费用但需一次有备份的 wrapper bootstrap；增长期只跟踪 Node 与 macOS 接口，无供应商锁定。实际用量 unknown，Phase 1 结束。

## Stage E diagnostic repair (LCB-STAGEE-FIX-11)

复用既有 manifest-scoped deploy/verifyLive 和 Node 内置有界超时，无新增重试库、服务或持久任务系统。官方接口来源：[AbortSignal.timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)、[spawnSync timeout/killSignal](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)。仅对部署后的只读健康门重试，不重放 mutation 或 restart。开发期成本是小范围诊断投影和虚拟时钟测试；上线日无新增依赖或费用；增长期仍是单用户有界窗口，无新锁定。实际用量 unknown。
