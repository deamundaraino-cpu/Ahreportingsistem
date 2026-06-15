# Genera report-utm.zip listo para instalar en WordPress
# Uso: cd wordpress-plugin; .\build.ps1

$pluginDir = Join-Path $PSScriptRoot "report-utm"
$outZip    = Join-Path $PSScriptRoot "report-utm.zip"

if (Test-Path $outZip) { Remove-Item $outZip -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($pluginDir, $outZip)

Write-Host "✅ Plugin empaquetado en: $outZip"
Write-Host "   Tamaño: $([math]::Round((Get-Item $outZip).Length/1KB, 1)) KB"
