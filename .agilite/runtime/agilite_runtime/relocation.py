"""Explicit, offline rebind of a moved schema-3 repository; no history rewriting."""
import json
import os
from pathlib import Path
import sqlite3
import uuid

from .evidence import StateConflict, canonical, digest, git, nonempty, repository
from .install import (START, END, _hash, _install_lock, _parent_fd, _read_at,
                      _remove_at, _replace as _install_replace, _safe)
from .schema import VERSION, initialize

PENDING = "relocation-pending.json"
DIGEST_FORMAT = "sqlite-typed-values-v1"


def guard_pending(shared):
    path = Path(shared) / PENDING
    if path.exists() or path.is_symlink():
        raise StateConflict("pending relocation; use explicit relocation-recover receipt before continuing")


def _replace(root, path, data):
    _install_replace(root, path, data)
    with _parent_fd(root, path) as (parent, _):
        os.fsync(parent)


def _remove(root, path):
    _remove_at(root, path)
    with _parent_fd(root, path) as (parent, _):
        os.fsync(parent)


def _absolute(value, label):
    nonempty(value, label)
    path = Path(value)
    if not path.is_absolute() or str(path.resolve()) != value:
        raise StateConflict(f"{label} must be a canonical absolute path without symlinks")
    return path


def _shape(db):
    if db.execute("PRAGMA user_version").fetchone()[0] != VERSION:
        raise StateConflict("relocation supports only known schema 3; migrate separately")
    expected = sqlite3.connect(":memory:", isolation_level=None)
    try:
        initialize(expected)
        names = lambda connection: {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if names(db) != names(expected):
            raise StateConflict("unknown schema 3 tables; database left untouched")
        for name in names(expected):
            columns = lambda connection: [(r[1], r[2], r[3], r[5]) for r in connection.execute(f'PRAGMA table_info("{name}")')]
            if columns(db) != columns(expected):
                raise StateConflict(f"unknown schema 3 columns: {name}")
        indexes = lambda connection: [(r[0], r[1], " ".join((r[2] or "").split())) for r in connection.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') ORDER BY type,name")]
        if indexes(db) != indexes(expected):
            raise StateConflict("unknown schema 3 indexes, triggers or views")
    finally:
        expected.close()
    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or db.execute("PRAGMA foreign_key_check").fetchone():
        raise StateConflict("database integrity check failed")


def _quiescent(db):
    active = db.execute("""SELECT task_id FROM tasks WHERE status NOT IN ('ready','done','legacy_blocked','obsolete')
        OR (status != 'done' AND active_attempt IS NOT NULL) LIMIT 1""").fetchone()
    attempt = db.execute("SELECT attempt_id FROM attempts WHERE status NOT IN ('integrated','abandoned') LIMIT 1").fetchone()
    pending = db.execute("SELECT operation_id FROM integrations WHERE status NOT IN ('completed','cancelled','needs_revision') LIMIT 1").fetchone()
    if active or attempt or pending or db.execute("SELECT 1 FROM reservations LIMIT 1").fetchone():
        raise StateConflict("relocation requires no active attempts, reservations or pending integration")


def _database_digest(db, project=None):
    # Bind all table bytes/values, DDL, user_version and AUTOINCREMENT state.
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
    tables = []
    for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        columns = [row[1] for row in db.execute(f'PRAGMA table_info("{name}")')]
        kinds = ",".join(f'typeof("{column}")' for column in columns)
        rows = db.execute(f'SELECT *,{kinds} FROM "{name}"').fetchall()
        encoded = []
        width = len(columns)
        for row in rows:
            values = list(row[:width])
            storage_types = list(row[width:])
            if name == "metadata" and project is not None and values[0] == "project":
                values[1], storage_types[1] = project, "text"
            encoded.append([[kind, value.hex() if kind in {"blob","real"} else value]
                            for kind,value in zip(storage_types,values)])
        tables.append([name, sorted(encoded,key=canonical)])
    return digest([DIGEST_FORMAT, VERSION, schema, tables])


def _guarded_runtime(root, manifest):
    # Pin actual guard modules, not schema_version or a self-declared marker.
    # A different supported source must be installed at the original bound path
    # first; this check never rewrites a moved installation to make it admissible.
    if manifest.get("relocation_guard_version") != 1:
        raise StateConflict("installed runtime lacks pending protection; upgrade at original bound path before moving")
    source = Path(__file__).resolve().parent
    for name in ("store.py","install.py","relocation.py"):
        rel = f".agilite/runtime/agilite_runtime/{name}"
        if manifest["files"].get(rel) != _hash((source / name).read_bytes()):
            raise StateConflict("installed guard modules differ from relocation source; upgrade at original bound path before moving")


def _managed(root, raw, *, require_guard=True):
    if raw is None:
        raise StateConflict("installed manifest is required")
    manifest = json.loads(raw)
    if not isinstance(manifest, dict) or manifest.get("schema_version") != VERSION or not isinstance(manifest.get("files"), dict):
        raise StateConflict("unknown installation manifest")
    for rel, expected in manifest["files"].items():
        current = _read_at(root, _safe(root, rel))
        if current is None or _hash(current) != expected:
            raise StateConflict(f"managed file drift: {rel}")
    if require_guard:
        _guarded_runtime(root,manifest)
    agents = _read_at(root, root / "AGENTS.md")
    if agents is None or agents.count(START.encode()) != 1 or agents.count(END.encode()) != 1:
        raise StateConflict("AGENTS.md managed block missing or ambiguous")
    start, end = agents.find(START.encode()), agents.find(END.encode())
    if end < start or _hash(agents[start:end+len(END)]) != manifest.get("agents_block_hash"):
        raise StateConflict("AGENTS.md managed block drift")
    return manifest


def _paths(target, request):
    paths = {key:_absolute(request[key], key) for key in ("old_root", "old_common_dir", "new_root", "new_common_dir")}
    current = repository(target)
    if current != {"root":request["new_root"], "common_dir":request["new_common_dir"]}:
        raise StateConflict("explicit new Git identity differs from current target")
    if request.get("reanchor"):
        # Reanchor changes only the primary TaskStore anchor, never Git admin.
        common = paths["new_common_dir"]
        if paths["old_common_dir"] != common:
            raise StateConflict("reanchor requires the same Git common-dir")
        if common != paths["new_root"] / ".git" or not common.is_dir():
            raise StateConflict("reanchor target must be the primary repository with internal .git")
        gitdir = git(paths["new_root"], "rev-parse", "--absolute-git-dir").decode().strip()
        if gitdir != str(common):
            raise StateConflict("reanchor target Git administration differs from common-dir")
        if paths["old_root"] == paths["new_root"] or paths["old_common_dir"] == paths["old_root"] / ".git":
            raise StateConflict("reanchor requires a former linked-worktree root")
        if os.path.lexists(paths["old_root"]):
            raise StateConflict("old worktree still exists; reanchor is not a primary-root switch")
    else:
        # A whole primary repository move is the supported unit; linked worktree
        # relocation needs separate Git administration and must not be guessed.
        if paths["old_common_dir"] != paths["old_root"] / ".git" or paths["new_common_dir"] != paths["new_root"] / ".git":
            raise StateConflict("only whole primary repositories with internal .git support relocation")
        if any(os.path.lexists(paths[key]) for key in ("old_root", "old_common_dir")):
            raise StateConflict("old repository still exists; a copy is not an existing-state move")
        worktrees = git(paths["new_root"], "worktree", "list", "--porcelain", "-z")
        entries = [os.fsdecode(item[9:]) for item in worktrees.split(b"\0") if item.startswith(b"worktree ")]
        if len(entries) != 1:
            if not request.get("repair_binding"):
                raise StateConflict("linked worktrees require separate Git relocation before rebinding")
            _linked_current(paths["new_common_dir"], entries, paths["new_root"])
    common = paths["new_common_dir"]
    shared = _safe(common, "agilite")
    state = _safe(common, "agilite/state.sqlite3")
    if _read_at(common, state) is None:
        raise StateConflict("existing state database required; no new identity is created")
    return paths["new_root"], common, shared, state


def _linked_current(common, entries, root):
    # Read Git administrative links only; never repair or move another worktree.
    for entry in entries:
        path = _absolute(entry, "registered worktree")
        if path == root:
            continue
        if repository(path)["common_dir"] != str(common):
            raise StateConflict(f"linked worktree common-dir is stale: {path}")
        raw = (path / ".git").read_text().strip()
        if not raw.startswith("gitdir: "):
            raise StateConflict(f"invalid linked worktree gitdir: {path}")
        admin = (path / raw[8:]).resolve(strict=True)
        if admin.parent != common / "worktrees":
            raise StateConflict(f"foreign linked worktree gitdir: {path}")
        if Path((admin / "gitdir").read_text().strip()) != path / ".git":
            raise StateConflict(f"linked worktree backlink is stale: {path}")
        if (admin / (admin / "commondir").read_text().strip()).resolve() != common:
            raise StateConflict(f"linked worktree commondir is stale: {path}")


def _inspect(db, root, request, *, require_guard=True):
    _shape(db)
    _quiescent(db)
    row = db.execute("SELECT value FROM metadata WHERE key='project'").fetchone()
    if not row:
        raise StateConflict("database project identity missing")
    project = json.loads(row[0])
    if any(project.get(k) != request[v] for k,v in (("root","old_root"), ("common_dir","old_common_dir"), ("project_id","project_id"))):
        raise StateConflict("explicit old project identity differs from database")
    manifest_raw = _read_at(root, _safe(root, ".agilite/project.json"))
    manifest = _managed(root, manifest_raw, require_guard=require_guard)
    bound_common = request["new_common_dir"] if request.get("repair_binding") else request["old_common_dir"]
    if manifest.get("git_common_dir") != bound_common or manifest.get("installation_id") != request["installation_id"]:
        raise StateConflict("explicit old installation identity differs from manifest")
    expected = {"expected_database_digest":_database_digest(db), "expected_project_digest":_hash(row[0].encode()),
                "expected_manifest_digest":_hash(manifest_raw)}
    return row[0], manifest_raw, expected


def _readonly(state):
    # immutable SQLite never creates/updates WAL/SHM. A nonempty WAL is refused
    # rather than silently ignoring committed pages during zero-write preflight.
    wal = state.with_name(state.name + "-wal")
    if wal.is_symlink() or (wal.exists() and wal.stat().st_size):
        raise StateConflict("nonempty SQLite WAL; close/checkpoint original runtime before offline relocation")
    return sqlite3.connect(state.as_uri()+"?mode=ro&immutable=1", uri=True, isolation_level=None)


def _save(common, receipt_path, receipt):
    _replace(common, receipt_path, (canonical(receipt)+"\n").encode())


def _receipt_current(common, shared, receipt_path, receipt):
    expected = {"receipt_id":receipt["receipt_id"],
                "receipt_digest":digest({k:v for k,v in receipt.items() if k != "status"})}
    pending, saved = _read_at(common, shared / PENDING), _read_at(common, receipt_path)
    if (pending is None or saved is None or json.loads(pending) != expected
            or digest({k:v for k,v in json.loads(saved).items() if k != "status"}) != expected["receipt_digest"]):
        raise StateConflict("relocation receipt/pending CAS changed; recovery requires inspection")


def _finish(common, shared, receipt_path, receipt, status):
    _receipt_current(common, shared, receipt_path, receipt)
    receipt["status"] = status
    _save(common, receipt_path, receipt)
    _remove(common, shared / PENDING)


def relocate(target, **request):
    if "repair_binding" in request or "reanchor" in request:
        raise StateConflict("use explicit binding-repair, not ordinary relocate")
    return _relocate(target, **request)


def binding_repair(target, *, prepare=False, **request):
    """Explicit split-binding recovery. Preparation installs guards but does not rebind."""
    if "repair_binding" in request or "reanchor" in request:
        raise StateConflict("repair_binding is internal to binding-repair")
    return _prepare_or_relocate(target, prepare=prepare, repair_binding=True, **request)


def reanchor(target, *, prepare=False, **request):
    """Explicit same-common-dir repair of an absent linked-worktree anchor."""
    if "repair_binding" in request or "reanchor" in request:
        raise StateConflict("binding mode is internal to reanchor")
    return _prepare_or_relocate(target, prepare=prepare, reanchor=True, **request)


def _prepare_or_relocate(target, *, prepare, repair_binding=False, reanchor=False, **request):
    if not prepare:
        return _relocate(target, repair_binding=repair_binding, reanchor=reanchor, **request)
    from .install import _planned, _apply
    apply = request.pop("apply", False)
    supplied = {key:request.pop(key, None) for key in (
        "expected_database_digest", "expected_project_digest", "expected_manifest_digest")}
    if request.get("old_runtime_handles_closed") is not True or request.get("writers_stopped") is not True:
        raise StateConflict("binding repair preparation requires closed runtime handles and stopped writers")
    request = {**request, **({"reanchor":True} if reanchor else {"repair_binding":True})}
    root, common, shared, state = _paths(target, request)
    guard_pending(shared)
    db = _readonly(state)
    try:
        _, raw, expected = _inspect(db, root, request, require_guard=False)
    finally:
        db.close()
    plan, _ = _planned(target, "upgrade")
    result = {"operation":"reanchor-prepare" if reanchor else "binding-repair-prepare", "applied":False, "expected":expected,
              "installation_plan":plan, "database_binding":f"unchanged; re-preview before {'reanchor' if reanchor else 'binding-repair'} --apply"}
    if not apply:
        return result
    if supplied != expected:
        raise StateConflict("missing or stale preparation CAS; preview preparation first")
    with _install_lock(shared):
        guard_pending(shared)
        db = sqlite3.connect(str(state), timeout=5, isolation_level=None)
        try:
            db.execute("BEGIN IMMEDIATE")
            _paths(target, request)
            _, current_raw, current = _inspect(db, root, request, require_guard=False)
            if current != supplied or current_raw != raw:
                raise StateConflict("binding repair preparation baseline changed")
            backup = _safe(common, f"agilite/relocations/prepare-{uuid.uuid4().hex}.sqlite3.bak")
            with _parent_fd(common, backup, create=True) as (parent, name):
                fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                os.close(fd)
            source, destination = _readonly(state), sqlite3.connect(str(backup))
            try:
                source.backup(destination)
                if _database_digest(destination) != supplied["expected_database_digest"]:
                    raise StateConflict("preparation backup CAS mismatch")
            finally:
                source.close()
                destination.close()
            with backup.open("rb") as saved:
                os.fsync(saved.fileno())
            plan, bundle = _planned(target, "upgrade")
            installation = _apply(plan, bundle)
            _managed(root, _read_at(root, root / ".agilite/project.json"))
            if _database_digest(db) != supplied["expected_database_digest"]:
                raise StateConflict("preparation changed database")
            result.update(applied=True, database_backup=str(backup), installation=installation)
            return result
        finally:
            if db.in_transaction:
                db.execute("ROLLBACK")
            db.close()


def _relocate(target, *, old_root, old_common_dir, new_root, new_common_dir,
             project_id, installation_id, apply=False, expected_database_digest=None,
             expected_project_digest=None, expected_manifest_digest=None,
             old_runtime_handles_closed=False, writers_stopped=False, repair_binding=False, reanchor=False):
    if old_runtime_handles_closed is not True or writers_stopped is not True:
        raise StateConflict("offline relocation requires explicit old_runtime_handles_closed=true and writers_stopped=true observations; CLI does not authenticate host state")
    request = {"old_root":old_root, "old_common_dir":old_common_dir, "new_root":new_root,
               "new_common_dir":new_common_dir, "project_id":nonempty(project_id,"project_id"),
               "installation_id":nonempty(installation_id,"installation_id"),
               "old_runtime_handles_closed":True, "writers_stopped":True}
    if repair_binding:
        request["repair_binding"] = True
    if reanchor:
        request["reanchor"] = True
    root, common, shared, state = _paths(target, request)
    guard_pending(shared)
    db = _readonly(state)
    try:
        before_project, before_manifest, expected = _inspect(db, root, request)
    finally:
        db.close()
    plan = {"operation":"reanchor" if reanchor else "relocate", **request, "state":str(state), "applied":False, "expected":expected,
            "changes":["metadata.project.root", "metadata.project.common_dir", ".agilite/project.json.git_common_dir"],
            "history":"preserved verbatim; stale historical paths are not rewritten"}
    if reanchor:
        plan["changes"] = ["metadata.project.root"]
        plan["controller"] = "preserved; existing binding requires native-host revalidation"
    if not apply:
        return plan
    supplied = {"expected_database_digest":expected_database_digest, "expected_project_digest":expected_project_digest,
                "expected_manifest_digest":expected_manifest_digest}
    if supplied != expected:
        raise StateConflict("missing or stale relocation CAS digests; run dry-run and pass its expected fields")
    with _install_lock(shared):
        guard_pending(shared)
        db = sqlite3.connect(str(state), timeout=5, isolation_level=None)
        receipt = None
        receipt_path = None
        try:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE")
            # Repeat Git/path, managed file and complete database CAS under both locks.
            _paths(target, request)
            live_project, live_manifest, live_expected = _inspect(db, root, request)
            if live_expected != supplied or live_project != before_project or live_manifest != before_manifest:
                raise StateConflict("repository changed after relocation preflight")
            receipt_id = uuid.uuid4().hex
            receipt_path = _safe(common, f"agilite/relocations/{receipt_id}.json")
            backup = _safe(common, f"agilite/relocations/{receipt_id}.sqlite3.bak")
            # Create parent through the inode-safe walker, then exclusively own backup.
            with _parent_fd(common, backup, create=True) as (parent, name):
                fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                os.close(fd)
            source, destination = _readonly(state), sqlite3.connect(str(backup))
            try:
                source.backup(destination)
                if _database_digest(destination) != supplied["expected_database_digest"]:
                    raise StateConflict("backup does not match locked relocation baseline")
            finally:
                destination.close()
                source.close()
            with backup.open("rb") as saved:
                os.fsync(saved.fileno())
            after_project = canonical({**json.loads(before_project), "root":new_root, "common_dir":new_common_dir})
            after_manifest = before_manifest if reanchor else (json.dumps({**json.loads(before_manifest), "git_common_dir":new_common_dir}, ensure_ascii=False, indent=2)+"\n").encode()
            receipt = {"version":1, "digest_format":DIGEST_FORMAT, "receipt_id":receipt_id, "status":"prepared", "request":request,
                       "backup":str(backup), "backup_sha256":_hash(backup.read_bytes()),
                       "before_project":before_project, "after_project":after_project,
                       "before_manifest":before_manifest.hex(), "after_manifest":after_manifest.hex(),
                       "before_database_digest":supplied["expected_database_digest"],
                       "after_database_digest":_database_digest(db, after_project)}
            _save(common, receipt_path, receipt)
            _replace(common, shared / PENDING, (canonical({"receipt_id":receipt_id,
                "receipt_digest":digest({k:v for k,v in receipt.items() if k != "status"})})+"\n").encode())
            if _read_at(root, root / ".agilite/project.json") != before_manifest:
                raise StateConflict("manifest changed during relocation")
            _managed(root, before_manifest)
            changed = db.execute("UPDATE metadata SET value=? WHERE key='project' AND value=?", (after_project,before_project))
            if changed.rowcount != 1:
                raise StateConflict("project metadata CAS failed")
            if not reanchor or after_manifest != before_manifest:
                _replace(root, root / ".agilite/project.json", after_manifest)
            if _read_at(root, root / ".agilite/project.json") != after_manifest:
                raise StateConflict("manifest replacement readback failed")
            _paths(target, request)
            db.execute("COMMIT")
            _finish(common, shared, receipt_path, receipt, "completed")
            plan.update(applied=True, receipt_id=receipt_id, receipt=str(receipt_path), backup=str(backup), status="completed")
            return plan
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            # Ordinary errors receive the same CAS compensation as explicit crash
            # recovery. If compensation fails, retain pending and never overwrite.
            if receipt is not None and (shared / PENDING).exists():
                try:
                    _recover_locked(db, root, common, shared, receipt_path, receipt, "rollback")
                except BaseException:
                    pass
            raise
        finally:
            db.close()


def _recover_locked(db, root, common, shared, receipt_path, receipt, action):
    db.execute("BEGIN IMMEDIATE")
    try:
        _receipt_current(common, shared, receipt_path, receipt)
        _shape(db)
        _quiescent(db)
        raw = _read_at(root, _safe(root,".agilite/project.json"))
        before, after = bytes.fromhex(receipt["before_manifest"]), bytes.fromhex(receipt["after_manifest"])
        current = _database_digest(db)
        if current not in {receipt["before_database_digest"],receipt["after_database_digest"]} or raw not in {before,after}:
            raise StateConflict("recovery CAS conflict; later state/manifest must not be overwritten")
        _managed(root, raw)
        backup = _safe(common, f'agilite/relocations/{receipt["receipt_id"]}.sqlite3.bak')
        if str(backup) != receipt["backup"] or _hash(_read_at(common,backup)) != receipt["backup_sha256"]:
            raise StateConflict("relocation backup changed or missing")
        project = db.execute("SELECT value FROM metadata WHERE key='project'").fetchone()[0]
        if project not in {receipt["before_project"],receipt["after_project"]}:
            raise StateConflict("recovery project CAS conflict")
        desired_project = receipt["after_project"] if action == "complete" else receipt["before_project"]
        desired_manifest = after if action == "complete" else before
        desired_digest = receipt["after_database_digest"] if action == "complete" else receipt["before_database_digest"]
        changed = db.execute("UPDATE metadata SET value=? WHERE key='project' AND value=?", (desired_project,project))
        if changed.rowcount != 1 or _database_digest(db) != desired_digest:
            raise StateConflict("recovery database CAS failed")
        if _read_at(root, root / ".agilite/project.json") != raw:
            raise StateConflict("manifest changed during recovery")
        if raw != desired_manifest:
            _replace(root, root / ".agilite/project.json", desired_manifest)
        db.execute("COMMIT")
        status = "completed" if action == "complete" else "rolled_back"
        _finish(common, shared, receipt_path, receipt, status)
        return {"status":status, "receipt_id":receipt["receipt_id"], "receipt":str(receipt_path), "backup":str(backup)}
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise


def recover_relocation(target, *, receipt_id, action):
    if action not in {"complete","rollback"} or not isinstance(receipt_id,str) or len(receipt_id) != 32 or any(c not in "0123456789abcdef" for c in receipt_id):
        raise StateConflict("recovery requires an explicit receipt_id and complete|rollback action")
    current = repository(target)
    root, common = Path(current["root"]), Path(current["common_dir"])
    shared = _safe(common,"agilite")
    receipt_path = _safe(common,f"agilite/relocations/{receipt_id}.json")
    # Validate pending before creating lock files, so missing/foreign references fail closed.
    pending = _read_at(common, shared / PENDING)
    if pending is None or json.loads(pending).get("receipt_id") != receipt_id:
        raise StateConflict("receipt does not match the pending relocation")
    with _install_lock(shared):
        if _read_at(common, shared / PENDING) != pending:
            raise StateConflict("pending relocation changed")
        raw = _read_at(common, receipt_path)
        if raw is None:
            raise StateConflict("relocation receipt missing")
        receipt = json.loads(raw)
        if receipt.get("version") != 1 or receipt.get("digest_format") != DIGEST_FORMAT or receipt.get("receipt_id") != receipt_id:
            raise StateConflict("unknown relocation receipt")
        if digest({k:v for k,v in receipt.items() if k != "status"}) != json.loads(pending).get("receipt_digest"):
            raise StateConflict("relocation receipt digest changed")
        request = receipt["request"]
        _paths(target,request)
        before_project, after_project = json.loads(receipt["before_project"]), json.loads(receipt["after_project"])
        before_manifest, after_manifest = json.loads(bytes.fromhex(receipt["before_manifest"])), json.loads(bytes.fromhex(receipt["after_manifest"]))
        if (before_project.get("project_id") != request["project_id"] or before_manifest.get("installation_id") != request["installation_id"]
                or after_project != {**before_project,"root":current["root"],"common_dir":current["common_dir"]}
                or after_manifest != {**before_manifest,"git_common_dir":current["common_dir"]}
                or before_project.get("root") != request["old_root"] or before_project.get("common_dir") != request["old_common_dir"]
                or before_manifest.get("git_common_dir") != (request["new_common_dir"] if request.get("repair_binding") else request["old_common_dir"])):
            raise StateConflict("receipt identity or allowed changes mismatch")
        state = _safe(common,"agilite/state.sqlite3")
        db = sqlite3.connect(str(state),timeout=5,isolation_level=None)
        try:
            db.execute("PRAGMA synchronous=FULL")
            return _recover_locked(db,root,common,shared,receipt_path,receipt,action)
        finally:
            db.close()
