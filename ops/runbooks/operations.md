# 运维

本次仅形成 candidate；生产安装仍运行事故修复版本（package 2.1.3）。已有备份路径在 provenance 所指事故源的 `deployment-backups/deployment-gBp147`，仅作追溯，不作为本项目运行依赖。

## 配置与安装

`deploy.sh` 在 sealed package 根目录运行。必须显式配置 `LCB_NODE`、`LCB_TRUST_VERIFIER`（包外）、`LCB_PRODUCTION_ROOT`、`LCB_LAUNCH_AGENT`、`LCB_BACKUP_ROOT`。
`LCB_LAUNCH_AGENT` 仅接受 `gui/<uid>/com.openai.tunnel-client.lcb-remote`。
验证配置还需 `CODEX_EXE`、`LCB_HEALTH_URL_FILE`、`LCB_TUNNEL_CLIENT`、`LCB_PID_FILE`、`LCB_STDIO_WRAPPER`；这些路径应在部署前 live-read，并与 manifest 的 host_code_hashes 相符。
不要把 profile、URL 文件内容或凭据复制到仓库。模板不包含健康 URL 或实际认证配置。

先运行 `scripts/verify PACKAGE_PATH` 或包的 `deploy.sh --check`。前者只校验发布封存，后者另核对生产/host 基线，均不重启。
部署前独立复核、用户授权、活动任务确认、包外 verifier 哈希确认缺一不可。
确认授权后包内 `deploy.sh` 执行隔离测试/构建、备份、manifest 文件替换、dist 原子交换、精确 kickstart。
运行证明必须包含实际模块 SHA-256、wrapper 子进程身份、Tunnel PID变化、MCP initialize/8 tools/codex_models 和真实远程路由。
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
显式 `scripts/rollback CONTRACT.json` 需要包外冻结的 `LCB_ROLLBACK_CONTRACT_SHA256`；合约字段为 `production`、`backup`、`changed`、`expected_current`、`agent`、`host_code_hashes`。
合约须依据上次 JSON receipt 与完整备份生成、独立复核；expected_current 是当前部署文件哈希，backup/files 与 baseline.json 是旧版本来源。
回滚先核对 current 和备份哈希，按 allowlist 恢复文件和原子交换 dist，然后精确重启并验证旧模块实际加载与真实远程只读调用。
契约变化或 current mismatch 必须停止，不通过重新计算 current 哈希来绕过冻结基线。

## MANUAL_RECOVERY_REQUIRED

保留 receipt、backup 与 displaced runtime，停止扩大修改。先核对精确文件/进程身份和旧文件哈希。
只有明确目标、有效备份、回滚和验证路径后才进行授权恢复。不能证明旧实例加载时，文件恢复不能报告为服务恢复。
