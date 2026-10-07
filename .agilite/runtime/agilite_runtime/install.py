"""Small, compare-and-swap project installer. State stays in Git common-dir."""
import hashlib
import fcntl
import json
import os
import re
import stat
import sqlite3
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

from .evidence import StateConflict, git, repository
from .schema import VERSION

POLICY_VERSION = 10
PYTHON_BINDING = ".agilite/python-executable"
START = "<!-- AGILITE:START -->"
END = "<!-- AGILITE:END -->"
BLOCK = (f"{START}\n"
         "项目使用 .agilite/policy.md 中固定版本的 AGILite 规则。当前用户授权优先；默认单写者；"
         "恢复与完成请通过同一 Git common-dir 中的 TaskStore CLI 读回证据。"
         "新增资产、模块或功能在编码/claim 前先按 $find-wheel Phase 1 查现成方案并绑定记录。"
         "涉及UI时使用 .agilite/ui-workflow.md，先确认目标、环境/产品形态及结构树/核心流程，随后选栈与表达。"
         "技术架构与真实UI实现/验收引用该文档#ui-four-layers单一规则源。\n"
         f"{END}\n")
POLICY = """# AGILite project policy v10

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
"""
SKILL = """# AGILite project entry

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
"""
FILES = {".agilite/policy.md": POLICY.encode(), ".agents/skills/agilite/SKILL.md": SKILL.encode()}
RUNTIME_NAMES = ("__init__.py", "__main__.py", "cli.py", "evidence.py", "schema.py", "store.py", "install.py", "wheel.py", "ui.py", "model_gate.py", "relocation.py", "controller.py", "documents.py")


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _role_route(role):
    script = Path.home() / ".agents/skills/astra-task-router/scripts/resolve_role.py"
    if not script.is_file():
        raise StateConflict(f"role resolver missing: {script}")
    try:
        proc = subprocess.run([sys.executable, str(script), role],
                              capture_output=True, text=True, timeout=5)
        route = json.loads(proc.stdout) if proc.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise StateConflict(f"role resolution failed: {role}") from exc
    if (not isinstance(route, dict) or route.get("role") != role
            or not isinstance(route.get("model"), str)
            or not re.fullmatch(r"gpt-6(?:\.[1-9][0-9]*)?-(?:astra|sol|luna)", route["model"])
            or route.get("effort") not in {"low", "medium", "high", "xhigh", "max", "ultra"}):
        raise StateConflict(f"GPT-6 role route unavailable: {role}")
    return route


def _codex_config():
    required = ("controller", "decision", "decision-hard", "developer", "difficult",
                "helper", "reviewer", "reviewer-high", "reviewer-decision")
    routes = {role: _role_route(role) for role in required}
    controller = routes["controller"]
    helper = routes["helper"]
    # These are project-scoped defaults. Explicit host selections and persisted
    # thread selections can take precedence; neither is certified by this file.
    return (f"model = {json.dumps(controller['model'])}\n"
            f"model_reasoning_effort = {json.dumps(controller['effort'])}\n\n"
            f"[models.new_thread]\n"
            f"model = {json.dumps(controller['model'])}\n"
            f"model_reasoning_effort = {json.dumps(controller['effort'])}\n\n"
            f"[agents]\n"
            f"default_subagent_model = {json.dumps(helper['model'])}\n"
            f"default_subagent_reasoning_effort = {json.dumps(helper['effort'])}\n").encode()


def _source(*, python_executable=None):
    folder = Path(__file__).parent
    files = dict(FILES)
    files[PYTHON_BINDING] = ((python_executable or sys.executable) + "\n").encode()
    files[".codex/config.toml"] = _codex_config()
    guide = (folder.parent.parent / "ui-workflow.md" if folder.parent.name == "runtime"
             else folder.parent / "docs/ui-workflow.md")
    files[".agilite/ui-workflow.md"] = guide.read_bytes()
    files[".agilite/controller-lifecycle.md"] = (guide.parent / "controller-lifecycle.md").read_bytes()
    for name in RUNTIME_NAMES:
        files[f".agilite/runtime/agilite_runtime/{name}"] = (folder / name).read_bytes()
    return files


