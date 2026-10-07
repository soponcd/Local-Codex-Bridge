"""Transactionally fenced task state with separately observed external effects."""
from __future__ import annotations
from contextlib import contextmanager
import fcntl
import json
import os
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path
from .evidence import (StateConflict, artifact, canonical, commit, digest, git,
                       nonempty, overlaps, repository, resource_path, snapshot,
                       subject, verify_artifact)
from .schema import VERSION, initialize, migrate_legacy, migrate
from .wheel import REVIEW_VERSION, KINDS, binding as wheel_binding, skill_status, validate_record
from . import ui, documents


def _now():
    return time.time_ns()


def _writer_limit(value):
    if type(value) is not int or value not in (1, 2):
        raise StateConflict("max_writers must be the integer 1 or 2")
    return value


def _decode(row):
    if row is None:
        raise StateConflict("record not found")
    return {key[:-5] if key.endswith('_json') else key:
            json.loads(value) if key.endswith('_json') and value is not None else value
            for key, value in dict(row).items()}


def _require_not_obsolete(task, action):
    """obsolete is terminal and claims nothing; no verb may revive or continue it."""
    if task["status"] == "obsolete":
        raise StateConflict(f"task is obsolete; {action} is not available")


class TaskStore:
    """Cooperative entrypoint, not an OS sandbox or host identity authenticator."""
    migrate_legacy = staticmethod(migrate_legacy)
    migrate = staticmethod(migrate)

    def __init__(self, path, *, project_root=None, max_writers=None, readonly=False):
        if max_writers is not None:
            _writer_limit(max_writers)
        self.path, self.readonly = str(Path(path).resolve()), readonly
        self._execution_identity = None
        from .relocation import guard_pending
        guard_pending(Path(self.path).parent)
        uri = Path(self.path).as_uri() + "?mode=ro" if readonly else self.path
        self.db = sqlite3.connect(uri, uri=readonly, timeout=5, isolation_level=None)
        identity = Path(self.path).stat()
        self._database_inode = (identity.st_dev, identity.st_ino)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        try:
            if readonly:
                if self.db.execute("PRAGMA user_version").fetchone()[0] != VERSION:
                    raise StateConflict("unsupported schema; read-only open never migrates")
            else:
                initialize(self.db)
                self.db.execute("PRAGMA journal_mode=WAL")
                self.db.execute("PRAGMA synchronous=FULL")
            row = self.db.execute("SELECT value FROM metadata WHERE key='project'").fetchone()
            if row:
                project = self._stored_project()
                if project_root:
                    current = repository(project_root)
                    if current["common_dir"] != project["common_dir"]:
                        raise StateConflict("database belongs to another repository")
                    # Worktrees may be removed. Keep project identity in the DB,
                    # but execute Git operations against this validated live root.
                    self._execution_identity = current
                elif not readonly and not Path(project["root"]).exists():
                    raise StateConflict("stored worktree is gone; reopen with a live project_root")
                if max_writers is not None and max_writers != project["max_writers"]:
                    raise StateConflict("writer policy cannot change on open")
            else:
                if readonly or project_root is None:
                    raise StateConflict("new database requires explicit project_root")
                proposed = {**repository(project_root), "project_id": uuid.uuid4().hex, "max_writers": max_writers or 1}
                with self._transaction():
                    self.db.execute("INSERT OR IGNORE INTO metadata VALUES ('project',?)", (canonical(proposed),))
                    project = self._stored_project()
                    if project["common_dir"] != proposed["common_dir"] or project["max_writers"] != proposed["max_writers"]:
                        raise StateConflict("concurrent project initialization mismatch")
                self._execution_identity = repository(project_root)
        except BaseException:
            self.db.close()
            raise

    def controller_status(self):
        from .controller import status
        return status(self)

    def controller_update(self, action, expected_revision, **fields):
        from .controller import transition
        return transition(self, action, expected_revision, **fields)

    def close(self):
        self.db.close()

    def _stored_project(self):
        row = self.db.execute("SELECT value FROM metadata WHERE key='project'").fetchone()
        if row is None:
            raise StateConflict("project metadata missing")
        project = json.loads(row[0])
        _writer_limit(project.get("max_writers"))
        return project

    @property
    def project(self):
        """Current persisted policy, with only the validated live Git root overlaid."""
        project = self._stored_project()
        if self._execution_identity:
            if project["common_dir"] != self._execution_identity["common_dir"]:
                raise StateConflict("database binding changed; reopen explicitly")
            project["root"] = self._execution_identity["root"]
        return project

    def _writer_policy(self):
        project = self._stored_project()
        latest = self.db.execute("SELECT * FROM events WHERE task_id='' AND kind='writer_policy_changed' ORDER BY event_id DESC LIMIT 1").fetchone()
        counts = self.db.execute("SELECT COUNT(DISTINCT attempt_id),COUNT(*) FROM reservations").fetchone()
        return {"project_id": project["project_id"], "common_dir": project["common_dir"],
                "max_writers": project["max_writers"], "reserved_attempts": counts[0], "reservation_rows": counts[1],
                "last_change_event": latest["event_id"] if latest else None,
                "last_change": _decode(latest) if latest else None,
                "policy_digest": digest({"project": project, "last_change_event": latest["event_id"] if latest else None})}

    def writer_policy(self):
        self.db.execute("BEGIN")
        try:
            return self._writer_policy()
        finally:
            self.db.execute("ROLLBACK")

    def set_writer_policy(self, max_writers, *, expected_digest, owner, reason):
        """An empty reservation window and CAS share the claim admission transaction."""
        _writer_limit(max_writers)
        nonempty(owner, "policy owner declaration")
        nonempty(reason, "policy change reason")
        with self._transaction():
            current = self._writer_policy()
            if current["policy_digest"] != expected_digest:
                raise StateConflict("writer policy changed; read back before mutation")
            if (current["reservation_rows"] or
                    self.db.execute("SELECT 1 FROM attempts WHERE status IN ('running','review','revise','rejected','appeal','accepted','integrating') LIMIT 1").fetchone() or
                    self.db.execute("SELECT 1 FROM integrations WHERE status NOT IN ('completed','cancelled','needs_revision') LIMIT 1").fetchone()):
                raise StateConflict("writer policy change requires no active reservations, attempts or pending integration")
            if current["max_writers"] != max_writers:
                project = self._stored_project()
                project["max_writers"] = max_writers
                self.db.execute("UPDATE metadata SET value=? WHERE key='project'", (canonical(project),))
                # Empty task ID cannot be created; project audit cannot collide with a task.
                self._event("", "writer_policy_changed", {"project_id": project["project_id"],
                            "previous": current["max_writers"], "max_writers": max_writers,
                            "owner": owner, "reason": reason, "expected_digest": expected_digest})
            return self._writer_policy()

    @contextmanager
    def _transaction(self):
        if self.readonly:
            raise StateConflict("read-only store")
        def current_file():
            try:
                identity = Path(self.path).stat()
            except OSError as exc:
                raise StateConflict("database moved; close the stale handle and reopen explicitly") from exc
            if (identity.st_dev, identity.st_ino) != self._database_inode:
                raise StateConflict("database file changed; stale open handle refused")
        try:
            current_file()
            self.db.execute("BEGIN IMMEDIATE")
            current_file()
            from .relocation import guard_pending
            guard_pending(Path(self.path).parent)
            yield
            self.db.execute("COMMIT")
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def _event(self, task_id, kind, payload):
        self.db.execute("INSERT INTO events(task_id,kind,payload_json,created_at) VALUES (?,?,?,?)",
                        (task_id, kind, canonical(payload), _now()))

    @contextmanager
    def _effect_lock(self, operation_id):
        """Kernel-released lock spanning the external effect, not a TTL lease.

        Each open uses a separate file description, including same-process store
        instances. No public flag can bypass this lock. Never unlink lock files:
        unlink/recreate would let two processes lock different inodes.
        """
        if self.readonly:
            raise StateConflict("read-only store")
        if not isinstance(operation_id, str) or len(operation_id) != 32 or any(c not in "0123456789abcdef" for c in operation_id):
            raise StateConflict("invalid operation ID")
        directory = Path(self.path).parent / (Path(self.path).name + ".effects")
        directory.mkdir(exist_ok=True)
        fd = os.open(directory / (operation_id + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise StateConflict("integration execution is in flight; observation cannot authorize cancellation or replay") from exc
            yield fd
        finally:
            os.close(fd)

    def task(self, task_id):
        return _decode(self.db.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone())

    def attempt(self, attempt_id):
        return _decode(self.db.execute("SELECT * FROM attempts WHERE attempt_id=?", (attempt_id,)).fetchone())

    def list_tasks(self):
        return [_decode(row) for row in self.db.execute("SELECT * FROM tasks ORDER BY created_at,task_id")]

    def events(self, task_id):
        return [_decode(row) for row in self.db.execute("SELECT * FROM events WHERE task_id=? ORDER BY event_id", (task_id,))]

    def resume(self, task_id):
        self.db.execute("BEGIN")
        try:
            task = self.task(task_id)
            return {"task": task, "attempt": self.attempt(task["active_attempt"]) if task["active_attempt"] else None,
                    "events": self.events(task_id), "capabilities": self.find_capabilities(task["goal"]),
                    "integrations": [_decode(r) for r in self.db.execute("SELECT * FROM integrations WHERE task_id=?", (task_id,))],
                    "wheel": self.wheel_status(task), "ui": self.ui_status(task_id),
                    "document_basis": self.document_basis_status(task)}
        finally:
            self.db.execute("ROLLBACK")

    def _revision(self, task, expected_revision):
        if type(expected_revision) is not int or expected_revision != task["revision"]:
            raise StateConflict("task revision changed")

    def document_basis_status(self, task, root=None):
        basis = documents.for_task(task, self.events(task["task_id"]))
        if basis is None:
            return {"status": "unconfigured", "note": "legacy task; plan/code/workspace snapshot is not document basis"}
        try:
            for event in self.events(task["task_id"]):
                if event["kind"] in {"goal_changed", "reopened"} and event["payload"]["previous_revision"] == task["revision"] - 1:
                    decision = event["payload"].get("document_change")
                    if decision:
                        documents.verify_source(decision)
            if root is None:
                root = self.attempt(task["active_attempt"])["workspace"] if task["active_attempt"] else self.project["root"]
            result = documents.observe(root, basis)
            assessed = any(e["kind"] == "document_refined" and e["payload"]["revision"] == task["revision"]
                           and e["payload"]["content_digest"] == result["content_digest"] for e in self.events(task["task_id"]))
            if result["status"] == "refined" and not assessed:
                result["status"] = "refinement_pending"
            return {"status": result["status"], "basis": basis, "current_digest": result["current"]["digest"]}
        except (StateConflict, OSError, ValueError) as exc:
            return {"status": "invalid", "basis": basis, "reason": str(exc)}

    def _document_guard(self, task, root=None):
        state = self.document_basis_status(task, root)
        if state["status"] in {"invalid", "material_changed", "refinement_pending"}:
            raise StateConflict("document basis requires related task revision: " + state.get("reason", state["status"]))
        return state.get("basis")

    def bind_document_basis(self, task_id, attempt_id, request, *, owner, epoch, expected_revision):
        """Explicit upgrade of a legacy attempt; never rewrite its claimed event."""
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"running", "revise"})
            if documents.for_task(task, self.events(task_id)) is not None:
                raise StateConflict("dispatch document basis is immutable; record refinement or revise material contract")
            if attempt["result_revision"] or self.db.execute("SELECT 1 FROM checks WHERE attempt_id=?", (attempt_id,)).fetchone():
                raise StateConflict("bind document basis before checks/results; prior evidence cannot be upgraded retroactively")
            snap = snapshot(attempt["workspace"], clean=True)
            basis = documents.resolve(attempt["workspace"], request, snap["head"])
            documents.matches(task, basis)
            self._event(task_id, "document_basis_bound", {"basis": basis, "revision": task["revision"],
                        "attempt_id": attempt_id, "owner": owner, "epoch": epoch,
                        "mode": "explicit_legacy_attempt_upgrade", "prior_claim_unchanged": True,
                        "preparation_basis": task["baseline"].get("document_basis_artifact"),
                        "source_classification_note": "unconfigured preparation/handoff is provenance, not original human approval; this event freezes the resolved directive source"})
            return basis

    def record_document_refinement(self, task_id, attempt_id, *, owner, epoch, expected_revision,
                                   classification, reason, semantic_assessment):
        nonempty(reason, "refinement reason")
        if classification not in {"editorial", "refinement"}:
            raise StateConflict("only editorial/refinement can keep task revision")
        if not isinstance(semantic_assessment, dict) or semantic_assessment.get("outcome") != "consistent":
            raise StateConflict("unknown/conflicting body semantics cannot be approved as editorial")
        nonempty(semantic_assessment.get("rationale"), "semantic assessment rationale")
        nonempty(semantic_assessment.get("source_ref"), "semantic assessment source reference")
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision,
                                        {"running", "revise"}, document_required=False)
            basis = documents.for_task(task, self.events(task_id))
            if basis is None:
                raise StateConflict("document basis unconfigured")
            observed = documents.observe(attempt["workspace"], basis)
            if observed["status"] == "material_changed":
                raise StateConflict("goal/scope/acceptance or effective lineage changed; cannot label editorial")
            self._event(task_id, "document_refined", {"revision": task["revision"], "attempt_id": attempt_id,
                        "classification": classification, "reason": reason, "frozen_digest": basis["digest"],
                        "observed": observed["current"], "content_digest": observed["content_digest"],
                        "semantic_assessment": semantic_assessment, "semantic_assessment_is_caller_declaration": True})
            return self.document_basis_status(task)

    def document_impact(self):
        """Read-only affected-task selection by each frozen stable item/lineage."""
        return [{"task_id": task["task_id"], "revision": task["revision"],
                 "item": (documents.for_task(task, self.events(task["task_id"])) or {}).get("request", {}).get("item"),
                 "status": self.document_basis_status(task, self.project["root"])["status"]} for task in self.list_tasks()]

    def full_projection(self, document_paths=None):
        """Optional projection from original Git carriers and this store only."""
        if document_paths is not None and (not isinstance(document_paths, list) or not all(isinstance(p, str) for p in document_paths)):
            raise StateConflict("document_paths must be an explicit list")
        tasks, paths = [], set(document_paths or [])
        associated = {}
        for task in self.list_tasks():
            current = self.resume(task["task_id"])
            basis = documents.for_task(task, current["events"])
            if basis:
                paths.update(basis["request"]["paths"])
                for key, entry in basis["material"]["lineage"].items():
                    associated.setdefault(key + "/" + entry["item"], []).append(task["task_id"])
            tasks.append({"task": task, "attempt": current["attempt"], "document_basis": current["document_basis"],
                          "checks": [_decode(r) for r in self.db.execute(
                              "SELECT checks.* FROM checks JOIN attempts USING(attempt_id) WHERE attempts.task_id=? ORDER BY checks.created_at", (task["task_id"],))],
                          "reviews": [_decode(r) for r in self.db.execute("SELECT * FROM reviews WHERE task_id=?", (task["task_id"],))],
                          "integrations": current["integrations"]})
        records, items, diagnostics = [], [], []
        if paths:
            try:
                records = documents.catalog(self.project["root"], sorted(paths))
                for record in records:
                    meta = record["meta"]
                    if meta is None:
                        diagnostics.append({"path": record["path"], "status": "unconfigured"})
                        continue
                    for item in meta["items"]:
                        ref = meta["id"] + "/" + item["id"]
                        state, reason = meta["state"], None
                        if state == "effective":
                            try:
                                documents.resolve(self.project["root"], {"paths": sorted(paths), "item": ref})
                            except (StateConflict, ValueError, OSError) as exc:
                                state, reason = "invalid", str(exc)
                        items.append({"reference": ref, "path": record["path"], "state": state,
                                      "reason": reason, "item": item, "task_ids": associated.get(ref, []),
                                      "dispatched": bool(associated.get(ref))})
            except (StateConflict, ValueError, OSError) as exc:
                diagnostics.append({"status": "invalid", "reason": str(exc), "paths": sorted(paths)})
        return {"tasks": tasks, "documents": records, "plan_items": items, "diagnostics": diagnostics,
                "readonly": True, "note": "all registrations including done/obsolete; evidence is not formal acceptance; sources do not authenticate authority"}

    def ui_status(self, task_id):
        return ui.project(self.task(task_id), self.events(task_id))

    def _ui_fence(self, task_id, expected_revision, expected_ui_digest, attempt_id, owner, epoch):
        task = self.task(task_id)
        _require_not_obsolete(task, "UI recording")
        self._revision(task, expected_revision)
        if task["status"] == "ready" and not task["active_attempt"]:
            if any(v is not None for v in (attempt_id, owner, epoch)):
                raise StateConflict("ready UI preparation has no attempt fence")
        else:
            self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"running", "revise"})
        state = self.ui_status(task_id)
        if expected_ui_digest != state["state_digest"]:
            raise StateConflict("UI state changed; read back before mutation")
        return task, state

    def record_ui(self, task_id, stage, content, *, expected_revision, expected_ui_digest,
                  attempt_id=None, owner=None, epoch=None, scope_change_evidence=None):
        with self._transaction():
            task, state = self._ui_fence(task_id, expected_revision, expected_ui_digest, attempt_id, owner, epoch)
            ui.validate_content(stage, content)
            required_history = any(e["kind"] == "ui_recorded" and e["payload"]["stage"] == "scope"
                                   and e["payload"]["content"]["mode"] == "required"
                                   for e in self.events(task_id))
            if stage == "scope" and content["mode"] == "no_ui" and required_history:
                current = state["nodes"].get("scope", {})
                if current.get("content") == content and scope_change_evidence is None:
                    scope_change_evidence = current.get("scope_change_evidence")
                changed = any(e["kind"] == "goal_changed" and
                              e["payload"]["previous_revision"] == task["revision"] - 1
                              for e in self.events(task_id))
                if (state["mode"] == "required" and (not changed or "scope" in state["nodes"])) or scope_change_evidence is None:
                    raise StateConflict("required UI cannot downgrade via ordinary record; change goal and supply user scope evidence")
                decision = ui.decision_record(scope_change_evidence, task_id, task["revision"], "scope", digest(content))
                if decision["kind"] != "user_message" or decision["decision"] != "confirm":
                    raise StateConflict("scope change requires actual user scope confirmation")
            if stage != "scope" and state["mode"] != "required":
                raise StateConflict("declare required UI scope before recording nodes")
            if stage in {"expression", "ui_acceptance"}:
                predecessor = "stack" if stage == "expression" else "expression"
                if not state["nodes"].get(predecessor, {}).get("usable"):
                    raise StateConflict("current user confirmation required before real UI stage")
            if stage == "stack":
                wheel = self.wheel_status(task)
                if wheel.get("status") != "valid" or content["wheel_review_id"] != wheel.get("review_id"):
                    raise StateConflict("UI stack must reference current bound find-wheel review")
            if stage == "ui_acceptance":
                workspace = self.attempt(attempt_id)["workspace"] if attempt_id else self.project["root"]
                if content["code_commit"] != snapshot(workspace, clean=True)["head"]:
                    raise StateConflict("UI acceptance must bind current clean code commit")
            current = state["nodes"].get(stage)
            if (not current or current["content"] != content or stage == "scope" and
                    current.get("scope_change_evidence") != scope_change_evidence):
                self._event(task_id, "ui_recorded", {"revision": task["revision"], "stage": stage,
                            "content": content, "scope_change_evidence": scope_change_evidence})
            return self.ui_status(task_id)

    def decide_ui(self, task_id, stage, content_digest, evidence, *, expected_revision, expected_ui_digest,
                  attempt_id=None, owner=None, epoch=None, source_revision=None, applicability=None):
        with self._transaction():
            task, state = self._ui_fence(task_id, expected_revision, expected_ui_digest, attempt_id, owner, epoch)
            if stage == "scope" or stage not in state["nodes"]:
                raise StateConflict("record a UI decision node first")
            if state["nodes"][stage]["content_digest"] != content_digest:
                raise StateConflict("UI content changed")
            origin = task["revision"] if source_revision is None else source_revision
            if source_revision is not None:
                if type(origin) is not int or not 1 <= origin < task["revision"]:
                    raise StateConflict("reuse source revision must precede current revision")
                nonempty(applicability, "unchanged decision applicability basis")
                old = ui.project({**task, "revision": origin}, self.events(task_id))
                node = old["nodes"].get(stage, {})
                if (node.get("content_digest") != content_digest or node.get("evidence") != evidence
                        or node.get("decision") != "confirm" or node.get("status") not in {"confirmed", "simulated"}):
                    raise StateConflict("reuse requires matching intact previously recorded decision")
                origin = node.get("source_revision", origin)
            decision = ui.decision_record(evidence, task_id, origin, stage, content_digest)
            self._event(task_id, "ui_decided", {"revision": task["revision"], "stage": stage,
                        "content_digest": content_digest, "evidence": evidence, "decision": decision["decision"],
                        "source_revision": origin, "applicability": applicability})
            return self.ui_status(task_id)

    def _fence(self, task_id, attempt_id, owner, epoch, expected_revision, statuses, *, wheel_required=True, document_required=True):
        task = self.task(task_id)
        _require_not_obsolete(task, "attempt-fenced execution")
        attempt = self.attempt(attempt_id)
        self._revision(task, expected_revision)
        if (not owner or type(epoch) is not int or task["owner"] != owner or attempt["owner"] != owner
                or task["epoch"] != epoch or attempt["epoch"] != epoch or task["active_attempt"] != attempt_id
                or attempt["task_id"] != task_id or attempt["baseline_revision"] != task["revision"]):
            raise StateConflict("stale attempt/owner/epoch/revision")
        if task["status"] not in statuses or attempt["status"] != task["status"]:
            raise StateConflict("illegal task/attempt status")
        if wheel_required:
            self._wheel_guard(task, attempt)
            if document_required:
                self._document_guard(task, attempt["workspace"])
        return task, attempt

    def wheel_review(self, review_id):
        row = _decode(self.db.execute("SELECT * FROM wheel_reviews WHERE review_id=?", (review_id,)).fetchone())
        if digest(row["record"]) != row["record_digest"]:
            raise StateConflict("find-wheel record digest changed")
        return {**row, "registered_at": row["created_at"]}

    def find_wheel_reviews(self, binding_digest=""):
        rows = self.db.execute("SELECT * FROM wheel_reviews WHERE binding_digest=? ORDER BY created_at" if binding_digest else
                               "SELECT * FROM wheel_reviews ORDER BY created_at", (binding_digest,) if binding_digest else ())
        return [self.wheel_review(row["review_id"]) for row in rows]

    def wheel_status(self, task):
        if task["kind"] == "nonbuild":
            if task["write_scope"] or task["capability_refs"]:
                return {"status": "invalid", "kind": task["kind"], "reason": "nonbuild contract cannot write or create capabilities"}
            return {"status": "not_required", "kind": task["kind"]}
        if task["kind"] != "build":
            return {"status": "legacy_unclassified", "kind": task["kind"], "reason": "explicit classification and fresh review required"}
        design = task["baseline"].get("design_digest")
        if not isinstance(design, str) or len(design) != 64 or any(c not in "0123456789abcdef" for c in design):
            return {"status": "invalid", "kind": task["kind"], "reason": "build baseline needs design_digest for interface/architecture changes"}
        if not task["wheel_review_id"]:
            return {"status": "missing", "kind": task["kind"]}
        try:
            review = self.wheel_review(task["wheel_review_id"])
            validate_record(review["record"])
            if review["binding_digest"] != digest(wheel_binding(task)) or review["record"]["binding"] != wheel_binding(task):
                raise StateConflict("find-wheel review binding is stale")
            skill = skill_status()
            if not skill["available"] or skill["sha256"] != review["record"]["skill"]["sha256"]:
                raise StateConflict("find-wheel skill missing or version changed")
            return {"status": "valid", "kind": task["kind"], "review_id": review["review_id"], "record_digest": review["record_digest"]}
        except StateConflict as exc:
            return {"status": "invalid", "kind": task["kind"], "review_id": task["wheel_review_id"], "reason": str(exc)}

    def _wheel_guard(self, task, attempt=None):
        status = self.wheel_status(task)
        if status["status"] not in {"valid", "not_required"}:
            raise StateConflict("find-wheel preflight required: " + status.get("reason", status["status"]))
        if attempt and status["status"] == "valid":
            review = self.wheel_review(status["review_id"])
            if review["created_at"] > attempt["created_at"]:
                raise StateConflict("find-wheel review was recorded after work began")

    def record_wheel_review(self, task_id, *, sources, candidates, decision, rationale, costs, skill, assumptions=None):
        with self._transaction():
            task = self.task(task_id)
            _require_not_obsolete(task, "wheel-record")
            if task["status"] not in {"ready", "superseded"}:
                raise StateConflict("find-wheel review must precede work")
            current = skill_status()
            if not current["available"] or skill != {"name": "find-wheel", "sha256": current["sha256"]}:
                raise StateConflict("installed find-wheel skill/version mismatch")
            normalized_sources = []
            for source in sources if isinstance(sources, list) else []:
                item = dict(source) if isinstance(source, dict) else source
                if isinstance(item, dict) and all(key in item for key in ("ref", "version", "checked_at", "finding")):
                    item.setdefault("evidence_digest", digest({key: item[key] for key in ("ref", "version", "checked_at", "finding")}))
                normalized_sources.append(item)
            record = validate_record({"version": REVIEW_VERSION, "skill": skill, "binding": wheel_binding(task),
                                      "sources": normalized_sources, "candidates": candidates, "decision": decision,
                                      "rationale": rationale, "costs": costs, "assumptions": assumptions or []})
            review_id, created_at = uuid.uuid4().hex, _now()
            self.db.execute("INSERT INTO wheel_reviews VALUES (?,?,?,?,?)",
                            (review_id, canonical(record), digest(record), digest(record["binding"]), created_at))
            self._event(task_id, "wheel_recorded", {"review_id": review_id, "record_digest": digest(record)})
            return self.wheel_review(review_id)

    def bind_wheel_review(self, task_id, review_id, *, expected_revision):
        with self._transaction():
            task = self.task(task_id)
            _require_not_obsolete(task, "wheel-bind")
            self._revision(task, expected_revision)
            if task["status"] not in {"ready", "superseded"}:
                raise StateConflict("bind find-wheel review before claim or after goal change")
            review = self.wheel_review(review_id)
            validate_record(review["record"])
            if review["binding_digest"] != digest(wheel_binding(task)) or review["record"]["binding"] != wheel_binding(task):
                raise StateConflict("find-wheel review does not apply to current contract")
            kind = "build" if task["kind"] == "legacy_unclassified" else task["kind"]
            if kind != "build":
                raise StateConflict("nonbuild tasks do not bind find-wheel reviews")
            self.db.execute("UPDATE tasks SET kind='build',wheel_review_id=?,updated_at=? WHERE task_id=?", (review_id, _now(), task_id))
            self._wheel_guard(self.task(task_id))
            self._event(task_id, "wheel_bound", {"review_id": review_id, "record_digest": review["record_digest"]})
            return self.task(task_id)

    def classify_task(self, task_id, kind, *, expected_revision, reason):
        nonempty(reason, "classification reason")
        if kind not in KINDS:
            raise StateConflict("kind must be build or nonbuild")
        with self._transaction():
            task = self.task(task_id)
            _require_not_obsolete(task, "classify_task")
            self._revision(task, expected_revision)
            if task["kind"] != "legacy_unclassified" or task["status"] != "ready":
                raise StateConflict("only unclaimed migrated tasks can be classified")
            if kind == "nonbuild" and (task["write_scope"] or task["capability_refs"]):
                raise StateConflict("nonbuild contract must have empty write_scope and no capability_refs")
            self.db.execute("UPDATE tasks SET kind=?,wheel_review_id=NULL,updated_at=? WHERE task_id=?", (kind, _now(), task_id))
            self._event(task_id, "classified", {"kind": kind, "reason": reason, "legacy": True})
            return self.task(task_id)

    def _contract(self, goal, acceptance, baseline, scope):
        nonempty(goal, "goal")
        if not isinstance(acceptance, list) or not acceptance or not all(isinstance(v, str) for v in acceptance) or len(set(acceptance)) != len(acceptance):
            raise StateConflict("acceptance must contain unique criteria")
        for item in acceptance:
            nonempty(item, "acceptance criterion")
        if not isinstance(baseline, dict):
            raise StateConflict("baseline must contain plan and code")
        nonempty(baseline.get("plan"), "baseline plan reference")
        code = commit(self.project["root"], baseline.get("code"))
        if isinstance(baseline.get("document_basis"), dict) and baseline["document_basis"].get("format") == documents.FORMAT and "documents" not in baseline:
            raise StateConflict("configured basis must resolve from documents; caller cannot inject a frozen standard")
        if "documents" in baseline:
            basis = documents.resolve(self.project["root"], baseline["documents"], code)
            expected = {"goal": goal, "acceptance": acceptance,
                        "write_scope": sorted({resource_path(self.project["root"], p) for p in (["."] if scope is None else scope)})}
            documents.matches(expected, basis)
            baseline = {**baseline, "document_basis": basis}
        return {**baseline, "code": code}, sorted({resource_path(self.project["root"], p) for p in (["."] if scope is None else scope)})

    def create_task(self, task_id, goal, acceptance, baseline, write_scope=None, *, resources=None, dependencies=None, capability_refs=None,
                    kind="build", wheel_review_id=None):
        nonempty(task_id, "task_id")
        if kind not in KINDS:
            raise StateConflict("kind must be build or nonbuild")
        with self._transaction():
            baseline, scope = self._contract(goal, acceptance, baseline, write_scope)
            resources, dependencies, capability_refs = resources or [], dependencies or [], capability_refs or []
            if kind == "nonbuild" and (scope or capability_refs):
                raise StateConflict("nonbuild contract must have empty write_scope and no capability_refs")
            for value in resources + dependencies + capability_refs:
                nonempty(value, "reference")
            if task_id in dependencies:
                raise StateConflict("task cannot depend on itself")
            for dep in dependencies:
                self.task(dep)
            try:
                self.db.execute("INSERT INTO tasks VALUES (?,?,?,1,0,'ready',NULL,NULL,?,?,?,?,?,NULL,?,?,?,?)",
                                (task_id, goal, canonical(baseline), canonical(acceptance), canonical(scope), canonical(sorted(set(resources))),
                                 canonical(dependencies), canonical(capability_refs), _now(), _now(), kind, wheel_review_id))
            except sqlite3.IntegrityError as exc:
                raise StateConflict("task already exists") from exc
            if wheel_review_id:
                self._wheel_guard(self.task(task_id))
            self._event(task_id, "created", {"baseline": baseline})
            return self.task(task_id)

    def _claim(self, task, owner, workspace, *, recovering=False):
        nonempty(owner, "host owner handle")
        _require_not_obsolete(task, "claim")
        if task["status"] != "ready" or task["active_attempt"]:
            raise StateConflict("task is not ready; completed work requires reopen")
        self._wheel_guard(task)
        document_basis = self._document_guard(task, workspace)
        if any(self.task(dep)["status"] != "done" for dep in task["dependencies"]):
            raise StateConflict("dependency incomplete")
        for ref in task["capability_refs"]:
            if any(c["status"] == "valid" for c in self.find_capabilities(ref, exact=True)):
                raise StateConflict("declared capability already completed; reuse or reopen")
        snap = snapshot(workspace, clean=not recovering)
        if snap["common_dir"] != self.project["common_dir"] or (not recovering and snap["head"] != task["baseline"]["code"]):
            raise StateConflict("workspace does not match project and baseline commit")
        if recovering:
            git(workspace, "merge-base", "--is-ancestor", task["baseline"]["code"], snap["head"])
        active = self.db.execute("SELECT DISTINCT attempt_id FROM reservations").fetchall()
        if len(active) >= self.project["max_writers"]:
            raise StateConflict("project writer limit reached")
        wanted = [("path", resource_path(workspace, p)) for p in task["write_scope"]]
        wanted += [("shared", p) for p in task["resources"]]
        wanted += [("capability", p.casefold()) for p in task["capability_refs"]]
        wanted += [("workspace", snap["root"])]
        for row in self.db.execute("SELECT kind,resource FROM reservations"):
            for kind, value in wanted:
                if kind == row["kind"] and (overlaps(value, row["resource"]) if kind == "path" else value == row["resource"]):
                    raise StateConflict(f"resource conflict: {kind}:{value}")
        attempt_id, epoch = uuid.uuid4().hex, task["epoch"] + 1
        self.db.execute("INSERT INTO attempts VALUES (?,?,?,?,?,'running',?,?,0,NULL,?,?)",
                        (attempt_id, task["task_id"], owner, epoch, task["revision"], snap["root"], canonical(snap), _now(), _now()))
        self.db.executemany("INSERT INTO reservations VALUES (?,?,?)", [(attempt_id, k, v) for k, v in set(wanted)])
        self.db.execute("UPDATE tasks SET owner=?,active_attempt=?,epoch=?,status='running',last_error=NULL,updated_at=? WHERE task_id=?",
                        (owner, attempt_id, epoch, _now(), task["task_id"]))
        self._event(task["task_id"], "claimed", {"attempt_id": attempt_id, "owner": owner, "epoch": epoch,
                    "snapshot": snap, "document_basis": document_basis})
        return {"task_id": task["task_id"], "attempt_id": attempt_id, "owner": owner, "epoch": epoch,
                "baseline_revision": task["revision"], "expected_revision": task["revision"]}

    def claim(self, task_id, owner, *, expected_revision=None, workspace=None):
        with self._transaction():
            task = self.task(task_id)
            if expected_revision is not None:
                self._revision(task, expected_revision)
            return self._claim(task, owner, workspace or self.project["root"])

    def change_goal(self, task_id, goal, baseline, reason, *, acceptance, expected_revision, kind=None,
                    write_scope=None, document_change=None):
        nonempty(reason, "change reason")
        with self._transaction():
            task = self.task(task_id)
            _require_not_obsolete(task, "change_goal")
            self._revision(task, expected_revision)
            if task["status"] in {"done", "legacy_blocked"}:
                raise StateConflict("use reopen/adopt_legacy")
            kind = ("build" if task["kind"] == "legacy_unclassified" else task["kind"]) if kind is None else kind
            if kind not in KINDS:
                raise StateConflict("kind must be build or nonbuild")
            if kind == "nonbuild" and (task["write_scope"] or task["capability_refs"]):
                raise StateConflict("nonbuild contract must have empty write_scope and no capability_refs")
            scope = task["write_scope"] if write_scope is None else write_scope
            old_basis = documents.for_task(task, self.events(task_id))
            if old_basis is not None:
                if not isinstance(document_change, dict) or document_change.get("classification") != "material":
                    raise StateConflict("configured document contract changes require explicit material user source")
                documents.verify_source(document_change)
                nonempty(document_change.get("source_ref"), "material user message reference")
                ids = document_change.get("task_ids")
                if document_change.get("kind") not in documents.SOURCE_KINDS or not isinstance(ids, list) or task_id not in ids:
                    raise StateConflict("material source scope must explicitly include task")
                if baseline.get("documents") != old_basis["request"]:
                    raise StateConflict("material revision must retain stable document/item association")
                old_sources = {v["authorization"]["source"]["sha256"] for v in old_basis["material"]["lineage"].values()}
                if document_change["source"]["sha256"] in old_sources:
                    raise StateConflict("material change needs a new applicable user decision; original source cannot self-approve changed standards")
            baseline, scope = self._contract(goal, acceptance, baseline, scope)
            if old_basis is not None and baseline["document_basis"]["material"] == old_basis["material"]:
                raise StateConflict("no material change; record refinement instead of invalidating attempt/wheel")
            if kind == "nonbuild" and (scope or task["capability_refs"]):
                raise StateConflict("nonbuild contract must have empty write_scope and no capability_refs")
            if task["active_attempt"]:
                self.db.execute("UPDATE attempts SET status='superseded',updated_at=? WHERE attempt_id=?", (_now(), task["active_attempt"]))
            status = "superseded" if task["active_attempt"] else "ready"
            self.db.execute("UPDATE tasks SET goal=?,baseline_json=?,acceptance_json=?,write_scope_json=?,kind=?,wheel_review_id=NULL,revision=revision+1,status=?,updated_at=? WHERE task_id=?",
                            (goal, canonical(baseline), canonical(acceptance), canonical(scope), kind, status, _now(), task_id))
            self._event(task_id, "goal_changed", {"reason": reason, "previous_revision": expected_revision,
                        "document_change": document_change})
            return self.task(task_id)

    def _abandon(self, task, attempt, reason, observation):
        self.db.execute("UPDATE attempts SET status='abandoned',updated_at=? WHERE attempt_id=?", (_now(), attempt["attempt_id"]))
        self.db.execute("DELETE FROM reservations WHERE attempt_id=?", (attempt["attempt_id"],))
        self.db.execute("UPDATE tasks SET status='ready',owner=NULL,active_attempt=NULL,updated_at=? WHERE task_id=?", (_now(), task["task_id"]))
        self._event(task["task_id"], "released", {"attempt_id": attempt["attempt_id"], "reason": reason, "observation": observation})

    def release(self, task_id, attempt_id, *, owner, epoch, expected_revision, reason):
        nonempty(reason, "release reason")
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"running", "revise", "rejected", "review", "accepted"}, wheel_required=False)
            self._abandon(task, attempt, reason, snapshot(attempt["workspace"]))
            return self.task(task_id)

    def recover(self, task_id, owner, *, attempt_id, epoch, expected_revision, reason, observation, workspace=None):
        """Host stop observation + current workspace required; no TTL takeover.

        JSON artifact: attempt_id, owner, epoch, state='stopped', source (host
        evidence ref), workspace_snapshot (snapshot output). Host authenticity
        remains the adapter's responsibility, not something a hash proves.
        """
        nonempty(reason, "recovery reason")
        nonempty(owner, "new host owner handle")
        with self._transaction():
            task, old = self.task(task_id), self.attempt(attempt_id)
            _require_not_obsolete(task, "recover")
            self._revision(task, expected_revision)
            if (type(epoch) is not int or task["active_attempt"] != attempt_id or task["epoch"] != epoch or old["epoch"] != epoch
                    or old["owner"] != task["owner"]
                    or old["task_id"] != task_id or task["status"] == "done"
                    or old["status"] not in {"running", "review", "revise", "rejected", "appeal", "accepted", "superseded", "integrating"}):
                raise StateConflict("recovery does not match active execution; use reopen/reconcile")
            verify_artifact(observation)
            data = json.loads(Path(observation["path"]).read_text())
            if any(data.get(k) != v for k, v in {"attempt_id": attempt_id, "owner": old["owner"], "epoch": epoch, "state": "stopped"}.items()):
                raise StateConflict("old execution not observed stopped")
            nonempty(data.get("source"), "host observation source")
            current = snapshot(old["workspace"])
            if data.get("workspace_snapshot") != current:
                raise StateConflict("recovery workspace observation is stale")
            pending_rows = self.db.execute("SELECT * FROM integrations WHERE attempt_id=? AND status NOT IN ('completed','cancelled','needs_revision')", (attempt_id,)).fetchall()
            if task["status"] == "integrating":
                self._wheel_guard(task, old)
                if len(pending_rows) != 1:
                    raise StateConflict("integration recovery requires exactly one pending operation")
                pending = self._operation(pending_rows[0]["operation_id"], task, old)
                with self._effect_lock(pending["operation_id"]):
                    observed = self._observe_operation(pending)
                    if observed["state"] == "unknown":
                        raise StateConflict("integration outcome unknown; inspect target before ownership transfer")
                    # Preserve candidate/review provenance; only the current fence
                    # and operation owner change. New integration checks are required.
                    next_epoch = epoch + 1
                    self.db.execute("UPDATE attempts SET owner=?,epoch=?,updated_at=? WHERE attempt_id=?", (owner, next_epoch, _now(), attempt_id))
                    self.db.execute("UPDATE tasks SET owner=?,epoch=?,updated_at=? WHERE task_id=?", (owner, next_epoch, _now(), task_id))
                    self.db.execute("UPDATE integrations SET epoch=?,status=?,observation_json=? WHERE operation_id=?",
                                    (next_epoch, observed["state"], canonical(observed), pending["operation_id"]))
                    self._event(task_id, "integration_taken_over", {"operation_id": pending["operation_id"], "previous_owner": old["owner"],
                                "previous_epoch": epoch, "owner": owner, "epoch": next_epoch, "reason": reason,
                                "stop_observation": observation, "target_observation": observed})
                    return {"task_id": task_id, "attempt_id": attempt_id, "owner": owner, "epoch": next_epoch,
                            "expected_revision": task["revision"], "baseline_revision": task["revision"],
                            "operation_id": pending["operation_id"], "integration_state": observed["state"]}
            # A changed goal may have fenced an in-flight Git operation. Only a
            # stopped host observation permits retiring that operation, after
            # reading the target. Preserve effects; never reverse/replay Git here.
            for pending in pending_rows:
                pending = _decode(pending)
                with self._effect_lock(pending["operation_id"]):
                    observed = self._observe_operation(pending)
                    if observed["state"] == "unknown":
                        raise StateConflict("old integration outcome unknown; inspect target before recovery")
                    status = "needs_revision" if observed["state"] == "applied" else "cancelled"
                    self.db.execute("UPDATE integrations SET status=?,observation_json=? WHERE operation_id=?",
                                    (status, canonical(observed), pending["operation_id"]))
                    self._event(task_id, "stale_integration_retired", {"operation_id": pending["operation_id"], "observation": observed})
            self._abandon(task, old, reason, {"artifact": observation, "workspace": current})
            return self._claim(self.task(task_id), owner, workspace or old["workspace"], recovering=True)

    def reopen(self, task_id, *, reason, expected_revision, baseline, acceptance=None, document_change=None):
        nonempty(reason, "reopen reason")
        with self._transaction():
            task = self.task(task_id)
            _require_not_obsolete(task, "reopen")
            self._revision(task, expected_revision)
            if task["status"] != "done":
                raise StateConflict("only completed tasks can reopen")
            acceptance = task["acceptance"] if acceptance is None else acceptance
            baseline, _ = self._contract(task["goal"], acceptance, baseline, task["write_scope"])
            old_basis = documents.for_task(task, self.events(task_id))
            if old_basis is not None:
                new_basis = baseline.get("document_basis")
                if not isinstance(new_basis, dict) or new_basis.get("request") != old_basis["request"]:
                    raise StateConflict("reopen cannot drop configured stable document/item basis")
                if new_basis["material"] != old_basis["material"]:
                    if not isinstance(document_change, dict) or document_change.get("classification") != "material" or document_change.get("kind") not in documents.SOURCE_KINDS:
                        raise StateConflict("material reopen requires applicable user decision")
                    documents.verify_source(document_change)
                    nonempty(document_change.get("source_ref"), "material user message reference")
                    ids = document_change.get("task_ids")
                    if not isinstance(ids, list) or task_id not in ids or document_change["source"]["sha256"] in {
                            v["authorization"]["source"]["sha256"] for v in old_basis["material"]["lineage"].values()}:
                        raise StateConflict("material reopen cannot self-approve original standard")
            self.db.execute("UPDATE tasks SET revision=revision+1,status='ready',owner=NULL,active_attempt=NULL,baseline_json=?,acceptance_json=?,wheel_review_id=NULL,updated_at=? WHERE task_id=?",
                            (canonical(baseline), canonical(acceptance), _now(), task_id))
            self.db.execute("UPDATE capabilities SET status='invalid',reason=? WHERE task_id=?", (reason, task_id))
            self._event(task_id, "reopened", {"reason": reason, "previous_revision": expected_revision, "document_change": document_change})
            return self.task(task_id)

    def obsolete(self, task_id, *, reason, expected_revision):
        """Retire a never-claimed registration whose outcome was delivered outside the flow.

        This is a terminal resting state, not a completion claim: nothing is
        verified, reviewed, integrated, or accepted here, and the event records
        only the caller's stated reason for retirement.
        """
        nonempty(reason, "obsolete reason")
        with self._transaction():
            task = self.task(task_id)
            self._revision(task, expected_revision)
            if task["status"] == "obsolete":
                raise StateConflict("task is already obsolete")
            if task["status"] != "ready":
                raise StateConflict(f"only ready tasks can be obsoleted; task is {task['status']}")
            if task["active_attempt"]:
                raise StateConflict("task has an active attempt; release or finish it before obsoleting")
            self.db.execute("UPDATE tasks SET status='obsolete',updated_at=? WHERE task_id=?", (_now(), task_id))
            self._event(task_id, "obsoleted", {"reason": reason, "previous_revision": expected_revision})
            return self.task(task_id)

    def adopt_legacy(self, task_id, *, expected_revision, goal, acceptance, baseline, reason, observation=None):
        nonempty(reason, "legacy adoption reason")
        with self._transaction():
            task = self.task(task_id)
            _require_not_obsolete(task, "adopt_legacy")
            self._revision(task, expected_revision)
            if task["status"] != "legacy_blocked":
                raise StateConflict("not an imported legacy task")
            old = self.db.execute("SELECT active_attempt,status,owner FROM legacy_tasks WHERE task_id=?", (task_id,)).fetchone()
            if old and old[0] and old[1] != "done":
                verify_artifact(observation)
                observed = json.loads(Path(observation["path"]).read_text())
                if any(observed.get(k) != v for k, v in {"attempt_id": old[0], "owner": old[2], "state": "stopped",
                        "workspace_snapshot": snapshot(self.project["root"])}.items()):
                    raise StateConflict("legacy execution requires stopped host and current workspace observation")
                nonempty(observed.get("source"), "legacy host observation source")
            baseline, scope = self._contract(goal, acceptance, baseline, task["write_scope"])
            self.db.execute("UPDATE tasks SET goal=?,acceptance_json=?,baseline_json=?,write_scope_json=?,kind='build',wheel_review_id=NULL,revision=revision+1,status='ready',last_error=NULL WHERE task_id=?",
                            (goal, canonical(acceptance), canonical(baseline), canonical(scope), task_id))
            self._event(task_id, "legacy_adopted", {"reason": reason, "observation": observation})
            return self.task(task_id)

    def run_check(self, task_id, attempt_id, *, owner, epoch, expected_revision, command,
                  coverage, timeout=120, operation_id=None, inputs=None):
        kwargs = dict(owner=owner, epoch=epoch, expected_revision=expected_revision, command=command,
                      coverage=coverage, timeout=timeout, operation_id=operation_id, inputs=inputs)
        if operation_id:
            with self._effect_lock(operation_id) as fd:
                return self._run_check(task_id, attempt_id, **kwargs, effect_fd=fd)
        return self._run_check(task_id, attempt_id, **kwargs, effect_fd=None)

    def _run_check(self, task_id, attempt_id, *, owner, epoch, expected_revision, command,
                   coverage, timeout, operation_id, inputs, effect_fd):
        """Execute authorized argv (no shell), retain logs, then recheck identity/code."""
        if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
            raise StateConflict("command must be a nonempty argv list")
        if not isinstance(coverage, list) or not coverage:
            raise StateConflict("check needs acceptance coverage")
        inputs = inputs or []
        for item in inputs:
            verify_artifact(item)
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision,
                                        {"integrating"} if operation_id else {"running", "revise"})
            if not set(coverage) <= set(task["acceptance"]):
                raise StateConflict("unknown acceptance criterion")
            operation = self._operation(operation_id, task, attempt) if operation_id else None
            root = operation["target_root"] if operation else attempt["workspace"]
            before = snapshot(root, clean=True)
            if operation and (before["head"] != operation["candidate"] or operation["status"] not in {"applied", "verify_failed"}):
                raise StateConflict("reconcile integration before running checks")
            result_revision = attempt["result_revision"] if operation else attempt["result_revision"] + 1
        started = _now()
        try:
            proc = subprocess.run(command, cwd=root, capture_output=True, timeout=timeout,
                                  pass_fds=() if effect_fd is None else (effect_fd,))
            code, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as exc:
            code, stdout, stderr = 124, exc.stdout or b"", exc.stderr or b""
        except OSError as exc:
            code, stdout, stderr = 127, b"", str(exc).encode()
        check_id = uuid.uuid4().hex
        evidence_dir = Path(self.path).parent / (Path(self.path).name + ".evidence")
        evidence_dir.mkdir(exist_ok=True)
        log = evidence_dir / (check_id + ".log")
        with log.open("xb") as output:
            output.write(stdout + b"\n--- stderr ---\n" + stderr)
        record = {"command": command, "cwd": root, "coverage": coverage, "exit_code": code,
                  "started_at": started, "finished_at": _now(), "log": artifact(log), "snapshot": before, "inputs": inputs}
        with self._transaction():
            task, current = self._fence(task_id, attempt_id, owner, epoch, expected_revision,
                                        {"integrating"} if operation else {"running", "revise"})
            if snapshot(root, clean=True) != before or current["result_revision"] != attempt["result_revision"]:
                raise StateConflict("code/result changed while check ran; log retained but not admitted")
            if operation:
                self._operation(operation_id, task, current)
            for item in inputs:
                verify_artifact(item)
            self.db.execute("INSERT INTO checks VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (check_id, attempt_id, epoch, expected_revision, result_revision,
                             "integration" if operation else "candidate", operation_id, before["head"], canonical(record), _now()))
            self._event(task_id, "check_recorded", {"check_id": check_id, "exit_code": code})
            if operation and code:
                self.db.execute("UPDATE integrations SET status='verify_failed' WHERE operation_id=?", (operation_id,))
                self.db.execute("UPDATE tasks SET last_error=? WHERE task_id=?", (f"integration check {check_id} failed", task_id))
            elif operation:
                self.db.execute("UPDATE integrations SET status='applied' WHERE operation_id=?", (operation_id,))
        return {"check_id": check_id, **record}

    def _checks(self, ids, task, attempt, subject_commit, result_revision, operation_id=None, evidence_epoch=None):
        if not isinstance(ids, list) or not ids or len(set(ids)) != len(ids):
            raise StateConflict("nonempty unique check IDs required")
        coverage, records = set(), []
        for check_id in ids:
            row = _decode(self.db.execute("SELECT * FROM checks WHERE check_id=?", (check_id,)).fetchone())
            if (row["attempt_id"] != attempt["attempt_id"] or row["epoch"] != (attempt["epoch"] if evidence_epoch is None else evidence_epoch)
                    or row["revision"] != task["revision"] or row["subject_commit"] != subject_commit
                    or row["result_revision"] != result_revision or row["operation_id"] != operation_id
                    or row["record"]["exit_code"] != 0):
                raise StateConflict("check is failed, stale, or for a different subject")
            verify_artifact(row["record"]["log"])
            for item in row["record"].get("inputs", []):
                verify_artifact(item)
            coverage.update(row["record"]["coverage"])
            records.append(row)
        if not set(task["acceptance"]) <= coverage:
            raise StateConflict("acceptance coverage incomplete")
        # Reconciliation cannot erase an already observed failed check. Every
        # affected criterion needs a later passing run in the selected evidence.
        for failed in self.db.execute("SELECT * FROM checks WHERE attempt_id=? AND result_revision=? AND operation_id IS ?",
                                      (attempt["attempt_id"], result_revision, operation_id)):
            failed = _decode(failed)
            if failed["record"]["exit_code"]:
                for criterion in failed["record"]["coverage"]:
                    if not any(criterion in r["record"]["coverage"] and r["created_at"] > failed["created_at"] for r in records):
                        raise StateConflict("newer failed check requires fresh passing evidence")
        return records

    def submit(self, task_id, attempt_id, result, *, owner, epoch, expected_revision):
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"running", "revise"})
            state = self.ui_status(task_id)
            if state["status"] != "unconfigured" and state["status"] != "not_applicable" and not state["ui_accepted"]:
                raise StateConflict("current user UI acceptance required; tests cannot substitute")
            snap = snapshot(attempt["workspace"], clean=True)
            self._validate_ui_binding(state, snap["head"])
            if not isinstance(result, dict) or result.get("commit") != snap["head"]:
                raise StateConflict("result must identify current full commit SHA")
            bound = subject(attempt["workspace"], task["baseline"]["code"], snap["head"])
            if task["kind"] == "nonbuild" and (bound["paths"] or result.get("capabilities")):
                raise StateConflict("nonbuild result cannot change code or produce a capability")
            for path in bound["paths"]:
                actual = resource_path(attempt["workspace"], path)
                if not any(scope == "." or actual == scope or actual.startswith(scope + "/") for scope in task["write_scope"]):
                    raise StateConflict(f"changed path outside write scope: {path}")
            revision = attempt["result_revision"] + 1
            checks = self._checks(result.get("checks"), task, attempt, bound["commit"], revision)
            artifacts = result.get("artifacts", [])
            for item in artifacts:
                verify_artifact(item)
            capabilities = self._validate_capabilities(result.get("capabilities", []), task, bound["commit"], attempt["workspace"])
            package = {"subject": bound, "checks": result["checks"], "artifacts": artifacts,
                       "capabilities": capabilities, "acceptance": task["acceptance"], "revision": task["revision"],
                       "result_revision": revision, "execution_epoch": epoch, "check_records_digest": digest(checks),
                       "ui_binding": state, "document_basis": self._document_guard(task)}
            package["subject_digest"] = digest(package)
            self.db.execute("UPDATE attempts SET status='review',result_revision=?,result_json=?,updated_at=? WHERE attempt_id=?",
                            (revision, canonical(package), _now(), attempt_id))
            self.db.execute("UPDATE tasks SET status='review',updated_at=? WHERE task_id=?", (_now(), task_id))
            self._event(task_id, "submitted", {"attempt_id": attempt_id, "result_revision": revision, "subject_digest": package["subject_digest"]})
            return package

    def _validate_ui_binding(self, state, code_commit):
        if state["status"] == "unconfigured":
            return
        if state["status"] == "not_applicable":
            return
        if not state["ui_accepted"]:
            raise StateConflict("current user UI acceptance required; tests cannot substitute")
        if state["nodes"]["ui_acceptance"]["content"]["code_commit"] != code_commit:
            raise StateConflict("UI acceptance code commit changed")

    def _result(self, task, attempt, result_revision, subject_digest):
        result = attempt["result"]
        if not result or attempt["result_revision"] != result_revision or result["subject_digest"] != subject_digest:
            raise StateConflict("stale result revision or subject digest")
        if snapshot(attempt["workspace"], clean=True)["head"] != result["subject"]["commit"]:
            raise StateConflict("reviewed workspace changed")
        current_ui = self.ui_status(task["task_id"])
        if "ui_binding" in result:
            if current_ui != result["ui_binding"]:
                raise StateConflict("submitted UI state or evidence changed")
            self._validate_ui_binding(current_ui, result["subject"]["commit"])
        elif current_ui["status"] != "unconfigured":
            raise StateConflict("result lacks configured UI binding; resubmit")
        checks = self._checks(result["checks"], task, attempt, result["subject"]["commit"], result_revision, evidence_epoch=result["execution_epoch"])
        if digest(checks) != result["check_records_digest"]:
            raise StateConflict("check records changed")
        for item in result["artifacts"]:
            verify_artifact(item)
        return result

    def _set_status(self, task_id, attempt_id, status):
        self.db.execute("UPDATE attempts SET status=?,updated_at=? WHERE attempt_id=?", (status, _now(), attempt_id))
        self.db.execute("UPDATE tasks SET status=?,updated_at=? WHERE task_id=?", (status, _now(), task_id))

    def review(self, task_id, attempt_id, alignment, technical, decision, rationale, *,
               owner, epoch, expected_revision, reviewer, result_revision, subject_digest):
        nonempty(rationale, "review rationale")
        nonempty(reviewer, "reviewer host identity")
        if alignment not in {"aligned", "misaligned", "unknown"} or technical not in {"correct", "failed", "unknown"} or decision not in {"accept", "revise", "reject"}:
            raise StateConflict("invalid review conclusion")
        if decision == "accept" and (alignment != "aligned" or technical != "correct"):
            raise StateConflict("negative or unknown findings cannot accept")
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"review"})
            if reviewer == owner:
                raise StateConflict("reviewer must differ from execution owner")
            self._result(task, attempt, result_revision, subject_digest)
            # At most one appeal for a result revision, even after an overturned
            # finding produces a new review record.
            review_id = uuid.uuid4().hex
            self.db.execute("INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            (review_id, task_id, attempt_id, result_revision, subject_digest, reviewer,
                             alignment, technical, decision, rationale, _now()))
            self._set_status(task_id, attempt_id, {"accept": "accepted", "revise": "revise", "reject": "rejected"}[decision])
            self._event(task_id, "reviewed", {"review_id": review_id, "reviewer": reviewer, "decision": decision})
            return review_id

    def reconsider(self, task_id, attempt_id, rationale, *, owner, epoch, expected_revision,
                   review_id, result_revision, subject_digest, evidence):
        nonempty(rationale, "appeal reason")
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"revise", "rejected"})
            self._result(task, attempt, result_revision, subject_digest)
            row = _decode(self.db.execute("SELECT * FROM reviews WHERE review_id=?", (review_id,)).fetchone())
            used = self.db.execute("SELECT 1 FROM appeals JOIN reviews USING(review_id) WHERE attempt_id=? AND result_revision=?", (attempt_id, result_revision)).fetchone()
            if used or row["attempt_id"] != attempt_id or row["result_revision"] != result_revision or row["decision"] == "accept":
                raise StateConflict("one appeal per current negative result")
            if not evidence:
                raise StateConflict("appeal requires counterevidence")
            for item in evidence:
                verify_artifact(item)
            self.db.execute("INSERT INTO appeals VALUES (?,?,?,NULL,NULL,NULL)", (review_id, rationale, canonical(evidence)))
            self._set_status(task_id, attempt_id, "appeal")
            self._event(task_id, "reconsidered", {"review_id": review_id, "rationale": rationale})

    def adjudicate(self, task_id, attempt_id, *, owner, epoch, expected_revision, review_id,
                   result_revision, subject_digest, adjudicator, decision, rationale):
        nonempty(rationale, "adjudication rationale")
        nonempty(adjudicator, "adjudicator identity")
        if decision not in {"uphold", "overturn"}:
            raise StateConflict("adjudication must uphold or overturn")
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"appeal"})
            self._result(task, attempt, result_revision, subject_digest)
            review = _decode(self.db.execute("SELECT * FROM reviews WHERE review_id=?", (review_id,)).fetchone())
            appeal = _decode(self.db.execute("SELECT * FROM appeals WHERE review_id=?", (review_id,)).fetchone())
            if (review["attempt_id"] != attempt_id or review["result_revision"] != result_revision
                    or adjudicator in {owner, review["reviewer"]} or appeal["decision"]):
                raise StateConflict("adjudication must be independent and current")
            for item in appeal["evidence"]:
                verify_artifact(item)
            status = "review" if decision == "overturn" else ("revise" if review["decision"] == "revise" else "rejected")
            self.db.execute("UPDATE appeals SET decision=?,adjudicator=?,rationale=? WHERE review_id=?", (decision, adjudicator, rationale, review_id))
            self._set_status(task_id, attempt_id, status)
            self._event(task_id, "adjudicated", {"review_id": review_id, "decision": decision, "rationale": rationale})

    def _validate_capabilities(self, values, task, revision, root):
        if not isinstance(values, list):
            raise StateConflict("capabilities must be a list")
        ids = set()
        for value in values:
            cid = nonempty(value.get("capability_id"), "capability ID")
            nonempty(value.get("name"), "capability name")
            if cid in ids:
                raise StateConflict("duplicate capability ID")
            ids.add(cid)
            if not isinstance(value.get("aliases", []), list) or not isinstance(value.get("entries"), list) or not value["entries"]:
                raise StateConflict("capability needs entries and aliases list")
            for alias in value.get("aliases", []):
                nonempty(alias, "alias")
            old = self.db.execute("SELECT task_id,status FROM capabilities WHERE capability_id=?", (cid,)).fetchone()
            if old and (old["status"] == "valid" or old["task_id"] != task["task_id"]):
                raise StateConflict("capability already exists; reopen its owning task")
            for entry in value["entries"]:
                path = nonempty(entry, "entry").split("#", 1)[0]
                resource_path(root, path)
                git(root, "cat-file", "-e", revision + ":" + path)
        return values

    def find_capabilities(self, query="", *, exact=False):
        folded, matches = query.casefold(), []
        for row in self.db.execute("SELECT * FROM capabilities ORDER BY capability_id"):
            value = _decode(row)
            keys = [value["capability_id"], value["name"], *value["aliases"], *value["entries"]]
            if any(folded == k.casefold() if exact else folded in k.casefold() for k in keys):
                matches.append(value)
        return matches

    def record_capability(self, *args, **kwargs):
        raise StateConflict("capabilities are registered by finalize_integration from the reviewed result")

    def reserve_integration(self, task_id, attempt_id, *, owner, epoch, expected_revision,
                            result_revision, subject_digest, target_root, target_ref, expected_head):
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"accepted"})
            result = self._result(task, attempt, result_revision, subject_digest)
            snap = snapshot(target_root, clean=True)
            if snap["common_dir"] != self.project["common_dir"] or snap["head"] != expected_head:
                raise StateConflict("integration target baseline changed")
            if self.db.execute("SELECT 1 FROM reservations WHERE kind='workspace' AND resource=? AND attempt_id!=?",
                               (snap["root"], attempt_id)).fetchone():
                raise StateConflict("integration target belongs to another active writer")
            if not target_ref.startswith("refs/heads/") or git(target_root, "symbolic-ref", "HEAD").decode().strip() != target_ref:
                raise StateConflict("target ref must be checked-out local branch")
            candidate = result["subject"]["commit"]
            git(target_root, "merge-base", "--is-ancestor", expected_head, candidate)
            operation_id = uuid.uuid4().hex
            try:
                self.db.execute("INSERT INTO integrations VALUES (?,?,?,?,?,?,?,?,?,?,?,'reserved',NULL,NULL,?)",
                                (operation_id, task_id, attempt_id, epoch, expected_revision, result_revision,
                                 subject_digest, snap["root"], target_ref, expected_head, candidate, _now()))
            except sqlite3.IntegrityError as exc:
                raise StateConflict("another integration is pending") from exc
            self._set_status(task_id, attempt_id, "integrating")
            self.db.execute("INSERT OR IGNORE INTO reservations VALUES (?,'workspace',?)", (attempt_id, snap["root"]))
            self._event(task_id, "integration_reserved", {"operation_id": operation_id, "target": snap})
            return self.integration(operation_id)

    def integration(self, operation_id):
        return _decode(self.db.execute("SELECT * FROM integrations WHERE operation_id=?", (operation_id,)).fetchone())

    def _operation(self, operation_id, task, attempt):
        op = self.integration(operation_id)
        if (op["task_id"] != task["task_id"] or op["attempt_id"] != attempt["attempt_id"]
                or op["revision"] != task["revision"] or op["epoch"] != attempt["epoch"]
                or op["result_revision"] != attempt["result_revision"] or op["subject_digest"] != attempt["result"]["subject_digest"]):
            raise StateConflict("stale integration operation")
        return op

    def _observe_operation(self, op):
        snap = snapshot(op["target_root"])
        ref = git(op["target_root"], "symbolic-ref", "HEAD").decode().strip()
        actual = commit(op["target_root"], op["target_ref"])
        if ref != op["target_ref"] or not snap["clean"] or snap["head"] != actual:
            status = "unknown"
        elif actual == op["candidate"]:
            status = "applied"
        elif actual == op["expected_head"]:
            status = "not_applied"
        else:
            status = "unknown"
        return {"state": status, "workspace": snap, "actual_ref": actual, "observed_at": _now()}

    def execute_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision):
        with self._effect_lock(operation_id) as fd:
            return self._execute_integration(task_id, attempt_id, operation_id, owner=owner, epoch=epoch, expected_revision=expected_revision, effect_fd=fd)

    def _execute_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, effect_fd):
        """Explicit fast-forward effect. Recovery never blindly repeats this."""
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"integrating"})
            op = self._operation(operation_id, task, attempt)
            if op["status"] not in {"reserved", "not_applied"}:
                raise StateConflict("observe pending effect before retry")
            self._result(task, attempt, op["result_revision"], op["subject_digest"])
            if self._observe_operation(op)["state"] != "not_applied":
                raise StateConflict("target moved; reconcile before execution")
            self.db.execute("UPDATE integrations SET status='applying' WHERE operation_id=?", (operation_id,))
            self._event(task_id, "integration_started", {"operation_id": operation_id})
        error = None
        try:
            git(op["target_root"], "merge", "--ff-only", "--no-edit", op["candidate"], pass_fds=(effect_fd,))
        except StateConflict as exc:
            error = str(exc)
        return self._reconcile_integration(task_id, attempt_id, operation_id, owner=owner, epoch=epoch,
                                           expected_revision=expected_revision, error=error)

    def reconcile_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, error=None):
        with self._effect_lock(operation_id):
            return self._reconcile_integration(task_id, attempt_id, operation_id, owner=owner, epoch=epoch, expected_revision=expected_revision, error=error)

    def _reconcile_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, error=None):
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"integrating"}, wheel_required=False)
            op = self._operation(operation_id, task, attempt)
            observation = self._observe_operation(op)
            self.db.execute("UPDATE integrations SET status=?,observation_json=? WHERE operation_id=?",
                            (observation["state"], canonical(observation), operation_id))
            self.db.execute("UPDATE tasks SET last_error=? WHERE task_id=?", (error or ("integration outcome unknown" if observation["state"] == "unknown" else task["last_error"]), task_id))
            self._event(task_id, "integration_observed", {"operation_id": operation_id, **observation, "error": error})
            return self.integration(operation_id)

    def cancel_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, reason):
        with self._effect_lock(operation_id):
            return self._cancel_integration(task_id, attempt_id, operation_id, owner=owner, epoch=epoch, expected_revision=expected_revision, reason=reason)

    def _cancel_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, reason):
        nonempty(reason, "cancellation reason")
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"integrating"}, wheel_required=False)
            op = self._operation(operation_id, task, attempt)
            observation = self._observe_operation(op)
            if observation["state"] != "not_applied" or op["status"] in {"applying", "unknown"}:
                raise StateConflict("pending/applied effects must be reconciled first")
            self.db.execute("UPDATE integrations SET status='cancelled',observation_json=? WHERE operation_id=?", (canonical(observation), operation_id))
            if op["target_root"] != attempt["workspace"]:
                self.db.execute("DELETE FROM reservations WHERE attempt_id=? AND kind='workspace' AND resource=?", (attempt_id, op["target_root"]))
            self._set_status(task_id, attempt_id, "accepted")
            self._event(task_id, "integration_cancelled", {"operation_id": operation_id, "reason": reason})

    def revise_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, reason):
        with self._effect_lock(operation_id):
            return self._revise_integration(task_id, attempt_id, operation_id, owner=owner, epoch=epoch, expected_revision=expected_revision, reason=reason)

    def _revise_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, reason):
        """Preserve an applied candidate and repair it in the existing worktree.

        The next reviewed candidate must fast-forward from the observed target.
        This does not roll back Git, accept failed tests, or re-use the old review.
        """
        nonempty(reason, "integration revision reason")
        with self._transaction():
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"integrating"}, wheel_required=False)
            op = self._operation(operation_id, task, attempt)
            if op["status"] not in {"applied", "verify_failed"}:
                raise StateConflict("reconcile pending integration before revision")
            observation = self._observe_operation(op)
            if observation["state"] != "applied":
                raise StateConflict("integration target differs from the applied candidate")
            self.db.execute("UPDATE integrations SET status='needs_revision',observation_json=? WHERE operation_id=?", (canonical(observation), operation_id))
            if op["target_root"] != attempt["workspace"]:
                self.db.execute("DELETE FROM reservations WHERE attempt_id=? AND kind='workspace' AND resource=?", (attempt_id, op["target_root"]))
            self._set_status(task_id, attempt_id, "revise")
            self._event(task_id, "integration_revision", {"operation_id": operation_id, "reason": reason})

    def finalize_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, checks):
        with self._effect_lock(operation_id):
            return self._finalize_integration(task_id, attempt_id, operation_id, owner=owner, epoch=epoch, expected_revision=expected_revision, checks=checks)

    def _finalize_integration(self, task_id, attempt_id, operation_id, *, owner, epoch, expected_revision, checks):
        with self._transaction():
            task = self.task(task_id)
            if task["status"] == "done":
                attempt = self.attempt(attempt_id)
                self._revision(task, expected_revision)
                op = self._operation(operation_id, task, attempt)
                if (task["owner"] != owner or task["epoch"] != epoch or task["active_attempt"] != attempt_id
                        or op["status"] != "completed" or op["checks"] != checks):
                    raise StateConflict("completion replay mismatch")
                return self.task(task_id)
            task, attempt = self._fence(task_id, attempt_id, owner, epoch, expected_revision, {"integrating"})
            op = self._operation(operation_id, task, attempt)
            if op["status"] != "applied":
                raise StateConflict("integration must be observed applied and passing")
            result = self._result(task, attempt, op["result_revision"], op["subject_digest"])
            observation = self._observe_operation(op)
            if observation["state"] != "applied":
                raise StateConflict("integration target changed")
            self._checks(checks, task, attempt, op["candidate"], op["result_revision"], operation_id)
            caps = self._validate_capabilities(result["capabilities"], task, op["candidate"], op["target_root"])
            for cap in caps:
                self.db.execute("INSERT OR REPLACE INTO capabilities VALUES (?,?,?,?,?,?,?,?, 'valid',NULL,?)",
                                (cap["capability_id"], task_id, cap["name"], canonical(cap.get("aliases", [])), canonical(cap["entries"]),
                                 op["candidate"], canonical({"operation_id": operation_id, "checks": checks, "subject_digest": op["subject_digest"]}), task["revision"], _now()))
            self.db.execute("UPDATE integrations SET status='completed',observation_json=?,checks_json=? WHERE operation_id=?", (canonical(observation), canonical(checks), operation_id))
            self.db.execute("UPDATE attempts SET status='integrated',updated_at=? WHERE attempt_id=?", (_now(), attempt_id))
            self.db.execute("UPDATE tasks SET status='done',last_error=NULL,updated_at=? WHERE task_id=?", (_now(), task_id))
            self.db.execute("DELETE FROM reservations WHERE attempt_id=?", (attempt_id,))
            self._event(task_id, "completed", {"operation_id": operation_id, "checks": checks})
            return self.task(task_id)

    def integrate(self, *args, **kwargs):
        raise StateConflict("boolean success is not evidence; use reserve/execute/reconcile/finalize_integration")
