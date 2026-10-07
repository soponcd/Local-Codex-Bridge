"""Opt-in UI intent records in TaskStore events, not an approval/auth system."""
import json
from pathlib import Path

from .evidence import StateConflict, digest, nonempty, verify_artifact

STAGES = ("scope", "blueprint", "environment", "requirements", "architecture",
          "stack", "expression", "ui_acceptance")
FIELDS = {
    "scope": ("mode", "reason"),
    "blueprint": ("users", "goal", "outcomes", "boundaries", "sources"),
    "environment": ("devices", "context", "product_form", "constraints"),
    "requirements": ("units", "classification_standard", "module_mapping"),
    "architecture": ("app_pattern", "module_patterns", "selection_basis", "structure_tree", "core_flow"),
    "stack": ("existing_stack", "choice", "reuse_delta", "wheel_review_id"),
    "expression": ("presentation", "ui_skills", "states", "artifacts"),
    "ui_acceptance": ("scenarios", "environment", "limitations", "artifacts", "code_commit"),
}


def validate_content(stage, content):
    if stage not in STAGES or not isinstance(content, dict):
        raise StateConflict("unknown UI stage or invalid content")
    for key in FIELDS[stage]:
        if (key not in content or not isinstance(content[key], (str, list, dict)) or not content[key]
                or isinstance(content[key], str) and not content[key].strip()):
            raise StateConflict(f"UI {stage}.{key} is required")
    if stage == "scope" and content["mode"] not in {"required", "no_ui"}:
        raise StateConflict("UI scope.mode must be required or no_ui")
    if stage == "environment":
        constraints = content["constraints"]
        if not isinstance(constraints, dict) or constraints.get("unresolved") != []:
            raise StateConflict("resolve stack-affecting environment constraints first")
    if stage == "requirements":
        units, mapping = content["units"], content["module_mapping"]
        if not isinstance(units, list) or not isinstance(mapping, dict):
            raise StateConflict("UI units must be a list and module_mapping an object")
        ids = []
        for unit in units:
            if not isinstance(unit, dict):
                raise StateConflict("UI requirement unit must be an object")
            for field in ("id", "purpose", "input", "output", "criterion"):
                nonempty(unit.get(field), "requirement " + field)
            ids.append(unit["id"])
        assigned = []
        for module, values in mapping.items():
            nonempty(module, "module purpose")
            if not isinstance(values, list) or not values or not all(isinstance(v, str) for v in values):
                raise StateConflict("module_mapping needs nonempty requirement ID lists")
            assigned.extend(values)
        if len(set(ids)) != len(ids) or sorted(ids) != sorted(assigned):
            raise StateConflict("requirements need unique IDs and exactly one primary module assignment")
    if stage in {"expression", "ui_acceptance"}:
        if not isinstance(content["artifacts"], list):
            raise StateConflict("UI artifacts must be a nonempty list")
        for item in content["artifacts"]:
            verify_artifact(item)
    return content


