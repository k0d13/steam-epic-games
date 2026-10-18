# The runner for one legendary job on Windows. runner.lua fills in the {braced}
# names. legendary runs in a pipeline so `taskkill /T` on this PID takes it down
# too, and progress and errors get files of their own so reads never scan the log.

$Dir = {dir}
$Exe = {exe}
# Not $Args: that's a PowerShell automatic variable and can't be assigned.
$Arguments = @({args})

$ErrorActionPreference = 'Continue'

# Held unshared and never closed, so the plugin can tell the runner is alive by
# failing to open it. It's released only after the exit code below is written.
$Lock = [System.IO.File]::Open("$Dir\{lock}", 'Create', 'Write', 'None')

$PID | Out-File -Encoding ascii -FilePath "$Dir\{pid}"

# One handle for the whole download: legendary prints thousands of lines.
$Log = New-Object System.IO.StreamWriter "$Dir\{log}", $true, (New-Object System.Text.UTF8Encoding $false)
$Log.AutoFlush = $true

$percent = 0; $done = 0; $total = 0; $eta = ''; $elapsed = ''; $speed = 0

# A blank line takes the default at a prompt -y doesn't cover, like the selective
# download one Fortnite gets. Stdin closes after it, so another prompt fails the
# job instead of hanging it.
@('') | & $Exe @Arguments 2>&1 | ForEach-Object {
  $line = [string]$_
  $Log.WriteLine($line)

  if ($line -match 'Progress: ([\d.]+)% \((\d+)/(\d+)\), Running for ([\d:]+), ETA: ([\d:]+)') {
    $percent = $matches[1]; $done = $matches[2]; $total = $matches[3]
    $elapsed = $matches[4]; $eta = $matches[5]
  } elseif ($line -match 'Download\s+- ([\d.]+) MiB/s \(raw\)') {
    $speed = $matches[1]
  } else {
    if ($line -match '(ERROR|CRITICAL):') {
      $line | Out-File -Encoding utf8 -FilePath "$Dir\{error}"
    }
    return
  }

  @(
    "percent=$percent", "downloaded=$done", "total=$total",
    "eta=$eta", "elapsed=$elapsed", "speed=$speed"
  ) -join "`n" | Out-File -Encoding ascii -FilePath "$Dir\{status}"
}

$code = $LASTEXITCODE
$Log.Dispose()
if ($null -eq $code) { $code = 0 }
$code | Out-File -Encoding ascii -FilePath "$Dir\{exit}"
