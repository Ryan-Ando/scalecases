$ErrorActionPreference = 'Stop'
# Installs Python deps, then registers the worker to start hidden at sign-in.
$here = $PSScriptRoot
$python = (Get-Command python.exe -ErrorAction Stop).Source
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (-not (Test-Path $pythonw)) { $pythonw = $python }
& $python -m pip install -q -r (Join-Path $here 'requirements.txt')
if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) { Write-Warning 'ffmpeg is not on PATH; video jobs will fail until it is installed (winget install Gyan.FFmpeg).' }
$workerPath = Join-Path $here 'worker.py'
$vbsPath = Join-Path $env:LOCALAPPDATA 'ScaleCasesDisclaimers\start.vbs'
New-Item -ItemType Directory -Force -Path (Split-Path $vbsPath) | Out-Null
$runCommand = '"' + $pythonw + '" "' + $workerPath + '"'
$vbs = 'CreateObject("WScript.Shell").Run "' + $runCommand.Replace('"', '""') + '", 0, False'
[IO.File]::WriteAllText($vbsPath, $vbs)
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Scale Cases Disclaimer Worker.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + $vbsPath + '"'
$shortcut.Description = 'Local disclaimer worker for Scale Cases'
$shortcut.Save()
Start-Process -FilePath $pythonw -ArgumentList ('"' + $workerPath + '"') -WindowStyle Hidden
Write-Output "Disclaimer worker installed. It runs hidden on 127.0.0.1:43128 and starts at sign-in."
Write-Output "To run it in a visible console instead:  python `"$workerPath`""
