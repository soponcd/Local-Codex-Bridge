"""Explicit Markdown carriers and Git-frozen inputs; no authorization authenticator.

Only structured contract fields are normative for automatic impact comparison.
Body semantics and the truth/applicability of a user source require human/model review.
"""
import hashlib
import json
import re
from pathlib import Path

from .evidence import StateConflict, commit, digest, git, nonempty, resource_path, verify_artifact

FORMAT = "agilite-document-basis-v1"
MARKER = "<!-- AGILITE-DOC\n"
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
STATES = {"draft", "effective", "superseded", "conflict"}
SOURCE_KINDS = {"user_message", "delegated_current_user_directive"}


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise StateConflict("invalid stable document/item ID")
    return value


def reference(value):
    if not isinstance(value, str) or value.count("/") != 1:
        raise StateConflict("item reference must be document-id/item-id")
    return tuple(identifier(part) for part in value.split("/"))


def parse(data):
    text = data.decode("utf-8")
    if MARKER not in text:
        return None
    if text.count(MARKER) != 1:
        raise StateConflict("ambiguous document metadata")
    raw, end, _ = text.split(MARKER, 1)[1].partition("\n-->")
    if not end:
        raise StateConflict("broken document metadata marker")
    try:
        meta = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise StateConflict("invalid document metadata JSON") from exc
    if not isinstance(meta, dict) or meta.get("version") != 1:
        raise StateConflict("unsupported document metadata")
    if {"id", "state", "parent", "authorization", "items"} - meta.keys():
        raise StateConflict("document metadata requires identity/state/parent/authorization/items")
    identifier(meta.get("id"))
    if meta.get("state") not in STATES:
        raise StateConflict("invalid document state")
    parent = meta.get("parent")
    if parent is not None:
        reference(parent)
    items = meta.get("items")
    if not isinstance(items, list):
        raise StateConflict("document items must be a list")
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            raise StateConflict("invalid document item")
        key = identifier(item.get("id"))
        if key in seen:
            raise StateConflict("duplicate stable item ID")
        seen.add(key)
        nonempty(item.get("goal"), "item goal")
        for field in ("write_scope", "acceptance"):
            values = item.get(field)
            if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
                raise StateConflict(f"invalid item {field}")
            if len(values) != len(set(values)) or (field == "acceptance" and not values):
                raise StateConflict(f"invalid item {field}")
    return meta


def catalog(root, paths, revision="HEAD"):
    if not isinstance(paths, list) or not paths or len(paths) != len(set(paths)):
        raise StateConflict("explicit unique document paths required")
    revision = commit(root, revision)
    result = []
    for path in paths:
        normalized = resource_path(root, path)
        # Scope normalization must not change the actual Git path spelling.
        if path.startswith("/") or path != Path(path).as_posix() or normalized == ".":
            raise StateConflict("document path must be repository-relative")
        data = git(root, "show", revision + ":" + path)
        result.append({"path": path, "git_commit": revision, "content": data.decode("utf-8"),
                       "sha256": hashlib.sha256(data).hexdigest(), "meta": parse(data)})
    return result


def _effective(records, key):
    candidates = [r for r in records if r["meta"] and r["meta"]["id"] == key and r["meta"]["state"] == "effective"]
    if len(candidates) != 1:
        raise StateConflict(("conflicting effective document: " if candidates else "no effective document for ") + key)
    return candidates[0]


def verify_source(auth):
    nonempty(auth.get("source_ref"), "authorization source reference")
    verify_artifact(auth.get("source"))
    # A retained directive wrapper can expose its source classification/ref.
    # Cross-check those explicit fields; raw text has no authenticated identity.
    try:
        wrapper = json.loads(Path(auth["source"]["path"]).read_bytes())
    except (ValueError, UnicodeError):
        wrapper = None
    if isinstance(wrapper, dict) and "source_kind" in wrapper:
        if wrapper["source_kind"] != auth["kind"] or wrapper.get("source_ref") != auth["source_ref"]:
            raise StateConflict("authorization source provenance/ref mismatch")


