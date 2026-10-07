"""Small, inspectable Find Wheel evidence contract; hashes bind declarations, not search quality."""
import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path

from .evidence import StateConflict, digest, nonempty

SKILL_NAME = "find-wheel"
REVIEW_VERSION = 1
KINDS = {"build", "nonbuild"}


def skill_status():
    explicit = os.environ.get("AGILITE_FIND_WHEEL_SKILL")
    path = Path(explicit) if explicit else Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "skills/find-wheel/SKILL.md"
    if not path.is_absolute():
        return {"available": False, "path": str(path), "reason": "skill path must be absolute"}
    try:
        data = path.read_bytes()
    except OSError as exc:
        return {"available": False, "path": str(path), "reason": str(exc)}
    if b"name: find-wheel" not in data:
        return {"available": False, "path": str(path), "reason": "skill identity mismatch"}
    return {"available": True, "path": str(path.resolve()), "sha256": hashlib.sha256(data).hexdigest()}


def binding(task):
    return {key: task[key] for key in ("goal", "acceptance", "baseline", "write_scope", "resources", "dependencies", "capability_refs")}


def _items(values, label):
    if not isinstance(values, list) or not values:
        raise StateConflict(f"{label} must be a nonempty list")
    return values


def validate_record(record):
    if not isinstance(record, dict) or record.get("version") != REVIEW_VERSION:
        raise StateConflict("find-wheel review version is unsupported")
    skill = record.get("skill")
    if not isinstance(skill, dict) or skill.get("name") != SKILL_NAME or not isinstance(skill.get("sha256"), str) or len(skill["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in skill["sha256"]):
        raise StateConflict("find-wheel skill identity/version is required")
    for source in _items(record.get("sources"), "sources"):
        if not isinstance(source, dict):
            raise StateConflict("source must be an object")
        for key in ("ref", "version", "checked_at", "finding"):
            nonempty(source.get(key), f"source {key}")
        try:
            checked = datetime.fromisoformat(source["checked_at"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise StateConflict("source checked_at must be ISO-8601 UTC") from exc
        if checked.tzinfo is None or checked.utcoffset().total_seconds() != 0 or checked > datetime.now(timezone.utc):
            raise StateConflict("source checked_at must be UTC and not in the future")
        if source.get("evidence_digest") != digest({key: source[key] for key in ("ref", "version", "checked_at", "finding")}):
            raise StateConflict("source evidence digest mismatch")
    for item in _items(record.get("candidates"), "candidates"):
        if not isinstance(item, dict):
            raise StateConflict("candidate must be an object")
        nonempty(item.get("name"), "candidate name")
        nonempty(item.get("applicability"), "candidate applicability")
    if record.get("decision") not in {"reuse", "adapt", "build"}:
        raise StateConflict("decision must be reuse, adapt, or build")
    nonempty(record.get("rationale"), "decision rationale")
    costs = record.get("costs")
    if not isinstance(costs, dict):
        raise StateConflict("three-stage costs required")
    for stage in ("development", "launch", "growth"):
        nonempty(costs.get(stage), f"{stage} cost")
    if not isinstance(record.get("binding"), dict):
        raise StateConflict("task binding required")
    return record
