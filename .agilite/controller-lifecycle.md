# 项目 Controller 与角色线程生命周期

初始化建立唯一的 **项目名 + Controller** 主控聊天（默认展示为 `项目名 Controller`），统一调度、编排和推进项目。用户沟通、目标与范围、计划、授权边界、模型选择、派工、跟进、阶段检查、汇总证据、验收裁决和最终交付等现有职责全部保留；新增角色线程全生命周期管理。Controller 不亲自读取、编码、运行或核查，执行及独立复核按 Astra 规则交给角色代理。它是协调者，不替代 TaskStore、Git 或业务真源。

## 初始化：安装 → 宿主创建/复用 → 读回绑定

`scripts/agilite-init` 是唯一安装器，只安装并验证项目文件与共享 TaskStore，不调用宿主或模型。exit 0 / `ok:true` / `installation_verified:true` 只证明安装检查。脚本返回 `controller` 与 `initialization_complete:false`；最后一个值表示本次 shell 没有验证宿主。即使登记为 bound，每次初始化仍须 fresh 宿主读回，才能对用户报告整体初始化完成。`--dry-run` 不登记、不创建、不发送消息。

初始化技能接着执行以下流程；只作用于用户明确指定的项目，不把当前 AGILite 源仓库当作默认替代目标。

1. 用安装副本 `controller-status` 读取共享库主控状态。`root`/`project_id` 是同 Git common-dir 的身份；worktree 使用相同主控和主项目名称，不能按 worktree 名另建。宿主 `projectId` 与 TaskStore `project_id` 不同，必须分别核对。
2. 用原生 `list_projects` 找与登记 `root` 对应的唯一已保存本地 Git 项目；再以 `list_threads`/有界 `read_thread`，必要时有界 `list_archived_threads`，寻找该项目的现有 Controller。标题只能辅助筛选，不能证明职责/归属；核对项目关联、目录、线程角色原文和未完成工作。已有有效 Controller 优先复用并在同一线程改为目标标题；不要向无关聊天发消息。候选不唯一时保留 pending 并报告准确候选；没有 saved project 时保留 pending 并报告宿主项目登记缺口，不创建 projectless 替代。
3. bound 只核对登记的线程ID；不要因空闲、notLoaded、列表未出现、归档或模型不匹配另建主控。已归档的主控按本次初始化授权原生恢复再读回。若绑定不符/线程找不到，保留登记并调查；不自动重绑第二主控。
4. 确认确无现有主控且状态 pending 后，通过 `controller-update` 的 `start` 在调用创建工具**之前**登记操作。start 为 CAS：两个初始化仅一个能开始创建；失败方重新读状态，不调用 create。start 后只调用一次原生 `create_thread`，target 为该保存项目的 local 环境，title 为登记的完整标题，prompt 带入本文件职责、项目身份、授权范围及下一步。本次用户初始化要求即创建 Controller 授权；普通 worker 切片用原生 sub-agent，不默认创建用户可见新聊天。
5. 创建/恢复前解析当前 controller role，并核对宿主支持。仅在受支持且本次授权允许显式模型选择的原生入口传当前角色模型/effort；不得违反入口参数限制或另建独立调用链。若入口仅允许宿主默认选择，创建后核对本轮身份；不支持当前角色时只阻断对应宿主切片，不能称路由生效。创建工具若规范化标题，在实际threadId出现后以原生 set_thread_title 设置登记标题并鲜读，再bind；不能仅信请求标题。创建返回的 clientThreadId 不当成 threadId；等待 setup/实际 threadId，读取该线程及项目列表，核对 `id,title,cwd,projectId,hostId`。这些字段可以来自多个原生返回的同一 threadId/projectId 关联组合；保留每个字段来源引用，不把输入路径当成读回。若 read_thread 不返回 cwd/projectId，补 list_threads/list_projects 或可用的原生精确线程元数据；字段仍缺失则保持 creating，不能伪造快照。effective 缺本轮宿主证据保持 unknown，不用项目投影代替。
6. 将实际宿主快照与证据引用传给 `bind`，再 `controller-status` 读回。该输入是调用者提供的结构检查，程序不认证宿主来源或业务验收。仅在真实宿主读回与登记一致后报告“初始化完成”；实际 threadId 返回主控供 final 使用宿主的 created-thread 指令。

`start` / `bind` / `retry` JSON（通过安装副本 `agilite_cli controller-update --input <file>`）：

```json
{"action":"start","expected_revision":0,"host_project_id":"实际保存项目ID","evidence":"本次list_projects唯一匹配的证据引用"}
```

```json
{"action":"bind","expected_revision":1,"snapshot":{"id":"实际threadId","projectId":"实际保存项目ID","hostId":"local","cwd":"登记root","title":"登记title"},"evidence":"本次native read_thread/list_projects证据引用"}
```

