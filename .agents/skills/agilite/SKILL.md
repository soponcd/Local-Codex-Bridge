# AGILite project entry

从目标 Git 项目或当前 worktree 内运行 CLI 时，先定义：

```sh
agilite_cli() (
  agilite_project_root="$(git rev-parse --show-toplevel)" || exit
  agilite_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || exit
  cd "$agilite_common_dir" || exit
  PYTHONPATH="$agilite_project_root/.agilite/runtime" python3 -B -m agilite_runtime --target "$agilite_project_root" "$@"
)
```

需要恢复项目任务时，先运行 `agilite_cli list`，随后对所选任务 `agilite_cli resume --input /absolute/resume.json`。该函数先进入 Git common-dir，再显式加载当前 worktree 的已安装 runtime，避免根目录同名源码包遮蔽。修改型操作使用 CLI JSON 文件和原始 fence；不得猜测 host stopped。
规则见 `.agilite/policy.md`。本 Skill 不派工、不调用模型 API。项目 Controller 与角色线程生命周期见 `.agilite/controller-lifecycle.md`；初始化宿主绑定使用 controller-status/controller-update，不以安装成功当作线程建立。dot为主要跨项目入口，直接用户输入汇入同一目标版本；Controller持续负责适用Git交付、资源安全收尾与角色归档；局部done不等于远端交付。来源关联不授权跨chat发信。
已有受管 `.agilite/python-executable` 时，正常模块 CLI 在开库前校验manifest/hash并切换至该项目解释器；init/upgrade保留它，不修改全局PATH。旧安装首次由已验证解释器upgrade后才具有绑定；直接导入TaskStore或旧长驻句柄不自动切换。
构建新资产/模块/功能时，claim 前先读本机 `$find-wheel` 完整技能并做 Phase 1；用 `wheel-record`、`wheel-bind` 保存和绑定记录。现有 `capability-find` 仅查本项目已有能力，不等于外部方案检索。目标/验收/接口架构/关键依赖改变后重新绑定；不要在写完代码后补称已做前置检索。
UI任务先读 .agilite/ui-workflow.md。主控收集用户决定，执行者以ui-record/ui-decide保存节点和原始消息引用；ui-status/resume读回后继续可执行节点，不猜测已确认。先环境/形态与架构后技术栈和表达；项目已有信息组织模式优先，按用途选择App及模块模式。无UI声明no_ui与理由；已有产品仅做适用差异。程序门与模型约定边界见流程文档。
技术架构与真实UI节点的产物和验收引用 .agilite/ui-workflow.md#ui-four-layers 单一规则源；职责映射与适用检查在原节点内记录，不另建四套模板或审批。
