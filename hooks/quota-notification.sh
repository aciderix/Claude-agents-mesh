#!/usr/bin/env bash
# Notification: inspect the message for quota/limit signals and report them to the
# mesh so other agents learn this account is blocked or back. Best-effort and
# heuristic — Claude Code does not emit a structured quota event to hooks.
set -euo pipefail
source "$(dirname "$0")/_mesh.sh"
read_hook_input
mesh_ready || exit 0

MSG="$(json_get "$HOOK_INPUT" 'str(d.get("message","")).lower()')"
[ -z "$MSG" ] && exit 0

case "$MSG" in
  *"resume"*|*"reset"*|*"auto_resume"*|*"auto-resume"*)
    mesh_call report_quota_event '{"event_type":"quota_auto_resumed"}' >/dev/null ;;
  *"limit"*|*"quota"*|*"rate"*)
    mesh_call report_quota_event '{"event_type":"quota_warning","error_details":{"source":"notification"}}' >/dev/null ;;
esac
exit 0