从 pending 复用现有主控可直接 bind，同时提供 `host_project_id`；bound 再读回只能绑定相同ID。expected_revision 必须来自最近 `controller-status`，冲突后重读，不能盲重试。

创建返回失败、超时、queued 或绑定前中断均保留 creating。恢复时按保存项目、完整标题、创建操作时间/结果与角色原文有界检查活动/归档列表并读线程：找到准确线程则 bind；效果未知保持 creating，不再次调用 create。只有 fresh 检索及原操作失败证据**确认未创建**时，才允许：

```json
{"action":"retry","expected_revision":1,"snapshot":{"host_effect":"confirmed_not_created"},"evidence":"fresh检索与原操作无宿主效果的证据引用"}
```

重置后仍须重新读取、start，再创建。单纯列表没显示不构成确认未创建；不删除共享状态、清锁或绕过身份保护。CAS 是合作式登记，不保证外部 create exactly-once 或拦截绕过入口的操作。项目显式 relocate 后若root变化，状态显示 needs_revalidation 并保留 previous_root和原threadId；只允许同ID经宿主关联/目录/标题鲜读重新bind，不能创建或替换主控。

## 角色线程：创建 → 派工 → 跟进 → 检查 → 验收 → 清理归档

- **创建与派工**：Controller 根据目标、完成条件和现有能力选择角色，先解析并核对模型/effort；默认单 writer。复用同一切片执行者以保留 owner/fence；不相关目标新建 worker。每片紧凑 handoff 包含目标、允许路径、输入、禁止事项、done_when、证据及停止条件。worker/reviewer 不递归派工。用户可见长期角色聊天仅在用户明确要求创建时使用原生 create_thread，并记录其与项目、角色、TaskStore任务ID的关联于现有交付/交接材料，不新增任务账本。
- **跟进与阶段检查**：按实际执行类型用 sub-agent wait 或原生 wait_threads，跟踪真实 thread/turn、运行 session、审批、writer reservation 与结果。用户消息/修正作为当前目标的 steering。partial 有运行 session/占用时保持有人跟进；不能只说已派发即交付。检查任务状态/fence、Git、产物、日志交执行或独立复核者。失败区分输入、环境、实现、方法；只阻断依赖项，复用有效证据，不无界重试。
- **验收**：先按既定 done_when 核对产物与证据；公共接口、数据含义、目标改变、重复无进展或集成前按风险派独立 reviewer，原作者不能自授独立通过。由 Controller 裁决；TaskStore accept 与 Git/运行效果、真实业务/用户验收分别报告。idle/completed turn、不再输出、文档完成、HTTP 200 或合成测试都不自动等于任务验收。
- **清理归档**：仅归档本项目、本切片明确管理的角色聊天，并先核对最后用户要求、TaskStore和交付证据：任务已验收闭环（或用户明确取消/终止且遗留已交接）、没有未处理审批、待验收、阻塞、运行 session、attempt/reservation/pending integration。ready/released不自动等于完成；obsolete只证明终止，不能当通过。保留唯一 Controller，阶段结束不归档它；只有用户明确撤回主控/结束项目时才处理。外部聊天用原生 set_thread_archived 并读回；子代理按宿主支持的结束入口处理，不能假设所有子代理都可用聊天归档工具。worktree清理是独立动作，需本任务所有权、Git/忽略资产检查及授权，使用原生 archive_worktree；不 reset/clean/stash、不删除用户成果、不以归档聊天证明worktree已清理。
- **恢复**：未验收或中断切片先读同库 resume/status、原owner和线程结果，沿现有 fence/recover 机制继续。不要另建竞争 writer 或因线程被归档改造完成证据。归档保存历史，后续需要可原生恢复；恢复不自动扩大原业务授权。

此机制没有后台调度器、自动计时唤醒、独立模型API或系统级访问控制；需要持续/定时执行时依用户明确请求使用现有宿主能力。初始化不自动开始未授权业务开发。

## 双入口与同一项目目标

**dot Agent 是主要用户入口**，负责跨项目意图、优先级、依赖和结果协调；每个项目 Controller 负责把本项目目标从输入持续推进到用户要求的输出，包括 Git 与资源管理。用户也可以直接在项目 Controller 中调整目标、授权、验收或取消。两个入口汇入同一个 Git common-dir 的 TaskStore Controller metadata；不创建另一个项目账本，不假设 dot 是本项目业务权限真源。

