"""JSON CLI for the single TaskStore API; no state transitions live here."""
import argparse
import json
import sys
import subprocess
import sqlite3
from pathlib import Path

from .evidence import StateConflict, repository
from .install import init, upgrade, withdraw, doctor
from .store import TaskStore

METHODS = {
    "controller-status": "controller_status", "controller-update": "controller_update",
    "writer-policy": "writer_policy", "writer-policy-set": "set_writer_policy",
    "create": "create_task", "list": "list_tasks", "show": "task", "resume": "resume",
    "claim": "claim", "change-goal": "change_goal", "check": "run_check",
    "submit": "submit", "review": "review", "reconsider": "reconsider",
    "adjudicate": "adjudicate", "release": "release", "recover": "recover",
    "reopen": "reopen", "obsolete": "obsolete", "capability-find": "find_capabilities",
    "wheel-record": "record_wheel_review", "wheel-bind": "bind_wheel_review",
    "wheel-show": "wheel_review", "wheel-find": "find_wheel_reviews", "classify-task": "classify_task",
    "ui-record": "record_ui", "ui-decide": "decide_ui", "ui-status": "ui_status",
    "integrate-reserve": "reserve_integration", "integrate-execute": "execute_integration",
    "integrate-reconcile": "reconcile_integration", "integrate-cancel": "cancel_integration",
    "integrate-revise": "revise_integration", "integrate-finalize": "finalize_integration",
    "integration-show": "integration", "attempt-show": "attempt", "adopt-legacy": "adopt_legacy",
    "basis-bind": "bind_document_basis", "document-refine": "record_document_refinement",
    "document-impact": "document_impact",
}
READS = {"controller-status", "writer-policy", "list", "show", "resume", "status", "capability-find", "wheel-show", "wheel-find", "integration-show", "attempt-show", "ui-status", "document-impact"}
FENCED = {"check", "submit", "review", "reconsider", "adjudicate", "release", "recover",
          "integrate-reserve", "integrate-execute", "integrate-reconcile", "integrate-cancel",
          "integrate-revise", "integrate-finalize", "basis-bind", "document-refine"}
RESULT_FENCED = {"review", "reconsider", "adjudicate", "integrate-reserve"}


def _payload(path):
    value = json.load(sys.stdin) if path == "-" else json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("input must be a JSON object")
    return value


def _state(target):
    identity = repository(target)
    return identity, Path(identity["common_dir"]) / "agilite" / "state.sqlite3"


def _status(store):
    """Advisory projection of existing task queries; never changes the store."""
    next_actions = {
        "ready": "claim", "running": "resume; continue work or run check",
        "review": "review", "revise": "resume; revise and resubmit",
        "rejected": "reconsider or revise", "appeal": "adjudicate",
        "accepted": "integrate-reserve", "integrating": "resume; inspect integration and reconcile/check",
        "superseded": "recover after host stopped observation", "legacy_blocked": "adopt-legacy",
    }
    tasks = []
    for item in store.list_tasks():
        # done and obsoleted registrations are terminal; neither is an active task
        if item["status"] in {"done", "obsolete"}:
            continue
        current = store.resume(item["task_id"])
        task, attempt = current["task"], current["attempt"]
        tasks.append({
            "task_id": task["task_id"], "goal": task["goal"], "revision": task["revision"],
            "status": task["status"], "owner": task["owner"],
            "active_attempt": task["active_attempt"],
            "attempt_status": attempt["status"] if attempt else None,
            "wheel": current["wheel"],
            "ui": current["ui"],
            "next_action": next_actions.get(task["status"], "resume; inspect state"),
            "unverified": ["host_execution_state", "workspace_and_evidence_currentness"] if attempt else ["workspace_currentness"],
        })
    return {"active_count": len(tasks), "tasks": tasks,
            "note": "next_action is advisory; verify fence, Git state and host observation before mutation"}


