# 运维

本次仅形成 candidate；生产安装仍运行事故修复版本（package 2.1.3）。已有备份路径在 provenance 所指事故源的 `deployment-backups/deployment-gBp147`，仅作追溯，不作为本项目运行依赖。

## 配置与安装

唯一正式首入口是独立保存且已复核哈希的包外runner：`NODE EXTERNAL_VERIFIER PACKAGE_ROOT OPERATION`。
OPERATION 为 `--verify`、`--check`、`--deploy` 或 `--rollback CONTRACT.json`。runner先校验整个sealed包，再按固定名称执行包内模块，并绑定其自身为外部trust verifier。
不要执行包内 `deploy.sh`、`scripts/install`、`scripts/rollback` 或包内JS作为可信首入口；包内shell默认拒绝运行，即使它被篡改为exit0，正式包外入口仍先拒绝sealed hash不匹配。
部署需显式配置 `LCB_PRODUCTION_ROOT`、`LCB_LAUNCH_AGENT`、`LCB_BACKUP_ROOT`。Node必须24+，包外runner路径和哈希应在可信渠道独立复核。
`LCB_LAUNCH_AGENT` 仅接受 `gui/<uid>/com.openai.tunnel-client.lcb-remote`。
验证配置还需 `CODEX_EXE`、`LCB_HEALTH_URL_FILE`、`LCB_TUNNEL_CLIENT`、`LCB_PID_FILE`、`LCB_STDIO_WRAPPER`；这些路径应在部署前 live-read，并与 manifest 的 host_code_hashes 相符。
不要把 profile、URL 文件内容或凭据复制到仓库。模板不包含健康 URL 或实际认证配置。

先运行包外runner的 `--verify` 或 `--check`。前者只校验发布封存，后者另核对生产/host 基线，均不重启。
部署前独立复核、用户授权、活动任务确认、包外 verifier 哈希确认缺一不可。
确认授权后包外runner的 `--deploy` 执行隔离测试/构建、备份、manifest 文件替换、dist 原子交换、精确 kickstart。
运行证明必须包含实际模块 SHA-256、wrapper 子进程身份、Tunnel PID变化、MCP initialize/8 tools/codex_models 和真实远程路由。`probe_loaded_runtime` 仅证明验证器启动的短命 wrapper 所加载字节，不能提升为 Tunnel 长驻 Bridge 的 loaded-instance claim；后者须独立 `daemon_loaded_runtime` 证明。
自动安装的额外历史验证目前需要显式 `LCB_ALLOW_HISTORY_VERIFICATION=1`、`LCB_TEST_HISTORY_ID`、`LCB_TEST_HISTORY_FILE`，且先批准专用隔离 fixture；没有配置会 fail-closed 并回滚。

## 只读健康与正常启动

正常启动依外部 LaunchAgent；本项目不安装、替换或修改现有 Tunnel profile。
healthz/readyz、control-plane poll、wrapper initialize、tools/list、models 与实际模块加载是不同证据。
只有 native app-server → codex_apps → local_codex_bridge.codex_models(limit=1) 成功才确认真实远程路由；不会以直接 Responses API 替代。

## 安全重启与故障

重启仅对已核对身份的精确 domain/label 执行 `launchctl kickstart -k TARGET`。记录重启前后 PID/运行次数并证明模块已加载。
JSONL overflow 时首个 fatal 是事实；code=0 的退出不能覆盖它。保持10 MiB上限，停止无界读取；不要记录协议正文。
Bridge unavailable 时区分外层 Tunnel 与内部 child；安全读取最多一次显式恢复，mutation/response 永不自动重放。
未获许可不能终止 Desktop、其他任务或所有 Codex 进程。

## 显式回滚

自动部署失败会恢复文件与 dist，并重新定向启动旧实例；不确定 kickstart 仍触发恢复后的再次定向重启。
显式包外runner `PACKAGE_ROOT --rollback CONTRACT.json` 需要包外冻结的 `LCB_ROLLBACK_CONTRACT_SHA256`；合约字段为 `production`、`backup`、`backup_baseline_sha256`、`changed`、`expected_current`、`agent`、`host_code_hashes`。
合约须依据上次 JSON receipt 与完整备份生成、独立复核；expected_current 是当前部署文件哈希，backup/files 与 baseline.json 是旧版本来源。
`backup_baseline_sha256` 必须在冻结合约时绑定已复核的backup/baseline.json字节，旧文件哈希由该冻结baseline授权；不能在回滚时按现有备份重新接受新hash。同步篡改备份文件和baseline将被拒绝。
回滚先核对 current 和备份哈希，按 allowlist 恢复文件和原子交换 dist，然后精确重启并验证旧模块实际加载与真实远程只读调用。
契约变化或 current mismatch 必须停止，不通过重新计算 current 哈希来绕过冻结基线。

## MANUAL_RECOVERY_REQUIRED

保留 receipt、backup 与 displaced runtime，停止扩大修改。先核对精确文件/进程身份和旧文件哈希。
只有明确目标、有效备份、回滚和验证路径后才进行授权恢复。不能证明旧实例加载时，文件恢复不能报告为服务恢复。

## Stage E candidate.6 诊断修复

来源：LCB-STAGEE-REVIEW-10 的主控提供脱敏结论（无单独复核文件）。其 P1 是逐轮子门未持久化；P2 是短命 wrapper probe 被误称为长驻 loaded instance。复核指出日志中候选 poller 于 13:41:21.745Z 启动，13:41:56.750Z 超时，13:42:05.286Z 开始回滚；35 秒 timeout 是控制面线索，历史失败子门仍未知，不能追认单一根因。

部署后只读健康窗口为90秒、最多18轮、轮间最多5秒，容纳两次35秒控制面请求及恢复间隔；每轮操作共享剩余截止预算，owned child 清理最多额外6秒。仅重试验证，不重试 kickstart 或 mutation。每轮将 phase、attempt、elapsed_ms、healthz/readyz/control-plane/wrapper/history/probe/daemon/remote 门的 passed/failed/not_run 和固定错误分类即时写入 backup/verification-attempts.json，并带入 result.json；两阶段总记录最多36轮。没有协议正文、历史正文、凭据或完整远程响应。

当前实现没有安全绑定真实长驻 Bridge 子进程的模块加载字节，`daemon_loaded_runtime` 明确未证明。探针、Tunnel PID变化及真实远程只读调用不能替代这个门；自动恢复文件后若仍缺实例证明，继续报告 MANUAL_RECOVERY_REQUIRED，不能称服务恢复。candidate.6 只声明 local validation/check，不声明 installed/runtime effective/production accepted。

由于缺少真正 daemon attestation，正式 `--check` 可以通过字节/host 基线检查，但同时输出 `deployment_ready=false`、`blocker=daemon_attestation_unavailable`。正式 `--deploy` 与 `--rollback` 在生产写入、dist 交换和 kickstart 之前拒绝；生产基线仍已恢复，当前不需要回滚。另一个候选切片必须先实现长驻 daemon attestation，不能仅修改 readiness 常量来绕过该门。