每次输入用 `controller-update` 的 `intake` 保存来源和目标版本。`source.entry` 为 `dot` 或 `user`，`message_ref` 是原始消息引用，`authorization_ref` 是当前人类授权依据；dot 另带 `coordination_ref` 说明跨项目关联。可在来源内附加实际 dot chat ID/任务关联，但输入 ID 只用于关联，**不提供发信授权**。Controller 只能在宿主已有明确用户授权内向别的聊天发送消息；没有发信授权时，在当前聊天交付可供 dot 使用的结果与关联，不自动回信。文档、另一个代理的请求和传入 threadId 均不替代人类授权。

```json
{"action":"intake","expected_revision":2,"snapshot":{"expected_goal_revision":0,"goal_id":"用户目标标识","goal":"明确目标","acceptance":"用户要求的输出及完成条件","source":{"entry":"dot","message_ref":"原始消息引用","authorization_ref":"人类授权引用","coordination_ref":"跨项目上下文引用"}},"evidence":"本次输入与现有目标对照"}
```

每次先 fresh `controller-status`。Controller CAS 与 `expected_goal_revision` 均须匹配：相同目标/验收输入追加来源而不改目标版本；目标ID/目标/验收变化则增加版本，保留历史并把未关闭交付批次标为 superseded。冲突拒绝写入，不能最后写入者静默覆盖；Controller 展示原目标、新指令及冲突依据，停止受影响的执行，再按当前人类指令协调。不能推断时仅询问不可替代的决定，继续独立的已授权项。目标调整同时沿现有 `change-goal`/`reopen` 更新受影响任务并重新绑定 find-wheel/UI 基准；metadata 不自动修改任务、停止宿主 session 或解除 fence。

## 从目标到输出的端到端交付

Controller 负责持续串联以下流程并委派执行者读回，不以单个角色 turn 结束或 TaskStore 局部 done 结束项目推进：

`输入/授权/验收 → 执行与独立复核 → 验证/验收 → 适用的 Git 交付 → 用户要求的输出 → 资源收尾 → 角色线程归档`

在现有 TaskStore 中通过 `delivery-open` 创建**目标版本内的交付批次**，关联一个或多个任务ID/当前 revision，记录交付方式、选择原因与授权依据。同一目标可有多个批次；历史关闭批次不能代表新目标或整个项目完成。新目标显式复用旧 done 任务时，Controller 必须核对产物版本、适用性与当前验收，重新记录 acceptance 证据；不把旧 done 当新目标通过。不适用时沿原 reopen/change-goal 流程继续，而非伪造新测试。

```json
{"action":"delivery-open","expected_revision":3,"snapshot":{"expected_goal_revision":1,"delivery_id":"batch-1","tasks":[{"task_id":"实际TaskStore任务ID","revision":1}],"mode":"merge","mode_reason":"用户要求远端合并交付","authorization_ref":"允许commit/push/PR/merge的实际授权引用"},"evidence":"当前目标与任务版本读回"}
```

根据用户输出与项目惯例选择 `artifact`（调查/报告等无需 Git）、`local`（本地提交）、`push`（远端分支）、`pr`（PR及检查/审查）、`merge`（实际远端合并）。记录为何后续阶段不适用；不一律要求所有任务 push/merge，不能为了避开应有交付而降级。选择依据不能扩大授权；缺少不可推断的发布/合并授权时先完成可审查候选并请求具体决定，已授权操作连续执行。

按方式在 `delivery-record` 逐项记录：

| 阶段 | 执行与证据读回 |
| --- | --- |
| acceptance | 既定验收、相关版本检查及适用独立 review；`accepted_by`、`result_ref`。本地验收与真实用户/业务验收分别描述。 |
| commit | 仅提交自有文件，检查 scope、差异及敏感资产；通过既有 TaskStore 集成/fence，读完整 `head`、`branch`。共享 dirty 不 reset/clean/stash，不能用登记绕开 clean gate。 |
| push | 已有授权下推送正确 remote/ref；`git ls-remote` 鲜读目标 ref 确认 subject head；记录 `head,remote,ref` 与证据。push 超时先读远端，不盲推。 |
| pr | 原生/既有 gh 创建或复用正确 base/head PR；鲜读URL与 head OID，原生 attach_artifact；记录 `head,url,base`。创建请求或PR打开不等于合并。 |
| checks | 按风险跟踪必要 CI、审查与既定验收；`head,checks_ref,review_ref,result=passed`，无检查须提供适用理由及独立审查证据，不编造CI。head 改变全部下游重新核对，以新批次记录。 |
| merge | 已获授权后合并；auto-merge queued 不算已合并。鲜读 PR 的 `state=MERGED`、原 subject `head`、`merge_method`、`merge_commit`、`target_ref,target_head`，并核对目标分支包含实际交付。支持 merge/squash/rebase；merge commit 与目标 head 可以不同于 PR head，不要求 SHA 相等。rebase/squash 必须有 PR合并映射及目标内容/必要验证证据，不能只凭原head ancestry。 |
| resources | 按下节完成 inventory 与宿主读回，记录 `disposition=archived/retained/none,inventory_ref,host_readback_ref,reason,unresolved=[]`。 |