def _authority(meta, item_id):
    auth = meta.get("authorization")
    if not isinstance(auth, dict):
        raise StateConflict("effective document needs authorization source and scope")
    if auth.get("kind") not in SOURCE_KINDS:
        raise StateConflict("effective source needs explicit human/delegated provenance; AI/test decisions cannot accept standards")
    verify_source(auth)
    scope = auth.get("scope")
    if not isinstance(scope, list) or not scope or not all(isinstance(s, str) for s in scope):
        raise StateConflict("authorization scope required")
    for value in scope:
        reference(value) if "/" in value else identifier(value)
    applicable = sorted(s for s in scope if s in {meta["id"], meta["id"] + "/" + item_id})
    if not applicable:
        raise StateConflict("authorization scope does not cover item")
    return {"kind": auth["kind"], "source": auth["source"], "source_ref": auth["source_ref"],
            "scope": applicable, "evidence_class": auth.get("evidence_class", "caller_declared")}


def _contract(root, item):
    return {"goal": item["goal"], "acceptance": item["acceptance"],
            "write_scope": sorted({resource_path(root, p) for p in item["write_scope"]})}


def resolve(root, request, revision="HEAD"):
    """Select unique effective carriers at a Git revision; never use mtime."""
    if not isinstance(request, dict) or set(request) != {"paths", "item"}:
        raise StateConflict("documents requires paths and one stable item reference")
    doc_id, item_id = reference(request["item"])
    records = catalog(root, request["paths"], revision)
    lineage, refinement, seen = {}, {}, set()
    key, selected_id = doc_id, item_id
    contract = None
    while key is not None:
        if key in seen:
            raise StateConflict("document parent cycle")
        seen.add(key)
        record = _effective(records, key)
        meta = record["meta"]
        selected = next((i for i in meta["items"] if i["id"] == selected_id), None)
        if selected is None:
            raise StateConflict("effective parent/item missing: " + key + "/" + selected_id)
        auth = _authority(meta, selected_id)
        item_contract = _contract(root, selected)
        if contract is None:
            contract = item_contract
        parent = meta.get("parent")
        lineage[key] = {"id": key, "state": meta["state"], "parent": parent,
                        "item": selected_id, "contract": item_contract, "authorization": auth}
        # Catalog contents are retained, but unrelated documents/items/scope
        # entries cannot contaminate this task's material or refinement keys.
        before, _, remainder = record["content"].partition(MARKER)
        body = before + remainder.partition("\n-->")[2]
        refinement[key] = {"body": body, "item": selected}
        key, selected_id = reference(parent) if parent else (None, None)
    basis = {"format": FORMAT, "request": request, "documents": records, "contract": contract,
             "material": {"lineage": lineage, "item": request["item"], "contract": contract},
             "refinement": refinement,
             "authority_note": "source bytes and declared scope verified; delegated provenance is not original human approval; identity and semantic authority not authenticated"}
    basis["digest"] = digest(basis)
    return basis


def verify(basis):
    if not isinstance(basis, dict) or basis.get("format") != FORMAT:
        raise StateConflict("unsupported frozen document basis")
    if basis.get("digest") != digest({k: v for k, v in basis.items() if k != "digest"}):
        raise StateConflict("frozen document basis digest changed")
    for record in basis["documents"]:
        data = record["content"].encode("utf-8")
        if hashlib.sha256(data).hexdigest() != record["sha256"] or parse(data) != record["meta"]:
            raise StateConflict("frozen document bytes/meta/hash disagree")
    for key, entry in basis["material"]["lineage"].items():
        record = _effective(basis["documents"], key)
        _authority(record["meta"], entry["item"])
    return basis


def for_task(task, events):
    for event in reversed(events):
        if event["kind"] == "document_basis_bound" and event["payload"]["revision"] == task["revision"]:
            return event["payload"]["basis"]
    basis = task["baseline"].get("document_basis")
    return basis if isinstance(basis, dict) and basis.get("format") == FORMAT else None


def matches(task, basis):
    expected = {key: task[key] for key in ("goal", "acceptance", "write_scope")}
    if expected != basis["contract"]:
        raise StateConflict("document item goal/scope/acceptance differs from task contract")


def observe(root, basis):
    verify(basis)
    current = resolve(root, basis["request"])
    if current["material"] != basis["material"]:
        status = "material_changed"
    elif current["refinement"] != basis["refinement"]:
        status = "refined"
    else:
        status = "current"
    return {"status": status, "basis_digest": basis["digest"], "current": current,
            "content_digest": digest(current["refinement"])}
