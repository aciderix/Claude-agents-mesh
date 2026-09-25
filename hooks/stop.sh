#!/usr/bin/env bash
# Stop: the assistant finished a turn. Refresh presence (keeps last_heartbeat_at fresh)
# without changing status.
set -euo pipefail
source "$(dirname "$0")/_mesh.sh"
read_hook_input
mesh_ready || exit 0
mesh_call heartbeat_session '{}' >/dev/null
exit 0