def _version():
    root = Path(__file__).resolve().parent.parent
    if ".agilite" in root.parts:
        return "embedded-copy"
    proc = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else "unknown"


def _paths(target):
    identity = repository(target)
    root = Path(identity["root"])
    shared = Path(identity["common_dir"]) / "agilite"
    return identity, root, shared, _safe(root, ".agilite/project.json")


def _read(path):
    if path.is_symlink():
        raise StateConflict(f"symlink target refused: {path}")
    return path.read_bytes() if path.exists() else None


@contextmanager
def _parent_fd(root, path, *, create=False):
    """Walk only directory inodes below the verified Git root, never symlinks."""
    rel = path.relative_to(root)
    if ".." in rel.parts or not rel.parts:
        raise StateConflict(f"unsafe managed path: {path}")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in rel.parts[:-1]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd, rel.parts[-1]
    finally:
        os.close(fd)


def _read_at(root, path):
    try:
        with _parent_fd(root, path) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise StateConflict(f"managed target is not a regular file: {path}")
                with os.fdopen(fd, "rb", closefd=False) as source:
                    return source.read()
            finally:
                os.close(fd)
    except FileNotFoundError:
        return None


def _remove_at(root, path):
    with _parent_fd(root, path) as (parent, name):
        os.unlink(name, dir_fd=parent)


def _safe(root, relative):
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        raise StateConflict(f"unsafe managed path: {relative}")
    path = root / relative
    if any(parent.is_symlink() for parent in (path, *path.parents) if parent != root and root in parent.parents):
        raise StateConflict(f"symlink parent refused: {path}")
    return path


def _manifest(path):
    raw = _read(path)
    return json.loads(raw) if raw is not None else None


def _guard_policy_version(manifest, operation):
    """Refuse unknown or newer policies before any installing-side write."""
    if manifest is None or operation not in {"init", "upgrade"}:
        return
    version = manifest.get("policy_version") if isinstance(manifest, dict) else None
    if type(version) is not int or version < 1:
        raise StateConflict("installed policy version missing or invalid; refusing installation")
    if version > POLICY_VERSION:
        raise StateConflict(f"policy downgrade refused: installed {version} > source {POLICY_VERSION}")


def runtime_python(target, *, default=False):
    """Read an owned interpreter selection; never adopt an unowned local file."""
    _, root, _, manifest_path = _paths(target)
    manifest = _manifest(manifest_path)
    expected = (manifest or {}).get("files", {}).get(PYTHON_BINDING)
    if expected is None:
        if ("runtime_python" in (manifest or {})
                or PYTHON_BINDING in (manifest or {}).get("files", {})):
            raise StateConflict("inconsistent project Python binding metadata")
        return sys.executable if default else None
    raw = _read(_safe(root, PYTHON_BINDING))
    if raw is None or _hash(raw) != expected:
        raise StateConflict(f"managed file drift: {PYTHON_BINDING}")
    try:
        value = raw.decode("utf-8").rstrip("\n")
    except UnicodeDecodeError as exc:
        raise StateConflict("invalid project Python binding") from exc
    if (not value or raw != (value + "\n").encode() or "\n" in value
            or "\r" in value or "\0" in value or not Path(value).is_absolute()
            or manifest.get("runtime_python") != value):
        raise StateConflict("invalid project Python binding")
    if not Path(value).is_file() or not os.access(value, os.X_OK):
        raise StateConflict(f"project Python interpreter unavailable: {value}")
    return value


def reexec_project_python(target, *, entry, args):
    """Bootstrap before DB access; unchanged global PATH and no new runtime."""
    selected = runtime_python(target)
    if selected and not os.path.samefile(selected, sys.executable):
        os.execv(selected, [selected, "-B", *entry, *args])


def _committed_snapshot(root, manifest_path):
    """A cloned tracked install may be rebound only before local state exists."""
    try:
        return git(root, "show", "HEAD:.agilite/project.json") == _read(manifest_path)
    except StateConflict:
        return False


