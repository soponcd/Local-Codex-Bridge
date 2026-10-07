"""Local observations: hashes bind bytes, not semantic truth or host authority."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unicodedata


class StateConflict(RuntimeError):
    """A stale, duplicate, unverified, or illegal transition."""


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def nonempty(value, label):
    if not isinstance(value, str) or not value.strip():
        raise StateConflict(f"{label} must be nonempty")
    return value


def git(root, *args, pass_fds=()):
    proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, pass_fds=pass_fds)
    if proc.returncode:
        raise StateConflict(proc.stderr.decode(errors="replace").strip())
    return proc.stdout


def repository(root):
    root = Path(root).resolve(strict=True)
    top = Path(git(root, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if root != top:
        raise StateConflict("workspace must be a Git top-level directory")
    common = git(root, "rev-parse", "--git-common-dir").decode().strip()
    return {"root": str(root), "common_dir": str((root / common).resolve())}


def commit(root, ref):
    nonempty(ref, "commit")
    if ref.startswith("-"):
        raise StateConflict("invalid commit")
    return git(root, "rev-parse", "--verify", ref + "^{commit}").decode().strip()


def snapshot(root, *, clean=False):
    identity = repository(root)
    status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if clean and status:
        raise StateConflict("workspace is dirty; preserve and commit changes before this operation")
    tracked = git(root, "diff", "HEAD", "--binary", "--no-ext-diff")
    files = []
    for name in filter(None, git(root, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0")):
        path = Path(root) / os.fsdecode(name)
        data = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
        files.append([os.fsdecode(name), hashlib.sha256(data).hexdigest()])
    head = commit(root, "HEAD")
    return {**identity, "head": head, "tree": git(root, "rev-parse", head + "^{tree}").decode().strip(),
            "dirty_digest": digest([status.hex(), tracked.hex(), files]), "clean": not bool(status)}


def artifact(path):
    try:
        path = Path(path).resolve(strict=True)
        data = path.read_bytes()
    except (OSError, ValueError, TypeError) as exc:
        raise StateConflict(f"unreadable artifact: {path}") from exc
    return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def verify_artifact(item):
    if not isinstance(item, dict) or artifact(item.get("path")) != item:
        raise StateConflict("artifact bytes/path/digest changed")
    return item


def resource_path(root, value):
    nonempty(value, "write scope")
    if any(ch in value for ch in "*?["):
        raise StateConflict("scope is a path, not a glob")
    root = Path(root).resolve()
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise StateConflict("scope must be relative without parent traversal")
    try:
        relative = (root / candidate).resolve().relative_to(root).as_posix()
    except ValueError as exc:
        raise StateConflict("scope escapes project via symlink") from exc
    return unicodedata.normalize("NFC", relative).casefold().rstrip("/") or "."


def overlaps(left, right):
    return left == "." or right == "." or left == right or left.startswith(right + "/") or right.startswith(left + "/")


def subject(root, base, revision):
    base, revision = commit(root, base), commit(root, revision)
    git(root, "merge-base", "--is-ancestor", base, revision)
    raw = git(root, "diff", "--name-only", "--no-renames", "-z", base, revision)
    return {"commit": revision, "base": base, "tree": git(root, "rev-parse", revision + "^{tree}").decode().strip(),
            "diff_sha256": hashlib.sha256(git(root, "diff", "--binary", "--no-ext-diff", base, revision)).hexdigest(),
            "paths": [os.fsdecode(path) for path in raw.split(b"\0") if path]}