def decision_record(evidence, task_id, revision, stage, content_digest):
    verify_artifact(evidence)
    data = json.loads(Path(evidence["path"]).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise StateConflict("UI decision evidence must be a JSON object")
    expected = {"task_id": task_id, "revision": revision, "stage": stage,
                "content_digest": content_digest, "role": "user"}
    if any(data.get(k) != v for k, v in expected.items()):
        raise StateConflict("UI decision does not match user/stage/revision/digest")
    if data.get("kind") not in {"user_message", "synthetic"}:
        raise StateConflict("Agent/test results cannot confirm UI intent")
    if data.get("decision") not in {"confirm", "revise", "reject"}:
        raise StateConflict("UI decision must be confirm, revise or reject")
    nonempty(data.get("text"), "user decision text")
    nonempty(data.get("source_ref"), "original user message reference")
    return data


def project(task, events):
    """Replay current revision only; retain history in the existing event log."""
    nodes = {}
    relevant = [e for e in events if e["kind"] in {"ui_recorded", "ui_decided"}]
    token = digest({"revision": task["revision"], "events": relevant})
    for event in relevant:
        p = event["payload"]
        if p["revision"] != task["revision"]:
            continue
        stage = p["stage"]
        if event["kind"] == "ui_recorded":
            for downstream in STAGES[STAGES.index(stage):]:
                nodes.pop(downstream, None)
            nodes[stage] = {"content": p["content"], "content_digest": digest(p["content"]),
                            "status": "draft", "event_id": event["event_id"]}
            if p.get("scope_change_evidence"):
                nodes[stage]["scope_change_evidence"] = p["scope_change_evidence"]
        elif stage in nodes and nodes[stage]["content_digest"] == p["content_digest"]:
            if p.get("decision") in {"revise", "reject"}:
                for downstream in STAGES[STAGES.index(stage) + 1:]:
                    nodes.pop(downstream, None)
            nodes[stage]["evidence"] = p["evidence"]
            if p.get("source_revision"):
                nodes[stage]["source_revision"] = p["source_revision"]
                nodes[stage]["applicability"] = p["applicability"]
    upstream = True
    required_history = any(e["kind"] == "ui_recorded" and e["payload"]["stage"] == "scope"
                           and e["payload"]["content"]["mode"] == "required"
                           and e["payload"]["revision"] <= task["revision"] for e in relevant)
    for stage in STAGES:
        node = nodes.get(stage)
        if not node:
            upstream = False
            continue
        try:
            validate_content(stage, node["content"])
            if "evidence" in node:
                data = decision_record(node["evidence"], task["task_id"], node.get("source_revision", task["revision"]),
                                       stage, node["content_digest"])
                node["status"] = ("simulated" if data["kind"] == "synthetic" else
                                  "confirmed" if data["decision"] == "confirm" else data["decision"])
                node["decision"] = data["decision"]
            if stage == "scope":
                # Scope is an applicability declaration, never user approval.
                if node["content"]["mode"] == "no_ui" and required_history and not node.get("scope_change_evidence"):
                    raise StateConflict("historical required scope needs persistent user scope evidence")
                if node.get("scope_change_evidence"):
                    data = decision_record(node["scope_change_evidence"], task["task_id"], task["revision"],
                                           stage, node["content_digest"])
                    if data["kind"] != "user_message" or data["decision"] != "confirm":
                        raise StateConflict("scope change evidence is not user confirmation")
                node["status"] = "declared"
            node["usable"] = upstream and node["status"] in {"confirmed", "declared"}
        except (StateConflict, OSError, ValueError, TypeError) as exc:
            node.update(status="stale", usable=False, reason=str(exc))
        upstream = node["usable"]
    historical_scope = next((e["payload"]["content"]["mode"] for e in reversed(relevant)
                             if e["kind"] == "ui_recorded" and e["payload"]["stage"] == "scope"
                             and e["payload"]["revision"] <= task["revision"]), None)
    mode = nodes.get("scope", {}).get("content", {}).get("mode", historical_scope)
    exempt = mode == "no_ui" and nodes.get("scope", {}).get("usable", False)
    configured = mode is not None
    return {"revision": task["revision"], "state_digest": token, "mode": mode,
            "status": "not_applicable" if exempt else "complete" if upstream else
                      "pending" if configured else "unconfigured",
            "nodes": nodes,
            "implementation_allowed": exempt or nodes.get("stack", {}).get("usable", False),
            "ui_accepted": not exempt and nodes.get("ui_acceptance", {}).get("usable", False),
            "business_acceptance": "handoff to existing business gate; may be a separate task",
            "next_stage": None if exempt else next((s for s in STAGES if not nodes.get(s, {}).get("usable")), None),
            "boundary": "Declarations and evidence hashes are not authenticated user identity or business acceptance"}