def _planned(target, operation):
    identity, root, shared, manifest_path = _paths(target)
    from .relocation import guard_pending
    guard_pending(shared)
    manifest = _manifest(manifest_path)
    _guard_policy_version(manifest, operation)
    selected_python = runtime_python(root, default=True)
    sources = _source(python_executable=selected_python)
    source_hash = _hash(b"".join(k.encode() + b"\0" + v for k, v in sorted(sources.items())))
    agents = root / "AGENTS.md"
    old_agents = _read(agents)
    if old_agents is not None and (old_agents.count(START.encode()) != old_agents.count(END.encode()) or old_agents.count(START.encode()) > 1):
        raise StateConflict("ambiguous AGENTS managed block")
    relocated = bool(manifest and manifest.get("git_common_dir") != identity["common_dir"])
    if relocated and ((shared / "state.sqlite3").exists() or not _committed_snapshot(root, manifest_path)):
        raise StateConflict("manifest belongs to another repository")
    if operation == "init" and manifest:
        if manifest.get("source_hash") != source_hash:
            raise StateConflict("different installed source; use upgrade")
        operation = "upgrade" if relocated else "verify"
    if operation in {"upgrade", "withdraw", "verify"} and not manifest:
        raise StateConflict("project is not initialized")
    if manifest:
        for rel, expected in manifest["files"].items():
            current = _read(_safe(root, rel))
            if current is None or _hash(current) != expected:
                raise StateConflict(f"managed file drift: {rel}")
        for rel in sources.keys() - manifest["files"].keys():
            if _read(_safe(root, rel)) is not None:
                raise StateConflict(f"new managed path collides with user file: {rel}")
        if old_agents is None:
            raise StateConflict("AGENTS.md managed block missing")
        start, end = old_agents.find(START.encode()), old_agents.find(END.encode())
        if start < 0 or end < start:
            raise StateConflict("AGENTS.md managed block missing")
        end += len(END)
        if _hash(old_agents[start:end]) != manifest["agents_block_hash"]:
            raise StateConflict("AGENTS.md managed block drift")
    else:
        if old_agents and (START.encode() in old_agents or END.encode() in old_agents):
            raise StateConflict("unowned AGENTS managed marker")
        for rel in sources:
            if _read(_safe(root, rel)) is not None:
                raise StateConflict(f"existing unowned file: {rel}")
        if _read(manifest_path) is not None:
            raise StateConflict("existing unowned manifest")
    if operation == "verify":
        return {"status": "unchanged", "installation_id": manifest["installation_id"],
                "source_hash": source_hash, "relocation_required": relocated}, None
    before = old_agents or b""
    if manifest:
        start, end = before.find(START.encode()), before.find(END.encode()) + len(END)
        prefix = before[:start]
        if operation == "withdraw" and manifest.get("agents_separator") and prefix.endswith(b"\n"):
            prefix = prefix[:-1]
        suffix = before[end:]
        if operation == "withdraw" and suffix.startswith(b"\n"):
            suffix = suffix[1:]
        new_agents = prefix + (b"" if operation == "withdraw" else BLOCK.rstrip("\n").encode()) + suffix
    else:
        new_agents = before + (b"\n" if before and not before.endswith(b"\n") else b"") + BLOCK.encode()
    desired = {} if operation == "withdraw" else sources
    managed_paths = set(sources) | set(manifest["files"] if manifest else ())
    new_manifest = None if operation == "withdraw" else {
        "installation_id": manifest["installation_id"] if manifest and not relocated else uuid.uuid4().hex,
        "git_common_dir": identity["common_dir"], "policy_version": POLICY_VERSION,
        "runtime_python": selected_python,
        "relocation_guard_version": 1,
        "schema_version": VERSION, "source_commit": (manifest["source_commit"] if manifest and not relocated and manifest["source_hash"] == source_hash else _version()), "source_hash": source_hash,
        "files": {k: _hash(v) for k, v in desired.items()},
        "agents_block_hash": _hash(BLOCK.rstrip("\n").encode()),
        "agents_separator": manifest.get("agents_separator", False) if manifest else bool(before and not before.endswith(b"\n")),
        "adapters": manifest.get("adapters", {}) if manifest else {},
    }
    plan = {"operation": operation, "target": str(root), "state": str(shared / "state.sqlite3"),
            "installation_id": (manifest or new_manifest)["installation_id"], "source_hash": source_hash,
            "changes": sorted(managed_paths | {"AGENTS.md", ".agilite/project.json"}),
            "applied": False}
    touched = [root / "AGENTS.md", manifest_path] + [root / rel for rel in sorted(managed_paths)]
    expected = {str(path): _read(path) for path in touched}
    return plan, (root, shared, manifest_path, new_agents, new_manifest, managed_paths, desired, expected)


