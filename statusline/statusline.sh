#!/usr/bin/env bash
# Claude Agents Mesh status line.
# Renders Claude Code quota windows, e.g.:
#   mesh | 5h 95% reset 19:00Z | 7d 82% reset 16:00Z
#
# Install by pointing your settings.json statusLine.command at this script:
#   { "statusLine": { "type": "command", "command": "/abs/path/statusline/statusline.sh" } }
#
# Optional: if MESH_MCP_URL + MESH_MCP_TOKEN are exported, it also reports a
# quota_warning to the mesh once per 5h window when usage crosses WARN_AT (default 90%).
set -euo pipefail
WARN_AT="${MESH_WARN_AT:-90}"
input="$(cat 2>/dev/null || true)"
[ -z "$input" ] && { echo "mesh"; exit 0; }

command -v jq >/dev/null 2>&1 || { echo "mesh"; exit 0; }

fmt_reset() { # epoch -> HH:MMZ, empty if null
  local e="$1"; [ "$e" = "null" ] || [ -z "$e" ] && { echo ""; return; }
  date -u -d "@$e" +"%H:%MZ" 2>/dev/null || date -u -r "$e" +"%H:%MZ" 2>/dev/null || echo ""
}

read5=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
r5=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
read7=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
r7=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')

line="mesh"
[ -n "$read5" ] && line="$line | 5h ${read5%.*}% $( [ -n "$r5" ] && echo "reset $(fmt_reset "$r5")" )"
[ -n "$read7" ] && line="$line | 7d ${read7%.*}% $( [ -n "$r7" ] && echo "reset $(fmt_reset "$r7")" )"
echo "$line"

# Optional throttled quota_warning emission (once per 5h reset window).
if [ -n "${MESH_MCP_URL:-}" ] && [ -n "${MESH_MCP_TOKEN:-}" ] && [ -n "$read5" ] && command -v curl >/dev/null 2>&1; then
  pct=${read5%.*}
  if [ "${pct:-0}" -ge "$WARN_AT" ] 2>/dev/null; then
    marker="${TMPDIR:-/tmp}/mesh_warn_${r5:-0}"
    if [ ! -f "$marker" ]; then
      : > "$marker" 2>/dev/null || true
      curl -s --max-time 8 -X POST "$MESH_MCP_URL" \
        -H "content-type: application/json" -H "authorization: Bearer $MESH_MCP_TOKEN" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report_quota_event\",\"arguments\":{\"event_type\":\"quota_warning\",\"quota_window\":\"five_hour\",\"used_percentage\":$pct,\"resets_at\":\"$(date -u -d "@$r5" +%FT%TZ 2>/dev/null || echo null)\"}}}" \
        >/dev/null 2>&1 || true
    fi
  fi
fi
exit 0
