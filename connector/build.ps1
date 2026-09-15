<#
  Packages the printer connector for the office PC.

  Not a single .exe, on purpose. Node's single-executable format works by
  injecting into node.exe, which invalidates node.exe's Authenticode signature.
  Windows Smart App Control — on by default on new Windows 11 machines, and
  enforced on this one — then blocks the result outright. Signing it properly
  needs a paid code-signing certificate; self-signed is not enough for SAC.

  So the signed node.exe ships untouched and the script sits beside it. Same
  result for the user: a folder to copy, one file to double-click, no terminal,
  no Node install, no npm.

    powershell -ExecutionPolicy Bypass -File connector\build.ps1
#>
param(
  [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) "dist"),
  [string]$Name = "POS Printer Connector"
)

$ErrorActionPreference = "Stop"

$target = Join-Path $OutDir $Name
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force $target | Out-Null

Write-Output "1/3  copying the signed Node runtime"
$node = (Get-Command node).Source
Copy-Item $node (Join-Path $target "node.exe") -Force
$sig = Get-AuthenticodeSignature (Join-Path $target "node.exe")
Write-Output "     signature: $($sig.Status)"

Write-Output "2/3  copying the connector"
Copy-Item (Join-Path $PSScriptRoot "connector.js") $target -Force
Copy-Item (Join-Path $PSScriptRoot "package.json") $target -Force

# serialport is a native addon and must travel with its compiled binding. It is
# also not optional: plain fs cannot open a COM device on Windows - it silently
# creates a file of that name instead and the receipt never reaches the printer.
$modules = Join-Path $PSScriptRoot "node_modules"
if (-not (Test-Path $modules)) { throw "run 'npm install' in connector\ first" }
Copy-Item $modules (Join-Path $target "node_modules") -Recurse -Force
$binding = Get-ChildItem (Join-Path $target "node_modules") -Recurse -Filter *.node -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $binding) { throw "serialport's native binding is missing from node_modules" }
Write-Output "     native binding: $($binding.Name)"
$envSrc = Join-Path $PSScriptRoot "connector.env"
if (Test-Path $envSrc) {
  Copy-Item $envSrc $target -Force
  Write-Output "     connector.env included (it holds your Supabase key - do not share this folder)"
} else {
  Write-Output "     no connector.env yet; the connector writes a template on first run"
}

Write-Output "3/3  writing the launcher"
# WScript.Shell with window style 0 runs it with no console window at all, which
# is the whole point: staff should never see or be able to close a terminal.
@'
' Starts the POS Printer Connector with no window.
' Double-click this, or put a shortcut to it in shell:startup to have it run at login.
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
shell.Run """" & here & "\node.exe"" """ & here & "\connector.js""", 0, False
'@ | Set-Content (Join-Path $target "Start Printer Connector.vbs") -Encoding ASCII

@'
@echo off
rem Puts a shortcut to the launcher in this user's Startup folder, so the
rem connector comes back on its own after a reboot.
set "HERE=%~dp0"
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\POS Printer Connector.lnk\"); $s.TargetPath='%HERE%Start Printer Connector.vbs'; $s.WorkingDirectory='%HERE%'; $s.Save()"
echo Done. The connector will start automatically at login.
pause
'@ | Set-Content (Join-Path $target "Run at startup.cmd") -Encoding ASCII

$mb = [Math]::Round(((Get-ChildItem $target -Recurse | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Output ""
Write-Output "built: $target  ($mb MB)"
Write-Output ""
Write-Output "On the office PC:"
Write-Output "  1. copy the whole folder anywhere"
Write-Output "  2. double-click 'Start Printer Connector.vbs'"
Write-Output "  3. run 'Run at startup.cmd' once, so it survives a reboot"