@contextmanager
def _install_lock(shared):
    if shared.is_symlink():
        raise StateConflict("shared state path is a symlink")
    shared.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = shared / "install.lock"
    if path.is_symlink():
        raise StateConflict("install lock path is a symlink")
    shared_fd = os.open(shared, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = os.open("install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=shared_fd)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield shared_fd
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
        os.close(shared_fd)


def _replace(root, path, data):
    with _parent_fd(root, path, create=True) as (parent, name):
        temp = name + ".agilite-" + uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb", closefd=False) as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
        finally:
            os.close(fd)
            try:
                os.unlink(temp, dir_fd=parent)
            except FileNotFoundError:
                pass


def _apply(plan, bundle):
    root, shared, manifest_path, new_agents, new_manifest, managed_paths, desired, expected = bundle
    if plan["operation"] == "verify":
        return plan
    # Preflight all paths before first write. A recovery copy is retained outside the worktree.
    for rel in managed_paths | {"AGENTS.md", ".agilite/project.json"}:
        _safe(root, rel)
    if shared.is_symlink() or (shared / "install-backups").is_symlink():
        raise StateConflict("shared state/backup path is a symlink")
    shared.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = shared / "install-backups" / uuid.uuid4().hex
    backup.mkdir(mode=0o700, parents=True)
    # This rejects any edit after planning, including edits outside the managed AGENTS block.
    for path_text, raw in expected.items():
        if _read_at(root, Path(path_text)) != raw:
            raise StateConflict(f"target changed after plan: {path_text}")
    before = expected
    after = {}
    for index, (path, raw) in enumerate(before.items()):
        if raw is not None:
            (backup / f"{index:03d}.bak").write_bytes(raw)
    (backup / "paths.json").write_text(json.dumps(list(before), ensure_ascii=False), encoding="utf-8")
    record = backup / "operation.json"
    record.write_text(json.dumps({"status": "applying", "operation": plan["operation"],
                                  "expected": {p: _hash(v) if v is not None else None for p, v in before.items()}},
                                 ensure_ascii=False, indent=2), encoding="utf-8")
    def put(path, value):
        key = str(path)
        if _read_at(root, path) != before[key]:
            raise StateConflict(f"target changed during apply: {path}")
        if value is None:
            if before[key] is not None:
                _remove_at(root, path)
        else:
            _replace(root, path, value)
        after[key] = value
    try:
        agents = root / "AGENTS.md"
        put(agents, new_agents)
        for rel in sorted(managed_paths):
            path = root / rel
            if rel in desired:
                put(path, desired[rel])
            else:
                put(path, None)
        if new_manifest is None:
            put(manifest_path, None)
        else:
            put(manifest_path, (json.dumps(new_manifest, ensure_ascii=False, indent=2) + "\n").encode())
    except BaseException as exc:
        conflicts = []
        for path_text, written in reversed(list(after.items())):
            path = Path(path_text)
            try:
                current = _read_at(root, path)
            except OSError:
                conflicts.append(path_text)
                continue
            if current != written:
                conflicts.append(path_text)
                continue
            raw = before[path_text]
            if raw is None:
                if current is not None:
                    _remove_at(root, path)
            else:
                _replace(root, path, raw)
        record.write_text(json.dumps({"status": "manual_recovery_required" if conflicts else "rolled_back",
                                      "error": str(exc), "conflicts": conflicts,
                                      "written": {p: _hash(v) if v is not None else None for p, v in after.items()}},
                                     ensure_ascii=False, indent=2), encoding="utf-8")
        raise
    record.write_text(json.dumps({"status": "completed", "operation": plan["operation"],
                                  "written": {p: _hash(v) if v is not None else None for p, v in after.items()}},
                                 ensure_ascii=False, indent=2), encoding="utf-8")
    plan.update(applied=True, backup=str(backup))
    return plan


def _run(target, operation, apply):
    if not apply:
        return _planned(target, operation)[0]
    _, _, shared, manifest_path = _paths(target)
    _guard_policy_version(_manifest(manifest_path), operation)
    with _install_lock(shared):
        plan, bundle = _planned(target, operation)
        return _apply(plan, bundle) if bundle else plan


def init(target, *, apply=False):
    return _run(target, "init", apply)


def upgrade(target, *, apply=False):
    return _run(target, "upgrade", apply)


def withdraw(target, *, apply=False):
    return _run(target, "withdraw", apply)


def doctor(target, *, apply=False):
    identity, root, shared, manifest_path = _paths(target)
    manifest = _manifest(manifest_path)
    state = shared / "state.sqlite3"
    from .store import TaskStore
    from .wheel import skill_status, REVIEW_VERSION
    db = None
    if state.exists():
        try:
            store = TaskStore(state, project_root=identity["root"], readonly=True)
            try:
                db = store.project
            finally:
                store.close()
        except (StateConflict, OSError) as exc:
            db = {"error": str(exc)}
    conflicts = []
    if isinstance(db, dict) and "error" in db:
        conflicts.append("database binding: " + db["error"])
    elif db and db.get("common_dir") != identity["common_dir"]:
        conflicts.append("database common-dir differs from current repository")
    relocation_required = False
    if manifest:
        try:
            relocation_required = _planned(target, "verify")[0]["relocation_required"]
        except (StateConflict, OSError) as exc:
            conflicts.append(str(exc))
    wheel_skill = skill_status()
    role_script = Path.home() / ".agents/skills/astra-task-router/scripts/resolve_role.py"
    requested = None
    if role_script.is_file():
        try:
            route = subprocess.run([sys.executable, str(role_script), "developer"],
                                   capture_output=True, text=True, timeout=5)
            if route.returncode == 0:
                requested = json.loads(route.stdout)
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            pass
    if (not isinstance(requested, dict) or requested.get("role") != "developer"
            or not isinstance(requested.get("model"), str)
            or not re.fullmatch(r"gpt-6(?:\.[1-9][0-9]*)?-(?:astra|sol|luna)", requested["model"])
            or not isinstance(requested.get("effort"), str)):
        requested = None
    role_warning = None if requested else "role map unavailable or invalid; resolve developer before spawn"
    config_path = root / ".codex/config.toml"
    try:
        projected = _codex_config()
        projection_error = None
    except StateConflict as exc:
        projected = None
        projection_error = str(exc)
    current_config = _read(config_path)
    project_model_config = {
        "path": str(config_path), "present": current_config is not None,
        "matches_role_projection": projected is not None and current_config == projected,
        "projection_error": projection_error,
        "scope": "trusted project default; explicit or persisted thread selection may override",
    }
    return {"workspace": identity, "state": str(state), "state_exists": state.exists(),
            "database_project": db, "installed": manifest is not None,
            "project_id": db.get("project_id") if db and "error" not in db else None,
            "installation_id": manifest.get("installation_id") if manifest else None,
            "source_commit": manifest.get("source_commit") if manifest else None,
            "source_hash": manifest.get("source_hash") if manifest else None,
            "runtime_python": manifest.get("runtime_python") if manifest else None,
            "executing_python": sys.executable,
            "sqlite_version": sqlite3.sqlite_version,
            "policy_version": manifest.get("policy_version") if manifest else None,
            "relocation_guard_version": manifest.get("relocation_guard_version", 0) if manifest else 0,
            "relocation_required": relocation_required,
            "rules": "central role tokens: controller/developer/helper/reviewer; single writer",
            "requested_role": "developer",
            "requested_model": requested["model"] if requested else "unknown",
            "requested_effort": requested["effort"] if requested else "unknown",
            "requested_source": requested["source"] if requested else str(role_script),
            "role_map": {"available": requested is not None, "warning": role_warning},
            "effective_model": "unknown", "effective_effort": "unknown", "effective_source": "host metadata unavailable",
            "project_model_config": project_model_config,
            "find_wheel": {"skill": wheel_skill, "review_version": REVIEW_VERSION,
                           "policy_required": bool(manifest and manifest.get("policy_version", 0) >= 2),
                           "warning": None if wheel_skill["available"] else "find-wheel skill unavailable; build claim will be refused"},
            "conflicts": conflicts}
