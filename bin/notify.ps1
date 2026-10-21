# agent-turn-notify — desktop notification when a coding CLI hands control back.
#
# Works with Qoder CLI, Claude Code and Codex CLI, which disagree about transport:
#   Qoder / Claude  -> hook event "Stop", JSON payload on STDIN
#   Codex (legacy)  -> config notify, JSON payload appended as the LAST ARGV argument
#                      (stdin/stdout/stderr are all null — see codex-rs/hooks/src/legacy_notify.rs)
#
# Two rules this script exists to enforce:
#   1. Only "the model stopped, it is your turn" pops. Subagents finishing, background
#      tasks, permission prompts stay silent — that is the whole point of the event list.
#   2. The balloon is shown BEFORE the sound, and the sound is asynchronous. A blocking
#      PlaySync on a multi-second ringtone delayed the popup by ~5s in practice.
#
# This file must stay UTF-8 with BOM (Windows PowerShell 5.1 otherwise decodes it as the
# OEM codepage and the Chinese strings break parsing). install.mjs re-adds the BOM.
# Always exit 0 and never write to stdout: stdout of a Stop hook is parsed as JSON, and a
# decision or exit code 2 would block the agent.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RestArgs = @()
)

$ErrorActionPreference = 'SilentlyContinue'
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# ---- edit these to change behaviour -------------------------------------------------------
$DoneEvents = @('Stop', 'agent-turn-complete')
$BalloonSeconds = 12
$SoundFiles = @('C:/Windows/Media/ding.wav', 'C:/Windows/Media/notify.wav', 'C:/Windows/Media/chimes.wav')
$FallbackTitle = 'Qoder / Claude / Codex · 任务完成'
# -------------------------------------------------------------------------------------------

$LogFile = Join-Path $env:USERPROFILE '.agent-notify\notify.log'

try {
    $raw = $null
    if ($RestArgs.Count -gt 0) {
        $candidate = $RestArgs[$RestArgs.Count - 1]
        if ($candidate -match '^\s*\{') { $raw = $candidate }
    }
    if (-not $raw) {
        # Hook stdin is UTF-8; [Console]::In would decode it with the OEM codepage (936 on
        # zh-CN), corrupting any Chinese in the payload.
        $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
        $fromStdin = $reader.ReadToEnd()
        $reader.Dispose()
        $raw = $fromStdin -replace "^\uFEFF", ''
    }
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

    $data = $raw | ConvertFrom-Json
    $event = [string]$data.hook_event_name
    if (-not $event) { $event = [string]$data.type }
    if ($DoneEvents -notcontains $event) { exit 0 }

    $project = [string]$data.cwd
    if ($project) { $project = (Get-Item -Path $project -ErrorAction SilentlyContinue).Name }
    if (-not $project) { $project = 'CLI' }

    # Codex hands us the model's last message; use it as the body when present.
    $body = [string]$data.last_assistant_message
    if ($body) { $body = ($body -replace '\s+', ' ').Trim() } else { $body = '模型已停止，轮到你操作了。' }
    if ($body.Length -gt 200) { $body = $body.Substring(0, 200) }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $icon.BalloonTipTitle = "$FallbackTitle · $project"
    $icon.BalloonTipText = $body
    $icon.Visible = $true
    $icon.ShowBalloonTip($BalloonSeconds * 1000)

    if (-not (Test-Path $LogFile)) { New-Item -ItemType Directory -Path (Split-Path $LogFile -Parent) -Force | Out-Null }
    Add-Content -Encoding UTF8 -Path $LogFile -Value ('{0} POPUP {1} event={2} 弹窗耗时 {3}ms' -f (Get-Date).ToString('HH:mm:ss'), $project, $event, $stopwatch.ElapsedMilliseconds)

    $wav = $SoundFiles | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($wav) {
        $player = New-Object System.Media.SoundPlayer $wav
        $player.Play()
    } else {
        [System.Media.SystemSounds]::Exclamation.Play()
    }

    Start-Sleep -Seconds ($BalloonSeconds + 1)
    $icon.Visible = $false
    $icon.Dispose()
    exit 0
} catch {
    exit 0
}
