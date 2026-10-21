#!/usr/bin/env bash
# agent-turn-notify — macOS / Linux counterpart of notify.ps1.
# Same rules: only "turn ended" events pop, notification first, sound afterwards.
#
# Transport:
#   Qoder CLI / Claude Code -> event "Stop", JSON on stdin
#   Codex CLI              -> config notify, JSON as the LAST argv argument
#
# Dependency-free: fields are pulled out with grep/sed because jq is not guaranteed.
# Exit 0 always; never print to stdout (a Stop hook's stdout is parsed as JSON).

set -u

DONE_EVENTS="Stop agent-turn-complete"          # events that pop; edit to taste
BALLOON_TEXT_FALLBACK="模型已停止，轮到你操作了。"
LOG_FILE="${HOME}/.agent-notify/notify.log"

field() { # field <json> <key>
    printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | sed -e "s/\"$2\":\"//" -e 's/"$//'
}

raw=""
# Codex passes the payload as the final argument.
if [ "$#" -gt 0 ]; then
    last="${@: -1}"
    case "$last" in
        "{"*) raw="$last" ;;
    esac
fi
# Qoder / Claude pass it on stdin.
if [ -z "$raw" ]; then
    raw="$(cat 2>/dev/null || true)"
fi
[ -z "$raw" ] && exit 0

event="$(field "$raw" hook_event_name)"
[ -z "$event" ] && event="$(field "$raw" type)"

case " $DONE_EVENTS " in
    *" $event "*) ;;
    *) exit 0 ;;
esac

cwd="$(field "$raw" cwd)"
project="${cwd##*/}"; [ -z "$project" ] && project="CLI"

# Codex includes the model's final message; use it when present.
body="$(field "$raw" last_assistant_message)"
[ -z "$body" ] && body="$BALLOON_TEXT_FALLBACK"
body="${body:0:200}"
title="CLI · 任务完成 · $project"

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
printf '%s POPUP %s event=%s\n' "$(date +%H:%M:%S)" "$project" "$event" >>"$LOG_FILE" 2>/dev/null

if command -v osascript >/dev/null 2>&1; then
    safe_body=${body//\"/\\\"}
    safe_title=${title//\"/\\\"}
    osascript -e "display notification \"$safe_body\" with title \"$safe_title\"" >/dev/null 2>&1
    ( afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 ) &
elif command -v notify-send >/dev/null 2>&1; then
    notify-send -u normal "$title" "$body" >/dev/null 2>&1
    ( paplay /usr/share/sounds/freedesktop/stereo/complete.oga >/dev/null 2>&1 ||
      aplay -q /usr/share/sounds/alsa/Front_Center.wav >/dev/null 2>&1 ) &
else
    printf 'agent-turn-notify: %s — %s\n' "$title" "$body" >&2
fi

exit 0
