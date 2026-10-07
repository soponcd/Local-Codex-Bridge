import argparse
import json
import sys
from pathlib import Path

from .evidence import StateConflict
from .install import reexec_project_python

if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--target", default=str(Path.cwd()))
    args, _ = parser.parse_known_args()
    try:
        # Existing help/invalid-target behavior belongs to the normal CLI.
        if not any(arg in {"-h", "--help"} for arg in sys.argv[1:]):
            reexec_project_python(args.target, entry=["-m", "agilite_runtime"], args=sys.argv[1:])
    except (StateConflict, OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}), file=sys.stderr)
        raise SystemExit(2)
    from .cli import main
    raise SystemExit(main())
