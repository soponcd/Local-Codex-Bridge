# 本地候选发布

当前候选：`2.1.3-local.1-candidate.4`，版本 `2.1.3-local.1`，源码commit见该目录release.json。
它包含独立复核提出的rollback baseline冻结、包外唯一可信runner入口和实际源分页fixture修正。
candidate.1/.2/.3保留作过程溯源，已被candidate.4取代，不用于部署。

archive与package目录忽略Git；release.json、validation.json与source commit/hash是追溯记录。
trusted verifier在`releases/trust/2.1.3-local.1-candidate.4/verify-package.mjs`，不在发布archive中。
应从可信渠道独立核对runner SHA-256，再以它作为唯一首入口：

```text
NODE EXTERNAL_VERIFIER PACKAGE_ROOT --verify
NODE EXTERNAL_VERIFIER PACKAGE_ROOT --check
```

`--check`仅只读生产/host基线，不重启。独立复核最终结果由主控登记；生产部署、runtime effective与production acceptance没有执行。
未来部署须满足用户授权、独立复核、基线匹配、备份和旧实例恢复证明，详见ops/runbooks/operations.md。
