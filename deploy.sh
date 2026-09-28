#!/bin/bash
set -euo pipefail
release_root="$(cd -- "$(dirname -- "$0")" && pwd -P)"
: "${LCB_NODE:?Explicit Node.js 24+ executable required}"
: "${LCB_TRUST_VERIFIER:?External trusted verifier required}"
"$LCB_NODE" "$LCB_TRUST_VERIFIER" "$release_root"
exec "$LCB_NODE" "$release_root/scripts/deploy-fix.mjs" "$@"
