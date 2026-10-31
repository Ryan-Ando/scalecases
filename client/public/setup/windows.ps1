# Scale Cases Helper setup for Windows: installs or updates the local helper that powers the
# Disclaimers tab and the local creative library (Ads Tracking / Relaunch).
# Run by "ScaleCases-Setup-Windows.cmd" (double-click) or in PowerShell:
#   iwr -UseBasicParsing https://scalecases-client.onrender.com/setup/windows.ps1 -OutFile $env:TEMP\sc.ps1; & $env:TEMP\sc.ps1
# Safe to run again at any time; that is also how to update. No administrator rights needed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoZip = 'https://github.com/Ryan-Ando/scalecases/archive/refs/heads/main.zip'
$App = Join-Path $env:LOCALAPPDATA 'ScaleCasesHelper'
$Links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
function Say($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }
Say 'Scale Cases Helper setup'

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
  throw 'winget is missing. Install "App Installer" from the Microsoft Store, then run this setup again.'
}
$wg = @('--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')

# 1. Python 3.12 (per-user install)
$Py = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
if (-not (Test-Path $Py)) {
  Say 'Installing Python 3.12...'
  winget install --id Python.Python.3.12 --scope user @wg | Out-Host
}
if (-not (Test-Path $Py)) { throw "Python did not install to $Py" }

# 2. ffmpeg
$env:PATH = "$Links;$env:PATH"
if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) {
  Say 'Installing ffmpeg...'
  winget install --id Gyan.FFmpeg @wg | Out-Host
}

# 3. The helper's code, from the Scale Cases repository
Say 'Downloading the latest helper...'
$Tmp = Join-Path $env:TEMP ('sc-setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp, $App | Out-Null
Invoke-WebRequest -UseBasicParsing $RepoZip -OutFile (Join-Path $Tmp 'sc.zip')
Expand-Archive -Path (Join-Path $Tmp 'sc.zip') -DestinationPath $Tmp -Force

# 4. Stop older installs (separate disclaimer worker / Node creative library) and this helper
$Startup = [Environment]::GetFolderPath('Startup')
foreach ($n in 'Scale Cases Disclaimer Worker.lnk', 'Scale Cases Creative Library.lnk', 'Scale Cases Helper.lnk') {
  Remove-Item -LiteralPath (Join-Path $Startup $n) -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine -match 'disclaimer-worker[\\/]worker\.py' -or $_.CommandLine -match 'ScaleCasesCreativeLibrary[\\/]helper\.mjs' -or $_.CommandLine -match 'ScaleCasesHelper[\\/]app[\\/]worker\.py')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$AppDir = Join-Path $App 'app'
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
Move-Item (Join-Path $Tmp 'scalecases-main\tools\disclaimer-worker') $AppDir
Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue

# 5. Python packages in the helper's own environment
Say 'Installing Python packages...'
$Venv = Join-Path $App 'venv'
if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) { & $Py -m venv $Venv }
$VPy = Join-Path $Venv 'Scripts\python.exe'
$VPyw = Join-Path $Venv 'Scripts\pythonw.exe'
& $VPy -m pip install -q --upgrade pip
& $VPy -m pip install -q -r (Join-Path $AppDir 'requirements.txt')
if ($LASTEXITCODE) { throw 'Installing Python packages failed' }

# 6. Start hidden at sign-in, and now
$Worker = Join-Path $AppDir 'worker.py'
$Vbs = Join-Path $App 'start.vbs'
# Started hidden by wscript; PATH includes winget's links so ffmpeg is found
$cmd = 'cmd /c set "PATH=' + $Links + ';%PATH%" && "' + $VPyw + '" "' + $Worker + '"'
[IO.File]::WriteAllText($Vbs, 'CreateObject("WScript.Shell").Run "' + $cmd.Replace('"', '""') + '", 0, False')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $Startup 'Scale Cases Helper.lnk'))
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + $Vbs + '"'
$lnk.Description = 'Scale Cases Helper (disclaimers + local creative library)'
$lnk.Save()
Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $Vbs + '"')

# 7. Check it
Say 'Starting...'
$h = $null
for ($i = 0; $i -lt 30 -and -not $h; $i++) {
  try { $h = Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:43128/health' -TimeoutSec 2 } catch { Start-Sleep -Seconds 1 }
}
if (-not $h) { throw "The helper did not start. Try running it visibly to see the error:  `"$VPy`" `"$Worker`"" }
function Line($ok, $text) { Write-Host (($(if ($ok) { 'OK ' } else { '!! ' })) + $text) -ForegroundColor $(if ($ok) { 'Green' } else { 'Yellow' }) }
Line $true "Helper running (version $($h.version))"
Line $h.ffmpeg $(if ($h.ffmpeg) { 'ffmpeg' } else { 'ffmpeg missing: sign out and back in, then run this setup again' })
if ($h.library_root_ok) { Line $true "Google Drive folder: $($h.library_root)" }
else { Line $false 'Google Drive not found. Install Google Drive for desktop (google.com/drive/download), sign in with your cypressmediagroup.com account, then run this setup again.' }
Line $h.shared $(if ($h.shared) { 'Shared disclaimer data' } else { 'Shared disclaimer data: ScaleCases\Disclaimers not found in Drive yet' })
Line ([bool]$h.creative_files) ("Creative library: $($h.creative_files) files" + $(if ($h.creative_root) { " in $($h.creative_root)" } else { '' }) + $(if ($h.creative_error) { " ($($h.creative_error))" } else { '' }))
Say 'Done. Open https://scalecases-client.onrender.com and, if the browser asks, allow access to devices on your local network.'
Write-Host 'The helper starts by itself when you sign in. Run this setup again any time to update it.'