调用形态为下例，所有 record/close 携带同一当前 goal revision 与 batch ID，并使用最新 Controller CAS revision：

```json
{"action":"delivery-record","expected_revision":4,"snapshot":{"expected_goal_revision":1,"delivery_id":"batch-1","step":"acceptance","observation":{"accepted_by":"当前Controller裁决","result_ref":"当前目标、产物版本和复核证据引用"}},"evidence":"实际工具结果引用"}
```

`delivery-close` 只有适用阶段与 resources 齐全、关联任务 revision 未变化且全部 done 才关闭该批次；obsolete/取消不算验收成功。TaskStore accept/done 保持原局部含义，不能直接称用户所需远端交付完成。目标取消/取代时停止受影响 session、交接遗留、按原 obsolete/release/recover 完成资源收尾，再以 `delivery-retire` 登记 resources 观测、`termination_ref`（取代/取消依据）及 `handoff_ref`（遗留可恢复交接），状态 retired；其 expected_goal_revision 使用当前目标版本，但资源记录仍归属于原批次版本，不调用 delivery-close 冒称完成。

这些结构门只核对 CAS、任务版本、阶段次序与声明内容，不自动运行 Git/gh，不认证消息/宿主/远端证据真实性，也不强制拦截绕过入口的操作。Controller 仍须让执行者核查真实工具结果；不能将 `closed` 或测试 fixture 当作远端、生产或用户验收事实。参考 [GitHub PR读回字段](https://cli.github.com/manual/gh_pr_view)、[合并入口](https://cli.github.com/manual/gh_pr_merge) 与 [Git worktree约束](https://git-scm.com/docs/git-worktree)。

## 安全资源收尾与线程归档顺序

产物验收与资源收尾分别判断。每个批次只检查自己明确管理的资源，inventory 必须列出所有权/占用、相关 TaskStore attempt/reservation/pending integration、宿主执行 session/审批、worktree/branch/commit，以及未提交、未推送、未跟踪和 **ignored** 资产的实际结果与证据引用；未知不能写“无”。程序在 resources 阶段拒绝关联未解除 reservation、未收尾 attempt、待处理 integration；宿主/Git/资产检查由执行者鲜读，程序不认证其声明。

1. 停止或交接自己管理的运行 session，核对最后人类要求、验收/取消事实、挂起审批和占用。不误杀其他项目/用户进程；正在被别的切片引用的资源保留。
2. worktree 先以 TaskStore/Git 与 `list_artifacts` 核对本聊天托管身份和所有权；检查 `git status --porcelain --untracked-files=all`、本地/远端分支差异、未跟踪及 `git ls-files --others --ignored --exclude-standard`，确认输出与待保留成果。archive_worktree 会保存未推送提交/未提交及非ignored未跟踪快照；ignored 必须先另行保存有价值资产并读回文件/摘要。不能把 archived request 当完成，须取得实际 archive 结果/快照并读回附件。错误或不支持时保持资源 retained，报告原因与恢复入口。
3. 已有授权且安全检查通过后，用原生 `archive_worktree`，不用裸 rm/reset/clean/stash；主、固定、共享、非托管或其他聊天所有 worktree 不强删。非托管资源明确 retained 和责任/路径/恢复方式。保留必要资源是有效收尾 disposition；resources/retire 的 `observation.retention` 必须带非空 `resource_refs` 清单、`owner_ref,location_ref,recovery_ref,authorization_ref`，并说明风险、实际读回和用户知情依据；无需为了关闭批次强制清除成果。unknown/未处理审批/在运行的无人跟进session 是 unresolved，不能伪装 retained。
4. 记录 resources 证据并 close 适用批次；先确保交付/交接材料可恢复且工作树资源已归档或明确保留，再按原角色线程规则使用宿主工具归档已经验收或明确取消收尾的聊天并读回。归档失败保留准确未完成项，不称全部收尾。子代理用其宿主支持的结束方式；不要假设可归档为用户聊天。唯一项目 Controller 保留，只有用户明确结束项目/撤回主控时才处理。

最终输出说明当前目标/批次、交付方式、代码/产物版本、实际 Git与验收证据、资源 archived/retained/none 和线程收尾结果、未验证/仍待用户决定项；effective 模型与用量不可得写 unknown。Controller 负责继续到用户要求的输出及可恢复收尾，不引入 daemon，也不把初始化当业务开发或跨chat通信授权。
