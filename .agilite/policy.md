# AGILite project policy v10

当前用户授权决定范围；项目已有业务真源继续负责业务数据与权限。
模型与 effort 仅从本机 ~/.agents/skills/astra-task-router/roles.json 解析；本文件不复制映射。项目主控 `controller` 只负责用户沟通、范围与验收、派工、汇总证据及最终裁决，不亲自读取、编码、运行或核查；复杂协调用 `decision` / `decision-hard`。`developer` 为主开发，困难实现用 `difficult`，窄任务用 `helper`；独立复核按风险用非原执行者的 `reviewer` / `reviewer-high` / `reviewer-decision`。spawn 前运行该技能 scripts/resolve_role.py 解析并核对宿主可用性；未知/损坏/不支持即阻断，不静默回退。
默认一位 writer；worker/reviewer 不递归派工。双 writer 只在独立 worktree、范围和集成顺序经验证后显式启用。公共接口、数据含义、目标变更、反复无进展与准备集成触发针对性复核；反证可带证据复议一次。
共库持久并发策略默认1，仅通过writer-policy读回及writer-policy-set显式1↔2切换；无活动reservation/attempt/待处理integration时才可变更，同入口回滚。新建只接受None或严格整数1/2，打开、初始化和升级不重置既有策略。并发领取在同一SQLite事务内核对当前策略和资源；更改策略不认证owner身份、不保证绕过入口的操作。
所有状态变更调用同一 TaskStore；fence 由原操作结果显式传递。检查记录与真实代码版本关联；review 区分目标对齐与技术正确性。完成以集成目标的实际读回及通过的检查为准。
模型路由文本仅为 requested 策略。项目 .codex/config.toml 是从中央角色映射生成的 controller/新线程/默认子代理投影，只为受信任项目提供默认值；每次 spawn 仍须按角色显式解析、核对宿主可用性并指定模型与 effort。恢复旧线程时必须显式选择 GPT-6 并读回本次 turn_context，不能把项目默认值当作旧线程已纠正。effective 必须由宿主元数据读回；缺失时 unknown。此项目不更改全局模型配置，不调用独立模型 API。
任何新资产、模块或功能构建都先运行 $find-wheel Phase 1，查项目已有能力及适用外部方案，再编码；小任务可短记且复用仍适用的检索，不免检。记录来源/版本/UTC时间、候选适用性、reuse/adapt/build 理由与开发/上线/增长三阶段成本，绑定任务目标/验收/范围/依赖/设计基准；重大变化重绑。普通纯只读/诊断任务才显式标 kind=nonbuild，write_scope=[]，不得提交代码 diff 或新能力；将构建伪装为 nonbuild 不符合规则。TaskStore 的 claim/交付门只验证记录结构、摘要、版本和登记时序，不能认证搜索语义或约束绕过入口的操作。技能从本机 Codex skills/find-wheel/SKILL.md 或显式 AGILITE_FIND_WHEEL_SKILL 读取；缺失须先安装/配置，不自动下载全局技能。
新增实现前先确认真实需求、关键输入输出与实际数据流，再依次判断：无需新增实现、项目已有能力、标准库、平台原生能力、现有依赖、极简实现；这些均不足时才写最少有效代码。选择精简实现时仍须保留适用的安全措施、输入校验、错误处理与可访问性。此判断是实现取舍，不取代实际构建写入前的 $find-wheel Phase 1、记录与绑定。
涉及UI时主控按 .agilite/ui-workflow.md 展示并交互确认：目标蓝图不足先补齐，先使用环境/产品形态后技术栈，同层同标准需求单元按用途聚合模块，分别选择App级/模块级信息组织模式，以结构树与核心动态流程共同确认架构，再做信息表达和真实UI。先复用项目模式目录，再用流程内候选目录；架构按用途选，不等同视觉风格，不以多个近似demo代替架构确认。真实UI阶段使用适用UI技能，模板差异执行find-wheel。先通过ui-record声明scope为required或no_ui，已有栈仅处理差异，不默认Web，不要求旧项目重复初始化。用户决定引用原始消息并绑定当前节点摘要，用ui-decide登记；不得由Agent或测试冒充。ui-status/resume/status读回持久状态，节点内容变化/任务revision变化使相应确认及下游失效。程序只在显式required流程中限制真实UI节点和submit；不认证用户身份、语义或绕过入口的操作。未配置的历史任务仅提示，无UI例外需说明依据。用户UI验收不等于业务完成。
技术架构与真实UI节点的产物和验收应用 [UI四层原则](ui-workflow.md#ui-four-layers)，以该文档为单一规则源；用户批准的AGILite原则，不声称ESD原文，不增加四个审批阶段或runtime门禁。
