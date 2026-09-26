#!/usr/bin/env bash
# SessionStart hook for the Claude Agents Mesh (cloud-friendly).
#
# It needs NO token: it injects a short instruction so Claude registers itself
# and orients via the already-connected `mesh` MCP server. If MESH_MCP_URL and
# MESH_MCP_TOKEN happen to be set in the environment, it ALSO registers directly
# over HTTP as a belt-and-braces measure. Never breaks the session.
set -euo pipefail

# Best-effort direct registration when a token is present in the environment.
if [ -n "${MESH_MCP_URL:-}" ] && [ -n "${MESH_MCP_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
  NAME="${MESH_AGENT_NAME:-claude-$(basename "${CLAUDE_PROJECT_DIR:-agent}")}"
  curl -s --max-time 8 -X POST "$MESH_MCP_URL" \
    -H "content-type: application/json" -H "authorization: Bearer $MESH_MCP_TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_session\",\"arguments\":{\"name\":\"$NAME\",\"status\":\"available\"}}}" \
    >/dev/null 2>&1 || true
fi

# Always inject guidance so Claude uses the mesh via its connected MCP tools.
CTX="Ce dépôt est relié à un Claude Agents Mesh (coordination multi-agents via Supabase, serveur MCP « mesh »/« Claude mesh »). Au démarrage : 1) appelle l'outil register_session (donne un nom d'agent clair, ex. Claude-<ton rôle>) ; 2) appelle get_coordination_status pour voir les autres agents, les tâches et les messages. Pour collaborer : send_message / read_messages / ack_message, et la file de tâches create_task → claim_task → heartbeat_task → complete_task. Signale les quotas avec report_quota_event. Consulte le skill \"coordination\" pour le détail."

python3 - "$CTX" <<'PY' 2>/dev/null || printf '%s\n' "$CTX"
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.argv[1]}}))
PY
exit 0
