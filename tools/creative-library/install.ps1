param([Parameter(Mandatory=$true)][string]$LibraryRoot)
$ErrorActionPreference = 'Stop'
$resolvedLibrary = (Resolve-Path -LiteralPath $LibraryRoot).Path
if (-not (Test-Path -LiteralPath $resolvedLibrary -PathType Container)) { throw 'Library folder not found' }
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$installDir = Join-Path $env:LOCALAPPDATA 'ScaleCasesCreativeLibrary'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'helper.mjs') -Destination (Join-Path $installDir 'helper.mjs') -Force
$configPath = Join-Path $installDir 'config.json'
@{ root = $resolvedLibrary; port = 43127; origins = @('https://scalecases-client.onrender.com'); intervalMs = 60000 } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
# Windows PowerShell emits a BOM; write JSON without it for Node's JSON.parse.
$json = Get-Content -LiteralPath $configPath -Raw
[IO.File]::WriteAllText($configPath, $json, (New-Object Text.UTF8Encoding($false)))
$helperPath = Join-Path $installDir 'helper.mjs'
$runCommand = '"' + $nodeExe + '" "' + $helperPath + '" --config "' + $configPath + '"'
$vbsPath = Join-Path $installDir 'start.vbs'
$vbs = 'CreateObject("WScript.Shell").Run "' + $runCommand.Replace('"', '""') + '", 0, False'
[IO.File]::WriteAllText($vbsPath, $vbs)
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Scale Cases Creative Library.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + $vbsPath + '"'
$shortcut.Description = 'Read-only local creative inventory for Scale Cases'
$shortcut.Save()
# Only stop a previous instance recorded by this installer, and verify its command.
$pidPath = Join-Path $installDir 'helper.pid'
if (Test-Path -LiteralPath $pidPath) {
  $oldHelperId = [int](Get-Content -LiteralPath $pidPath)
  $oldHelper = Get-CimInstance Win32_Process -Filter "ProcessId = $oldHelperId" -ErrorAction SilentlyContinue
  if ($oldHelper -and $oldHelper.CommandLine.Contains($helperPath)) { Stop-Process -Id $oldHelperId -ErrorAction SilentlyContinue }
}
$process = Start-Process -FilePath $nodeExe -ArgumentList ('"' + $helperPath + '" --config "' + $configPath + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $installDir 'helper.log') -RedirectStandardError (Join-Path $installDir 'helper-error.log')
$process.Id | Set-Content -LiteralPath $pidPath
Write-Output "Installed read-only helper for $resolvedLibrary (PID $($process.Id)). Starts at sign-in."
