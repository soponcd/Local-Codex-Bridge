"""Read-only checks around native Codex model selection and rollout evidence.

This module does not create turns or call a model. A controller must still pass
the checked model and effort explicitly to the native host operation.
"""

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path


# Family boundary only; exact role selection belongs to the central resolver.
# Native catalog matching below establishes model and effort availability.
MODEL_FAMILY = re.compile(r"gpt-6(?:\.[1-9][0-9]*)?-(?:astra|sol|luna)")


def _fail(message):
    raise ValueError(message)


def _route(role):
    script = Path.home() / ".agents/skills/astra-task-router/scripts/resolve_role.py"
    if not script.is_file():
        _fail("central role resolver missing")
    try:
        run = subprocess.run([sys.executable, str(script), role], capture_output=True,
                             text=True, timeout=5)
        route = json.loads(run.stdout) if run.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        _fail("central role resolution failed")
    if (not isinstance(route, dict) or route.get("role") != role
            or not isinstance(route.get("model"), str)
            or not MODEL_FAMILY.fullmatch(route["model"])):
        _fail("GPT-6 role route unavailable")
    if route.get("effort") not in {"low", "medium", "high", "xhigh", "max", "ultra"}:
        _fail("role effort unavailable")
    return route


def preflight(role, catalog):
    route = _route(role)
    value = json.loads(Path(catalog).read_text(encoding="utf-8"))
    if value.get("source") != "codex_app_server_model_list" or not isinstance(value.get("data"), list):
        _fail("native model catalog source missing")
    matches = [entry for entry in value["data"] if entry.get("id") == route["model"]]
    if len(matches) != 1 or matches[0].get("hidden") is not False:
        _fail("requested model unavailable in native catalog")
    efforts = {x.get("reasoningEffort") for x in matches[0].get("supportedReasoningEfforts", [])}
    if route["effort"] not in efforts:
        _fail("requested effort unavailable for model")
    if "nextCursor" not in value or value["nextCursor"] is not None:
        _fail("model catalog page is incomplete")
    return {"role": role, "requested_model": route["model"],
            "requested_effort": route["effort"],
            "available_in_supplied_catalog": True,
            "catalog_path": str(Path(catalog).resolve()),
            "catalog_mtime_utc": dt.datetime.fromtimestamp(Path(catalog).stat().st_mtime,
                                                               dt.timezone.utc).isoformat(),
            "catalog_provenance": "caller_supplied_snapshot_unverified",
            "effective_model": "unknown", "effective_effort": "unknown"}


def _timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        _fail("invalid timestamp")
    if parsed.tzinfo is None:
        _fail("timestamp must include timezone")
    return parsed


def verify(role, rollout, thread_id, turn_id, after):
    route = _route(role)
    cutoff = _timestamp(after)
    session_id = None
    session_meta_line = None
    started = None
    context = None
    with Path(rollout).open(encoding="utf-8") as source:
        for number, raw in enumerate(source, 1):
            record = json.loads(raw)
            kind = record.get("type")
            payload = record.get("payload") or {}
            if kind == "session_meta":
                session_id = payload.get("id")
                session_meta_line = number
            if (kind == "event_msg" and payload.get("type") == "task_started"
                    and payload.get("turn_id") == turn_id
                    and _timestamp(record.get("timestamp")) >= cutoff):
                started = number
            if kind == "turn_context" and payload.get("turn_id") == turn_id:
                context = {"line": number, "model": payload.get("model"),
                           "effort": payload.get("effort")}
    if session_id != thread_id:
        _fail("rollout thread identity mismatch")
    if started is None or context is None or context["line"] <= started:
        _fail("no context for exact fresh turn")
    if context["model"] != route["model"] or context["effort"] != route["effort"]:
        _fail("host turn model or effort differs from requested role")
    return {"role": role, "requested_model": route["model"],
            "requested_effort": route["effort"], "effective_model": context["model"],
            "effective_effort": context["effort"], "effective_source": str(Path(rollout).resolve()),
            "thread_id": thread_id, "turn_id": turn_id,
            "session_meta_line": session_meta_line, "task_started_line": started,
            "turn_context_line": context["line"],
            "rollout_provenance": "caller_supplied_file_unverified",
            "billing_model": "unknown"}


def main(argv=None):
    parser = argparse.ArgumentParser(description="AGILite native Codex model preflight and rollout check")
    sub = parser.add_subparsers(dest="command", required=True)
    before = sub.add_parser("preflight")
    before.add_argument("--role", required=True)
    before.add_argument("--catalog", required=True)
    after = sub.add_parser("verify")
    after.add_argument("--role", required=True)
    after.add_argument("--rollout", required=True)
    after.add_argument("--thread-id", required=True)
    after.add_argument("--turn-id", required=True)
    after.add_argument("--after", required=True)
    args = parser.parse_args(argv)
    try:
        result = (preflight(args.role, args.catalog) if args.command == "preflight"
                  else verify(args.role, args.rollout, args.thread_id, args.turn_id, args.after))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
