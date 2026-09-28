# 更新日志

当前本地候选版本为 **V2.1.3-local.1**。本地 fork 基于已部署的 upstream V2.1.3 / `ff5d8804008a5a8c483a5925bd20c90f21cc67fd`；上游最新版本可能不同，本次不升级 API。

## V2.1.3-local.1（2026-09-28 candidate）

- 精确导入生产 manifest 的 16 个已部署路径和两项既有兼容验证脚本，导入 SHA-256 见事故 provenance。
- 保留首个 JSONL fatal、限制诊断、释放缓冲；上限保持 10 MiB，mutation 不自动重放。
- 历史读取改为 metadata + 原生分页，拒绝无界读取；不存储历史正文。
- 信任锚点置于包外，部署与回滚保留 fail-closed、定向 kickstart 和旧运行实例加载证明；参数化 host/fixture 路径。
- 隔离 tamper、rollback、overflow、remote 只读协议测试；增加版本化封存包和文档。未部署生产。
- 兼容边界：Node.js 24+、macOS 当前验收；Windows 测试本机未运行。8 个工具保持不变。可选签名 launcher 未重编译，版本仍为 upstream 2.1.3。

本文件只记录当前公共仓库 Git 历史中可以核验的事实。当前公开版本为 **V2.1.3**；公共历史中没有单独的 V2.1.0 发布记录。

## V2.1.3（2026-08-24）

- 新增第 8 个公开工具 `codex_models`：按需读取有界的原生 `model/list` 页面；显式 model/effort override 使用新鲜、有界且防游标循环的 catalog 校验，不建立 Bridge 模型缓存或当前模型状态。
- 将公共运行与测试基线扩展为 Windows 和 macOS、Node.js 24+，保留各平台原生路径与精确子进程生命周期边界；CI 在 Windows 与 macOS 上执行等价验证。
- 对显式 sandbox 与 approval policy 使用 `thread/start` / `thread/resume` 返回的原生有效 policy 做失败关闭核验；省略 override 时保持原生默认，不增加 Bridge 状态或额外读取。
- 将缺失有效 status 的 `turn/completed` 保守投影为 `unknown`，并把流式 agent 文本保留改为有界尾部，避免丢失最终结论。
- 补充原生 app-server 硬依赖清单与版本锚点校验；V2.1.3 必须存在对应的 CHANGELOG 版本章节。

## V2.1.2（2026-08-12）

- 对已经发送但确认超时的原生变更请求保留有界的晚到响应上下文；晚到成功或错误会成为已清理、可观察的运行时证据，并以保守规则对账，不自动重试，也不覆盖更新的活动回合或终态。
- 在 app-server 入站边界拒绝重复的未决请求 ID，并以 claim / release / complete 生命周期保护真实 pending request，避免并发响应、身份替换或误清理。
- 当调用者显式请求 sandbox 时，先核验 `thread/start` / `thread/resume` 返回的原生 policy，再把同一 policy 传给 `turn/start`；缺失、类型不符或模式不匹配时在启动回合前失败关闭。
- 将公开工具 schema 中的线程、回合、工作目录、游标和方法字符串上限与既有运行时校验对齐，并把独立 tools 回归测试纳入完整测试套件。
- 将包元数据、Bridge 上游 `clientInfo`、MCP `serverInfo` 与公开文档统一为 `2.1.2`，并补录 V2.1.1 版本化与后续 canonical convergence 提交。
- 保持 7 个工具及既有薄桥边界不变；`codex_observe.wait_ms` 仍默认 `0`、上限 10 秒，仍是一次事件驱动等待，不增加轮询、自动重试、自动重启或进程控制。

## V2.1.1（2026-08-11）

- 完成监督与控制边界加固：会改变原生状态的请求若在发送后等待确认超时，会明确报告结果为 `UNKNOWN`，Bridge 不会自动重试、取消或推断结果。
- 在 MCP 客户端→Bridge 入站边界拒绝仍在处理中的重复活动请求 ID，同时不干扰原请求的取消、清理及后续 ID 复用。
- 收紧 `codex_respond` 的前向兼容边界：只响应具有明确原生契约的已支持方法；未知方法保持已清理、可观察和 pending 状态，并且不发送响应。
- 加强 app-server 与 MCP 回归测试，覆盖变更请求确认超时、原生写入仍 pending、未知请求、已知用户输入响应和 MCP 入站重复活动请求 ID 等边界。
- 将项目包版本、Bridge 上游 `clientInfo`、MCP `serverInfo` 与公开文档统一为 `2.1.1`。

## 可核验的公共历史

- `53e97f6`：将 self-use 与 public 工作树收敛为同一 canonical repository。
- `8991e70`：将 Bridge 收敛到 public-safe canonical tree。
- `53536f2`：回填已接受的 V2.1.1 重复请求加固。
- `9a8b8f3`：归档已接受的 V2.1.1 监督加固状态。
- `0a99f39`：完成 V2.1.1 公共版本化，并由 `v2.1.1` 标记。
- `ccd98f2`：V2.1.1 公共监督边界加固。
- `c28fc37`：中文优先的 README 与 `AGENTS.md` 公共文档完善。
- `8996398`：Local Codex Bridge 初始公共基线。

上述 V2.1.1 发布及早期公共基线提交日期为 2026-08-11；后续加固归档、回填与 canonical convergence 提交日期为 2026-08-12。
