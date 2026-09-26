#!/usr/bin/env bash
# Shared helpers for Claude Agents Mesh hooks.
# All hooks are best-effort: they must never break the session, so every failure
# path exits 0 and stays quiet.

# Resolve MCP endpoint + token from plugin userConfig (exported to hook processes
# as CLAUDE_PLUGIN_OPTION_<KEY>) or from plain env vars as a fallback.
MESH_URL="${CLAUDE_PLUGIN_OPTION_MESH_URL:-${MESH_MCP_URL:-}}"
MESH_TOKEN="${CLAUDE_PLUGIN_OPTION_MESH_TOKEN:-${MESH_MCP_TOKEN:-}}"

mesh_ready() { [ -n "$MESH_URL" ] && [ -n "$MESH_TOKEN" ] && command -v curl >/dev/null 2>&1; }

# mesh_call <tool> <arguments-json>  -> prints raw JSON-RPC response (or nothing)
mesh_call() {
  local tool="$1" args="${2:-{\}}"
  curl -s --max-time 10 -X POST "$MESH_URL" \
    -H "content-type: application/json" \
    -H "authorization: Bearer $MESH_TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
    2>/dev/null || true
}

# json_get <json> <python-expr on variable d>  -> extracts a value, empty on error
json_get() {
  local json="$1" expr="$2"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    print($expr)
except Exception:
    pass" 2>/dev/null
  fi
}

# Read all of stdin (the hook input JSON) into $HOOK_INPUT.
read_hook_input() { HOOK_INPUT="$(cat 2>/dev/null || true)"; }