def _invoke(args):
    if args.command in {"relocate", "relocation-recover", "binding-repair", "reanchor"}:
        from .relocation import relocate, recover_relocation, binding_repair, reanchor
        data = _payload(args.input)
        if args.command == "relocate":
            return relocate(args.target, apply=args.apply, **data)
        if args.command in {"binding-repair", "reanchor"}:
            operation = binding_repair if args.command == "binding-repair" else reanchor
            return operation(args.target, prepare=args.prepare, apply=args.apply, **data)
        return recover_relocation(args.target, **data)
    if args.command in {"init", "upgrade", "withdraw", "doctor"}:
        return {"init": init, "upgrade": upgrade, "withdraw": withdraw, "doctor": doctor}[args.command](args.target, apply=getattr(args, "apply", False))
    identity, state = _state(args.target)
    if args.command == "migrate":
        if not state.exists():
            raise StateConflict("state database does not exist")
        return {"backup": str(TaskStore.migrate(state))}
    if not state.exists() and args.command != "create":
        raise StateConflict("state database does not exist; initialize/create first")
    data = _payload(args.input) if args.input else {}
    if args.command == "status" and data and not args.full:
        raise ValueError("status takes no input fields")
    if args.command == "status" and args.full and set(data) - {"document_paths"}:
        raise ValueError("full status accepts only document_paths")
    if args.command in FENCED:
        required = {"owner", "epoch", "expected_revision", "attempt_id", "task_id"}
        if args.command == "recover":
            required |= {"observation"}
        missing = required - data.keys()
        if missing:
            raise ValueError("missing fence/input: " + ", ".join(sorted(missing)))
    if args.command in RESULT_FENCED and ({"result_revision", "subject_digest"} - data.keys()):
        raise ValueError("result_revision and subject_digest are required")
    if args.command == "claim" and "expected_revision" not in data:
        raise ValueError("claim requires expected_revision")
    if args.command in {"change-goal", "reopen", "adopt-legacy", "obsolete"} and "expected_revision" not in data:
        raise ValueError("expected_revision is required")
    if args.command == "create" and "baseline" not in data:
        raise ValueError("create requires a real baseline with plan and code")
    if args.command == "check" and isinstance(data.get("command"), str):
        raise ValueError("check.command must be an argv array, never a shell string")
    if args.command == "recover" and not isinstance(data.get("observation"), dict):
        raise ValueError("recover.observation must be a host artifact object")
    readonly = args.command in READS
    if not readonly:
        state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    store = TaskStore(state, project_root=identity["root"], readonly=readonly)
    try:
        if args.command == "status":
            if args.full:
                return store.full_projection(**data)
            return _status(store)
        return getattr(store, METHODS[args.command])(**data)
    finally:
        store.close()


def main():
    parser = argparse.ArgumentParser(description="AGILite project task control (JSON output; no model API)")
    parser.add_argument("--target", default=".", help="Git top-level project path; default current directory")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "upgrade", "withdraw", "doctor"):
        p = sub.add_parser(name, help="project lifecycle; dry-run unless --apply")
        if name != "doctor":
            p.add_argument("--apply", action="store_true")
    sub.add_parser("migrate", help="explicit legacy state migration with backup")
    relocation = sub.add_parser("relocate", help="explicit existing-state move rebind; dry-run unless --apply")
    relocation.add_argument("--input", required=True, help="old/new identities and CAS fields; JSON file or -")
    relocation.add_argument("--apply", action="store_true")
    repair = sub.add_parser("binding-repair", help="explicit split binding repair; prepare guards before rebinding")
    repair.add_argument("--input", required=True)
    repair.add_argument("--prepare", action="store_true")
    repair.add_argument("--apply", action="store_true")
    anchor = sub.add_parser("reanchor", help="explicit absent linked-root repair to the same common-dir primary root")
    anchor.add_argument("--input", required=True)
    anchor.add_argument("--prepare", action="store_true")
    anchor.add_argument("--apply", action="store_true")
    recovery = sub.add_parser("relocation-recover", help="recover only the current pending relocation receipt")
    recovery.add_argument("--input", required=True, help="receipt_id and explicit complete|rollback action")
    status = sub.add_parser("status", help="read-only active task summary from TaskStore")
    status.add_argument("--input", help="optional empty JSON object file; status has no arguments")
    status.add_argument("--full", action="store_true", help="read-only original plan/all-task/evidence projection; optional document_paths input")
    for name in METHODS:
        p = sub.add_parser(name, help=f"TaskStore.{METHODS[name]} via JSON --input")
        p.add_argument("--input", help="UTF-8 JSON object file, or - for stdin")
    args = parser.parse_args()
    try:
        result = _invoke(args)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, sort_keys=True, default=str))
    except (StateConflict, ValueError, TypeError, OSError, sqlite3.Error, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0
