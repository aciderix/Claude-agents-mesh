#!/usr/bin/env bash
# SessionStart: register this session as an agent and inject a coordination summary.
set -euo pipefail
source "$(dirname "$0")/_mesh.sh"
read_hook_input
mesh_ready || exit 0

SESSION_ID="$(json_get "$HOOK_INPUT" 'd.get("session_id","")')"
NAME="${MESH_AGENT_NAME:-$(json_get "$HOOK_INPUT" 'd.get("session_name","")')}"
[ -z "$NAME" ] && NAME="claude-$(hostname 2>/dev/null || echo agent)"

mesh_call register_session "{\"name\":\"$NAME\",\"session_id\":\"$SESSION_ID\",\"status\":\"available\"}" >/dev/null

STATUS="$(mesh_call get_coordination_status '{}')"
SUMMARY="$(json_get "$STATUS" 'json.loads(d["result"]["content"][0]["text"]) if "result" in d else {}' )"
CONTEXT="$(json_get "$STATUS" '"Claude Agents Mesh — %d agent(s), %d active task(s), %d recent message(s) in this workspace. Use whoami / list_agents / get_coordination_status to coordinate." % (len(json.loads(d["result"]["content"][0]["text"]).get("agents",[])), len(json.loads(d["result"]["content"][0]["text"]).get("active_tasks",[])), len(json.loads(d["result"]["content"][0]["text"]).get("recent_messages",[])))')"

if [ -n "$CONTEXT" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
    "$(printf '%s' "$CONTEXT" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')"
fi
exit 0
