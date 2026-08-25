function Stop-SteamProcess {
  Write-Host "Stopping Steam process..."
  Get-Process -Name "steam" -ErrorAction SilentlyContinue | Stop-Process -Force
}

function Start-SteamProcess {
  param ([string]$SteamPath)

  Write-Host "Starting Steam process in dev mode..."
  Start-Process -FilePath "$SteamPath/steam.exe" -ArgumentList "-dev"
}

function Get-PluginName {
  param ([string]$Path)

  $json = Get-Content $Path | ConvertFrom-Json
  return @($json.name, $json.common_name)
}

function Set-PluginName {
  param ([string]$Path, [string]$Name, [string]$CommonName)

  $json = Get-Content $Path | ConvertFrom-Json
  $json.name = $Name
  $json.common_name = $CommonName
  $json | ConvertTo-Json -Depth 100 | Set-Content $Path

  pnpm exec oxfmt plugin.json
}

function Build-Plugin {
  Write-Host "Building plugin..."
  pnpm exec millennium-ttc --build dev
}

function Copy-PluginFiles {
  param ([string]$Destination)

  Write-Host "Copying plugin files to $Destination..."
  New-Item -Path $Destination -ItemType Directory -Force | Out-Null
  Copy-Item -Path "plugin.json" -Destination $Destination -Force
  Copy-Item -Path ".millennium" -Destination $Destination -Recurse -Force
  Copy-Item -Path "backend" -Destination $Destination -Recurse -Force
}

function Set-DeployedLink {
  param ([string]$Path, [string]$Target)

  # A junction rather than a symlink, because that needs no elevation, and
  # deleted through .Delete() so only the link goes and never the plugin behind it.
  $existing = Get-Item -Path $Path -Force -ErrorAction SilentlyContinue
  if ($existing -and (@($existing.Target)[0] -ne $Target)) {
    $existing.Delete()
    $existing = $null
  }

  if (-not $existing) {
    Write-Host "Linking $Path to the deployed plugin..."
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  }
}

function Toggle-Plugin {
  param ([string]$Path, [string]$Name, [bool]$Enable)

  Write-Host "$(if ($Enable) { "Enabling" } else { "Disabling" }) plugin $Name..."

  $json = Get-Content -Path $Path -Raw | ConvertFrom-Json
  $plugins = @($json.plugins.enabledPlugins)

  if ($Enable) {
    if (-not ($plugins -contains $Name)) { $plugins = @($plugins + $Name) }
    $plugins = @($plugins | Sort-Object -Unique)
  } else {
    $plugins = @($plugins | Where-Object { $_ -ne $Name })
  }

  $json.plugins.enabledPlugins = $plugins
  $json | ConvertTo-Json -Depth 100 | Set-Content $Path
}

#####

$SteamPath = "C:\Program Files (x86)\Steam"
$ConfigPath = "$SteamPath\millennium\config\config.json"
$PluginName, $PluginCommonName = Get-PluginName -Path "./plugin.json"
Stop-SteamProcess
Set-PluginName -Path "plugin.json" -Name $PluginName-dev -CommonName "$PluginCommonName (dev)"
try {
  Build-Plugin
  Copy-PluginFiles -Destination "$SteamPath\millennium\plugins\$PluginName-dev"
} finally {
  Set-PluginName -Path "plugin.json" -Name $PluginName -CommonName $PluginCommonName
}

Set-DeployedLink -Path ".deployed" -Target "$SteamPath\millennium\plugins\$PluginName-dev"

Toggle-Plugin -Path $ConfigPath -Name $PluginName -Enable $false
Toggle-Plugin -Path $ConfigPath -Name $PluginName-dev -Enable $true
Start-SteamProcess $SteamPath
