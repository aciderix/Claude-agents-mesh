#!/usr/bin/env bash
# SessionEnd: mark this agent offline so others stop routing work to it.
set -euo pipefail
source "$(dirname "$0")/_mesh.sh"
read_hook_input
mesh_ready || exit 0
mesh_call heartbeat_session '{"status":"offline"}' >/dev/null
exit 0
