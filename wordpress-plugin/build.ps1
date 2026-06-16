# Genera report-utm.zip listo para instalar en WordPress
# Uso: cd wordpress-plugin; .\build.ps1
#
# IMPORTANTE: No se usa [ZipFile]::CreateFromDirectory porque en
# Windows/.NET Framework escribe los nombres de entrada con barras
# invertidas (\), lo cual viola la especificación ZIP. Al descomprimir
# en Linux (WordPress), las carpetas no se crean y los require_once del
# plugin fallan con un error fatal. Aquí escribimos cada entrada
# manualmente normalizando los separadores a barra normal (/).

$pluginDir = Join-Path $PSScriptRoot "report-utm"
$outZip    = Join-Path $PSScriptRoot "report-utm.zip"

if (Test-Path $outZip) { Remove-Item $outZip -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# El prefijo "report-utm/" asegura que el ZIP contenga la carpeta del
# plugin en la raíz, como espera WordPress al subir un plugin.
$rootName = Split-Path $pluginDir -Leaf
$baseLen  = $pluginDir.Length + 1

$zipStream = [System.IO.File]::Open($outZip, [System.IO.FileMode]::Create)
$archive   = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)

try {
    $files = Get-ChildItem -Path $pluginDir -Recurse -File
    foreach ($file in $files) {
        # Ruta relativa al directorio del plugin, con barras normales
        $relative  = $file.FullName.Substring($baseLen).Replace('\', '/')
        $entryName = "$rootName/$relative"

        $entry       = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        $fileBytes   = [System.IO.File]::ReadAllBytes($file.FullName)
        $entryStream.Write($fileBytes, 0, $fileBytes.Length)
        $entryStream.Close()
    }
}
finally {
    $archive.Dispose()
    $zipStream.Dispose()
}

# Verificación: confirmar que ninguna entrada tiene barras invertidas
$verify = [System.IO.Compression.ZipFile]::OpenRead($outZip)
$bad    = @($verify.Entries | Where-Object { $_.FullName.Contains('\') })
$count  = $verify.Entries.Count
$verify.Dispose()

if ($bad.Count -gt 0) {
    Write-Host "ERROR: el ZIP contiene entradas con barras invertidas:" -ForegroundColor Red
    $bad | ForEach-Object { Write-Host "   $($_.FullName)" -ForegroundColor Red }
    exit 1
}

Write-Host "Plugin empaquetado en: $outZip"
Write-Host "   Entradas: $count (todas con separador '/')"
Write-Host "   Tamano: $([math]::Round((Get-Item $outZip).Length/1KB, 1)) KB"
